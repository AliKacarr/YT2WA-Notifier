const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');

test('Baileys retry patch kapanan bağlantı hatasını yakalayacak şekilde kuruludur', () => {
  const baileysEntry = require.resolve('@whiskeysockets/baileys');
  const sourcePath = path.join(path.dirname(baileysEntry), 'Socket', 'messages-recv.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const retryBlockStart = source.indexOf('await retryMutex.mutex(async () => {');
  const retryBlockEnd = source.indexOf('// no type in the receipt', retryBlockStart);

  assert.notEqual(retryBlockStart, -1, 'retry mutex çağrısı await edilmelidir');
  assert.notEqual(retryBlockEnd, -1, 'retry bloğu bulunmalıdır');
  const retryBlock = source.slice(retryBlockStart, retryBlockEnd);
  assert.match(retryBlock, /try\s*{/);
  assert.match(retryBlock, /await sendRetryRequest\(node, !encNode\)/);
  assert.match(retryBlock, /catch \(error\)/);
  assert.match(retryBlock, /failed to send retry request/);
});

test('kalıcı Baileys patch dosyası ve postinstall komutu mevcuttur', () => {
  const packageJson = require('../package.json');
  const patchPath = path.join(projectRoot, 'patches', '@whiskeysockets+baileys+6.7.24.patch');

  assert.equal(packageJson.dependencies['@whiskeysockets/baileys'], '6.7.24');
  assert.equal(packageJson.scripts.postinstall, 'patch-package');
  assert.equal(fs.existsSync(patchPath), true);
});
