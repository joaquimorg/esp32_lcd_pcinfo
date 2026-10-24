'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Player } = require('../src/main/player');
const { exportScreen, importScreen } = require('../src/main/screens');
const { scanWidgets } = require('../src/main/widgets');
const { migrate } = require('../src/main/config');

const BUILTIN = path.join(__dirname, '..', 'widgets');
let n = 0;
const newId = (p) => `${p}${++n}`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'screens-'));

/* ---- Player ---- */

const S = (id, enabled = true, durationSec = 10) => ({ id, enabled, durationSec, components: [] });

test('player: roda só pelos ativos, com a duração de cada um', () => {
  const p = new Player();
  const screens = [S('a', true, 5), S('b', false), S('c', true, 2)];
  p.update(screens, 0);
  assert.strictEqual(p.currentId, 'a');
  p.update(screens, 4999);
  assert.strictEqual(p.currentId, 'a');
  p.update(screens, 5000);
  assert.strictEqual(p.currentId, 'c', 'salta o inativo');
  p.update(screens, 7000);
  assert.strictEqual(p.currentId, 'a', 'volta ao início');
});

test('player: sem ativos não mostra nada; um só ativo não roda', () => {
  const p = new Player();
  assert.strictEqual((p.update([S('a', false)], 0), p.currentId), null);
  p.update([S('a')], 0);
  p.update([S('a')], 999999);
  assert.strictEqual(p.currentId, 'a');
  assert.strictEqual(p.remainingSec([S('a')], 0), null);
});

test('player: no editor fixa o ecrã editado, mesmo inativo', () => {
  const p = new Player();
  const screens = [S('a', true, 1), S('b', false)];
  p.setMode('edit', 'b', 0);
  p.update(screens, 0);
  assert.strictEqual(p.currentId, 'b');
  p.update(screens, 60000);
  assert.strictEqual(p.currentId, 'b');
  p.setMode('run', null, 60000);
  p.update(screens, 60000);
  assert.strictEqual(p.currentId, 'a');
});

test('player: saltar para o seguinte e anterior', () => {
  const p = new Player();
  const screens = [S('a'), S('b'), S('c')];
  p.update(screens, 0);
  p.step(screens, 1, 0);
  assert.strictEqual(p.currentId, 'b');
  p.step(screens, -1, 0);
  p.step(screens, -1, 0);
  assert.strictEqual(p.currentId, 'c');
});

/* ---- Exportar / importar ---- */

test('exportar e importar noutro PC: componente próprio e imagem viajam no ficheiro', () => {
  // PC de origem: um componente próprio e uma imagem.
  const userA = tmp();
  const custom = path.join(userA, 'ai-anel');
  fs.mkdirSync(custom);
  fs.writeFileSync(path.join(custom, 'widget.html'),
    '<script type="application/json" id="widget-manifest">{"name":"Anel","properties":[{"key":"sensor","type":"sensor","label":"S"}]}</script>');
  const img = path.join(userA, 'logo.png');
  fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));

  const catalogA = scanWidgets([BUILTIN, userA]);
  const builtin = new Set(Object.keys(scanWidgets([BUILTIN])));
  const screen = {
    id: 's1', name: 'Teste', enabled: true, durationSec: 7, background: '#101010',
    components: [
      { id: 'c1', type: 'ai-anel', x: 1, y: 2, w: 50, h: 60, props: { sensor: '/cpu/0' } },
      { id: 'c2', type: 'image', x: 0, y: 0, w: 20, h: 20, props: { file: img, fit: 'cover' } },
      { id: 'c3', type: 'gauge', x: 5, y: 5, w: 100, h: 90, props: { label: 'T' } },
    ],
  };
  const file = JSON.parse(JSON.stringify(exportScreen(screen, { catalog: catalogA, builtin, size: { width: 240, height: 320 } })));
  assert.deepStrictEqual(Object.keys(file.types), ['ai-anel'], 'só embute o componente próprio');
  assert.match(file.components[1].props.file, /^asset:/);

  // PC de destino: sem o componente nem a imagem.
  const userB = tmp();
  const assetsB = path.join(userB, 'assets');
  const { screen: imported, newTypes } = importScreen(file, {
    catalog: scanWidgets([BUILTIN, userB]), userWidgetsDir: userB, assetsDir: assetsB, newId,
  });
  assert.deepStrictEqual(newTypes, ['ai-anel']);
  assert.strictEqual(imported.name, 'Teste');
  assert.strictEqual(imported.background, '#101010');
  assert.strictEqual(imported.components[0].type, 'ai-anel');
  assert.strictEqual(imported.components[0].props.sensor, '/cpu/0');
  assert.deepStrictEqual(fs.readFileSync(imported.components[1].props.file), fs.readFileSync(img));
  assert.notStrictEqual(imported.components[0].id, 'c1', 'IDs novos');
  assert.ok(scanWidgets([userB])['ai-anel'], 'componente criado e legível');

  // Importar outra vez: o componente igual é reutilizado.
  const again = importScreen(file, { catalog: scanWidgets([BUILTIN, userB]), userWidgetsDir: userB, assetsDir: assetsB, newId });
  assert.deepStrictEqual(again.newTypes, []);

  // Componente com o mesmo nome mas diferente: não sobrepõe.
  file.types['ai-anel'].html += '<!-- versão 2 -->';
  const changed = importScreen(file, { catalog: scanWidgets([BUILTIN, userB]), userWidgetsDir: userB, assetsDir: assetsB, newId });
  assert.deepStrictEqual(changed.newTypes, ['ai-anel-2']);
  assert.strictEqual(changed.screen.components[0].type, 'ai-anel-2');
});

