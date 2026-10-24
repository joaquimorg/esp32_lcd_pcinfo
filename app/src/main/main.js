'use strict';

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog, shell, clipboard } = require('electron');
const { Device, listPorts } = require('./device');
const { FrameSender } = require('./frame-sender');
const { Sensors } = require('./sensors');
const { ConfigStore, newId } = require('./config');
const { Player } = require('./player');
const { Thumbnailer } = require('./thumbnails');
const { exportScreen, importScreen } = require('./screens');
const { scanWidgets, withDefaults, ensureUserWidgetsDir, importWidget } = require('./widgets');
const { imageFileSize } = require('./images');
const { TRANSITIONS, resolveTransition } = require('./transitions');
const I18N = require('../i18n');
const P = require('./protocol');

const ROOT = path.join(__dirname, '..', '..');
const BUILTIN_WIDGETS = path.join(ROOT, 'widgets');
const DISPLAY_HTML = path.join(ROOT, 'src', 'display', 'display.html');
const DISPLAY_PRELOAD = path.join(__dirname, '..', 'preload', 'display.js');
const PREVIEW_INTERVAL_MS = 100;
const SITE_URL = 'https://joaquim.org';
const THUMB_DEBOUNCE_MS = 1200;

// --screenshot=<pasta>: grava imagens do LCD e da janela de gestão e sai (para testes).
const screenshotArg = process.argv.find((a) => a.startsWith('--screenshot='));
const SCREENSHOT_DIR = screenshotArg ? screenshotArg.split('=')[1] : null;
// Nos testes a janela pode estar tapada por outras: o Windows deixaria de a pintar.
if (SCREENSHOT_DIR) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// --hidden: arranque com o Windows, fica só no tray.
const START_HIDDEN = process.argv.includes('--hidden');
// --profile=<pasta>: usa outra pasta de dados (testes sem tocar na configuração real).
const profileArg = process.argv.find((a) => a.startsWith('--profile='));
if (profileArg) app.setPath('userData', profileArg.split('=')[1]);

if (!app.requestSingleInstanceLock()) app.quit();

const store = new ConfigStore(app.getPath('userData'));
const userWidgetsDir = path.join(app.getPath('userData'), 'widgets');
const assetsDir = path.join(app.getPath('userData'), 'assets');
const device = new Device();
const sender = new FrameSender(device);
const sensors = new Sensors();
const player = new Player();

let config;
let state;
let catalog = {};
let builtinTypes = new Set();
let displayWin = null;
let controlWin = null;
let tray = null;
let thumbnailer = null;
let size = { width: 240, height: 320 };        // área visível: o tamanho dos widgets
let controller = { width: 240, height: 320 };  // controlador do LCD (reportado pelo ESP32)
let renderGeom = { x: 0, y: 0, width: 240, height: 320 };  // o que a janela do LCD desenha agora
let calibrating = false;
let lastPreview = 0;
let lastFrameImage = null;
let quitting = false;
let deviceErrors = 0;
const thumbs = new Map();   // id do ecrã -> { key, url }

const screenById = (id) => config.screens.find((s) => s.id === id) || null;

/** Tradução no idioma configurado (inglês por omissão). */
function t(key, vars) {
  return I18N.translator(config && config.language)(key, vars);
}
const errorText = (err) => (err.key ? t(err.key, err.vars) : err.message);
const language = () => I18N.normalizeLanguage(config && config.language);

/* ------------------------------------------------------------------------ */
/* Janela offscreen: o conteúdo do LCD                                       */
/* ------------------------------------------------------------------------ */

/** Mostra na consola os erros das páginas (LCD, componentes e janela de gestão). */
function logConsole(name, webContents) {
  webContents.on('console-message', (e) => {
    if (e.level === 'warning' || e.level === 'error') {
      console.log(`[${name}] ${e.message} (${e.sourceId}:${e.lineNumber})`);
    }
  });
}

