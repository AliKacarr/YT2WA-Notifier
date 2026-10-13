const test = require('node:test');
const assert = require('node:assert/strict');

process.env.CONFIG_KEY ||= 'test';

function channel(automationId) {
  return {
    automationId,
    id: `youtube-${automationId}`,
    title: automationId,
    targetGroupId: 'group@g.us',
    enabled: true,
    monitor: {
      startedAt: new Date('2024-12-01T00:00:00Z'),
      acceptVideosAfter: new Date('2024-12-01T00:00:00Z'),
      schedules: [{ intervalSeconds: 15, startHour: 0, startMinute: 0, endHour: 23, endMinute: 59 }]
    }
  };
}

function loadMonitor({ channels, fetchLatestUploads, saveResult, writeEvent }) {
  const dbPath = require.resolve('../src/db');
  const youtubePath = require.resolve('../src/youtube');
  const monitorPath = require.resolve('../src/youtube-monitor');
  const monitorUpdates = [];
  const eventWrites = [];

  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      db: () => ({
        collection: () => ({
          updateOne: async (...args) => {
            eventWrites.push(args);
            if (writeEvent) return writeEvent(...args);
            return { upsertedCount: 1 };
          }
        })
      }),
      getSettings: async () => ({ channels }),
      appendChannel: async item => ({ channels: [...channels, item] }),
      updateChannelFields: async (automationId, fields, options) => {
        monitorUpdates.push({ automationId, fields, options });
        if (saveResult) return saveResult({ automationId, fields, options, channels });
        return { matched: true, settings: { channels } };
      }
    }
  };
  require.cache[youtubePath] = {
    id: youtubePath,
    filename: youtubePath,
    loaded: true,
    exports: { fetchLatestUploads }
  };
  delete require.cache[monitorPath];

  return { monitor: require(monitorPath), monitorUpdates, eventWrites };
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Beklenen eşzamanlı kontrol başlamadı.');
}

test('her kanalın kontrol tamamlanma zamanı kaydedilir', async () => {
  const channels = [channel('one'), channel('two')];
  const { monitor, monitorUpdates } = loadMonitor({
    channels,
    fetchLatestUploads: async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return [];
    }
  });

  const result = await monitor.reconcileChannels();

  assert.equal(result.checkedChannels, 2);
  assert.equal(monitorUpdates.length, 2);
  assert.ok(monitorUpdates.every(update => update.fields['monitor.lastCheckedAt'] instanceof Date));
});

test('video yaşı API isteğinin başlangıcına değil tamamlanma zamanına göre belirlenir', async () => {
  const RealDate = Date;
  const requestStartedAt = new RealDate('2025-01-01T09:00:00Z');
  const requestCompletedAt = new RealDate('2025-01-01T09:06:00Z');
  const dates = [requestStartedAt, requestCompletedAt];
  global.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [dates.shift() || requestCompletedAt]));
    }
    static now() { return requestCompletedAt.getTime(); }
  };

  try {
    const channels = [channel('age-check')];
    const { monitor, eventWrites } = loadMonitor({
      channels,
      fetchLatestUploads: async () => [{
        videoId: 'stale-after-request',
        title: 'Video',
        publishedAt: new RealDate('2025-01-01T08:59:00Z')
      }]
    });

    const result = await monitor.reconcileChannels();

    assert.equal(result.inserted, 0);
    assert.equal(result.cancelled, 1);
    assert.equal(eventWrites[0][1].$setOnInsert.status, 'cancelled');
    assert.equal(eventWrites[0][1].$setOnInsert.receivedAt.getTime(), requestCompletedAt.getTime());
  } finally {
    global.Date = RealDate;
  }
});

test('kontrol sırasında kanal yapılandırması değişirse eski sonuca göre olay yazılmaz', async () => {
  const channels = [channel('changed')];
  const { monitor, eventWrites } = loadMonitor({
    channels,
    fetchLatestUploads: async () => [{
      videoId: 'old-configuration',
      title: 'Video',
      publishedAt: new Date()
    }],
    saveResult: async () => ({ matched: false, settings: { channels } })
  });

  const result = await monitor.reconcileChannels();

  assert.equal(result.inserted, 0);
  assert.equal(result.cancelled, 0);
  assert.equal(eventWrites.length, 0);
});

test('önceki istek bitmemiş olsa da sonraki 15 saniyelik slot başlatılır', async () => {
  const releases = [];
  let requestCount = 0;
  const { monitor } = loadMonitor({
    channels: [channel('fixed-slots')],
    fetchLatestUploads: async () => {
      requestCount += 1;
      return new Promise(resolve => releases.push(() => resolve([])));
    }
  });

  const first = monitor.reconcileChannels({ scheduledAt: new Date('2025-01-01T09:00:15Z') });
  await waitUntil(() => requestCount === 1);
  const second = monitor.reconcileChannels({ scheduledAt: new Date('2025-01-01T09:00:30Z') });
  await waitUntil(() => requestCount === 2);

  assert.equal(requestCount, 2);
  releases.forEach(resolve => resolve());
  await Promise.all([first, second]);
});

test('eşzamanlı kontroller aynı videoyu yalnızca bir kez kuyruğa ekler', async () => {
  let insertAttempt = 0;
  const publishedAt = new Date(Date.now() - 1000);
  const { monitor, eventWrites } = loadMonitor({
    channels: [channel('deduplicated')],
    fetchLatestUploads: async () => [{ videoId: 'same-video', title: 'Video', publishedAt }],
    writeEvent: async () => {
      insertAttempt += 1;
      if (insertAttempt === 1) return { upsertedCount: 1 };
      const error = new Error('duplicate key');
      error.code = 11000;
      throw error;
    }
  });

  const results = await Promise.all([
    monitor.reconcileChannels({ scheduledAt: new Date('2025-01-01T09:00:15Z') }),
    monitor.reconcileChannels({ scheduledAt: new Date('2025-01-01T09:00:30Z') })
  ]);

  assert.equal(eventWrites.length, 2);
  assert.equal(results.reduce((sum, result) => sum + result.inserted, 0), 1);
});
