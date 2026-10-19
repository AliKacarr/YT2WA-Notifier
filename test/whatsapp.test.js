const test = require('node:test');
const assert = require('node:assert/strict');
const { formatVideoMessage, runSocketEvent } = require('../src/whatsapp');

test('video mesajı başlık ve alt satırda bağlantı biçiminde hazırlanır', () => {
  assert.equal(
    formatVideoMessage({ title: 'Hayat Değiştiren İnce Düşünce', videoUrl: 'https://youtube.com/shorts/IhQuNsLao-k?si=X2_nX9uPd7gQiU7k' }),
    'Hayat Değiştiren İnce Düşünce\nhttps://youtube.com/shorts/IhQuNsLao-k?si=X2_nX9uPd7gQiU7k'
  );
});

test('video mesajında başlık ve bağlantı zorunludur', () => {
  assert.throws(() => formatVideoMessage({ title: '', videoUrl: 'https://youtube.com/test' }), /başlığı/);
  assert.throws(() => formatVideoMessage({ title: 'Başlık', videoUrl: '' }), /bağlantısı/);
});

test('async socket eventindeki Baileys 428 reddi unhandled rejection olmaz', async () => {
  const error = Object.assign(new Error('Connection Closed'), {
    isBoom: true,
    output: { statusCode: 428 }
  });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  try {
    await runSocketEvent({}, 'connection.update', async () => { throw error; });
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandled);
    console.warn = originalWarn;
  }

  assert.deepEqual(unhandled, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].join(' '), /Connection Closed/);
});