function createDisplayWindow() {
  displayWin = new BrowserWindow({
    width: renderGeom.width,
    height: renderGeom.height,
    useContentSize: true,
    show: false,
    frame: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, preload: DISPLAY_PRELOAD },
  });
  logConsole('lcd', displayWin.webContents);
  displayWin.webContents.setFrameRate(config.frameRate);
  displayWin.webContents.on('paint', (_e, _dirty, image) => onPaint(image));
  displayWin.webContents.on('did-finish-load', () => {
    sendLayout();
    displayWin.webContents.send('sensors', sensors.snapshot);
  });
  displayWin.loadFile(DISPLAY_HTML);
}

function onPaint(image) {
  const { width, height } = renderGeom;
  const s = image.getSize();
  if (s.width !== width || s.height !== height) {
    // Ecrã com escala (ex: 125%), ou a meio de uma mudança de tamanho.
    image = image.resize({ width, height, quality: 'best' });
  }
  lastFrameImage = image;
  const frame = P.bgraToRgb565(image.toBitmap(), new Uint16Array(width * height));
  sender.submit(frame);

  const now = Date.now();
  if (controlWin && controlWin.isVisible() && now - lastPreview >= PREVIEW_INTERVAL_MS) {
    lastPreview = now;
    controlWin.webContents.send('preview', image.toDataURL());
  }
}

/** Área visível: a configurada na app ou, em automático, o controlador inteiro. */
function viewport() {
  const d = config.display;
  if (!d) return { x: 0, y: 0, width: controller.width, height: controller.height };
  const x = clamp(Math.round(d.x) || 0, 0, controller.width - 16);
  const y = clamp(Math.round(d.y) || 0, 0, controller.height - 16);
  return {
    x, y,
    width: clamp(Math.round(d.width) || controller.width, 16, controller.width - x),
    height: clamp(Math.round(d.height) || controller.height, 16, controller.height - y),
  };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Aplica a área visível (ou o controlador inteiro durante a calibração) à
 * janela do LCD e ao envio de frames, e comunica-a ao ESP32.
 */
function applyGeometry() {
  const vp = viewport();
  const sizeChanged = vp.width !== size.width || vp.height !== size.height;
  size = { width: vp.width, height: vp.height };
  renderGeom = calibrating ? { x: 0, y: 0, ...controller } : vp;
  sender.setGeometry(renderGeom, controller);
  if (displayWin) displayWin.setContentSize(renderGeom.width, renderGeom.height);

  const dv = device.info?.viewport;
  if (device.ready && (!dv || dv.x !== vp.x || dv.y !== vp.y || dv.width !== vp.width || dv.height !== vp.height)) {
    device.setViewport(vp);
  }
  sendLayout();
  if (sizeChanged) refreshThumbs(true);
  sendStatus();
}

function setCalibrating(on) {
  if (calibrating === !!on) return;
  calibrating = !!on;
  applyGeometry();
}

/** Padrão de calibração: o controlador inteiro com réguas e a área visível marcada. */
function calibrationLayout() {
  return {
    screenId: '__calibration',
    width: controller.width,
    height: controller.height,
    background: '#000000',
    lang: language(),
    components: [],
    calibration: { controller, viewport: viewport() },
  };
}

/**
 * @param animate  com transição ao entrar neste ecrã (só no LCD em execução;
 *                 o editor e as miniaturas trocam de imediato)
 */
function buildLayout(screen, animate = false) {
  if (!screen) {
    return { screenId: null, width: size.width, height: size.height, background: '#000000', lang: language(), components: [], message: t('msg.noActive') };
  }
  return {
    screenId: screen.id,
    lang: language(),
    transition: animate ? resolveTransition(screen, config) : { type: 'none', durationMs: 0 },
    width: size.width,
    height: size.height,
    background: screen.background || '#000000',
    components: screen.components
      .filter((c) => catalog[c.type])
      .map((c) => {
        const type = catalog[c.type];
        const props = withDefaults(type, c.props);
        for (const p of type.properties) {
          if (p.type === 'file' && props[p.key]) props[p.key] = pathToFileURL(props[p.key]).href;
        }
        return {
          id: c.id,
          url: type.url,
          x: c.x, y: c.y, w: c.w, h: c.h,
          props,
          sensorProps: type.properties.filter((p) => p.type === 'sensor').map((p) => p.key),
        };
      }),
  };
}

function sendLayout() {
  if (!displayWin) return;
  displayWin.webContents.send('layout', calibrating
    ? calibrationLayout()
    : buildLayout(screenById(player.currentId), player.mode === 'run'));
}

function updatePlayer() {
  if (config && player.update(config.screens)) {
    sendLayout();
    sendStatus();
  }
}
setInterval(updatePlayer, 250);

/* ------------------------------------------------------------------------ */
/* Miniaturas                                                                */
/* ------------------------------------------------------------------------ */

let thumbTimer = null;

/** Pede miniaturas novas para os ecrãs que mudaram desde a última. */
function refreshThumbs(now = false) {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => {
    const changed = [];
    for (const s of config.screens) {
      const key = JSON.stringify([s.background, s.components, size, language()]);
      if (thumbs.get(s.id)?.key !== key) {
        thumbs.set(s.id, { key, url: thumbs.get(s.id)?.url || null });
        changed.push(s.id);
      }
    }
    for (const id of thumbs.keys()) if (!screenById(id)) thumbs.delete(id);
    if (changed.length) thumbnailer.request(changed);
  }, now ? 0 : THUMB_DEBOUNCE_MS);
}

