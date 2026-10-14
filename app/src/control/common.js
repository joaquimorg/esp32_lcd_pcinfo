'use strict';

// Estado partilhado pelas duas vistas (Execução e Editor) e utilitários de UI.

const ipc = window.api;

let config = null;
let catalog = {};          // tipo -> { type, name, description, size, properties, builtin } (já traduzido)
let rawCatalog = [];       // como vem do processo principal (com manifest.i18n)
let sensors = [];
let size = { width: 240, height: 320 };
let thumbs = {};           // id do widget -> data URL
let transitionTypes = [];  // tipos de transição (ver src/main/transitions.js)
let t = I18N.translator(I18N.DEFAULT_LANGUAGE);
let language = I18N.DEFAULT_LANGUAGE;
let appVersion = '';
let playerState = { mode: 'run', currentId: null, remainingSec: null };
// controller: o que o ESP32 reporta; viewport: a área visível em uso (auto ou manual)
let displayState = { controller: { width: 240, height: 320 }, viewport: { x: 0, y: 0, width: 240, height: 320 }, auto: true, calibrating: false };

const $ = (sel) => document.querySelector(sel);

/** Muda o idioma da janela: textos fixos (data-i18n) e catálogo; as vistas são redesenhadas por quem chama. */
function setLanguage(lang) {
  language = I18N.normalizeLanguage(lang);
  t = I18N.translator(language);
  document.documentElement.lang = language;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  localizeCatalog();
}

/** [tipo, nome] das transições no idioma atual. */
function transitionOptions() {
  return transitionTypes.map((id) => [id, t('tr.' + id)]);
}

/** Criação de elementos: h('div', { class: 'x', onclick }, filho, ...) */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
}

const newId = (prefix) => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const screenById = (id) => config.screens.find((s) => s.id === id) || null;

function commit() {
  ipc.setConfig(config);
}

function setCatalog(list) {
  rawCatalog = list;
  localizeCatalog();
}

function localizeCatalog() {
  catalog = Object.fromEntries(rawCatalog.map((c) => [c.type, I18N.localizeManifest(c, language)]));
}

function showMessage(el, text, kind) {
  el.hidden = false;
  el.className = 'msg ' + (kind || '');
  el.textContent = text;
}

function newScreen(name) {
  return { id: newId('s'), name, enabled: false, durationSec: 10, background: '#000000', components: [] };
}

function duplicateScreen(screen) {
  const copy = structuredClone(screen);
  copy.id = newId('s');
  copy.name = t('screen.copyName', { name: screen.name });
  copy.enabled = false;
  for (const c of copy.components) c.id = newId('c');
  config.screens.splice(config.screens.indexOf(screen) + 1, 0, copy);
  return copy;
}

/* ------------------------------------------------------------------------ */
/* Campos de formulário                                                      */
/* ------------------------------------------------------------------------ */

function field(label, input, inline = false) {
  return h('div', { class: 'field' + (inline ? ' inline' : '') }, h('label', {}, label), input);
}

function textInput(value, onChange) {
  return h('input', { type: 'text', value: value ?? '', oninput: (e) => onChange(e.target.value) });
}

function numberInput(value, onChange, { min, max, step } = {}) {
  return h('input', {
    type: 'number', value: value ?? '', min, max, step: step ?? 'any',
    oninput: (e) => {
      const v = e.target.valueAsNumber;
      if (Number.isFinite(v)) onChange(v);
    },
  });
}

function toggle(value, onChange) {
  return h('label', { class: 'switch' },
    h('input', { type: 'checkbox', checked: !!value, onchange: (e) => onChange(e.target.checked) }),
    h('span'));
}

function colorInput(value, onChange) {
  const code = h('code', {}, value);
  return h('div', { class: 'color-row' },
    h('input', { type: 'color', value: value || '#ffffff', oninput: (e) => { code.textContent = e.target.value; onChange(e.target.value); } }),
    code);
}

