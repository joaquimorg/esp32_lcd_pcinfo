'use strict';

// Vista Definições: idioma, arranque, sensores, ligação ao ESP32, área visível
// do LCD (com o padrão de calibração) e "sobre".

function renderSettingsView() {
  renderGeneralSettings();
  renderSensorSettings();
  renderConnectionSettings();
  renderDisplaySettings();
  renderAbout();
}

function renderGeneralSettings() {
  const box = $('#settingsGeneral');
  box.innerHTML = '';
  box.append(
    field(language === 'en' ? t('settings.language') : `${t('settings.language')} / Language`, choiceInput(language, I18N.LANGUAGES, (v) => {
      config.language = v;
      commit();
      applyLanguage(v);
    })),
    field(t('settings.startup'), toggle(config.startWithWindows, (v) => { config.startWithWindows = v; commit(); }), true),
  );
}

function renderSensorSettings() {
  const box = $('#settingsSensors');
  box.innerHTML = '';
  box.append(
    field(t('settings.lhm'), textInput(config.lhmUrl, (v) => { config.lhmUrl = v.trim(); commit(); })),
    field(t('settings.sensorMs'), numberInput(config.sensorIntervalMs, (v) => { config.sensorIntervalMs = Math.max(250, v); commit(); }, { min: 250, step: 250 })),
    h('p', { class: 'desc' }, t('settings.lhmHelp')),
  );
}

function renderConnectionSettings() {
  const box = $('#settingsConnection');
  box.innerHTML = '';
  box.append(
    field(t('settings.port'), portPicker()),
    field(t('settings.fps'), numberInput(config.frameRate, (v) => { config.frameRate = clamp(Math.round(v), 1, 60); commit(); }, { min: 1, max: 60 })),
  );
}

function renderAbout() {
  const box = $('#about');
  box.innerHTML = '';
  box.append(
    t('about.text', { name: 'USB LCD Widgets', version: appVersion, year: new Date().getFullYear() }), ' ',
    // Abre no navegador do sistema (a janela da app não navega para fora).
    h('a', { href: '#', title: t('about.siteTitle'), onclick: (e) => { e.preventDefault(); ipc.openSite(); } }, 'joaquim.org'),
    ' · ', t('about.license'));
}

/* ---- Ecrã do LCD: área visível e calibração ---- */

const ANIM_LEVELS = ['quality', 'balanced', 'smooth'];

function renderDisplaySettings() {
  const box = $('#displaySettings');
  box.innerHTML = '';
  const { controller } = displayState;
  const manual = !!config.display;
  const vp = config.display || displayState.viewport;

  const geo = (key, label, max) => field(label, h('input', {
    type: 'number', min: 0, max, step: 1, value: vp[key], disabled: !manual,
    oninput: (e) => {
      const v = e.target.valueAsNumber;
      if (!Number.isFinite(v)) return;
      config.display[key] = Math.round(v);
      commit();
    },
  }));

  box.append(
    h('p', { class: 'desc', id: 'ctrlInfo' }),
    ...(displayState.rotatable ? [
      field(t('display.rotation'), choiceInput(Number.isInteger(config.rotation) ? config.rotation & 3 : 0,
        [0, 1, 2, 3].map((r) => [r, r * 90 + '°']), (v) => {
          config.rotation = Number(v);
          config.display = null;
          commit();
          renderDisplaySettings();
        })),
      h('p', { class: 'desc' }, t('display.rotationHelp')),
    ] : []),
    field(t('display.manual'), toggle(manual, (v) => {
      config.display = v ? { ...displayState.viewport } : null;
      commit();
      renderDisplaySettings();
    }), true),
    h('div', { class: 'grid4' },
      geo('x', 'X', controller.width), geo('y', 'Y', controller.height),
      geo('width', t('display.width'), controller.width), geo('height', t('display.height'), controller.height)),
    field(t('display.calibration'), toggle(displayState.calibrating, (v) => ipc.setCalibration(v)), true),
    h('p', { class: 'desc' }, t('display.help')),
    field(t('display.scale'), choiceInput(Scaling.normalizeMode(config.scaleMode),
      Scaling.MODES.map((m) => [m, t('display.scale.' + m)]), (v) => {
        config.scaleMode = v;
        commit();
        renderDisplaySettings();
      })),
    h('p', { class: 'desc' }, t('display.scaleHelp.' + Scaling.normalizeMode(config.scaleMode))),
    field(t('display.anim'), choiceInput(ANIM_LEVELS.includes(config.animQuality) ? config.animQuality : 'quality',
      ANIM_LEVELS.map((m) => [m, t('display.anim.' + m)]), (v) => {
        config.animQuality = v;
        commit();
        renderDisplaySettings();
      })),
    h('p', { class: 'desc' }, t('display.animHelp.' + (ANIM_LEVELS.includes(config.animQuality) ? config.animQuality : 'quality'))),
  );
  updateDisplayInfo();
}

