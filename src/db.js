const { MongoClient } = require('mongodb');
const { randomUUID } = require('crypto');
const { getConfigKey } = require('./config');

let client;
let database;

function defaultSettings(configKey) {
  return {
    automationId: randomUUID(),
    configKey,
    channels: []
  };
}

function legacyChannel(settings) {
  if (!settings?.youtubeChannelId) return null;
  return {
    id: settings.youtubeChannelId,
    title: settings.youtubeChannelTitle || settings.youtubeChannelId,
    thumbnail: settings.youtubeChannelThumbnail || null,
    input: settings.youtubeInput || settings.youtubeChannelId,
    targetGroupId: settings.targetGroupId || null,
    targetGroupName: settings.targetGroupName || null,
    deliveryType: settings.deliveryType === 'message' ? 'message' : 'poll',
    enabled: true,
    monitor: {
      startedAt: settings.monitor?.startedAt || new Date(),
      lastCheckedAt: settings.monitor?.lastCheckedAt || null,
      lastCheckedCount: settings.monitor?.lastCheckedCount || 0,
      lastError: settings.monitor?.lastError || null,
      schedules: [{ ...(settings.monitor?.schedule || { startHour: 0, startMinute: 0, endHour: 23, endMinute: 59 }), intervalSeconds: 60 }]
    }
  };
}

async function connectDatabase() {
  const uri = process.env.MONGO_URI?.trim();
  const dbName = process.env.DB_NAME?.trim();
  if (!uri || !dbName) throw new Error('MONGO_URI ve DB_NAME zorunludur.');

  client = new MongoClient(uri);
  await client.connect();
  database = client.db(dbName);
  const configKey = getConfigKey();

  const oldIndex = await database.collection('video_events').indexExists('unique_channel_video');
  if (oldIndex) await database.collection('video_events').dropIndex('unique_channel_video');
  const singleAutomationIndex = await database.collection('video_events').indexExists('unique_config_channel_video');
  if (singleAutomationIndex) await database.collection('video_events').dropIndex('unique_config_channel_video');

  // Önceki tek-kullanıcılı sürümün kayıtlarını ilk çalıştırmada bu bota bağla.
  const settings = database.collection('app_settings');
  if (!(await settings.findOne({ _id: configKey }))) {
    const legacySettings = await settings.findOne({ _id: 'main' });
    if (legacySettings) {
      const { _id, ...fields } = legacySettings;
      await settings.insertOne({ _id: configKey, ...fields, configKey, updatedAt: new Date() });
      await settings.deleteOne({ _id: 'main' });
    }
  }
  await database.collection('video_events').updateMany(
    { configKey: { $exists: false } },
    { $set: { configKey } }
  );

  await Promise.all([
    database.collection('video_events').createIndex(
      { configKey: 1, automationId: 1, videoId: 1 },
      { unique: true, name: 'unique_config_automation_video' }
    ),
    database.collection('video_events').createIndex({ status: 1, nextAttemptAt: 1 }),
    database.collection('app_settings').createIndex({ updatedAt: 1 }),
    database.collection('auth_sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    database.collection('auth_sessions').createIndex({ tokenHash: 1 }, { unique: true })
  ]);

  await database.collection('app_settings').updateOne(
    { _id: configKey },
    {
      $setOnInsert: {
        ...defaultSettings(configKey),
        createdAt: new Date()
      },
      $set: { updatedAt: new Date() }
    },
    { upsert: true }
  );
  const current = await settings.findOne({ _id: configKey });
  if (!Array.isArray(current?.channels)) {
    const migrated = legacyChannel(current);
    await settings.updateOne({ _id: configKey }, { $set: { channels: migrated ? [migrated] : [], updatedAt: new Date() } });
  } else if (current.channels.some(channel => !channel.automationId || !Array.isArray(channel.monitor?.schedules) || !channel.monitor?.acceptVideosAfter)) {
    const channels = current.channels.map(channel => {
      const monitor = channel.monitor || {};
      const source = Array.isArray(monitor.schedules) && monitor.schedules.length ? monitor.schedules : [monitor.schedule || { startHour: 0, startMinute: 0, endHour: 23, endMinute: 59 }];
      const schedules = source.map(item => ({
        intervalSeconds: [15, 60].includes(Number(item.intervalSeconds)) ? Number(item.intervalSeconds) : 60,
        startHour: Number(item.startHour ?? 0),
        startMinute: Number(item.startMinute ?? 0),
        endHour: Number(item.endHour ?? 23),
        endMinute: Number(item.endMinute ?? 59)
      }));
      const { schedule: legacySchedule, ...monitorFields } = monitor;
      return {
        ...channel,
        automationId: channel.automationId || randomUUID(),
        monitor: { ...monitorFields, schedules, acceptVideosAfter: monitor.acceptVideosAfter || monitor.lastCheckedAt || monitor.startedAt || new Date() }
      };
    });
    await settings.updateOne({ _id: configKey }, { $set: { channels, updatedAt: new Date() } });
  }
  console.log(`MongoDB bağlantısı hazır: ${dbName}`);
  return database;
}

function db() {
  if (!database) throw new Error('Veritabanı henüz hazır değil.');
  return database;
}

async function getSettings() {
  return db().collection('app_settings').findOne({ _id: getConfigKey() });
}

async function updateSettings(update) {
  await db().collection('app_settings').updateOne(
    { _id: getConfigKey() },
    { $set: { ...update, updatedAt: new Date() } },
    { upsert: true }
  );
  return getSettings();
}

async function appendChannel(channel) {
  const result = await db().collection('app_settings').updateOne(
    { _id: getConfigKey() },
    { $push: { channels: channel }, $set: { updatedAt: new Date() } }
  );
  if (!result.matchedCount) throw new Error('Uygulama ayarları bulunamadı.');
  return getSettings();
}

async function updateChannelFields(automationId, fields, { unset = {}, expected = {} } = {}) {
  const channelMatch = { automationId, ...expected };
  const $set = { updatedAt: new Date() };
  const $unset = {};
  for (const [path, value] of Object.entries(fields)) $set[`channels.$.${path}`] = value;
  for (const path of Object.keys(unset)) $unset[`channels.$.${path}`] = '';
  const update = { $set };
  if (Object.keys($unset).length) update.$unset = $unset;
  const result = await db().collection('app_settings').updateOne(
    { _id: getConfigKey(), channels: { $elemMatch: channelMatch } },
    update
  );
  return { matched: result.matchedCount > 0, settings: await getSettings() };
}

async function removeChannel(automationId) {
  const result = await db().collection('app_settings').updateOne(
    { _id: getConfigKey(), 'channels.automationId': automationId },
    { $pull: { channels: { automationId } }, $set: { updatedAt: new Date() } }
  );
  return { removed: result.modifiedCount > 0, settings: await getSettings() };
}

async function resetSettings() {
  const now = new Date();
  const configKey = getConfigKey();
  await db().collection('app_settings').replaceOne(
    { _id: configKey },
    { _id: configKey, ...defaultSettings(configKey), createdAt: now, updatedAt: now },
    { upsert: true }
  );
  return getSettings();
}

async function closeDatabase() {
  if (client) await client.close();
}

module.exports = { connectDatabase, closeDatabase, db, getSettings, updateSettings, appendChannel, updateChannelFields, removeChannel, resetSettings };
