'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const I18N = require('../src/i18n');
const { scanWidgets } = require('../src/main/widgets');
const { TRANSITIONS } = require('../src/main/transitions');

test('inglês e português têm as mesmas chaves', () => {
  const en = Object.keys(I18N.STRINGS.en).sort();
  const pt = Object.keys(I18N.STRINGS.pt).sort();
  assert.deepStrictEqual(pt.filter((k) => !en.includes(k)), [], 'só em pt');
  assert.deepStrictEqual(en.filter((k) => !pt.includes(k)), [], 'só em en');
});

test('inglês por omissão; variáveis substituídas; idioma desconhecido cai para inglês', () => {
  assert.strictEqual(I18N.DEFAULT_LANGUAGE, 'en');
  assert.strictEqual(I18N.translator()('tray.quit'), 'Quit');
  assert.strictEqual(I18N.translator('pt')('now.next', { s: 5 }), 'Seguinte em 5 s');
  assert.strictEqual(I18N.translator('xx')('tray.quit'), 'Quit');
  assert.strictEqual(I18N.translator('pt')('chave.inexistente'), 'chave.inexistente');
});

test('todas as transições têm nome', () => {
  for (const lang of ['en', 'pt']) {
    for (const id of TRANSITIONS) assert.ok(I18N.STRINGS[lang]['tr.' + id], `${lang} tr.${id}`);
  }
});

test('componentes incluídos: texto base em inglês e tradução portuguesa completa', () => {
  const catalog = scanWidgets([path.join(__dirname, '..', 'widgets')]);
  for (const c of Object.values(catalog)) {
    const pt = I18N.localizeManifest(c, 'pt');
    assert.ok(c.i18n && c.i18n.pt, `${c.type} sem i18n.pt`);
    assert.notStrictEqual(pt.name, undefined);
    for (const p of c.properties) {
      assert.ok(c.i18n.pt.properties[p.key]?.label, `${c.type}.${p.key} sem label em pt`);
    }
  }
  const line = I18N.localizeManifest(catalog.line, 'pt');
  assert.strictEqual(line.name, 'Linha');
  assert.strictEqual(I18N.localizeManifest(catalog.line, 'en').properties.find((p) => p.key === 'style').optionLabels['contínuo'], 'solid');
  // Os valores guardados não mudam com o idioma.
  assert.deepStrictEqual(line.properties.find((p) => p.key === 'style').options, ['contínuo', 'tracejado', 'pontilhado']);
});

test('a especificação para a IA existe nos dois idiomas, com o exemplo completo', () => {
  const docs = path.join(__dirname, '..', 'docs');
  assert.match(fs.readFileSync(path.join(docs, 'widget-ai-spec.md'), 'utf8'), /## 5\. Exemplo completo/);
  assert.match(fs.readFileSync(path.join(docs, 'widget-ai-spec.en.md'), 'utf8'), /## 5\. Complete example/);
});