/* ------------------------------------------------------------------------ */
/* Janela de gestão                                                          */
/* ------------------------------------------------------------------------ */

function createControlWindow() {
  controlWin = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 980,
    minHeight: 660,
    title: 'USB LCD Widgets',
    icon: trayIcon(32),
    backgroundColor: '#14161a',
    show: !SCREENSHOT_DIR && !START_HIDDEN,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'control.js'),
      backgroundThrottling: !SCREENSHOT_DIR,
    },
  });
  logConsole('gestão', controlWin.webContents);
  controlWin.loadFile(path.join(ROOT, 'src', 'control', 'index.html'));
  controlWin.on('close', (e) => {
    // Fechar a janela só a esconde: o LCD continua a ser atualizado.
    if (!quitting) {
      e.preventDefault();
      controlWin.hide();
    }
  });
  // Sem a janela à vista não há edição nem calibração: o LCD volta à execução normal.
  controlWin.on('hide', () => {
    setCalibrating(false);
    setMode('run');
  });
}

function openControl() {
  if (!controlWin) createControlWindow();
  controlWin.show();
  controlWin.focus();
}

function sendToControl(channel, data) {
  if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send(channel, data);
}

function deviceStatus() {
  return device.info ? { connected: true, ...device.info } : { connected: false, path: null };
}

let rateCounters = { fps: 0, kbps: 0 };
setInterval(() => {
  const c = sender.takeCounters();
  rateCounters = { fps: c.frames, kbps: c.bytes / 1024 };
  // LCD_DEBUG=1: débito no terminal, para diagnosticar a ligação.
  if (process.env.LCD_DEBUG) {
    const kb = (n) => Math.round(n / 1024);
    // Por formato (KB), retângulos e pixels enviados / pixels que mudaram de facto.
    console.log(`[rate] ${c.frames} fps, ${kb(c.bytes)} KB/s`
      + ` (raw ${kb(c.byType.raw)}, rle ${kb(c.byType.rle)}, lz4 ${kb(c.byType.lz4)}, fill ${kb(c.byType.fill)})`
      + `, ${c.rects} rects, ${c.sentPx}/${c.changedPx} px enviados/alterados`);
  }
  sendStatus();
}, 1000);

function playerStatus() {
  return {
    mode: player.mode,
    currentId: player.currentId,
    remainingSec: config ? player.remainingSec(config.screens) : null,
  };
}

function sendStatus() {
  sendToControl('status', {
    device: deviceStatus(),
    lhm: sensors.lhmStatus,
    fps: rateCounters.fps,
    kbps: rateCounters.kbps,
    deviceErrors,
    player: playerStatus(),
    size,
    display: { controller, viewport: viewport(), auto: !config?.display, calibrating },
  });
}

function setMode(mode, screenId = null) {
  player.setMode(mode, screenId);
  updatePlayer();
  sendStatus();
}

/* ------------------------------------------------------------------------ */
/* Tray                                                                      */
/* ------------------------------------------------------------------------ */