/** Atualiza só os textos do painel (chamado a cada estado). */
function updateDisplayInfo() {
  const el = $('#ctrlInfo');
  if (!el) return;
  const { controller, viewport } = displayState;
  el.textContent = t('display.info', { cw: controller.width, ch: controller.height, w: viewport.width, h: viewport.height })
    + (viewport.x || viewport.y ? t('display.infoOffset', { x: viewport.x, y: viewport.y }) : '.');
}

/* ---- Escolha da porta ---- */

let portList = [];

/** Lista das portas série com a informação de cada uma; 'auto' procura o ESP32 sozinho. */
function portPicker() {
  const select = h('select', {
    id: 'portSelect',
    onchange: (e) => {
      config.port = e.target.value;
      commit();
      updatePortDetails();
    },
  });
  const refresh = h('button', { class: 'btn small', title: t('port.refresh'), onclick: () => loadPorts() }, '↻');
  const details = h('div', { id: 'portDetails', class: 'port-details' });
  const box = h('div', { class: 'form', style: 'gap:6px' }, h('div', { class: 'port-row' }, select, refresh), details);
  fillPortSelect(select, details);
  loadPorts();
  return box;
}

async function loadPorts() {
  portList = await ipc.listPorts();
  const select = $('#portSelect');
  if (select) fillPortSelect(select, $('#portDetails'));
}

function portLabel(p) {
  const tags = [p.connected ? t('port.connected') : null, !p.connected && p.last ? t('port.lastUsed') : null].filter(Boolean);
  return [p.path, p.short || t('port.short.' + p.kind), ...tags].join(' · ');
}

function fillPortSelect(select, details) {
  const current = config.port || 'auto';
  select.innerHTML = '';
  select.append(h('option', { value: 'auto', selected: current === 'auto' }, t('port.auto')));
  for (const p of portList) {
    select.append(h('option', { value: p.path, selected: p.path === current }, portLabel(p)));
  }
  if (current !== 'auto' && !portList.some((p) => p.path === current)) {
    select.append(h('option', { value: current, selected: true }, t('port.notFound', { port: current })));
  }
  updatePortDetails(details);
}

function updatePortDetails(box = $('#portDetails')) {
  if (!box) return;
  box.innerHTML = '';
  const current = config.port || 'auto';
  if (current === 'auto') {
    const found = portList.filter((p) => p.usable).map((p) => p.path);
    box.append(h('p', { class: 'desc' },
      t('port.autoHelp'),
      found.length ? t('port.candidates', { list: found.join(', ') }) : t('port.noneNow')));
    return;
  }
  const p = portList.find((x) => x.path === current);
  if (!p) {
    box.append(h('p', { class: 'desc warn' }, t('port.missing', { port: current })));
    return;
  }
  const rows = [
    [t('port.type'), t('port.kind.' + p.kind, { name: p.uart })],
    [t('port.name'), p.name],
    [t('port.maker'), p.manufacturer],
    [t('port.vidpid'), p.vid ? `${p.vid}:${p.pid}` : ''],
    [t('port.serial'), p.serialNumber],
    [t('port.state'), p.connected ? t('port.lcdHere') : t('port.noLcd')],
  ].filter(([, v]) => v);
  box.append(h('dl', { class: 'port-info' }, rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
  if (!p.usable) {
    box.append(h('p', { class: 'desc warn' },
      t('port.notUsable'),
      p.kind === 'jtag' ? t('port.jtagWarn') : ''));
  }
}
