const { requireEnv } = require('./config');

const CHANNEL_ID_PATTERN = /^UC[\w-]{22}$/;

function parseChannelInput(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('YouTube kanal adresi, handle veya kanal ID gereklidir.');
  if (CHANNEL_ID_PATTERN.test(raw)) return { type: 'id', value: raw };
  if (/^@[A-Za-z0-9._-]+$/.test(raw)) return { type: 'handle', value: raw };

  let url;
  try { url = new URL(raw); } catch { throw new Error('Geçerli bir YouTube URL, @handle veya kanal ID girin.'); }
  if (!/(^|\.)youtube\.com$/i.test(url.hostname)) throw new Error('URL youtube.com alan adına ait olmalıdır.');

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'channel' && CHANNEL_ID_PATTERN.test(parts[1] || '')) {
    return { type: 'id', value: parts[1] };
  }
  if (parts[0]?.startsWith('@')) return { type: 'handle', value: parts[0] };
  if (parts[0] === 'user' && parts[1]) return { type: 'username', value: parts[1] };
  throw new Error('Bu YouTube URL biçimi desteklenmiyor. Kanalın @handle veya /channel/UC... adresini kullanın.');
}

async function resolveChannel(input) {
  const parsed = parseChannelInput(input);
  const key = requireEnv('YOUTUBE_API_KEY');
  const url = new URL('https://www.googleapis.com/youtube/v3/channels');
  url.searchParams.set('part', 'id,snippet');
  url.searchParams.set('key', key);
  url.searchParams.set(parsed.type === 'handle' ? 'forHandle' : parsed.type === 'username' ? 'forUsername' : 'id', parsed.value);

  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `YouTube API hatası (${response.status})`);
  const channel = body.items?.[0];
  if (!channel) throw new Error('YouTube kanalı bulunamadı.');

  return {
    id: channel.id,
    title: channel.snippet?.title || channel.id,
    handle: channel.snippet?.customUrl || null,
    thumbnail: channel.snippet?.thumbnails?.medium?.url || channel.snippet?.thumbnails?.default?.url || null,
    input: String(input).trim()
  };
}

async function fetchLatestUploads(channelId, maxResults = 5) {
  if (!CHANNEL_ID_PATTERN.test(channelId || '')) throw new Error('Ge\u00e7ersiz YouTube kanal kimli\u011fi.');
  const key = requireEnv('YOUTUBE_API_KEY');
  const uploadsPlaylistId = 'UU' + channelId.slice(2);
  const url = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
  url.searchParams.set('part', 'snippet,contentDetails,status');
  url.searchParams.set('playlistId', uploadsPlaylistId);
  url.searchParams.set('maxResults', String(maxResults));
  url.searchParams.set('key', key);

  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || 'YouTube video listesi al\u0131namad\u0131 (' + response.status + ')');

  return (body.items || [])
    .filter(item => !item.status?.privacyStatus || item.status.privacyStatus === 'public')
    .map(item => ({
      videoId: item.contentDetails?.videoId,
      channelId,
      title: item.snippet?.title || item.contentDetails?.videoId,
      publishedAt: item.contentDetails?.videoPublishedAt
        ? new Date(item.contentDetails.videoPublishedAt)
        : item.snippet?.publishedAt ? new Date(item.snippet.publishedAt) : null,
      updatedAt: item.snippet?.publishedAt ? new Date(item.snippet.publishedAt) : null
    }))
    .filter(item => item.videoId);
}

module.exports = {
  CHANNEL_ID_PATTERN,
  parseChannelInput,
  resolveChannel,
  fetchLatestUploads
};
