const test = require('node:test');
const assert = require('node:assert/strict');
const { parseChannelInput, fetchLatestUploads } = require('../src/youtube');
const { normalizeSchedule, isWithinHours, activeIntervalSeconds, isDue, isScheduledTick, scheduleMinutes, dailyRequestCount, quotaSummary, classifyEntries, eligibleEntries } = require('../src/youtube-monitor');

test('YouTube handle URL ayrıştırılır', () => {
  assert.deepEqual(parseChannelInput('https://www.youtube.com/@hisarkapisi'), { type: 'handle', value: '@hisarkapisi' });
});

test('kanal ID ayrıştırılır', () => {
  assert.deepEqual(parseChannelInput('UCb2NNTeDSPr2sFHrI2AwHTQ'), { type: 'id', value: 'UCb2NNTeDSPr2sFHrI2AwHTQ' });
});

test('YouTube channel URL ayrıştırılır', () => {
  assert.deepEqual(
    parseChannelInput('https://www.youtube.com/channel/UCb2NNTeDSPr2sFHrI2AwHTQ'),
    { type: 'id', value: 'UCb2NNTeDSPr2sFHrI2AwHTQ' }
  );
});

test('son yüklemeler varsayılan olarak en fazla 5 video ister', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.YOUTUBE_API_KEY;
  let requestedUrl;
  process.env.YOUTUBE_API_KEY = 'test-key';
  global.fetch = async url => {
    requestedUrl = new URL(url);
    return { ok: true, json: async () => ({ items: [] }) };
  };

  try {
    await fetchLatestUploads('UCb2NNTeDSPr2sFHrI2AwHTQ');
    assert.equal(requestedUrl.searchParams.get('maxResults'), '5');
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = originalKey;
  }
});

test('kontrol planı 15 saniye veya bir dakikalık sıklık ve geçerli saat sınırlarını kullanır', () => {
  assert.deepEqual(normalizeSchedule({ intervalSeconds: '15', startHour: '9', startMinute: '15', endHour: '18', endMinute: '45' }), { intervalSeconds: 15, startHour: 9, startMinute: 15, endHour: 18, endMinute: 45 });
  assert.throws(() => normalizeSchedule({ intervalSeconds: 30 }), /15 saniye veya 1 dakika/);
  assert.throws(() => normalizeSchedule({ startHour: 24 }), /00 ile 23/);
  assert.throws(() => normalizeSchedule({ startMinute: 60 }), /00 ile 59/);
});

test('kontrol saat aralığı Türkiye saatine göre, gece yarısını aşacak şekilde uygulanır', () => {
  const schedule = { intervalMinutes: 1, startHour: 22, endHour: 2 };
  assert.equal(isWithinHours(schedule, new Date('2025-01-01T20:30:00Z')), true); // 23:30 TRT
  assert.equal(isWithinHours(schedule, new Date('2025-01-01T12:30:00Z')), false); // 15:30 TRT
});

test('kontrol seçilen saniye sıklığında yapılır', () => {
  const now = new Date('2025-01-01T10:05:00Z');
  assert.equal(isDue(15, new Date('2025-01-01T10:04:45Z'), now), true);
  assert.equal(isDue(60, new Date('2025-01-01T10:04:01Z'), now), false);
});

test('sabit zaman slotları 15 saniye ve bir dakika için doğru seçilir', () => {
  assert.equal(isScheduledTick(15, new Date('2025-01-01T10:00:30Z')), true);
  assert.equal(isScheduledTick(15, new Date('2025-01-01T10:00:31Z')), false);
  assert.equal(isScheduledTick(60, new Date('2025-01-01T10:00:00Z')), true);
  assert.equal(isScheduledTick(60, new Date('2025-01-01T10:00:15Z')), false);
});

test('günlük istek tahmini gece yarısını aşan aralıkları doğru hesaplar', () => {
  assert.equal(scheduleMinutes({ startHour: 8, endHour: 20 }), 780);
  assert.equal(scheduleMinutes({ startHour: 22, endHour: 2 }), 300);
  assert.equal(scheduleMinutes({ startHour: 8, startMinute: 30, endHour: 9, endMinute: 15 }), 46);
});

test('kontrol penceresi dakika hassasiyetinde uygulanır', () => {
  const schedule = { startHour: 13, startMinute: 30, endHour: 13, endMinute: 45 };
  assert.equal(isWithinHours(schedule, new Date('2025-01-01T10:29:00Z')), false);
  assert.equal(isWithinHours(schedule, new Date('2025-01-01T10:30:00Z')), true);
  assert.equal(isWithinHours(schedule, new Date('2025-01-01T10:46:00Z')), false);
});

