const { db, getSettings, appendChannel, updateChannelFields } = require('./db');
const { fetchLatestUploads } = require('./youtube');
const { getConfigKey } = require('./config');
const { randomUUID } = require('crypto');

const DEFAULT_SCHEDULE = Object.freeze({ intervalSeconds: 60, startHour: 0, startMinute: 0, endHour: 23, endMinute: 59 });
const ALLOWED_INTERVAL_SECONDS = new Set([15, 60]);
const MAX_SCHEDULES = 20;
const MAX_VIDEO_AGE_MS = 5 * 60 * 1000;
const DAILY_QUOTA_LIMIT = Number(process.env.YOUTUBE_DAILY_QUOTA_LIMIT) || 1000;
let paused = false;
let activeRuns = 0;
const idleWaiters = new Set();

function normalizeSchedule(schedule = {}) {
  const intervalSeconds = Number(schedule.intervalSeconds ?? DEFAULT_SCHEDULE.intervalSeconds);
  const startHour = Number(schedule.startHour ?? DEFAULT_SCHEDULE.startHour);
  const startMinute = Number(schedule.startMinute ?? DEFAULT_SCHEDULE.startMinute);
  const endHour = Number(schedule.endHour ?? DEFAULT_SCHEDULE.endHour);
  const endMinute = Number(schedule.endMinute ?? DEFAULT_SCHEDULE.endMinute);
  if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23 || !Number.isInteger(endHour) || endHour < 0 || endHour > 23) throw new Error('Kontrol saatleri 00 ile 23 arasında olmalıdır.');
  if (!Number.isInteger(startMinute) || startMinute < 0 || startMinute > 59 || !Number.isInteger(endMinute) || endMinute < 0 || endMinute > 59) throw new Error('Kontrol dakikaları 00 ile 59 arasında olmalıdır.');
  if (!ALLOWED_INTERVAL_SECONDS.has(intervalSeconds)) throw new Error('Kontrol sıklığı 15 saniye veya 1 dakika olmalıdır.');
  return { intervalSeconds, startHour, startMinute, endHour, endMinute };
}

function normalizeSchedules(schedules) {
  const source = Array.isArray(schedules) ? schedules : [schedules || DEFAULT_SCHEDULE];
  if (!source.length) throw new Error('En az bir kontrol zaman aralığı gereklidir.');
  if (source.length > MAX_SCHEDULES) throw new Error(`En fazla ${MAX_SCHEDULES} kontrol zaman aralığı eklenebilir.`);
  return source.map(normalizeSchedule);
}

function channelSchedules(channel) {
  return normalizeSchedules(channel?.monitor?.schedules || channel?.monitor?.schedule || DEFAULT_SCHEDULE);
}

function getIstanbulSecondOfDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const value = type => Number(parts.find(part => part.type === type)?.value);
  return value('hour') * 3600 + value('minute') * 60 + value('second');
}

function isWithinHours(schedule, now = new Date()) {
  const { startHour, startMinute, endHour, endMinute } = normalizeSchedule(schedule);
  const current = getIstanbulSecondOfDay(now);
  const start = (startHour * 60 + startMinute) * 60;
  const end = (endHour * 60 + endMinute) * 60;
  return start <= end ? current >= start && current <= end : current >= start || current <= end;
}

function isWithinAnySchedule(schedules, now = new Date()) {
  return normalizeSchedules(schedules).some(schedule => isWithinHours(schedule, now));
}

function activeIntervalSeconds(schedules, now = new Date()) {
  const active = normalizeSchedules(schedules).filter(schedule => isWithinHours(schedule, now));
  return active.length ? Math.min(...active.map(schedule => schedule.intervalSeconds)) : null;
}

function isDue(scheduleOrSeconds, lastCheckedAt, now = new Date()) {
  const intervalSeconds = typeof scheduleOrSeconds === 'number' ? scheduleOrSeconds : normalizeSchedule(scheduleOrSeconds).intervalSeconds;
  return !lastCheckedAt || now.getTime() - new Date(lastCheckedAt).getTime() >= intervalSeconds * 1000;
}

function scheduleMinutes(schedule) {
  const { startHour, startMinute, endHour, endMinute } = normalizeSchedule({ ...schedule, intervalSeconds: 60 });
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  return (end >= start ? end - start : 1440 - start + end) + 1;
}

function dailyRequestCount(schedules) {
  const normalized = normalizeSchedules(schedules);
  let count = 0;
  let lastCheckSecond = null;
  for (let second = 0; second < 86400; second += 15) {
    const active = normalized.filter(schedule => {
      const start = (schedule.startHour * 60 + schedule.startMinute) * 60;
      const end = (schedule.endHour * 60 + schedule.endMinute) * 60;
      return start <= end ? second >= start && second <= end : second >= start || second <= end;
    });
    if (!active.length) continue;
    const interval = Math.min(...active.map(schedule => schedule.intervalSeconds));
    if (lastCheckSecond === null || second - lastCheckSecond >= interval) {
      count += 1;
      lastCheckSecond = second;
    }
  }
  return count;
}

function quotaSummary(channels = []) {
  const items = channels.map(channel => ({
    automationId: channel.automationId,
    channelId: channel.id,
    title: channel.title,
    requests: channel.enabled === false ? 0 : dailyRequestCount(channelSchedules(channel))
  }));
  const estimatedRequests = items.reduce((sum, item) => sum + item.requests, 0);
  return { estimatedRequests, limit: DAILY_QUOTA_LIMIT, remaining: DAILY_QUOTA_LIMIT - estimatedRequests, exceeded: estimatedRequests > DAILY_QUOTA_LIMIT, items };
}

