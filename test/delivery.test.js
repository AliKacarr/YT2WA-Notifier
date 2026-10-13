const test = require('node:test');
const assert = require('node:assert/strict');

process.env.CONFIG_KEY ||= 'test';

function loadDelivery({ settings, event = null, whatsappStatus = 'READY', sendError = null }) {
  const dbPath = require.resolve('../src/db');
  const whatsappPath = require.resolve('../src/whatsapp');
  const deliveryPath = require.resolve('../src/delivery');
  const updateOneCalls = [];
  const updateManyCalls = [];
  const sendCalls = [];
  const findOneAndUpdateCalls = [];
  let nextEvent = event;
  const collection = {
    findOneAndUpdate: async (...args) => {
      findOneAndUpdateCalls.push(args);
      const result = nextEvent;
      nextEvent = null;
      return result;
    },
    updateOne: async (...args) => { updateOneCalls.push(args); return { matchedCount: 1 }; },
    updateMany: async (...args) => { updateManyCalls.push(args); }
  };

  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { db: () => ({ collection: () => collection }), getSettings: async () => settings }
  };
  require.cache[whatsappPath] = {
    id: whatsappPath,
    filename: whatsappPath,
    loaded: true,
    exports: {
      getState: () => ({ status: whatsappStatus }),
      sendVideoPoll: async payload => { sendCalls.push(payload); if (sendError) throw sendError; return { groupId: settings?.targetGroupId, messageId: 'message-1' }; },
      sendVideoMessage: async payload => { sendCalls.push(payload); if (sendError) throw sendError; return { groupId: settings?.targetGroupId, messageId: 'message-1' }; }
    }
  };
  delete require.cache[deliveryPath];

  return { delivery: require(deliveryPath), updateOneCalls, updateManyCalls, sendCalls, findOneAndUpdateCalls };
}

test('hedef grup yoksa olay otomatik tekrar olmadan failed yapılır', async () => {
  const { delivery, updateOneCalls } = loadDelivery({
    settings: { targetGroupId: null },
    event: { _id: 'event-1', attemptCount: 0, videoUrl: 'https://youtube.com/watch?v=test' }
  });

  await delivery.processNext();

  assert.equal(updateOneCalls.length, 1);
  assert.equal(updateOneCalls[0][1].$set.status, 'failed');
  assert.match(updateOneCalls[0][1].$set.lastError, /Hedef WhatsApp grubu/);
  assert.equal(updateOneCalls[0][1].$unset.processingStartedAt, '');
  assert.equal(updateOneCalls[0][1].$unset.nextAttemptAt, '');
});

test('ayarlar sıfırlanırken bekleyen teslimatlar silinmeden iptal edilir', async () => {
  const { delivery, updateManyCalls } = loadDelivery({ settings: {} });

  await delivery.cancelOutstanding();

  assert.equal(updateManyCalls.length, 1);
  assert.deepEqual(updateManyCalls[0][0].status.$in, ['pending', 'failed', 'sending']);
  assert.equal(updateManyCalls[0][1].$set.status, 'cancelled');
  assert.equal(updateManyCalls[0][1].$set.reason, 'settings-reset');
});

test('kanala özel iptal yalnızca ilgili otomasyonun kuyruğunu hedefler', async () => {
  const { delivery, updateManyCalls } = loadDelivery({ settings: {} });

  await delivery.cancelOutstanding('channel-deleted', 'automation-1');

  assert.equal(updateManyCalls[0][0].automationId, 'automation-1');
  assert.equal(updateManyCalls[0][1].$set.reason, 'channel-deleted');
});

test('silinmiş kanalın bekleyen videosu gönderilmeden iptal edilir', async () => {
  const { delivery, updateOneCalls, sendCalls } = loadDelivery({
    settings: { channels: [] },
    event: {
      _id: 'event-deleted-channel',
      automationId: 'automation-1',
      targetGroupId: 'group@g.us',
      videoUrl: 'https://youtube.com/watch?v=deleted'
    }
  });

  await delivery.processNext();

  assert.equal(sendCalls.length, 0);
  assert.equal(updateOneCalls[0][1].$set.status, 'cancelled');
  assert.equal(updateOneCalls[0][1].$set.reason, 'channel-missing');
});

test('devre dışı kanalın bekleyen videosu gönderilmeden iptal edilir', async () => {
  const { delivery, updateOneCalls, sendCalls } = loadDelivery({
    settings: { channels: [{ automationId: 'automation-1', enabled: false, targetGroupId: 'group@g.us' }] },
    event: {
      _id: 'event-disabled-channel',
      automationId: 'automation-1',
      targetGroupId: 'group@g.us',
      videoUrl: 'https://youtube.com/watch?v=disabled'
    }
  });

  await delivery.processNext();

  assert.equal(sendCalls.length, 0);
  assert.equal(updateOneCalls[0][1].$set.status, 'cancelled');
  assert.equal(updateOneCalls[0][1].$set.reason, 'channel-disabled');
});