/** Lista de escolha com valor e texto diferentes: options = [[valor, texto], ...]. */
function choiceInput(value, options, onChange) {
  return h('select', { onchange: (e) => onChange(e.target.value) },
    options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
}

/** labels: { valor: texto } opcional (o valor guardado não muda com o idioma). */
function selectInput(value, options, onChange, labels = {}) {
  return h('select', { onchange: (e) => onChange(e.target.value) },
    options.map((o) => h('option', { value: o, selected: String(o) === String(value) }, labels[o] ?? o)));
}

function formatSensor(s) {
  if (!s) return t('field.sensorMissing');
  return s.value == null ? '--' : `${Number(s.value).toFixed(s.value % 1 ? 1 : 0)} ${s.unit}`;
}

/** Escolha de sensor: pesquisa + lista agrupada por hardware. */
function sensorPicker(value, onChange) {
  const live = h('div', { class: 'sensor-live', 'data-sensor': value || '' });
  const select = h('select', {
    onchange: (e) => {
      onChange(e.target.value || null);
      live.dataset.sensor = e.target.value;
      updateLive();
    },
  });

  const fill = (filter) => {
    const f = (filter || '').toLowerCase();
    select.innerHTML = '';
    select.append(h('option', { value: '' }, t('field.none')));
    const groups = new Map();
    for (const s of sensors) {
      const text = `${s.hardware} ${s.group} ${s.name} ${s.id}`.toLowerCase();
      if (f && !text.includes(f) && s.id !== value) continue;
      if (!groups.has(s.hardware)) groups.set(s.hardware, []);
      groups.get(s.hardware).push(s);
    }
    for (const [hw, list] of groups) {
      select.append(h('optgroup', { label: hw },
        list.map((s) => h('option', { value: s.id, selected: s.id === value }, `${s.name} · ${s.group}`))));
    }
    if (value && !sensors.some((s) => s.id === value)) {
      select.append(h('option', { value, selected: true }, t('field.unavailable', { id: value })));
    }
  };
  const updateLive = () => {
    const s = sensors.find((x) => x.id === live.dataset.sensor);
    live.textContent = live.dataset.sensor ? t('field.now', { value: formatSensor(s) }) : '';
  };

  fill('');
  updateLive();
  return h('div', { class: 'form', style: 'gap:6px' },
    h('input', { type: 'search', placeholder: t('field.searchSensor'), oninput: (e) => fill(e.target.value) }),
    select,
    live);
}

function filePicker(value, onChange) {
  const pathEl = h('span', { class: 'path', title: value || '' }, value || t('field.noFile'));
  return h('div', { class: 'file-row' },
    pathEl,
    h('button', {
      class: 'btn small',
      onclick: async () => {
        const file = await ipc.pickImage();
        if (file) { pathEl.textContent = file; pathEl.title = file; onChange(file); }
      },
    }, t('field.choose')));
}

/** Campo para uma propriedade do manifest de um componente. */
function propField(def, value, onChange) {
  const v = value ?? def.default;
  switch (def.type) {
    case 'number': return field(def.label, numberInput(v, onChange, def));
    case 'color': return field(def.label, colorInput(v, onChange), true);
    case 'boolean': return field(def.label, toggle(v, onChange), true);
    case 'select': return field(def.label, selectInput(v, def.options || [], onChange, def.optionLabels));
    case 'sensor': return field(def.label, sensorPicker(v, onChange));
    case 'file': return field(def.label, filePicker(v, onChange));
    default: return field(def.label, textInput(v, onChange));
  }
}

/* ------------------------------------------------------------------------ */
/* Importar widgets (.lcdwidget) — usado nas duas vistas                     */
/* ------------------------------------------------------------------------ */

async function importScreens(msgEl) {
  const res = await ipc.importScreens();
  if (res.canceled) return [];
  if (res.imported.length) {
    config = res.config;
    setCatalog(res.catalog);
  }
  const names = res.imported.map((id) => `"${screenById(id).name}"`).join(', ');
  if (res.errors.length) {
    showMessage(msgEl, (names ? t('import.partial', { names }) : '') + t('import.failed', { errors: res.errors.join('; ') }), 'bad');
  } else {
    showMessage(msgEl, t('import.done', { names }), 'ok');
  }
  return res.imported;
}
