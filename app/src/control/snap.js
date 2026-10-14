'use strict';

// Encaixe e guias de alinhamento do editor (funções puras, testadas em test/snap.test.js).
//
// Referências: lados e centro do ecrã, e lados e centro dos outros componentes.
// Um ponto do componente que se está a mexer (lado ou centro) encaixa na
// referência mais próxima, se estiver a menos de `threshold` pixels do LCD.

/** Referências de alinhamento na horizontal (xs) e na vertical (ys). */
function snapTargets(components, exceptId, screen) {
  const xs = [
    { v: 0, kind: 'edge' }, { v: screen.width / 2, kind: 'center' }, { v: screen.width, kind: 'edge' },
  ];
  const ys = [
    { v: 0, kind: 'edge' }, { v: screen.height / 2, kind: 'center' }, { v: screen.height, kind: 'edge' },
  ];
  for (const c of components) {
    if (c.id === exceptId) continue;
    xs.push({ v: c.x, id: c.id }, { v: c.x + c.w / 2, id: c.id }, { v: c.x + c.w, id: c.id });
    ys.push({ v: c.y, id: c.id }, { v: c.y + c.h / 2, id: c.id }, { v: c.y + c.h, id: c.id });
  }
  return { xs, ys };
}

/** Menor correção (|d| ≤ threshold) que alinha um dos pontos a uma referência, ou null. */
function nearestSnap(points, targets, threshold) {
  let best = null;
  for (const p of points) {
    for (const t of targets) {
      const d = t.v - p;
      if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
  }
  return best;
}

/** Referências que coincidem com algum dos pontos (são as guias a desenhar). */
function matchingTargets(points, targets) {
  return targets.filter((t) => points.some((p) => Math.abs(t.v - p) < 0.51));
}

const xPoints = (r) => [r.x, r.x + r.w / 2, r.x + r.w];
const yPoints = (r) => [r.y, r.y + r.h / 2, r.y + r.h];
const clampTo = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Mover: devolve a posição com encaixe e as guias.
 * @param rect       { x, y, w, h } pretendido (já com o deslocamento do rato)
 * @param targets    resultado de snapTargets
 */
function snapMove(rect, targets, screen, threshold) {
  let { x, y } = rect;
  const dx = nearestSnap(xPoints(rect), targets.xs, threshold);
  const dy = nearestSnap(yPoints(rect), targets.ys, threshold);
  if (dx !== null) x = Math.round(x + dx);
  if (dy !== null) y = Math.round(y + dy);
  x = clampTo(x, 0, screen.width - rect.w);
  y = clampTo(y, 0, screen.height - rect.h);
  const r = { ...rect, x, y };
  return { x, y, guides: { xs: matchingTargets(xPoints(r), targets.xs), ys: matchingTargets(yPoints(r), targets.ys) } };
}

/**
 * Redimensionar pelo canto inferior direito: o lado direito e o de baixo
 * encaixam nas referências, e a largura/altura no tamanho de outro componente.
 */
function snapResize(rect, targets, others, screen, threshold) {
  let { w, h } = rect;
  const widths = others.map((o) => ({ v: o.w, id: o.id }));
  const heights = others.map((o) => ({ v: o.h, id: o.id }));

  const pick = (a, b) => (a === null ? b : b === null ? a : Math.abs(a) <= Math.abs(b) ? a : b);
  const dw = pick(nearestSnap([rect.x + w], targets.xs, threshold), nearestSnap([w], widths, threshold));
  const dh = pick(nearestSnap([rect.y + h], targets.ys, threshold), nearestSnap([h], heights, threshold));
  if (dw !== null) w = Math.round(w + dw);
  if (dh !== null) h = Math.round(h + dh);
  w = clampTo(w, 8, screen.width - rect.x);
  h = clampTo(h, 8, screen.height - rect.y);

  return {
    w,
    h,
    guides: {
      xs: matchingTargets([rect.x + w], targets.xs),
      ys: matchingTargets([rect.y + h], targets.ys),
    },
    sameWidth: others.find((o) => o.w === w) || null,
    sameHeight: others.find((o) => o.h === h) || null,
  };
}

if (typeof module !== 'undefined') module.exports = { snapTargets, nearestSnap, matchingTargets, snapMove, snapResize };
