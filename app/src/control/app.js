'use strict';

// Arranque, separadores Execução/Editor/Definições e eventos do processo principal.

let currentView = 'run';
let lastDevicePath;

function setView(view) {
  currentView = view;
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.view === view);
  $('#viewRun').hidden = view !== 'run';
  $('#viewEdit').hidden = view !== 'edit';
  $('#viewSettings').hidden = view !== 'settings';
  // O padrão de calibração só faz sentido com as definições do LCD à vista.
  if (view !== 'settings' && displayState.calibrating) ipc.setCalibration(false);
  if (view === 'edit') {
    if (!editing()) editingId = config.screens[0]?.id || null;
    ipc.setMode('edit', editingId);
    renderEditor();
  } else {
    ipc.setMode('run');
    if (view === 'settings') renderSettingsView();
    else renderRun();
  }
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    if (tab.dataset.view === 'edit') openEditor(editingId);
    else setView(tab.dataset.view);
  });
}

/** Chamado quando o idioma muda nas Definições: traduz e redesenha a vista atual. */
function applyLanguage(lang) {
  setLanguage(lang);
  if (currentView === 'edit') renderEditor();
  else if (currentView === 'settings') renderSettingsView();
  else renderRun();
}

// O processo principal volta à execução quando a janela é escondida; ao
// voltar a mostrá-la no editor, o LCD regressa ao widget em edição.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentView === 'edit') ipc.setMode('edit', editingId);
});

window.addEventListener('resize', () => { if (currentView === 'edit') fitStage(); });

ipc.onPreview((url) => {
  $('#runPreview').src = url;
  $('#preview').src = url;
});

ipc.onThumb(({ id, url }) => {
  thumbs[id] = url;
  updateCardThumb(id);
});

ipc.onSensors((list) => {
  sensors = list;
  for (const el of document.querySelectorAll('.sensor-live')) {
    const s = sensors.find((x) => x.id === el.dataset.sensor);
    if (el.dataset.sensor) el.textContent = t('field.now', { value: formatSensor(s) });
  }
});

ipc.onStatus((st) => {
  const dev = $('#stDevice');
  dev.className = 'pill ' + (st.device.connected ? 'ok' : 'bad');
  dev.textContent = st.device.connected ? `ESP32 ${st.device.path} · ${st.size.width}×${st.size.height}` : t('status.espOff');
  const lhm = $('#stLhm');
  lhm.className = 'pill ' + (st.lhm.ok ? 'ok' : 'bad');
  lhm.textContent = st.lhm.ok ? t('status.lhm') : t('status.lhmError', { message: st.lhm.message });
  $('#stRate').textContent = st.device.connected ? `${st.fps} fps · ${st.kbps.toFixed(1)} KB/s` : '';

  // A marca "ligado" na lista de portas muda quando o ESP32 liga ou desliga.
  if (st.device.path !== lastDevicePath) {
    lastDevicePath = st.device.path;
    if (currentView === 'settings') loadPorts();
  }
  const currentChanged = st.player.currentId !== playerState.currentId;
  const calibrationChanged = st.display.calibrating !== displayState.calibrating;
  playerState = st.player;
  displayState = st.display;
  if (st.size.width !== size.width || st.size.height !== size.height) {
    size = st.size;
    if (currentView === 'edit') fitStage();
  }
  if (currentView === 'run') {
    if (currentChanged) updateCurrentCard();
    renderNow();
  } else if (currentView === 'settings') {
    updateDisplayInfo();
    if (calibrationChanged) renderDisplaySettings();
  }
});

(async () => {
  const st = await ipc.getState();
  config = st.config;
  sensors = st.sensors;
  size = st.size;
  thumbs = st.thumbs;
  playerState = st.player;
  displayState = st.display;
  transitionTypes = st.transitions;
  appVersion = st.version;
  setCatalog(st.catalog);
  setLanguage(config.language);
  setView('run');
})();