async function storeEntries(entries, channel, status, now) {
  const configKey = getConfigKey();
  let inserted = 0;
  for (const entry of entries) {
    let result;
    try {
      result = await db().collection('video_events').updateOne(
        { configKey, automationId: channel.automationId, videoId: entry.videoId },
        {
          $setOnInsert: {
          ...entry,
          automationId: channel.automationId,
          channelTitle: channel.title,
          targetGroupId: channel.targetGroupId,
          targetGroupName: channel.targetGroupName,
          deliveryType: channel.deliveryType === 'message' ? 'message' : 'poll',
          configKey,
          videoUrl: `https://www.youtube.com/watch?v=${entry.videoId}`,
          status,
          attemptCount: 0,
          receivedAt: now,
          ...(status === 'pending' ? { nextAttemptAt: now } : { reason: 'older-than-5-minutes', cancelledAt: now })
          }
        },
        { upsert: true }
      );
    } catch (error) {
      if (error?.code === 11000) continue;
      throw error;
    }
    if (result.upsertedCount) inserted += 1;
  }
  return inserted;
}

function classifyEntries(entries, channel, schedules, now = new Date()) {
  const startedAt = new Date(channel.monitor?.startedAt || now);
  const acceptVideosAfter = new Date(channel.monitor?.acceptVideosAfter || startedAt);
  const cutoff = acceptVideosAfter > startedAt ? acceptVideosAfter : startedAt;
  const pending = [];
  const cancelled = [];
  for (const entry of entries) {
    const publishedAt = new Date(entry.publishedAt);
    if (!Number.isFinite(publishedAt.getTime()) || publishedAt <= cutoff || publishedAt > now || !isWithinAnySchedule(schedules, publishedAt)) continue;
    (now.getTime() - publishedAt.getTime() > MAX_VIDEO_AGE_MS ? cancelled : pending).push(entry);
  }
  return { pending, cancelled };
}

function eligibleEntries(entries, channel, schedules, now = new Date()) {
  return classifyEntries(entries, channel, schedules, now).pending;
}

async function addChannel(channel, options) {
  const startedAt = new Date();
  const item = { ...channel, automationId: randomUUID(), targetGroupId: options.targetGroupId, targetGroupName: options.targetGroupName, deliveryType: options.deliveryType, enabled: true, monitor: { startedAt, acceptVideosAfter: startedAt, lastError: null, schedules: normalizeSchedules(options.schedules || options.schedule) } };
  const settings = await appendChannel(item);
  const quota = quotaSummary(settings?.channels || []);
  return { channel: item, quota };
}

async function saveMonitorResult(channel, fields) {
  const expectedCutoff = channel.monitor?.acceptVideosAfter;
  const expected = {
    enabled: { $ne: false },
    ...(expectedCutoff ? { 'monitor.acceptVideosAfter': expectedCutoff } : {})
  };
  return updateChannelFields(channel.automationId, fields, {
    expected,
    unset: { 'monitor.schedule': '' }
  });
}

async function reconcileChannels() {
  if (paused) return { skipped: 'paused' };
  if (activeRuns > 0) return { skipped: 'running' };
  activeRuns += 1;
  try {
    const settings = await getSettings();
    const channels = settings?.channels || [];
    let inserted = 0;
    let cancelled = 0;
    let checkedChannels = 0;
    for (const channel of channels) {
      const checkStartedAt = new Date();
      const schedules = channelSchedules(channel);
      const intervalSeconds = activeIntervalSeconds(schedules, checkStartedAt);
      if (channel.enabled === false || !channel.targetGroupId || !intervalSeconds || !isDue(intervalSeconds, channel.monitor?.lastCheckedAt, checkStartedAt)) continue;
      checkedChannels += 1;
      try {
        const entries = await fetchLatestUploads(channel.id);
        const checkedAt = new Date();
        const classified = classifyEntries(entries, channel, schedules, checkedAt);
        const monitorUpdate = await saveMonitorResult(channel, {
          'monitor.lastCheckedAt': checkedAt,
          'monitor.lastCheckedCount': entries.length,
          'monitor.lastEligibleCount': classified.pending.length,
          'monitor.lastCancelledCount': classified.cancelled.length,
          'monitor.lastError': null
        });
        // Kanal silinmiş veya kontrol sırasında zaman planı değiştirilmişse eski
        // yapılandırmaya göre bulunan sonuçları kuyruğa ekleme.
        if (!monitorUpdate.matched) continue;
        const currentChannel = monitorUpdate.settings?.channels?.find(item => item.automationId === channel.automationId);
        if (!currentChannel || currentChannel.enabled === false) continue;
        inserted += await storeEntries(classified.pending, currentChannel, 'pending', checkedAt);
        cancelled += await storeEntries(classified.cancelled, currentChannel, 'cancelled', checkedAt);
      } catch (error) {
        const checkedAt = new Date();
        await saveMonitorResult(channel, {
          'monitor.lastCheckedAt': checkedAt,
          'monitor.lastError': error.message
        });
      }
    }
    return { checkedChannels, inserted, cancelled, source: 'youtube-data-api' };
  } finally {
    activeRuns -= 1;
    if (activeRuns === 0) {
      for (const resolve of idleWaiters) resolve();
      idleWaiters.clear();
    }
  }
}

function pause() {
  paused = true;
}

function resume() {
  paused = false;
}

async function waitForIdle() {
  if (activeRuns === 0) return;
  await new Promise(resolve => idleWaiters.add(resolve));
}

module.exports = { addChannel, reconcileChannels, normalizeSchedule, normalizeSchedules, channelSchedules, isWithinHours, isWithinAnySchedule, activeIntervalSeconds, isDue, scheduleMinutes, dailyRequestCount, quotaSummary, classifyEntries, eligibleEntries, pause, resume, waitForIdle };