/** Ícone desenhado em código: um pequeno LCD com barras. */
function trayIcon(px) {
  const buf = Buffer.alloc(px * px * 4);
  const set = (x, y, [r, g, b]) => {
    const i = (y * px + x) * 4;
    buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = 255;
  };
  const m = Math.round(px / 8);
  for (let y = m; y < px - m; y++) {
    for (let x = m * 2; x < px - m * 2; x++) {
      const edge = y === m || y === px - m - 1 || x === m * 2 || x === px - m * 2 - 1;
      set(x, y, edge ? [0, 170, 255] : [12, 14, 18]);
    }
  }
  const bars = [0.45, 0.75, 0.3];
  bars.forEach((v, k) => {
    const y0 = m * 2 + k * Math.max(2, Math.round(px / 6));
    const len = Math.round((px - m * 6) * v);
    for (let y = y0; y < y0 + Math.max(1, Math.round(px / 12)); y++) {
      for (let x = m * 3; x < m * 3 + len; x++) set(x, y, [79, 195, 247]);
    }
  });
  return nativeImage.createFromBitmap(buf, { width: px, height: px });
}

function stepScreen(dir) {
  if (player.step(config.screens, dir)) {
    sendLayout();
    sendStatus();
  }
}

function createTray() {
  tray = new Tray(trayIcon(16));
  tray.setToolTip('USB LCD Widgets');
  updateTrayMenu();
  tray.on('click', openControl);
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('tray.open'), click: openControl },
    { label: t('tray.next'), click: () => stepScreen(1) },
    { type: 'separator' },
    { label: t('tray.quit'), click: () => { quitting = true; app.quit(); } },
  ]));
}

/* ------------------------------------------------------------------------ */
/* IPC: estado e configuração                                                */
/* ------------------------------------------------------------------------ */

function publicCatalog() {
  return Object.values(catalog).map(({ folder, url, ...rest }) => ({ ...rest, builtin: builtinTypes.has(rest.type) }));
}

function rescanCatalog() {
  catalog = scanWidgets([BUILTIN_WIDGETS, userWidgetsDir]);
}

function applyConfig(next) {
  const prev = config;
  config = next;
  store.save(config);
  if (displayWin && prev.frameRate !== config.frameRate) displayWin.webContents.setFrameRate(config.frameRate);
  if (prev.lhmUrl !== config.lhmUrl || prev.sensorIntervalMs !== config.sensorIntervalMs || prev.language !== config.language) {
    sensors.configure({ lhmUrl: config.lhmUrl, intervalMs: config.sensorIntervalMs, language: config.language });
  }
  if (prev.language !== config.language) {
    updateTrayMenu();
    device.setLanguage(language());
  }
  if (prev.port !== config.port) device.setPortSetting(config.port || 'auto');
  if (prev.startWithWindows !== config.startWithWindows) applyLoginItem();
  if (JSON.stringify(prev.display) !== JSON.stringify(config.display)) applyGeometry();
  player.update(config.screens);
  sendLayout();
  sendStatus();
  refreshThumbs();
}

