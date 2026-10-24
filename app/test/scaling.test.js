'use strict';

const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/scaling');

const D = { width: 240, height: 320 };
const AMOLED = { width: 410, height: 502 };
const c = { x: 10, y: 20, w: 100, h: 50 };

test('tamanho igual: identidade em qualquer modo, caixa original e sem ampliação', () => {
  for (const mode of S.MODES) {
    const m = S.compute(D, D, mode);
    assert.strictEqual(m.identity, true);
    assert.deepStrictEqual(S.box(c, m), { x: 10, y: 20, w: 100, h: 50, scale: 1, width: 100, height: 50 });
  }
});

test('modo off: tamanhos diferentes não ampliam', () => {
  const m = S.compute(D, AMOLED, 'off');
  assert.strictEqual(m.identity, true);
});

test('fit: ampliação uniforme, centrada, o ecrã cabe inteiro', () => {
  const m = S.compute(D, AMOLED, 'fit');
  assert.strictEqual(m.kx, m.ky);
  assert.ok(Math.abs(m.k - 502 / 320) < 1e-9);
  const full = S.box({ x: 0, y: 0, w: 240, h: 320 }, m);
  assert.ok(full.x >= 0 && full.y >= 0 && full.x + full.w <= 410 && full.y + full.h <= 502);
  assert.ok(Math.abs(full.x - (410 - full.w - full.x)) <= 1, 'centrado na horizontal');
  assert.strictEqual(full.h, 502);
});

test('fill: o layout ocupa o LCD todo e o conteúdo amplia-se pelo menor fator', () => {
  const m = S.compute(D, AMOLED, 'fill');
  assert.ok(Math.abs(m.kx - 410 / 240) < 1e-9 && Math.abs(m.ky - 502 / 320) < 1e-9);
  assert.strictEqual(m.k, Math.min(m.kx, m.ky));
  const full = S.box({ x: 0, y: 0, w: 240, h: 320 }, m);
  assert.deepStrictEqual([full.x, full.y, full.w, full.h], [0, 0, 410, 502]);
  // O componente vê um tamanho (em unidades de desenho) que, ampliado, preenche a caixa.
  assert.ok(Math.abs(full.width * full.scale - full.w) < 1e-9);
});

test('auto: parecidos usam fill, muito diferentes usam fit', () => {
  const near = S.compute(D, AMOLED, 'auto');
  assert.strictEqual(near.ox, 0);
  assert.notStrictEqual(near.kx, near.ky);
  const wide = S.compute(D, { width: 480, height: 272 }, 'auto');   // retrato -> paisagem
  assert.strictEqual(wide.kx, wide.ky);
  assert.ok(wide.ox > 0);
});

test('LCD mais pequeno: reduz sem deformar e as caixas não passam do ecrã', () => {
  const small = { width: 128, height: 160 };
  for (const mode of ['fit', 'fill', 'auto']) {
    const m = S.compute(D, small, mode);
    assert.ok(m.k < 1);
    for (const comp of [c, { x: 0, y: 0, w: 240, h: 320 }, { x: 230, y: 310, w: 10, h: 10 }]) {
      const b = S.box(comp, m);
      assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= small.width && b.y + b.h <= small.height, `${mode} ${JSON.stringify(b)}`);
    }
  }
});

test('ida e volta: sem folgas entre caixas vizinhas (arredonda as arestas, não o tamanho)', () => {
  const m = S.compute(D, AMOLED, 'fill');
  const a = S.box({ x: 0, y: 0, w: 77, h: 10 }, m), b = S.box({ x: 77, y: 0, w: 83, h: 10 }, m);
  assert.strictEqual(a.x + a.w, b.x);
});

test('ecrãs antigos sem tamanho de desenho: o LCD, ou o original se o LCD é maior', () => {
  const AMOLED_ = { width: 410, height: 502 };
  const small = [{ x: 10, y: 6, w: 220, h: 271 }];
  // LCD até ao tamanho original: foi para ele que desenhou (nada muda).
  assert.deepStrictEqual(S.guessDesign(small, { width: 240, height: 280 }), { width: 240, height: 280 });
  assert.deepStrictEqual(S.guessDesign(small, D), D);
  // LCD maior que o original e componentes que cabem no original: vêm de 240x320 (o bug da placa AMOLED).
  assert.deepStrictEqual(S.guessDesign(small, AMOLED_), D);
  // Componentes que já não cabem no original mas cabem no LCD: desenhou no LCD grande.
  assert.deepStrictEqual(S.guessDesign([{ x: 0, y: 0, w: 400, h: 480 }], AMOLED_), AMOLED_);
  // Ecrã vazio: nada a ampliar.
  assert.deepStrictEqual(S.guessDesign([], AMOLED_), AMOLED_);
});

test('modo desconhecido cai para auto; dados em falta dão identidade', () => {
  assert.strictEqual(S.normalizeMode('xx'), 'auto');
  assert.strictEqual(S.compute(null, AMOLED, 'fit').identity, true);
  assert.strictEqual(S.compute(D, { width: 0, height: 0 }, 'fit').identity, true);
});