test('çalışma saati dışında yayımlanan bekleyen video gönderilmeden iptal edilir', async () => {
  const { delivery, updateOneCalls } = loadDelivery({
    settings: {
      channels: [{
        automationId: 'automation-1',
        targetGroupId: 'group@g.us',
        monitor: {
          startedAt: new Date('2025-01-01T05:00:00Z'),
          schedule: { startHour: 8, startMinute: 0, endHour: 20, endMinute: 0 }
        }
      }]
    },
    event: {
      _id: 'event-outside-hours',
      automationId: 'automation-1',
      publishedAt: new Date('2025-01-01T21:00:00Z'),
      videoUrl: 'https://youtube.com/watch?v=outside'
    }
  });

  await delivery.processNext();

  assert.equal(updateOneCalls.length, 1);
  assert.equal(updateOneCalls[0][1].$set.status, 'cancelled');
  assert.equal(updateOneCalls[0][1].$set.reason, 'outside-publishing-window');
});

test('eşzamanlı worker tetikleri aynı videoyu yalnızca bir kez gönderir', async () => {
  const publishedAt = new Date('2025-01-01T09:00:00Z');
  const { delivery, sendCalls } = loadDelivery({
    settings: {
      channels: [{
        automationId: 'automation-1',
        targetGroupId: 'group@g.us',
        deliveryType: 'message',
        monitor: {
          startedAt: new Date('2025-01-01T08:00:00Z'),
          schedules: [{ intervalSeconds: 15, startHour: 0, startMinute: 0, endHour: 23, endMinute: 59 }]
        }
      }]
    },
    event: {
      _id: 'event-1',
      automationId: 'automation-1',
      publishedAt,
      title: 'Yeni video',
      videoUrl: 'https://youtube.com/watch?v=once',
      targetGroupId: 'group@g.us',
      deliveryType: 'message'
    }
  });

  await Promise.all([delivery.processNext(), delivery.processNext(), delivery.processNext()]);

  assert.equal(sendCalls.length, 1);
  assert.match(sendCalls[0].messageId, /^3EB0[A-F0-9]{18}$/);
});

test('aynı kuyruk olayı için kararlı WhatsApp mesaj kimliği üretilir', () => {
  const { delivery } = loadDelivery({ settings: {} });
  const event = { _id: 'stable-event-id' };

  assert.equal(
    delivery.deliveryMessageId(event, 'group@g.us', 'message'),
    delivery.deliveryMessageId(event, 'group@g.us', 'message')
  );
  assert.notEqual(
    delivery.deliveryMessageId(event, 'group@g.us', 'message'),
    delivery.deliveryMessageId({ _id: 'another-event-id' }, 'group@g.us', 'message')
  );
});

test('WhatsApp hazır değilken olay gönderilmeden pending durumuna bırakılır', async () => {
  const publishedAt = new Date('2025-01-01T09:00:00Z');
  const settings = {
    channels: [{
      automationId: 'automation-1',
      targetGroupId: 'group@g.us',
      deliveryType: 'message',
      monitor: {
        startedAt: new Date('2025-01-01T08:00:00Z'),
        schedules: [{ intervalSeconds: 15, startHour: 0, startMinute: 0, endHour: 23, endMinute: 59 }]
      }
    }]
  };
  const { delivery, updateOneCalls, sendCalls } = loadDelivery({
    settings,
    whatsappStatus: 'DISCONNECTED',
    event: {
      _id: 'waiting-event', automationId: 'automation-1', publishedAt,
      videoUrl: 'https://youtube.com/watch?v=waiting', targetGroupId: 'group@g.us'
    }
  });

  await delivery.processNext();

  assert.equal(sendCalls.length, 0);
  assert.equal(updateOneCalls[0][1].$set.status, 'pending');
  assert.ok(updateOneCalls[0][1].$set.nextAttemptAt instanceof Date);
});

test('başlayan gönderim hata verirse terminal failed olur ve tekrar seçilmez', async () => {
  const publishedAt = new Date('2025-01-01T09:00:00Z');
  const settings = {
    channels: [{
      automationId: 'automation-1', targetGroupId: 'group@g.us', deliveryType: 'message',
      monitor: {
        startedAt: new Date('2025-01-01T08:00:00Z'),
        schedules: [{ intervalSeconds: 15, startHour: 0, startMinute: 0, endHour: 23, endMinute: 59 }]
      }
    }]
  };
  const { delivery, updateOneCalls, sendCalls, findOneAndUpdateCalls } = loadDelivery({
    settings,
    sendError: new Error('ACK alınamadı'),
    event: {
      _id: 'uncertain-event', automationId: 'automation-1', publishedAt,
      videoUrl: 'https://youtube.com/watch?v=uncertain', targetGroupId: 'group@g.us'
    }
  });

  await delivery.processNext();

  assert.equal(sendCalls.length, 1);
  assert.equal(findOneAndUpdateCalls[0][0].status, 'pending');
  assert.equal(updateOneCalls.at(-1)[1].$set.status, 'failed');
  assert.equal(updateOneCalls.at(-1)[1].$unset.nextAttemptAt, '');
});

test('yarım kalan sending olayı başlangıçta tekrar gönderilmeden failed yapılır', async () => {
  const { delivery, updateManyCalls } = loadDelivery({ settings: {} });

  await delivery.recoverInterrupted();

  assert.equal(updateManyCalls[0][0].status, 'sending');
  assert.equal(updateManyCalls[0][0].processingStartedAt, undefined);
  assert.equal(updateManyCalls[0][1].$set.status, 'failed');
  assert.equal(updateManyCalls[0][1].$unset.nextAttemptAt, '');
});