ipcMain.handle('state:get', () => ({
  config,
  catalog: publicCatalog(),
  sensors: Object.values(sensors.snapshot),
  thumbs: Object.fromEntries([...thumbs].filter(([, t]) => t.url).map(([id, t]) => [id, t.url])),
  player: playerStatus(),
  size,
  display: { controller, viewport: viewport(), auto: !config.display, calibrating },
  transitions: TRANSITIONS,
  version: app.getVersion(),
}));
ipcMain.on('config:set', (_e, next) => applyConfig(next));
ipcMain.on('mode:set', (_e, { mode, screenId }) => setMode(mode, screenId));
ipcMain.on('player:show', (_e, id) => {
  if (player.show(id)) sendLayout();
  sendStatus();
});
ipcMain.on('player:step', (_e, dir) => stepScreen(dir));
ipcMain.on('calibration:set', (_e, on) => setCalibrating(on));
ipcMain.handle('ports:list', async () => {
  const ports = await listPorts().catch(() => []);
  return ports.map((p) => ({ ...p, connected: p.path === device.info?.path, last: p.path === state.lastPort }));
});
ipcMain.handle('dialog:pickImage', async () => {
  const res = await dialog.showOpenDialog(controlWin, {
    properties: ['openFile'],
    filters: [{ name: t('dialog.images'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'] }],
  });
  return res.canceled ? null : res.filePaths[0];
});
ipcMain.handle('image:size', (_e, file) => imageFileSize(file));
ipcMain.handle('components:reload', () => {
  rescanCatalog();
  sendLayout();
  refreshThumbs(true);
  return publicCatalog();
});
ipcMain.on('components:openFolder', () => shell.openPath(userWidgetsDir));
ipcMain.on('site:open', () => shell.openExternal(SITE_URL));

/* ------------------------------------------------------------------------ */
/* IPC: exportar / importar widgets (.lcdwidget)                             */
/* ------------------------------------------------------------------------ */

ipcMain.handle('screen:export', async (_e, id) => {
  const screen = screenById(id);
  if (!screen) return { ok: false, error: t('err.widgetNotFound') };
  const safe = screen.name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'widget';
  const res = await dialog.showSaveDialog(controlWin, {
    defaultPath: path.join(app.getPath('documents'), `${safe}.lcdwidget`),
    filters: [{ name: t('dialog.widget'), extensions: ['lcdwidget'] }],
  });
  if (res.canceled) return { ok: false, canceled: true };
  try {
    const data = exportScreen(screen, { catalog, builtin: builtinTypes, size });
    fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2));
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
});

/** Importa ficheiros .lcdwidget e acrescenta-os à biblioteca. */
function importScreenFiles(files) {
  const imported = [];
  const errors = [];
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const { screen } = importScreen(data, { catalog, userWidgetsDir, assetsDir, newId });
      rescanCatalog();
      config.screens.push(screen);
      imported.push(screen.id);
    } catch (err) {
      errors.push(`${path.basename(file)}: ${err instanceof SyntaxError ? t('err.corrupt') : errorText(err)}`);
    }
  }
  if (imported.length) applyConfig({ ...config });
  return { ok: !errors.length, imported, errors, config, catalog: publicCatalog() };
}

ipcMain.handle('screen:import', async () => {
  const res = await dialog.showOpenDialog(controlWin, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: t('dialog.widget'), extensions: ['lcdwidget', 'json'] }],
  });
  if (res.canceled) return { ok: false, canceled: true };
  return importScreenFiles(res.filePaths);
});

/* ------------------------------------------------------------------------ */
/* IPC: componentes criados com IA                                           */
/* ------------------------------------------------------------------------ */

/** Instruções para a IA: a especificação mais o contexto deste PC. */
function aiInstructions() {
  // Especificação no idioma da app (docs/widget-ai-spec.en.md ou .md em português).
  const spec = fs.readFileSync(path.join(ROOT, 'docs', language() === 'pt' ? 'widget-ai-spec.md' : 'widget-ai-spec.en.md'), 'utf8');
  const byType = new Map();
  for (const s of Object.values(sensors.snapshot)) {
    const key = `${s.type}|${s.unit}`;
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key).push(s);
  }
  const lines = [...byType.values()]
    .sort((a, b) => b.length - a.length)
    .map((list) => {
      const ex = list.slice(0, 3).map((s) => `${s.name} = ${s.value == null ? '--' : +s.value.toFixed(1)}`).join('; ');
      return `- ${list[0].type} (${list[0].unit || t('ai.noUnit')}): ${t('ai.sensorsLine', { n: list.length, examples: ex })}`;
    });
  return `${spec}

## 7. ${t('ai.context')}

- ${t('ai.screen', { w: size.width, h: size.height })}
- ${t('ai.sensorTypes')}
${lines.join('\n')}

## 8. ${t('ai.request')}

`;
}

ipcMain.handle('ai:copyInstructions', () => {
  clipboard.writeText(aiInstructions());
  return true;
});