test('kota özeti etkin kanalları toplar, duraklatılan kanalı saymaz', () => {
  const quota = quotaSummary([
    { id: 'one', monitor: { schedule: { startHour: 8, endHour: 14 } } },
    { id: 'two', enabled: false, monitor: { schedule: { startHour: 0, endHour: 23 } } }
  ]);
  assert.equal(quota.estimatedRequests, 420);
  assert.equal(quota.limit, 1000);
  assert.equal(quota.exceeded, false);
});

test('çakışan aralıklarda en hızlı sıklık kazanır ve çift kontrol oluşmaz', () => {
  const schedules = [
    { intervalSeconds: 15, startHour: 7, startMinute: 0, endHour: 7, endMinute: 10 },
    { intervalSeconds: 60, startHour: 7, startMinute: 5, endHour: 7, endMinute: 15 }
  ];
  assert.equal(activeIntervalSeconds(schedules, new Date('2025-01-01T04:09:45Z')), 15);
  assert.equal(activeIntervalSeconds(schedules, new Date('2025-01-01T04:10:00Z')), 15);
  assert.equal(activeIntervalSeconds(schedules, new Date('2025-01-01T04:10:15Z')), 60);
  assert.equal(activeIntervalSeconds(schedules, new Date('2025-01-01T04:15:15Z')), null);
});

test('14:59–15:02 hızlı ve 15:02–15:15 normal aralıkları günde 26 benzersiz kontrol üretir', () => {
  assert.equal(dailyRequestCount([
    { intervalSeconds: 15, startHour: 14, startMinute: 59, endHour: 15, endMinute: 2 },
    { intervalSeconds: 60, startHour: 15, startMinute: 2, endHour: 15, endMinute: 15 }
  ]), 26);
});

test('beş dakikalık videolar gönderilir, daha eskiler cancelled olarak sınıflandırılır', () => {
  const schedule = { startHour: 8, startMinute: 0, endHour: 20, endMinute: 0 };
  const channel = { monitor: { startedAt: new Date('2025-01-01T05:00:00Z'), acceptVideosAfter: new Date('2025-01-01T05:00:00Z') } };
  const entries = [
    { videoId: 'old', publishedAt: new Date('2025-01-01T12:00:00Z') },
    { videoId: 'outside-hours', publishedAt: new Date('2025-01-01T21:00:00Z') },
    { videoId: 'stale', publishedAt: new Date('2025-01-02T06:54:00Z') },
    { videoId: 'eligible', publishedAt: new Date('2025-01-02T06:58:00Z') },
    { videoId: 'future', publishedAt: new Date('2025-01-02T07:01:00Z') },
    { videoId: 'missing-date', publishedAt: null }
  ];

  const classified = classifyEntries(entries, channel, schedule, new Date('2025-01-02T07:00:00Z'));
  assert.deepEqual(classified.pending.map(entry => entry.videoId), ['eligible']);
  assert.deepEqual(classified.cancelled.map(entry => entry.videoId), ['old', 'stale']);
});

test('zaman aralığı değişikliğinden önce yayımlanan video geriye dönük işlenmez', () => {
  const channel = { monitor: { startedAt: new Date('2025-01-02T04:00:00Z'), acceptVideosAfter: new Date('2025-01-02T04:56:00Z') } };
  const entries = [
    { videoId: 'before-update', publishedAt: new Date('2025-01-02T04:55:00Z') },
    { videoId: 'after-update', publishedAt: new Date('2025-01-02T04:57:00Z') }
  ];

  assert.deepEqual(
    eligibleEntries(entries, channel, { startHour: 7, endHour: 9 }, new Date('2025-01-02T04:58:00Z')).map(entry => entry.videoId),
    ['after-update']
  );
});

test('kanal eklenmeden önce yayımlanan videolar ilk kontrolde işlenmez', () => {
  const channel = { monitor: { startedAt: new Date('2025-01-02T09:00:00Z') } };
  const entries = [
    { videoId: 'before-channel', publishedAt: new Date('2025-01-02T08:59:59Z') },
    { videoId: 'after-channel', publishedAt: new Date('2025-01-02T09:00:01Z') }
  ];

  assert.deepEqual(
    eligibleEntries(entries, channel, { startHour: 0, endHour: 23, endMinute: 59 }, new Date('2025-01-02T09:01:00Z')).map(entry => entry.videoId),
    ['after-channel']
  );
});
