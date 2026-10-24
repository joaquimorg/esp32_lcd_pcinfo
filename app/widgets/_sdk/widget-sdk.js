/*
 * Widget SDK — incluir no widget.html:
 *   <script src="../_sdk/widget-sdk.js"></script>
 *
 *   Widget.onUpdate((props, info) => { ... })
 *     props  valores das propriedades do manifest.json. As propriedades do
 *            tipo "sensor" chegam como objeto:
 *              { id, name, hardware, group, type, value, unit, min, max, history }
 *            ou null se o sensor não existir. history tem as últimas leituras
 *            (até 600, a mais recente no fim).
 *     info   { size: { width, height }, sensorSeq, lang } — sensorSeq muda a
 *            cada leitura nova (útil para históricos); lang é o idioma da app
 *            ('en' ou 'pt').
 *   Widget.locale(info)  'en-GB' ou 'pt-PT', para toLocaleDateString e afins.
 *
 *   Widget.format / fraction / mix / opacity / attrs — utilitários (ver em baixo).
 *
 * O widget é desenhado num iframe com fundo transparente, do tamanho do widget.
 */
(function () {
  const listeners = [];
  let last = null;

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.type !== 'widget:update') return;
    last = m;
    // O ecrã pode estar ampliado (LCD maior que o do desenho): o iframe é maior que
    // m.size e o conteúdo é ampliado por igual (zoom do CSS: texto e SVG ficam nítidos).
    document.documentElement.style.zoom = m.scale && m.scale !== 1 ? String(m.scale) : '';
    const info = { size: m.size, scale: m.scale || 1, sensorSeq: m.sensorSeq, lang: m.lang || 'en' };
    for (const cb of listeners) cb(m.props, info);
  });

  const rgb = (c) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(c || '');
    const n = m ? parseInt(m[1], 16) : 0xffffff;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };

  const toHsl = ([r, g, b]) => {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  };

  const fromHsl = ([h, s, l]) => {
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
  };

  window.Widget = {
    onUpdate(cb) {
      listeners.push(cb);
      if (last) cb(last.props, { size: last.size, scale: last.scale || 1, sensorSeq: last.sensorSeq, lang: last.lang || 'en' });
    },

    /**
     * Prepara um <canvas> para desenhar em unidades de desenho (info.size) e
     * ficar nítido quando o ecrã está ampliado (info.scale): o canvas tem
     * size x scale pixels e o contexto já vem ampliado, por isso o resto do
     * código desenha como se a escala fosse 1. Devolve o contexto, limpo.
     */
    canvas(canvas, size, scale = 1) {
      const w = Math.max(1, Math.round(size.width * scale)), h = Math.max(1, Math.round(size.height * scale));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      // O documento está ampliado pelo zoom do CSS: o tamanho em CSS é o de desenho.
      canvas.style.width = size.width + 'px';
      canvas.style.height = size.height + 'px';
      const ctx = canvas.getContext('2d');
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.clearRect(0, 0, size.width, size.height);
      return ctx;
    },

    /** Valor de um sensor com `decimals` casas, ou "--" se não houver leitura. */
    format(sensor, decimals = 0) {
      if (!sensor || sensor.value == null) return '--';
      return Number(sensor.value).toFixed(Math.max(0, Math.min(3, decimals | 0)));
    },

    /** Posição do valor entre min e max, limitada a 0..1. */
    fraction(value, min, max) {
      if (value == null || max === min) return 0;
      return Math.max(0, Math.min(1, (value - min) / (max - min)));
    },

    /** Locale para datas e números no idioma da app. */
    locale(info) {
      return info && info.lang === 'pt' ? 'pt-PT' : 'en-GB';
    },

    /** Percentagem 0..100 (de uma propriedade "Opacidade") para o valor CSS 0..1. */
    opacity(percent) {
      const n = Number(percent);
      return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) / 100 : 1;
    },

    /** Aplica vários atributos a um elemento (útil para SVG). */
    attrs(el, values) {
      for (const [k, v] of Object.entries(values)) el.setAttribute(k, v);
      return el;
    },

    /**
     * Interpola duas cores "#rrggbb" pelo matiz (HSL): de azul para vermelho
     * passa por verde e amarelo em vez de ficar cinzento.
     */
    mix(a, b, t) {
      const ha = toHsl(rgb(a)), hb = toHsl(rgb(b));
      if (ha[1] === 0) ha[0] = hb[0];
      if (hb[1] === 0) hb[0] = ha[0];
      const c = fromHsl(ha.map((v, i) => v + (hb[i] - v) * t));
      return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
    },
  };
})();
