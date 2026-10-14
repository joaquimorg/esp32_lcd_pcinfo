'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { snapTargets, snapMove, snapResize } = require('../src/control/snap');

const screen = { width: 240, height: 320 };
const other = { id: 'a', x: 20, y: 40, w: 100, h: 60 };   // centro x=70, direita=120, baixo=100

test('mover: o lado esquerdo encaixa no lado esquerdo de outro componente', () => {
  const t = snapTargets([other], 'me', screen);
  const r = snapMove({ x: 23, y: 200, w: 50, h: 30 }, t, screen, 4);
  assert.strictEqual(r.x, 20);
  assert.ok(r.guides.xs.some((g) => g.id === 'a' && g.v === 20));
});

test('mover: o centro encaixa no centro do ecrã (e mostra a guia do centro)', () => {
  const t = snapTargets([], 'me', screen);
  const r = snapMove({ x: 93, y: 150, w: 50, h: 30 }, t, screen, 4);   // centro 118 -> 120
  assert.strictEqual(r.x, 95);
  assert.ok(r.guides.xs.some((g) => g.kind === 'center' && g.v === 120));
});

test('mover: o topo encaixa no fundo de outro componente; longe demais não encaixa', () => {
  const t = snapTargets([other], 'me', screen);
  assert.strictEqual(snapMove({ x: 150, y: 102, w: 50, h: 30 }, t, screen, 4).y, 100);
  const far = snapMove({ x: 150, y: 110, w: 50, h: 30 }, t, screen, 4);
  assert.strictEqual(far.y, 110);
  assert.strictEqual(far.guides.ys.length, 0);
});

test('mover: o encaixe não deixa o componente sair do ecrã', () => {
  const t = snapTargets([], 'me', screen);
  const r = snapMove({ x: 238, y: 0, w: 50, h: 30 }, t, screen, 4);
  assert.ok(r.x + 50 <= 240);
});

test('redimensionar: o lado direito encaixa e a largura iguala a de outro componente', () => {
  const t = snapTargets([other], 'me', screen);
  const edge = snapResize({ x: 30, y: 150, w: 88, h: 40 }, t, [other], screen, 4);   // direita 118 -> 120
  assert.strictEqual(edge.w, 90);
  assert.ok(edge.guides.xs.some((g) => g.v === 120));

  const same = snapResize({ x: 130, y: 150, w: 98, h: 59 }, t, [other], screen, 4);
  assert.strictEqual(same.w, 100);
  assert.strictEqual(same.sameWidth.id, 'a');
  assert.strictEqual(same.h, 60);
  assert.strictEqual(same.sameHeight.id, 'a');
});
