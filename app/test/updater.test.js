'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Updater, parseVersion, isNewer, parseRelease } = require('../src/main/updater');

const BYTES = Buffer.from('installer-bytes');
const SHA = crypto.createHash('sha256').update(BYTES).digest('hex');
const release = (over = {}) => ({
  tag_name: 'v0.17.0', html_url: 'https://github.com/x/y/releases/tag/v0.17.0', body: 'Notes', draft: false, prerelease: false,
  assets: [
    { name: 'USB-LCD-Widgets-Portable-0.17.0.exe', browser_download_url: 'https://x/portable.exe', size: 1 },
    { name: 'USB-LCD-Widgets-Setup-0.17.0.exe', browser_download_url: 'https://x/setup.exe', size: BYTES.length, digest: 'sha256:' + SHA },
  ],
  ...over,
});
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('versões: leitura e comparação', () => {
  assert.deepStrictEqual(parseVersion('v0.16.1'), [0, 16, 1]);
  assert.strictEqual(parseVersion('abc'), null);
  assert.ok(isNewer('0.17.0', '0.16.9'));
  assert.ok(isNewer('1.0.0', '0.99.99'));
  assert.ok(!isNewer('0.16.1', '0.16.1'));
  assert.ok(!isNewer('0.9.0', '0.10.0'));
  assert.ok(!isNewer('x', '0.1.0'));
});

test('parseRelease escolhe o instalador e ignora rascunhos e pré-lançamentos', () => {
  const r = parseRelease(release());
  assert.strictEqual(r.version, '0.17.0');
  assert.strictEqual(r.asset.name, 'USB-LCD-Widgets-Setup-0.17.0.exe');
  assert.strictEqual(r.asset.sha256, SHA);
  assert.strictEqual(parseRelease(release({ draft: true })), null);
  assert.strictEqual(parseRelease(release({ prerelease: true })), null);
  assert.strictEqual(parseRelease(release({ assets: [] })).asset, null);
});

test('check: versão nova, igual, sem releases e erro', async () => {
  const mk = (res) => new Updater({ fetch: async () => res });
  let u = mk(json(release()));
  assert.strictEqual((await u.check('0.16.1')).version, '0.17.0');
  assert.strictEqual(u.status.state, 'available');
  u = mk(json(release()));
  assert.strictEqual(await u.check('0.17.0'), null);
  assert.strictEqual(u.status.state, 'none');
  u = mk(json({}, 404));
  assert.strictEqual(await u.check('0.1.0'), null);
  assert.strictEqual(u.status.state, 'none');
  u = mk(json({}, 500));
  await u.check('0.1.0');
  assert.strictEqual(u.status.state, 'error');
});

function downloadUpdater(bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
  const fetch = async (url) => (url.endsWith('setup.exe')
    ? { ok: true, status: 200, headers: new Map([['content-length', String(bytes.length)]]), body: (async function* () { yield bytes.subarray(0, 4); yield bytes.subarray(4); })() }
    : json(release()));
  return { dir, u: new Updater({ fetch, dir }) };
}

test('download grava o instalador e verifica o SHA-256', async () => {
  const { dir, u } = downloadUpdater(BYTES);
  await u.check('0.16.1');
  const file = await u.download();
  assert.deepStrictEqual(fs.readFileSync(file), BYTES);
  assert.strictEqual(u.status.state, 'available');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('download com conteúdo diferente do SHA-256 é rejeitado e apagado', async () => {
  const bad = Buffer.from('installer-bytez');
  const { dir, u } = downloadUpdater(bad);
  await u.check('0.16.1');
  await assert.rejects(() => u.download(), /checksum/);
  assert.strictEqual(u.status.state, 'error');
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
