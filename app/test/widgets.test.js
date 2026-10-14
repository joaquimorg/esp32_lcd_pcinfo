'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { importWidget, scanWidgets, extractHtml } = require('../src/main/widgets');

const spec = fs.readFileSync(path.join(__dirname, '..', 'docs', 'widget-ai-spec.md'), 'utf8');
// O exemplo completo da secção 5 da especificação.
const example = /## 5\. Exemplo completo\s+```html\n([\s\S]*?)```/.exec(spec)[1];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'widgets-'));
}

test('o exemplo da especificação importa e aparece no catálogo', () => {
  const dir = tmpDir();
  const res = importWidget(example, dir, new Set());
  assert.strictEqual(res.type, 'ai-anel-de-carga');
  const catalog = scanWidgets([dir]);
  const w = catalog[res.type];
  assert.ok(w, 'widget no catálogo');
  assert.strictEqual(w.name, 'Anel de carga');
  assert.deepStrictEqual(w.size, { w: 120, h: 120 });
  assert.strictEqual(w.properties[0].type, 'sensor');
});

test('resposta de IA com texto e cercas ``` à volta', () => {
  const answer = `Claro! Aqui está o widget:\n\n\`\`\`html\n${example}\`\`\`\n\nEspero que ajude.`;
  assert.ok(extractHtml(answer).startsWith('<!doctype html>'));
  const dir = tmpDir();
  importWidget(answer, dir, new Set());
  const again = importWidget(answer, dir, new Set());
  assert.strictEqual(again.type, 'ai-anel-de-carga-2', 'não sobrepõe um widget existente');
});

test('injeta o SDK se a IA se esqueceu dele', () => {
  const html = example.replace('<script src="../_sdk/widget-sdk.js"></script>', '');
  const dir = tmpDir();
  const { type } = importWidget(html, dir, new Set());
  const saved = fs.readFileSync(path.join(dir, type, 'widget.html'), 'utf8');
  const sdk = saved.indexOf('widget-sdk.js');
  assert.ok(sdk > 0);
  assert.ok(sdk < saved.indexOf('Widget.onUpdate'), 'SDK antes do código do widget');
  assert.ok(sdk > saved.indexOf('widget-manifest'), 'manifest continua intacto');
});

test('rejeita manifests inválidos com uma mensagem útil', () => {
  const dir = tmpDir();
  assert.throws(() => importWidget('<html><body>sem manifest</body></html>', dir, new Set()), /widget-manifest/);
  const badType = example.replace('"type": "color", "label": "Cor",', '"type": "colour", "label": "Cor",');
  assert.throws(() => importWidget(badType, dir, new Set()), /type "colour"/);
  const badJson = example.replace('"size": { "w": 120, "h": 120 },', '"size": { "w": 120, "h": 120 },,');
  assert.throws(() => importWidget(badJson, dir, new Set()), /invalid JSON/);
});
