'use strict';

// Compõe o ecrã (widget) atual: cada componente corre num iframe isolado e
// recebe as props (com os sensores já resolvidos) por postMessage — ver widgets/_sdk.

let pageEl = document.getElementById('page');   // página do ecrã atual
const messageEl = document.getElementById('message');
let frames = new Map();     // id do componente -> { iframe, url, widget, loaded } (ecrã atual)
let sensors = {};
let sensorSeq = 0;          // incrementa a cada leitura nova dos sensores
const HISTORY = 600;        // leituras guardadas por sensor
const history = new Map();  // id do sensor -> últimos valores
let currentScreenId;
let lang = I18N.DEFAULT_LANGUAGE;   // idioma da app (vem em cada layout)
let transition = null;      // troca de ecrã em curso: { old, page, anims }
const LOAD_TIMEOUT_MS = 1500;   // espera máxima pelos componentes do ecrã novo

function resolveProps(widget) {
  const props = { ...widget.props };
  for (const key of widget.sensorProps) {
    const sensor = sensors[props[key]];
    props[key] = sensor ? { ...sensor, history: history.get(sensor.id) || [] } : null;
  }
  return props;
}

function post(entry) {
  if (!entry.loaded) return;
  const { widget } = entry;
  entry.iframe.contentWindow.postMessage({
    type: 'widget:update',
    props: resolveProps(widget),
    size: { width: widget.w, height: widget.h },
    sensorSeq,
    lang,
  }, '*');
}

/**
 * Padrão de calibração do painel: o controlador inteiro, com réguas em
 * pixels absolutos, e a área visível configurada contornada a verde.
 */
function drawCalibration({ controller, viewport: vp }) {
  const t = I18N.translator(lang);
  const canvas = document.getElementById('calibration');
  const W = controller.width, H = controller.height;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  // Fora da área visível: vermelho escuro.
  ctx.fillStyle = '#3a0d0d';
  ctx.fillRect(0, 0, W, vp.y);
  ctx.fillRect(0, vp.y + vp.height, W, H - vp.y - vp.height);
  ctx.fillRect(0, vp.y, vp.x, vp.height);
  ctx.fillRect(vp.x + vp.width, vp.y, W - vp.x - vp.width, vp.height);

  // Grelha.
  for (let p = 10; p < Math.max(W, H); p += 10) {
    ctx.fillStyle = p % 50 === 0 ? '#3a3f47' : '#1c1f24';
    if (p < W) ctx.fillRect(p, 0, 1, H);
    if (p < H) ctx.fillRect(0, p, W, 1);
  }

  // Área visível configurada.
  ctx.strokeStyle = '#00ff66';
  ctx.lineWidth = 2;
  ctx.strokeRect(vp.x + 1, vp.y + 1, vp.width - 2, vp.height - 2);

  // Réguas (por cima da linha verde, com fundo para se lerem sempre): números
  // das linhas (y) dos dois lados e das colunas (x) em cima e em baixo.
  ctx.font = '600 11px "Segoe UI", sans-serif';
  ctx.textBaseline = 'middle';
  const label = (text, x, y, align) => {
    const w = ctx.measureText(text).width + 4;
    const left = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
    ctx.fillStyle = 'rgba(0,0,0,.75)';
    ctx.fillRect(left, y - 7, w, 14);
    ctx.fillStyle = '#e6e8eb';
    ctx.textAlign = 'left';
    ctx.fillText(text, left + 2, y);
  };
  for (let y = 0; y <= H; y += 20) {
    const ty = Math.min(H - 7, Math.max(7, y));
    label(String(y), 1, ty, 'left');
    label(String(y), W - 1, ty, 'right');
  }
  for (let x = 40; x < W - 20; x += 40) {
    label(String(x), x, 7, 'center');
    label(String(x), x, H - 7, 'center');
  }

  // Informação ao centro.
  const cx = vp.x + vp.width / 2, cy = vp.y + vp.height / 2;
  ctx.fillStyle = 'rgba(0,0,0,.8)';
  ctx.fillRect(cx - 95, cy - 46, 190, 92);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#00ff66';
  ctx.font = '600 15px "Segoe UI", sans-serif';
  ctx.fillText(t('cal.area', { w: vp.width, h: vp.height }), cx, cy - 26);
  ctx.fillStyle = '#e6e8eb';
  ctx.font = '12px "Segoe UI", sans-serif';
  ctx.fillText(t('cal.start', { x: vp.x, y: vp.y }), cx, cy - 6);
  ctx.fillText(t('cal.controller', { w: W, h: H }), cx, cy + 12);
  ctx.fillStyle = '#9aa0a6';
  ctx.fillText(t('cal.hint'), cx, cy + 32);
}