function doImportComponent(text) {
  try {
    const res = importWidget(text, userWidgetsDir, new Set(Object.keys(catalog)));
    rescanCatalog();
    if (!catalog[res.type]) throw I18N.appError('err.savedNotRead');
    return { ok: true, ...res, catalog: publicCatalog() };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

ipcMain.handle('components:importClipboard', () => {
  const text = clipboard.readText();
  if (!text.trim()) return { ok: false, error: t('err.clipboardEmpty') };
  return doImportComponent(text);
});
ipcMain.handle('components:importFile', async () => {
  const res = await dialog.showOpenDialog(controlWin, {
    properties: ['openFile'],
    filters: [{ name: t('dialog.component'), extensions: ['html', 'htm', 'txt', 'md'] }],
  });
  if (res.canceled) return { ok: false, canceled: true };
  return doImportComponent(fs.readFileSync(res.filePaths[0], 'utf8'));
});

/* ------------------------------------------------------------------------ */
/* Arranque com o Windows                                                    */
/* ------------------------------------------------------------------------ */

function applyLoginItem() {
  // Em desenvolvimento o executável é o electron.exe: é preciso passar a pasta da app.
  // Na versão portátil, process.execPath é uma cópia temporária: usa o .exe original.
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const args = app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
  app.setLoginItemSettings({ openAtLogin: !!config.startWithWindows, path: exe, args });
}

/* ------------------------------------------------------------------------ */
/* Arranque                                                                  */
/* ------------------------------------------------------------------------ */

device.on('connected', (info) => {
  console.log(`[device] ligado em ${info.path} (${info.width}x${info.height}, protocolo v${info.version}`
    + (info.reset ? `, último arranque: ${P.describeReset(info.reset, I18N.translator('pt'))}` : '') + ')');
  deviceErrors = 0;
  controller = { width: info.width, height: info.height };
  state.lastPort = info.path;
  state.controller = controller;
  store.saveState(state);
  applyGeometry();
  device.setLanguage(language());
});
device.on('disconnected', () => {
  console.log('[device] desligado');
  sendStatus();
});
device.on('device-error', (err) => {
  deviceErrors++;
  console.log(`[device] erro ${err.code} no pacote tipo ${err.packetType}`);
});
device.on('log', (msg) => console.log(`[device] ${msg}`));

sensors.on('update', (snapshot) => {
  if (displayWin && !displayWin.isDestroyed()) displayWin.webContents.send('sensors', snapshot);
  sendToControl('sensors', Object.values(snapshot));
});

app.on('second-instance', openControl);
app.on('window-all-closed', (e) => e.preventDefault());
let shutdownDone = false;
app.on('before-quit', (e) => {
  quitting = true;
  store.saveNow(config);
  if (shutdownDone) return;
  // Fecha a porta de forma limpa antes de sair (ver Device.stop).
  e.preventDefault();
  shutdownDone = true;
  device.stop().finally(() => {
    if (thumbnailer) thumbnailer.destroy();
    app.quit();
  });
});

app.whenReady().then(() => {
  config = store.load();
  state = store.loadState();
  // Último controlador conhecido, para desenhar já antes de o ESP32 responder.
  if (state.controller || state.size) controller = state.controller || state.size;
  const vp = viewport();
  size = { width: vp.width, height: vp.height };
  renderGeom = vp;
  sender.setGeometry(renderGeom, controller);

  ensureUserWidgetsDir(userWidgetsDir, BUILTIN_WIDGETS);
  builtinTypes = new Set(Object.keys(scanWidgets([BUILTIN_WIDGETS])));
  rescanCatalog();

  sensors.configure({ lhmUrl: config.lhmUrl, intervalMs: config.sensorIntervalMs, language: config.language });
  sensors.start();
  applyLoginItem();
  device.start({ portSetting: config.port || 'auto', lastPort: state.lastPort });

  player.update(config.screens);
  createDisplayWindow();
  createControlWindow();
  createTray();

  thumbnailer = new Thumbnailer({
    htmlFile: DISPLAY_HTML,
    preload: DISPLAY_PRELOAD,
    layoutFor: (id) => (screenById(id) ? buildLayout(screenById(id)) : null),
    sensors: () => sensors.snapshot,
    size: () => size,
    onThumb: (id, url) => {
      if (thumbs.has(id)) thumbs.get(id).url = url;
      sendToControl('thumb', { id, url });
    },
  });
  // Primeiras miniaturas depois de chegarem leituras dos sensores.
  setTimeout(() => refreshThumbs(true), 2000);

  if (SCREENSHOT_DIR) runScreenshot();
});

async function runScreenshot() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const capture = async (name) => {
    const img = await controlWin.webContents.capturePage();
    fs.writeFileSync(path.join(SCREENSHOT_DIR, name), img.toPNG());
  };
  const js = (code) => controlWin.webContents.executeJavaScript(code);
  controlWin.showInactive();

  // Execução: espera pelas miniaturas.
  await wait(2500 + config.screens.length * 1700);
  if (lastFrameImage) fs.writeFileSync(path.join(SCREENSHOT_DIR, 'lcd-run.png'), lastFrameImage.toPNG());
  await capture('run.png');
  // Imagem de LCD de cada widget (as miniaturas são desenhadas como no LCD).
  config.screens.forEach((s, i) => {
    const url = thumbs.get(s.id)?.url;
    if (url) fs.writeFileSync(path.join(SCREENSHOT_DIR, `lcd-widget-${i + 1}.png`), Buffer.from(url.split(',')[1], 'base64'));
  });
  await js("setView('settings');");
  await wait(800);
  await capture('settings.png');

  // Área visível manual + padrão de calibração (no fim volta à área anterior).
  const displayBefore = config.display;
  applyConfig({ ...config, display: { x: 0, y: 20, width: 240, height: 280 } });
  await js('config = ' + JSON.stringify(config) + '; renderDisplaySettings();');
  setCalibrating(true);
  await wait(2000);
  if (lastFrameImage) fs.writeFileSync(path.join(SCREENSHOT_DIR, 'lcd-calibration.png'), lastFrameImage.toPNG());
  await capture('settings-calibration.png');
  setCalibrating(false);
  await wait(2500);
  if (lastFrameImage) fs.writeFileSync(path.join(SCREENSHOT_DIR, 'lcd-viewport.png'), lastFrameImage.toPNG());
  console.log('viewport no ESP32:', JSON.stringify(device.info?.viewport));
  applyConfig({ ...config, display: displayBefore });
  await js('config = ' + JSON.stringify(config) + '; renderDisplaySettings();');

  // Editor com o primeiro widget e um componente selecionado.
  await js('openEditor(config.screens[0].id); selectComponent(config.screens[0].components[1]?.id || null);');
  await wait(2000);
  if (lastFrameImage) fs.writeFileSync(path.join(SCREENSHOT_DIR, 'lcd-edit.png'), lastFrameImage.toPNG());
  await capture('editor.png');
  await js("document.querySelector('#palette').scrollIntoView();");
  await wait(300);
  await capture('editor-palette.png');
  await js("document.querySelector('#inspector').scrollIntoView();");

  // Arrastar um componente com o rato (eventos reais) para testar o encaixe.
  const box = await js(`(() => {
    const c = config.screens[0].components[2];
    const b = document.querySelector('.box[data-id="' + c.id + '"]').getBoundingClientRect();
    return { x: b.left + 20, y: b.top + 20, scale, before: { x: c.x, y: c.y } };
  })()`);
  const mouse = (type, x, y, extra = {}) => controlWin.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra });
  mouse('mouseDown', box.x, box.y);
  for (let i = 1; i <= 6; i++) {
    const d = (1 * box.scale * i) / 6;
    mouse('mouseMove', box.x + d, box.y + d, { modifiers: ['leftbuttondown'] });
    await wait(40);
  }
  await wait(300);
  await capture('editor-drag.png');
  mouse("mouseUp", box.x + box.scale, box.y + box.scale);
  await wait(200);
  const after = await js('({ x: config.screens[0].components[2].x, y: config.screens[0].components[2].y })');
  console.log('arrastar ~2 px:', JSON.stringify(box.before), '->', JSON.stringify(after));

  // Mudar de idioma com a app aberta: a janela e o LCD passam para o outro idioma.
  const other = language() === 'pt' ? 'en' : 'pt';
  await js(`config.language = '${other}'; commit(); applyLanguage('${other}');`);
  await wait(1500);
  await capture(`editor-${other}.png`);
  await js(`config.language = '${other === 'pt' ? 'en' : 'pt'}'; commit(); applyLanguage(config.language);`);

  console.log(JSON.stringify({ device: deviceStatus(), lhm: sensors.lhmStatus, rate: rateCounters, deviceErrors, player: playerStatus() }));
  quitting = true;
  app.quit();
}
