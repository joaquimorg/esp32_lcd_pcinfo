'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveTransition, TRANSITIONS } = require('../src/main/transitions');
const { exportScreen, importScreen } = require('../src/main/screens');
const { scanWidgets } = require('../src/main/widgets');

test('a transição do widget sobrepõe-se à geral', () => {
  const config = { transition: { type: 'fade', durationMs: 700 } };
  assert.deepStrictEqual(resolveTransition({}, config), { type: 'fade', durationMs: 700 });
  assert.deepStrictEqual(resolveTransition({ transition: { type: 'push-left' } }, config), { type: 'push-left', durationMs: 700 });
  assert.deepStrictEqual(resolveTransition({ transition: { type: 'none' } }, config), { type: 'none', durationMs: 0 });
});

test('valores inválidos ou em falta usam o padrão; a duração fica limitada', () => {
  assert.deepStrictEqual(resolveTransition({}, {}), { type: 'fade', durationMs: 500 });
  assert.deepStrictEqual(resolveTransition({ transition: { type: 'xpto' } }, { transition: { type: 'xpto' } }), { type: 'fade', durationMs: 500 });
  assert.strictEqual(resolveTransition({}, { transition: { type: 'fade', durationMs: 99999 } }).durationMs, 3000);
  assert.strictEqual(resolveTransition({}, { transition: { type: 'fade', durationMs: 1 } }).durationMs, 100);
});

test('aleatória escolhe uma transição real', () => {
  const real = new Set(TRANSITIONS.filter((t) => t !== 'none' && t !== 'random'));
  for (const r of [0, 0.3, 0.6, 0.9999]) {
    assert.ok(real.has(resolveTransition({ transition: { type: 'random' } }, {}, () => r).type));
  }
});

test('o ficheiro .lcdwidget leva a transição do widget', () => {
  const catalog = scanWidgets([path.join(__dirname, '..', 'widgets')]);
  const screen = { id: 's1', name: 'T', background: '#000000', transition: { type: 'circle' }, components: [] };
  const data = exportScreen(screen, { catalog, builtin: new Set(Object.keys(catalog)), size: { width: 240, height: 320 } });
  assert.deepStrictEqual(data.transition, { type: 'circle' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trans-'));
  let n = 0;
  const { screen: back } = importScreen(JSON.parse(JSON.stringify(data)), { catalog, userWidgetsDir: dir, assetsDir: dir, newId: (p) => p + ++n });
  assert.deepStrictEqual(back.transition, { type: 'circle' });

  const plain = exportScreen({ ...screen, transition: undefined }, { catalog, builtin: new Set(), size: { width: 240, height: 320 } });
  assert.ok(!('transition' in plain));
});
