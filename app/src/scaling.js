'use strict';

/*
 * Ampliação dos ecrãs quando o LCD não tem o tamanho com que foram desenhados
 * (mudança de placa ou de resolução). Módulo partilhado pelo processo principal
 * (layout do LCD e miniaturas) e pela janela do editor.
 *
 * Cada ecrã guarda o tamanho de desenho (screen.design) e os seus componentes
 * ficam sempre nessas coordenadas; só ao desenhar se aplica a ampliação:
 *
 *   fit    ampliação uniforme que cabe no LCD, centrada; as faixas que sobram
 *          ficam com a cor de fundo do ecrã. Nada é deformado.
 *   fill   o layout estica-se para ocupar o LCD inteiro (as caixas dos componentes
 *          crescem na horizontal e na vertical), mas o conteúdo de cada componente
 *          é ampliado por igual (o menor dos dois fatores): texto e formas
 *          não se deformam.
 *   auto   fill se as proporções forem parecidas (diferença até AUTO_FILL_MAX),
 *          senão fit.
 *   off    sem ampliação: os componentes ficam onde estão, como antes.
 *
 * Se o tamanho de desenho for igual ao do LCD, o resultado é sempre a identidade.
 */
(function (root) {
  const MODES = ['auto', 'fit', 'fill', 'off'];
  const DEFAULT_MODE = 'auto';
  const AUTO_FILL_MAX = 0.25;

  const normalizeMode = (m) => (MODES.includes(m) ? m : DEFAULT_MODE);

  /**
   * @param design   { width, height } com que o ecrã foi desenhado
   * @param display  { width, height } do LCD (área visível)
   * @returns { kx, ky, k, ox, oy, identity } k = ampliação do conteúdo (uniforme)
   */
  function compute(design, display, mode = DEFAULT_MODE) {
    const identity = { kx: 1, ky: 1, k: 1, ox: 0, oy: 0, identity: true };
    if (!design || !design.width || !design.height || !display || !display.width || !display.height) return identity;
    if (design.width === display.width && design.height === display.height) return identity;
    mode = normalizeMode(mode);
    if (mode === 'off') return identity;

    const kx = display.width / design.width;
    const ky = display.height / design.height;
    if (mode === 'auto') {
      const aspect = (kx / ky);
      mode = Math.abs(aspect - 1) <= AUTO_FILL_MAX ? 'fill' : 'fit';
    }
    if (mode === 'fill') return { kx, ky, k: Math.min(kx, ky), ox: 0, oy: 0, identity: false };
    const k = Math.min(kx, ky);
    return {
      kx: k, ky: k, k,
      ox: Math.round((display.width - design.width * k) / 2),
      oy: Math.round((display.height - design.height * k) / 2),
      identity: false,
    };
  }

  /**
   * Caixa de um componente no LCD, em pixels inteiros, e o tamanho que o próprio
   * componente vê (em unidades de desenho; o iframe é `scale` vezes maior).
   */
  function box(c, m) {
    if (m.identity) return { x: c.x, y: c.y, w: c.w, h: c.h, scale: 1, width: c.w, height: c.h };
    const x = Math.round(c.x * m.kx + m.ox), y = Math.round(c.y * m.ky + m.oy);
    const w = Math.max(1, Math.round((c.x + c.w) * m.kx + m.ox) - x);
    const h = Math.max(1, Math.round((c.y + c.h) * m.ky + m.oy) - y);
    return { x, y, w, h, scale: m.k, width: w / m.k, height: h / m.k };
  }

  // Antes da ampliação a app só suportava LCDs até este tamanho (o do primeiro hardware).
  const ORIGINAL = { width: 240, height: 320 };

  /**
   * Tamanho de desenho de um ecrã antigo, sem registo. Quem desenhou num LCD até
   * ao tamanho original, desenhou para o LCD que tem: fica esse (nada muda). Num
   * LCD maior que isso, os ecrãs antigos vêm do tamanho original, a menos que os
   * componentes já não caibam nele.
   */
  function guessDesign(components, display) {
    const d = { width: display.width, height: display.height };
    if (!components.length) return d;
    if (d.width <= ORIGINAL.width && d.height <= ORIGINAL.height) return d;
    let w = 0, h = 0;
    for (const c of components) {
      w = Math.max(w, c.x + c.w);
      h = Math.max(h, c.y + c.h);
    }
    if (w <= ORIGINAL.width && h <= ORIGINAL.height) return { ...ORIGINAL };
    return w <= d.width && h <= d.height ? d : { width: Math.max(w, ORIGINAL.width), height: Math.max(h, ORIGINAL.height) };
  }

  const api = { MODES, DEFAULT_MODE, ORIGINAL, normalizeMode, compute, box, guessDesign };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Scaling = api;
})(typeof window !== 'undefined' ? window : globalThis);