test('exportar e importar mantêm os componentes bloqueados', () => {
  const catalog = scanWidgets([BUILTIN]);
  const builtin = new Set(Object.keys(catalog));
  const screen = {
    id: 's1', name: 'Lock', components: [
      { id: 'a', type: 'label', x: 1, y: 2, w: 50, h: 20, locked: true, props: { text: 'A', font: 'Arial', italic: true } },
      { id: 'b', type: 'label', x: 1, y: 30, w: 50, h: 20, props: { text: 'B' } },
    ],
  };
  const file = JSON.parse(JSON.stringify(exportScreen(screen, { catalog, builtin, size: { width: 240, height: 320 } })));
  assert.strictEqual(file.components[0].locked, true);
  assert.strictEqual('locked' in file.components[1], false, 'só guarda quando está bloqueado');
  const { screen: imported } = importScreen(file, { catalog, userWidgetsDir: tmp(), assetsDir: tmp(), newId });
  assert.strictEqual(imported.components[0].locked, true);
  assert.strictEqual(imported.components[1].locked, undefined);
  assert.deepStrictEqual(imported.components[0].props, { text: 'A', font: 'Arial', italic: true });
});

test('o tamanho de desenho vai e volta no ficheiro e não é o do LCD atual', () => {
  const catalog = scanWidgets([BUILTIN]);
  const builtin = new Set(Object.keys(catalog));
  const screen = { id: 's1', name: 'D', design: { width: 240, height: 320 }, components: [] };
  const file = JSON.parse(JSON.stringify(exportScreen(screen, { catalog, builtin, size: { width: 410, height: 502 } })));
  assert.deepStrictEqual(file.screen, { width: 240, height: 320 }, 'exporta o desenho, não o LCD');
  const { screen: imported } = importScreen(file, { catalog, userWidgetsDir: tmp(), assetsDir: tmp(), newId });
  assert.deepStrictEqual(imported.design, { width: 240, height: 320 });
  // Sem tamanho no ficheiro (versões antigas): fica por registar e a app carimba o do LCD.
  delete file.screen;
  assert.strictEqual(importScreen(file, { catalog, userWidgetsDir: tmp(), assetsDir: tmp(), newId }).screen.design, undefined);
});

test('importar rejeita ficheiros que não são widgets', () => {
  const ctx = { catalog: {}, userWidgetsDir: tmp(), assetsDir: tmp(), newId };
  assert.throws(() => importScreen({ hello: 1 }, ctx), (err) => err.key === 'err.notLcdwidget' && /not a widget file/.test(err.message));
  assert.throws(() => importScreen({ format: 'usb-lcd-widget', version: 99, components: [] }, ctx), /version 99/);
});

/* ---- Migração ---- */

test('configuração antiga (pages/widgets) é migrada para screens/components', () => {
  const cfg = migrate({ rotatePages: true, pages: [{ id: 'p1', name: 'CPU', durationSec: 5, widgets: [{ id: 'w1', type: 'gauge' }] }] });
  assert.strictEqual(cfg.pages, undefined);
  assert.deepStrictEqual(cfg.screens[0], {
    id: 'p1', name: 'CPU', enabled: true, durationSec: 5, background: '#000000', components: [{ id: 'w1', type: 'gauge' }],
  });
});
