const pino = require('pino');
const QRCode = require('qrcode');
const { db } = require('./db');
const { getConfigKey } = require('./config');

let makeWASocket;
let initAuthCreds;
let BufferJSON;
let DisconnectReason;
let fetchLatestWaWebVersion;
let Browsers;
let proto;
let socket;
let starting;
let reconnectTimer;

const state = {
  status: 'DISCONNECTED',
  qrDataUrl: null,
  userInfo: null,
  lastError: null,
  connectedAt: null
};

async function loadBaileys() {
  if (makeWASocket) return;
  const baileys = await import('@whiskeysockets/baileys');
  makeWASocket = baileys.default || baileys.makeWASocket;
  initAuthCreds = baileys.initAuthCreds;
  BufferJSON = baileys.BufferJSON;
  DisconnectReason = baileys.DisconnectReason;
  fetchLatestWaWebVersion = baileys.fetchLatestWaWebVersion;
  Browsers = baileys.Browsers;
  proto = baileys.proto;
}

function authCollectionName() {
  return `baileys_auth_${getConfigKey()}`;
}

async function migrateLegacyAuthIfNeeded() {
  const sourceName = process.env.AUTH_COLLECTION?.trim();
  const targetName = authCollectionName();
  if (!sourceName || sourceName === targetName) return;
  const target = db().collection(targetName);
  if (await target.findOne({ _id: 'creds' })) return;
  const documents = await db().collection(sourceName).find({}).toArray();
  if (documents.length) {
    await target.insertMany(documents, { ordered: false });
    console.log(`WhatsApp oturumu ${targetName} koleksiyonuna taşındı.`);
  }
}

async function useMongoAuthState() {
  const collection = db().collection(authCollectionName());
  const write = async (value, id) => {
    const serialized = JSON.stringify(value, BufferJSON.replacer);
    await collection.updateOne({ _id: id }, { $set: { value: serialized, updatedAt: new Date() } }, { upsert: true });
  };
  const read = async id => {
    const document = await collection.findOne({ _id: id });
    return document?.value ? JSON.parse(document.value, BufferJSON.reviver) : null;
  };
  const remove = id => collection.deleteOne({ _id: id });

  let creds = await read('creds');
  if (!creds) creds = initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const result = {};
          await Promise.all(ids.map(async id => {
            let value = await read(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            result[id] = value;
          }));
          return result;
        },
        set: async data => {
          const operations = [];
          for (const [type, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries)) {
              operations.push(value ? write(value, `${type}-${id}`) : remove(`${type}-${id}`));
            }
          }
          await Promise.all(operations);
        }
      }
    },
    saveCreds: () => write(creds, 'creds')
  };
}

async function hasSession() {
  return Boolean(await db().collection(authCollectionName()).findOne({ _id: 'creds' }));
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => start(false).catch(error => {
    state.status = 'ERROR';
    state.lastError = error.message;
  }), 3000);
}

async function start(onlyIfSessionExists = false) {
  if (starting) return starting;
  if (socket && ['INITIALIZING', 'WAITING_FOR_QR', 'READY'].includes(state.status)) return socket;
  starting = (async () => {
    await loadBaileys();
    await migrateLegacyAuthIfNeeded();
    if (onlyIfSessionExists && !(await hasSession())) return null;

    state.status = 'INITIALIZING';
    state.lastError = null;
    const auth = await useMongoAuthState();
    const { version } = await fetchLatestWaWebVersion().catch(() => ({ version: [2, 3000, 1015901307] }));
    socket = makeWASocket({
      version,
      auth: auth.state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      keepAliveIntervalMs: 30000,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      syncFullHistory: false,
      markOnlineOnConnect: false
    });

    socket.ev.on('creds.update', auth.saveCreds);
    socket.ev.on('connection.update', async update => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        state.status = 'WAITING_FOR_QR';
        state.qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 8 });
      }
      if (connection === 'open') {
        state.status = 'READY';
        state.qrDataUrl = null;
        state.connectedAt = new Date();
        state.userInfo = { id: socket.user?.id || null, name: socket.user?.name || socket.user?.notify || 'WhatsApp' };
        console.log(`WhatsApp bağlantısı hazır: ${state.userInfo.name}`);
      }
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        state.status = loggedOut ? 'LOGGED_OUT' : 'DISCONNECTED';
        state.qrDataUrl = null;
        state.lastError = lastDisconnect?.error?.message || null;
        socket = null;
        if (loggedOut) await db().collection(authCollectionName()).deleteMany({});
        scheduleReconnect();
      }
    });
    return socket;
  })().finally(() => { starting = null; });
  return starting;
}

async function logout() {
  clearTimeout(reconnectTimer);
  if (socket) {
    try { await socket.logout(); } catch { try { socket.end(new Error('Manual logout')); } catch {} }
  }
  socket = null;
  await db().collection(authCollectionName()).deleteMany({});
  Object.assign(state, { status: 'DISCONNECTED', qrDataUrl: null, userInfo: null, lastError: null, connectedAt: null });
  return start(false);
}

async function groups() {
  if (!socket || state.status !== 'READY') throw new Error('WhatsApp henüz bağlı değil.');
  const map = await socket.groupFetchAllParticipating();
  return Object.values(map).map(group => ({ id: group.id, name: group.subject }))
    .sort((a, b) => a.name.localeCompare(b.name, 'tr'));
}

async function sendVideoPoll({ groupId, videoUrl, messageId }) {
  if (!socket || state.status !== 'READY') throw new Error('WhatsApp istemcisi hazır değil.');
  const target = groupId;
  if (!target) throw new Error('Hedef WhatsApp grubu seçilmedi.');
  const sent = await socket.sendMessage(target, {
    poll: { name: videoUrl, values: ['İzledim', 'İzlemedim'], selectableCount: 1 }
  }, messageId ? { messageId } : undefined);
  return { messageId: sent?.key?.id || null, groupId: target };
}

function formatVideoMessage({ title, videoUrl }) {
  const cleanTitle = String(title || '').trim();
  const cleanUrl = String(videoUrl || '').trim();
  if (!cleanTitle) throw new Error('Video başlığı gereklidir.');
  if (!cleanUrl) throw new Error('Video bağlantısı gereklidir.');
  return `${cleanTitle}\n${cleanUrl}`;
}

async function sendVideoMessage({ groupId, title, videoUrl, messageId }) {
  if (!socket || state.status !== 'READY') throw new Error('WhatsApp istemcisi hazır değil.');
  const target = groupId;
  if (!target) throw new Error('Hedef WhatsApp grubu seçilmedi.');
  const sent = await socket.sendMessage(target, { text: formatVideoMessage({ title, videoUrl }) }, messageId ? { messageId } : undefined);
  return { messageId: sent?.key?.id || null, groupId: target };
}

function getState() {
  return { ...state, qrDataUrl: state.qrDataUrl };
}

module.exports = { start, logout, groups, sendVideoPoll, sendVideoMessage, formatVideoMessage, getState };
