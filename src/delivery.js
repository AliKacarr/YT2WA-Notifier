const { db, getSettings } = require('./db');
const whatsapp = require('./whatsapp');
const { getConfigKey } = require('./config');
const { channelSchedules, isWithinAnySchedule } = require('./youtube-monitor');

let running = false;
let paused = false;
let timer;
const idleWaiters = new Set();

async function recoverInterrupted() {
  await db().collection('video_events').updateMany(
    { configKey: getConfigKey(), status: 'sending', processingStartedAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) } },
    { $set: { status: 'pending', nextAttemptAt: new Date() }, $unset: { processingStartedAt: '' } }
  );
}

async function processNext() {
  if (running || paused) return;
  running = true;
  try {
    const event = await db().collection('video_events').findOneAndUpdate(
      { configKey: getConfigKey(), status: { $in: ['pending', 'failed'] }, nextAttemptAt: { $lte: new Date() } },
      { $set: { status: 'sending', processingStartedAt: new Date() } },
      { sort: { receivedAt: 1 }, returnDocument: 'after' }
    );
    if (!event) return;
    try {
      const settings = await getSettings();
      const channel = event.automationId
        ? settings?.channels?.find(item => item.automationId === event.automationId)
        : settings?.channels?.find(item => item.id === event.channelId);
      if ((event.automationId && !channel) || channel?.enabled === false) {
        await db().collection('video_events').updateOne(
          { _id: event._id },
          { $set: { status: 'cancelled', reason: channel ? 'channel-disabled' : 'channel-missing', cancelledAt: new Date() }, $unset: { nextAttemptAt: '', processingStartedAt: '', lastError: '' } }
        );
        return;
      }
      if (channel) {
        const publishedAt = new Date(event.publishedAt);
        const startedAt = new Date(channel.monitor?.startedAt);
        const validPublishedAt = Number.isFinite(publishedAt.getTime());
        const publishedAfterStart = !Number.isFinite(startedAt.getTime()) || publishedAt >= startedAt;
        if (!validPublishedAt || !publishedAfterStart || !isWithinAnySchedule(channelSchedules(channel), publishedAt)) {
          await db().collection('video_events').updateOne(
            { _id: event._id },
            { $set: { status: 'cancelled', reason: 'outside-publishing-window', cancelledAt: new Date() }, $unset: { nextAttemptAt: '', processingStartedAt: '', lastError: '' } }
          );
          return;
        }
      }
      const targetGroupId = event.targetGroupId || channel?.targetGroupId || settings?.targetGroupId;
      if (!targetGroupId) throw new Error('Hedef WhatsApp grubu seçilmedi.');
      const deliveryType = (event.deliveryType || channel?.deliveryType || settings?.deliveryType) === 'message' ? 'message' : 'poll';
      const sent = deliveryType === 'message'
        ? await whatsapp.sendVideoMessage({ groupId: targetGroupId, title: event.title, videoUrl: event.videoUrl })
        : await whatsapp.sendVideoPoll({ groupId: targetGroupId, videoUrl: event.videoUrl });
      await db().collection('video_events').updateOne(
        { _id: event._id },
        { $set: { status: 'sent', sentAt: new Date(), targetGroupId: sent.groupId, messageId: sent.messageId, deliveryType }, $unset: { lastError: '', nextAttemptAt: '', processingStartedAt: '' } }
      );
    } catch (error) {
      const attemptCount = (event.attemptCount || 0) + 1;
      const delays = [1, 5, 20, 60, 180];
      const delayMinutes = delays[Math.min(attemptCount - 1, delays.length - 1)];
      await db().collection('video_events').updateOne(
        { _id: event._id },
        { $set: { status: 'failed', attemptCount, lastError: error.message, nextAttemptAt: new Date(Date.now() + delayMinutes * 60000) }, $unset: { processingStartedAt: '' } }
      );
    }
  } finally {
    running = false;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }
}

function pause() {
  paused = true;
}

function resume() {
  paused = false;
}

async function waitForIdle() {
  if (!running) return;
  await new Promise(resolve => idleWaiters.add(resolve));
}

async function cancelOutstanding(reason = 'settings-reset', automationId = null) {
  await waitForIdle();
  const filter = { configKey: getConfigKey(), status: { $in: ['pending', 'failed', 'sending'] } };
  if (automationId) filter.automationId = automationId;
  return db().collection('video_events').updateMany(
    filter,
    {
      $set: { status: 'cancelled', reason, cancelledAt: new Date() },
      $unset: { nextAttemptAt: '', processingStartedAt: '', lastError: '' }
    }
  );
}

async function start() {
  await recoverInterrupted();
  timer = setInterval(() => processNext().catch(error => console.error('Teslimat worker hatası:', error)), 15000);
  timer.unref?.();
  processNext().catch(error => console.error('Teslimat worker başlangıç hatası:', error));
}

function kick() {
  setImmediate(() => processNext().catch(error => console.error('Teslimat worker hatası:', error)));
}

module.exports = { start, kick, processNext, pause, resume, cancelOutstanding };
