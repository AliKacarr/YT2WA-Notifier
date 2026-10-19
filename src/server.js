require('dotenv').config();

// Baileys/libsignal bazen yeniden bağlantı sırasında artık geçerli olmayan eski
// mesaj oturumlarını çözmeye çalışır ve uygulamanın çalışmasını etkilemeyen uzun
// Bad MAC stack trace'leri veya kapatılmış oturum ayrıntıları basar. Yalnızca bu
// bilinen gürültüyü (anahtar materyali içeren çıktılar dahil) sustururuz;
// diğer stdout/stderr hata ve uyarıları görünmeye devam eder.
const ignoredSignalLogFragments = [
  'Failed to decrypt message with any known session',
  'Session error:Error: Bad MAC',
  'Bad MAC Error: Bad MAC',
  'Removing old closed session:',
  'Closing open session',
  'Closing session: SessionEntry',
  'Object.verifyMAC',
  'SessionCipher.doDecryptWhisperMessage',
  'SessionCipher.decryptWithSessions',
  'libsignal\\src\\session_cipher.js',
  'libsignal/src/session_cipher.js'
];

for (const stream of [process.stdout, process.stderr]) {
  const originalWrite = stream.write.bind(stream);
  stream.write = (chunk, encoding, callback) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    if (ignoredSignalLogFragments.some(fragment => text.includes(fragment))) {
      if (typeof callback === 'function') callback();
      return true;
    }
    return originalWrite(chunk, encoding, callback);
  };
}

const path = require('path');
const express = require('express');
const schedule = require('node-schedule');
const { connectDatabase, closeDatabase, db, getSettings, updateChannelFields, removeChannel, resetSettings } = require('./db');
const { getConfigKey } = require('./config');
const youtube = require('./youtube');
const youtubeMonitor = require('./youtube-monitor');
const whatsapp = require('./whatsapp');
const delivery = require('./delivery');
const auth = require('./auth');

const app = express();
const port = Number(process.env.PORT) || 3000;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.get('/api/health', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()), timestamp: new Date().toISOString() }));

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { etag: true, maxAge: 0 }));

app.get('/api/status', async (req, res, next) => {
  try {
    const settings = await getSettings();
    const authState = await auth.status(req);
    const { _id, configKey, ...safeSettings } = settings || {};
    const whatsappState = whatsapp.getState();
    const visibleSettings = authState.authenticated ? safeSettings : {
      ...safeSettings,
      channels: (safeSettings.channels || []).map(channel => {
        const { targetGroupId, input, ...visibleChannel } = channel;
        const { lastError, ...visibleMonitor } = visibleChannel.monitor || {};
        return { ...visibleChannel, monitor: visibleMonitor };
      })
    };
    res.json({
      ok: true,
      auth: authState,
      whatsapp: authState.authenticated ? whatsappState : { ...whatsappState, qrDataUrl: null, lastError: null, userInfo: whatsappState.userInfo ? { name: whatsappState.userInfo.name } : null },
      settings: visibleSettings,
      quota: youtubeMonitor.quotaSummary(settings?.channels)
    });
  } catch (error) { next(error); }
});

app.get('/api/auth/status', async (req, res, next) => {
  try { res.json({ ok: true, auth: await auth.status(req) }); } catch (error) { next(error); }
});

app.post('/api/auth/setup', async (req, res, next) => {
  try { await auth.setup(req, res); res.status(201).json({ ok: true, auth: { authenticated: true, passwordConfigured: true } }); } catch (error) { next(error); }
});

app.post('/api/auth/login', async (req, res, next) => {
  try { await auth.login(req, res); res.json({ ok: true, auth: { authenticated: true, passwordConfigured: true } }); } catch (error) { next(error); }
});

app.post('/api/auth/logout', async (req, res, next) => {
  try { await auth.logout(req, res); res.json({ ok: true }); } catch (error) { next(error); }
});

app.post('/api/whatsapp/start', auth.requireAdmin, async (req, res, next) => {
  try { await whatsapp.start(false); res.json({ ok: true, whatsapp: whatsapp.getState() }); } catch (error) { next(error); }
});

app.post('/api/whatsapp/logout', auth.requireAdmin, async (req, res, next) => {
  delivery.pause();
  youtubeMonitor.pause();
  try {
    await whatsapp.logout();
    await youtubeMonitor.waitForIdle();
    const settings = await resetSettings();
    await delivery.cancelOutstanding();
    res.json({ ok: true, whatsapp: whatsapp.getState(), settings });
  } catch (error) { next(error); }
  finally {
    youtubeMonitor.resume();
    delivery.resume();
  }
});