/** Cria, atualiza e remove os iframes do ecrã atual para coincidirem com o layout. */
function syncFrames(layout) {
  const ids = new Set(layout.components.map((w) => w.id));
  for (const [id, entry] of frames) {
    const next = layout.components.find((w) => w.id === id);
    if (!ids.has(id) || next.url !== entry.url) {
      entry.iframe.remove();
      frames.delete(id);
    }
  }

  layout.components.forEach((widget, z) => {
    let entry = frames.get(widget.id);
    if (!entry) {
      const iframe = document.createElement('iframe');
      iframe.setAttribute('scrolling', 'no');
      entry = { iframe, url: widget.url, widget, loaded: false };
      const e = entry;
      iframe.addEventListener('load', () => {
        e.loaded = true;
        post(e);
      });
      iframe.src = widget.url;
      frames.set(widget.id, entry);
      pageEl.appendChild(iframe);
    }
    entry.widget = widget;
    Object.assign(entry.iframe.style, {
      left: widget.x + 'px',
      top: widget.y + 'px',
      width: widget.w + 'px',
      height: widget.h + 'px',
      zIndex: String(z),
    });
    post(entry);
  });
}

function sizePage(page, layout) {
  Object.assign(page.style, { width: layout.width + 'px', height: layout.height + 'px', background: layout.background });
}

/** Termina já a troca em curso (ex: chegou outro ecrã a meio da animação). */
function finishTransition() {
  if (!transition) return;
  const { old, page, anims } = transition;
  transition = null;
  for (const a of anims) a.cancel();
  old.remove();
  page.style.visibility = '';
}

/** Espera que os componentes do ecrã novo carreguem e desenhem (com limite). */
async function waitForFrames(entries) {
  const until = Date.now() + LOAD_TIMEOUT_MS;
  while (Date.now() < until && entries.some((e) => !e.loaded)) await new Promise((r) => setTimeout(r, 30));
  // Tempo para o primeiro desenho depois de receberem as props.
  await new Promise((r) => setTimeout(r, 80));
}

/** Animações (Web Animations) do ecrã novo e do antigo para cada tipo de transição. */
function transitionKeyframes(type, w, h) {
  const at = (x, y) => `translate(${x}px, ${y}px)`;
  const slide = { left: [w, 0], right: [-w, 0], up: [0, h], down: [0, -h] };
  const [kind, dir] = type.split('-');
  if (kind === 'slide' && slide[dir]) {
    return { page: [{ transform: at(...slide[dir]) }, { transform: at(0, 0) }] };
  }
  if (kind === 'push' && slide[dir]) {
    const [x, y] = slide[dir];
    return {
      page: [{ transform: at(x, y) }, { transform: at(0, 0) }],
      old: [{ transform: at(0, 0) }, { transform: at(-x, -y) }],
    };
  }
  switch (type) {
    case 'zoom':
      return { page: [{ transform: 'scale(0.4)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }] };
    case 'wipe-right':
      return { page: [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }] };
    case 'wipe-down':
      return { page: [{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0 0)' }] };
    case 'circle':
      return { page: [{ clipPath: 'circle(0% at 50% 50%)' }, { clipPath: 'circle(75% at 50% 50%)' }] };
    default:   // fade
      return { page: [{ opacity: 0 }, { opacity: 1 }] };
  }
}

/** Troca de ecrã: o antigo fica à vista enquanto o novo carrega; depois anima. */
async function changeScreen(layout) {
  finishTransition();
  const first = currentScreenId === undefined;
  currentScreenId = layout.screenId;

  const old = pageEl;
  const page = document.createElement('div');
  page.className = 'page';
  page.style.visibility = 'hidden';
  sizePage(page, layout);
  old.after(page);
  pageEl = page;
  frames = new Map();
  syncFrames(layout);

  const t = layout.transition || { type: 'none', durationMs: 0 };
  const current = { old, page, anims: [] };
  transition = current;
  if (!first) await waitForFrames([...frames.values()]);
  if (transition !== current) return;   // entretanto chegou outro ecrã

  page.style.visibility = '';
  if (first || t.type === 'none' || !t.durationMs) {
    finishTransition();
    return;
  }
  const keys = transitionKeyframes(t.type, layout.width, layout.height);
  const opts = { duration: t.durationMs, easing: 'ease-in-out', fill: 'both' };
  current.anims.push(page.animate(keys.page, opts));
  if (keys.old) current.anims.push(old.animate(keys.old, opts));
  await Promise.all(current.anims.map((a) => a.finished.catch(() => {})));
  if (transition === current) finishTransition();
}

function applyLayout(layout) {
  lang = I18N.normalizeLanguage(layout.lang);
  const calibrationEl = document.getElementById('calibration');
  calibrationEl.hidden = !layout.calibration;
  if (layout.calibration) drawCalibration(layout.calibration);

  messageEl.textContent = layout.message || '';
  messageEl.hidden = !layout.message;

  if (layout.screenId !== currentScreenId) {
    changeScreen(layout);
    return;
  }
  sizePage(pageEl, layout);
  syncFrames(layout);
}

window.displayApi.onLayout(applyLayout);
window.displayApi.onSensors((s) => {
  sensors = s;
  sensorSeq++;
  for (const sensor of Object.values(s)) {
    let h = history.get(sensor.id);
    if (!h) history.set(sensor.id, (h = []));
    h.push(sensor.value);
    if (h.length > HISTORY) h.splice(0, h.length - HISTORY);
  }
  for (const entry of frames.values()) post(entry);
});