app.get('/api/groups', auth.requireAdmin, async (req, res, next) => {
  try { const groups = await whatsapp.groups(); res.json({ ok: true, groups }); } catch (error) { next(error); }
});

app.get('/api/channel-thumbnail/:automationId', async (req, res, next) => {
  try {
    const settings = await getSettings();
    const channel = settings?.channels?.find(item => item.automationId === req.params.automationId);
    if (!channel?.thumbnail) return res.sendStatus(404);
    const thumbnailUrl = new URL(channel.thumbnail);
    const allowedHosts = ['yt3.ggpht.com', 'yt3.googleusercontent.com'];
    if (thumbnailUrl.protocol !== 'https:' || !allowedHosts.includes(thumbnailUrl.hostname)) return res.sendStatus(404);
    const response = await fetch(thumbnailUrl, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Kanal görseli alınamadı (${response.status})`);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) throw new Error('Kanal görseli geçerli bir resim değil.');
    const image = Buffer.from(await response.arrayBuffer());
    if (image.length > 5 * 1024 * 1024) throw new Error('Kanal görseli çok büyük.');
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(image);
  } catch (error) { next(error); }
});

app.post('/api/youtube/resolve', auth.requireAdmin, async (req, res, next) => {
  try { res.json({ ok: true, channel: await youtube.resolveChannel(req.body.input) }); } catch (error) { next(error); }
});

app.post('/api/channels', auth.requireAdmin, async (req, res, next) => {
  try {
    if (whatsapp.getState().status !== 'READY') throw new Error('Önce WhatsApp bağlantısını tamamlayın.');
    const groupId = String(req.body.targetGroupId || '').trim();
    if (!groupId.endsWith('@g.us')) throw new Error('Geçerli bir WhatsApp grubu seçin.');
    const group = (await whatsapp.groups()).find(item => item.id === groupId);
    if (!group) throw new Error('Seçilen grup bağlı WhatsApp hesabında bulunamadı.');
    const deliveryType = String(req.body.deliveryType || 'poll');
    if (!['poll', 'message'].includes(deliveryType)) throw new Error('Gönderim biçimi anket veya mesaj olmalıdır.');
    const channel = await youtube.resolveChannel(req.body.input);
    const result = await youtubeMonitor.addChannel(channel, { targetGroupId: group.id, targetGroupName: group.name, deliveryType, schedules: req.body.schedules || req.body.schedule });
    res.status(201).json({ ok: true, ...result });
  } catch (error) { next(error); }
});

app.put('/api/channels/:automationId', auth.requireAdmin, async (req, res, next) => {
  try {
    if (whatsapp.getState().status !== 'READY') throw new Error('Önce WhatsApp bağlantısını tamamlayın.');
    const groupId = String(req.body.targetGroupId || '').trim();
    if (!groupId.endsWith('@g.us')) throw new Error('Geçerli bir WhatsApp grup JID seçin.');
    const group = (await whatsapp.groups()).find(item => item.id === groupId);
    if (!group) throw new Error('Seçilen grup bağlı WhatsApp hesabında bulunamadı.');
    const settings = await getSettings();
    const index = settings.channels?.findIndex(item => item.automationId === req.params.automationId);
    if (index < 0) throw new Error('YouTube kanalı bulunamadı.');
    const deliveryType = String(req.body.deliveryType || 'poll');
    if (!['poll', 'message'].includes(deliveryType)) throw new Error('Gönderim biçimi anket veya mesaj olmalıdır.');
    const previous = settings.channels[index];
    const schedules = youtubeMonitor.normalizeSchedules(req.body.schedules || req.body.schedule || youtubeMonitor.channelSchedules(previous));
    const previousSchedules = youtubeMonitor.channelSchedules(previous);
    const scheduleChanged = JSON.stringify(previousSchedules) !== JSON.stringify(schedules);
    const enabled = req.body.enabled !== false;
    const monitorReset = scheduleChanged || (previous.enabled === false && enabled);
    const fields = {
      targetGroupId: group.id,
      targetGroupName: group.name,
      deliveryType,
      enabled,
      'monitor.schedules': schedules
    };
    if (monitorReset) {
      fields['monitor.acceptVideosAfter'] = new Date();
      fields['monitor.lastCheckedAt'] = null;
    }
    const result = await updateChannelFields(req.params.automationId, fields, { unset: { 'monitor.schedule': '' } });
    if (!result.matched) throw new Error('YouTube kanalı bulunamadı.');
    if (!enabled) await delivery.cancelOutstanding('channel-disabled', req.params.automationId);
    const updated = result.settings.channels.find(item => item.automationId === req.params.automationId);
    const quota = youtubeMonitor.quotaSummary(result.settings.channels || []);
    res.json({ ok: true, channel: updated, quota });
  } catch (error) { next(error); }
});

app.delete('/api/channels/:automationId', auth.requireAdmin, async (req, res, next) => {
  try {
    const result = await removeChannel(req.params.automationId);
    if (!result.removed) throw new Error('YouTube kanalı bulunamadı.');
    await delivery.cancelOutstanding('channel-deleted', req.params.automationId);
    res.json({ ok: true, quota: youtubeMonitor.quotaSummary(result.settings?.channels || []) });
  } catch (error) { next(error); }
});

app.post('/api/test-delivery', auth.requireAdmin, async (req, res, next) => {
  try {
    const settings = await getSettings();
    const channel = settings?.channels?.find(item => item.automationId === req.body.automationId);
    if (whatsapp.getState().status !== 'READY' || !channel?.targetGroupId) throw new Error('Test için geçerli bir kanal seçilmelidir.');
    const videoUrl = String(req.body.videoUrl || 'https://www.youtube.com/watch?v=test').trim();
    const deliveryType = channel.deliveryType === 'message' ? 'message' : 'poll';
    const result = deliveryType === 'message'
      ? await whatsapp.sendVideoMessage({ groupId: channel.targetGroupId, title: req.body.title || 'Test video başlığı', videoUrl })
      : await whatsapp.sendVideoPoll({ groupId: channel.targetGroupId, videoUrl });
    res.json({ ok: true, deliveryType, result });
  } catch (error) { next(error); }
});

app.get('/api/events', async (req, res, next) => {
  try {
    const requestedPage = Number.parseInt(req.query.page, 10);
    const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 0;
    const filter = { configKey: getConfigKey() };
    const [events, total] = await Promise.all([
      db().collection('video_events').find(filter).sort({ receivedAt: -1 }).skip(page * 10).limit(10).toArray(),
      db().collection('video_events').countDocuments(filter)
    ]);
    const authState = await auth.status(req);
    const visibleEvents = authState.authenticated ? events : events.map(event => ({
      channelId: event.channelId,
      channelTitle: event.channelTitle,
      videoId: event.videoId,
      title: event.title,
      videoUrl: event.videoUrl,
      targetGroupName: event.targetGroupName,
      status: event.status,
      reason: event.reason,
      receivedAt: event.receivedAt
    }));
    res.json({ ok: true, events: visibleEvents, total, page });
  } catch (error) { next(error); }
});

app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Endpoint bulunamadı.' }));
app.use((error, req, res, next) => {
  console.error(error);
  res.status(400).json({ ok: false, error: error.message || 'Beklenmeyen hata.' });
});

function scheduleJobs() {
  if (process.env.PING_URL?.trim()) {
    schedule.scheduleJob('*/2 * * * *', async () => {
      try {
        const response = await fetch(process.env.PING_URL.trim());
        if (!response.ok) console.warn(`Health self-ping başarısız: ${response.status}`);
      } catch (error) { console.warn('Health self-ping hatası:', error.message); }
    });
  }
  // Zamanlayıcı 15 saniyede bir çalışır; kanalın etkin aralık ve sıklığı
  // reconcileChannels içinde uygulanır. videoId unique indeksi tekrar gönderimi önler.
  schedule.scheduleJob('*/15 * * * * *', async fireDate => {
    try {
      // Kararı callback'in gecikmiş olabileceği gerçek çalışma anına göre değil,
      // node-schedule'ın hedeflediği sabit :00/:15/:30/:45 slotuna göre ver.
      const result = await youtubeMonitor.reconcileChannels({ scheduledAt: fireDate });
      if (result?.inserted) delivery.kick();
    } catch (error) { console.warn('YouTube video kontrolü hatası:', error.message); }
  });
}

async function main() {
  await connectDatabase();
  await delivery.start();
  whatsapp.start(true).catch(error => console.warn('WhatsApp otomatik başlatılamadı:', error.message));
  scheduleJobs();
  await new Promise(resolve => app.listen(port, '0.0.0.0', () => {
    console.log(`Sunucu 0.0.0.0:${port} üzerinde hazır.`);
    resolve();
  }));
}

async function shutdown() {
  await closeDatabase().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (require.main === module) main().catch(error => { console.error('Başlatma hatası:', error); process.exit(1); });

module.exports = { app, main };
