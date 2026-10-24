'use strict';

// Vista Editor: compor um widget com componentes, configurar cada um,
// criar componentes com IA e exportar/importar o widget.

let editingId = null;
let selectedId = null;
let scale = 2;
let dragging = false;

const editing = () => screenById(editingId);
const selected = () => editing()?.components.find((c) => c.id === selectedId) || null;

/** Abre o editor num widget; o LCD passa a mostrá-lo enquanto se edita. */
function openEditor(id) {
  editingId = id || config.screens[0]?.id || null;
  selectedId = null;
  setView('edit');
}

function renderEditor() {
  if (!editing()) editingId = config.screens[0]?.id || null;
  renderPicker();
  renderScreenSettings();
  renderLayers();
  fitStage();
  renderInspector();
  renderPalette();
}

/* ------------------------------------------------------------------------ */
/* Widget em edição                                                          */
/* ------------------------------------------------------------------------ */

function renderPicker() {
  const sel = $('#editPicker');
  sel.innerHTML = '';
  for (const s of config.screens) {
    sel.append(h('option', { value: s.id, selected: s.id === editingId }, s.name + (s.enabled === false ? t('edit.inactiveSuffix') : '')));
  }
  sel.disabled = !config.screens.length;
}

$('#editPicker').addEventListener('change', (e) => {
  editingId = e.target.value;
  selectedId = null;
  ipc.setMode('edit', editingId);
  renderEditor();
});

function renderScreenSettings() {
  const box = $('#screenSettings');
  box.innerHTML = '';
  const s = editing();
  for (const id of ['#editExport', '#editDuplicate']) $(id).disabled = !s;
  if (!s) {
    box.append(h('p', { class: 'empty' }, t('edit.noWidgets')));
    return;
  }
  box.append(
    field(t('edit.name'), textInput(s.name, (v) => {
      s.name = v;
      commit();
      $('#editPicker').selectedOptions[0].textContent = v + (s.enabled === false ? t('edit.inactiveSuffix') : '');
    })),
    field(t('edit.background'), colorInput(s.background, (v) => { s.background = v; commit(); }), true),
    field(t('edit.transition'), transitionPicker(s)),
  );
}

/** Transição ao entrar neste widget: a geral (Definições) ou uma própria. */
function transitionPicker(s) {
  const general = t('tr.' + (config.transition?.type || 'fade'));
  const options = [['', t('edit.transitionDefault', { name: general.toLowerCase() })], ...transitionOptions()];
  return choiceInput(s.transition?.type || '', options, (v) => {
    if (v) s.transition = { type: v };
    else delete s.transition;
    commit();
  });
}

$('#editNew').addEventListener('click', () => {
  const s = newScreen(t('screen.newName', { n: config.screens.length + 1 }));
  config.screens.push(s);
  commit();
  openEditor(s.id);
});
$('#editDuplicate').addEventListener('click', () => {
  const copy = duplicateScreen(editing());
  commit();
  openEditor(copy.id);
});
$('#editExport').addEventListener('click', () => exportScreen(editing(), $('#editMsg')));
$('#editImport').addEventListener('click', async () => {
  const ids = await importScreens($('#editMsg'));
  if (ids.length) openEditor(ids[0]);
});

/* ------------------------------------------------------------------------ */
/* Lista de componentes (camadas)                                            */
/* ------------------------------------------------------------------------ */

function componentLabel(c) {
  const type = catalog[c.type];
  const sensorKey = type?.properties.find((p) => p.type === 'sensor')?.key;
  const sensor = sensorKey && sensors.find((s) => s.id === c.props[sensorKey]);
  const fileKey = type?.properties.find((p) => p.type === 'file')?.key;
  const file = fileKey && c.props[fileKey] ? c.props[fileKey].split(/[\\/]/).pop() : '';
  const extra = c.props.label || c.props.text || c.props.title || sensor?.name || file;
  return { name: type ? type.name : t('edit.missingType', { type: c.type }), extra };
}

function renderLayers() {
  const list = $('#layers');
  list.innerHTML = '';
  const s = editing();
  if (!s || !s.components.length) {
    list.append(h('li', { class: 'empty-item' }, t('edit.noComponents')));
    return;
  }
  // Do que está por cima para o que está por baixo.
  [...s.components].reverse().forEach((c) => {
    const { name, extra } = componentLabel(c);
    list.append(h('li', { class: c.id === selectedId ? 'active' : '', onclick: () => selectComponent(c.id) },
      h('span', { class: 'name' }, name),
      h('span', { class: 'meta' }, extra),
      h('button', {
        class: 'lock-btn' + (c.locked ? ' on' : ''),
        title: t(c.locked ? 'edit.unlockTitle' : 'edit.lockTitle'),
        onclick: (e) => { e.stopPropagation(); setLocked(c, !c.locked); },
      }, c.locked ? '🔒' : '🔓')));
  });
}

/* ------------------------------------------------------------------------ */
/* Palco                                                                     */
/* ------------------------------------------------------------------------ */

function fitStage() {
  const stage = $('#stage');
  if (!stage.clientWidth) return;
  const s = Math.min((stage.clientWidth - 60) / size.width, (stage.clientHeight - 60) / size.height, 3);
  scale = Math.max(1, Math.floor(s * 4) / 4);
  const lcd = $('#lcd');
  lcd.style.width = size.width * scale + 'px';
  lcd.style.height = size.height * scale + 'px';
  renderOverlay();
}

function placeBox(box, c) {
  if (!box) return;
  Object.assign(box.style, {
    left: c.x * scale + 'px', top: c.y * scale + 'px',
    width: c.w * scale + 'px', height: c.h * scale + 'px',
  });
}

function renderOverlay() {
  const overlay = $('#overlay');
  overlay.innerHTML = '';
  for (const c of editing()?.components || []) {
    const out = c.x + c.w > size.width || c.y + c.h > size.height;
    const box = h('div', {
      class: 'box' + (c.id === selectedId ? ' selected' : '') + (out ? ' out' : '') + (c.locked ? ' locked' : ''),
      'data-id': c.id,
      title: out ? t('edit.outside') : null,
    },
      h('span', { class: 'tag' }, catalog[c.type]?.name || c.type),
      h('span', { class: 'handle' }));
    placeBox(box, c);
    overlay.append(box);
  }
}

/** Um componente bloqueado não muda de posição nem de tamanho (rato, setas, campos). */
function setLocked(c, locked) {
  if (locked) c.locked = true;
  else delete c.locked;
  commit();
  renderOverlay();
  renderLayers();
  renderInspector();
}

function selectComponent(id) {
  selectedId = id;
  for (const b of document.querySelectorAll('.box')) b.classList.toggle('selected', b.dataset.id === id);
  renderLayers();
  renderInspector();
}

/* ---- Guias de alinhamento (ver snap.js) ---- */

const SNAP_SCREEN_PX = 6;   // distância de encaixe, em pixels do ecrã do PC

/** Desenha as guias, destaca os componentes de referência e mostra a etiqueta de posição/tamanho. */
function showGuides(c, guides, note) {
  clearGuides();
  const overlay = $('#overlay');
  const ids = new Set();
  for (const g of guides.xs) {
    overlay.append(h('div', { class: 'guide v' + (g.kind === 'center' ? ' center' : ''), style: `left:${g.v * scale}px` }));
    if (g.id) ids.add(g.id);
  }
  for (const g of guides.ys) {
    overlay.append(h('div', { class: 'guide h' + (g.kind === 'center' ? ' center' : ''), style: `top:${g.v * scale}px` }));
    if (g.id) ids.add(g.id);
  }
  for (const id of ids) document.querySelector(`.box[data-id="${id}"]`)?.classList.add('snap-target');

  const text = `x ${c.x}  y ${c.y}  ·  ${c.w} × ${c.h}` + (note ? `  ·  ${note}` : '');
  const below = (c.y + c.h) * scale + 6;
  const top = below + 22 > size.height * scale ? c.y * scale - 26 : below;
  overlay.append(h('div', { class: 'dim-badge', style: `left:${c.x * scale}px; top:${top}px` }, text));
}

function clearGuides() {
  for (const el of document.querySelectorAll('#overlay .guide, #overlay .dim-badge')) el.remove();
  for (const el of document.querySelectorAll('.box.snap-target')) el.classList.remove('snap-target');
}

$('#overlay').addEventListener('pointerdown', (e) => {
  const box = e.target.closest('.box');
  if (!box) {
    selectComponent(null);
    return;
  }
  const c = editing().components.find((x) => x.id === box.dataset.id);
  selectComponent(c.id);
  if (c.locked) return;
  const mode = e.target.classList.contains('handle') ? 'resize' : 'move';
  const start = { x: e.clientX, y: e.clientY, cx: c.x, cy: c.y, cw: c.w, ch: c.h };
  const others = editing().components.filter((o) => o.id !== c.id);
  const targets = snapTargets(others, c.id, size);
  dragging = true;
  box.setPointerCapture(e.pointerId);

  const onMove = (ev) => {
    const dx = Math.round((ev.clientX - start.x) / scale);
    const dy = Math.round((ev.clientY - start.y) / scale);
    // Alt desliga o encaixe (posicionamento livre).
    const threshold = ev.altKey ? 0 : SNAP_SCREEN_PX / scale;
    let note = '';
    let guides;
    if (mode === 'move') {
      const r = snapMove({ x: start.cx + dx, y: start.cy + dy, w: c.w, h: c.h }, targets, size, threshold);
      c.x = r.x;
      c.y = r.y;
      guides = r.guides;
    } else {
      const r = snapResize({ x: c.x, y: c.y, w: start.cw + dx, h: start.ch + dy }, targets, others, size, threshold);
      c.w = r.w;
      c.h = r.h;
      guides = r.guides;
      const name = (o) => componentLabel(o).extra || componentLabel(o).name;
      note = [r.sameWidth && t('edit.sameWidth', { name: name(r.sameWidth) }), r.sameHeight && t('edit.sameHeight', { name: name(r.sameHeight) })]
        .filter(Boolean).join(', ');
    }
    if (ev.altKey) guides = { xs: [], ys: [] };
    placeBox(box, c);
    showGuides(c, guides, note);
    updateGeometryFields(c);
    commit();
  };
  const onUp = () => {
    dragging = false;
    clearGuides();
    box.removeEventListener('pointermove', onMove);
    box.removeEventListener('pointerup', onUp);
  };
  box.addEventListener('pointermove', onMove);
  box.addEventListener('pointerup', onUp);
});

document.addEventListener('keydown', (e) => {
  const c = selected();
  if (currentView !== 'edit' || !c || e.target.closest('input, select, textarea')) return;
  if (c.locked) return;   // nem mover nem apagar por engano
  const step = e.shiftKey ? 10 : 1;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (moves[e.key]) {
    e.preventDefault();
    c.x = clamp(c.x + moves[e.key][0], 0, size.width - c.w);
    c.y = clamp(c.y + moves[e.key][1], 0, size.height - c.h);
    placeBox(document.querySelector(`.box[data-id="${c.id}"]`), c);
    updateGeometryFields(c);
    commit();
  } else if (e.key === 'Delete') {
    removeComponent(c);
  }
});

/* ------------------------------------------------------------------------ */
/* Inspetor                                                                  */
/* ------------------------------------------------------------------------ */

const geometryInputs = {};

function updateGeometryFields(c) {
  for (const k of ['x', 'y', 'w', 'h']) {
    if (geometryInputs[k] && document.activeElement !== geometryInputs[k]) geometryInputs[k].value = c[k];
  }
}

function removeComponent(c) {
  const list = editing().components;
  list.splice(list.indexOf(c), 1);
  selectedId = null;
  commit();
  renderOverlay();
  renderLayers();
  renderInspector();
}

function renderInspector() {
  const box = $('#inspector');
  box.innerHTML = '';
  const c = selected();
  if (!c) {
    $('#inspTitle').textContent = t('edit.component');
    box.append(h('p', { class: 'empty' }, t('edit.selectHint')));
    return;
  }
  const type = catalog[c.type];
  $('#inspTitle').textContent = type ? type.name : c.type;
  if (type?.description) box.append(h('p', { class: 'desc' }, type.description));

  const geo = (k, label, max) => {
    const input = numberInput(c[k], (v) => {
      c[k] = Math.round(v);
      if (k === 'w' || k === 'h') c[k] = Math.max(8, c[k]);
      placeBox(document.querySelector(`.box[data-id="${c.id}"]`), c);
      commit();
    }, { min: 0, max, step: 1 });
    input.disabled = !!c.locked;
    geometryInputs[k] = input;
    return field(label, input);
  };
  box.append(field(t('edit.lock'), toggle(c.locked, (v) => setLocked(c, v)), true));
  if (c.locked) box.append(h('p', { class: 'desc' }, t('edit.lockedHint')));
  box.append(h('div', { class: 'grid4' },
    geo('x', 'X', size.width), geo('y', 'Y', size.height), geo('w', t('edit.width'), size.width), geo('h', t('edit.height'), size.height)));

  const center = (axis) => () => {
    if (axis === 'x') c.x = Math.round((size.width - c.w) / 2);
    else c.y = Math.round((size.height - c.h) / 2);
    placeBox(document.querySelector(`.box[data-id="${c.id}"]`), c);
    updateGeometryFields(c);
    commit();
  };
  box.append(h('div', { class: 'align-row' },
    h('span', {}, t('edit.center')),
    h('button', { class: 'btn small', title: t('edit.centerHTitle'), disabled: !!c.locked, onclick: center('x') }, t('edit.centerH')),
    h('button', { class: 'btn small', title: t('edit.centerVTitle'), disabled: !!c.locked, onclick: center('y') }, t('edit.centerV'))));

  const fileDef = type?.properties.find((p) => p.type === 'file');
  if (fileDef && c.props[fileDef.key]) {
    box.append(h('div', { class: 'align-row' },
      h('span', {}, t('edit.image')),
      h('button', {
        class: 'btn small',
        title: t('edit.imageSizeTitle'),
        disabled: !!c.locked,
        onclick: () => fitToImage(c, c.props[fileDef.key]),
      }, t('edit.imageSize'))));
  }

  if (!type) {
    box.append(h('p', { class: 'empty' }, t('edit.unknownType', { type: c.type })));
  } else {
    for (const def of type.properties) {
      box.append(propField(def, c.props[def.key], (v) => {
        c.props[def.key] = v;
        commit();
        if (def.type === 'file') renderInspector();
        if (['sensor', 'file'].includes(def.type) || ['label', 'text', 'title'].includes(def.key)) renderLayers();
      }));
    }
  }

  const list = editing().components;
  const idx = list.indexOf(c);
  const reorder = (d) => () => {
    const j = idx + d;
    if (j < 0 || j >= list.length) return;
    [list[idx], list[j]] = [list[j], list[idx]];
    commit();
    renderOverlay();
    renderLayers();
    renderInspector();
  };
  box.append(h('div', { class: 'actions' },
    h('button', {
      class: 'btn small',
      onclick: () => {
        const copy = { ...structuredClone(c), id: newId('c'), x: clamp(c.x + 10, 0, size.width - c.w), y: clamp(c.y + 10, 0, size.height - c.h) };
        delete copy.locked;   // a cópia fica solta, para a poder pôr no sítio
        list.push(copy);
        commit();
        renderOverlay();
        selectComponent(copy.id);
      },
    }, t('edit.duplicateComp')),
    h('button', { class: 'btn small', disabled: idx === list.length - 1, onclick: reorder(1), title: t('edit.forwardTitle') }, t('edit.forward')),
    h('button', { class: 'btn small', disabled: idx === 0, onclick: reorder(-1), title: t('edit.backwardTitle') }, t('edit.backward')),
    h('button', { class: 'btn small danger', onclick: () => removeComponent(c) }, t('edit.remove'))));
}

/* ------------------------------------------------------------------------ */
/* Paleta de componentes                                                     */
/* ------------------------------------------------------------------------ */

/** Acrescenta um componente ao centro do widget em edição e seleciona-o. */
function addComponent(t, props = {}, w = t.size.w, hh = t.size.h) {
  const s = editing();
  if (!s) return null;
  w = Math.min(w, size.width);
  hh = Math.min(hh, size.height);
  const c = {
    id: newId('c'), type: t.type,
    x: Math.round((size.width - w) / 2), y: Math.round((size.height - hh) / 2), w, h: hh,
    props,
  };
  s.components.push(c);
  commit();
  renderOverlay();
  selectComponent(c.id);
  return c;
}

/** Tamanho original da imagem, reduzido (mantendo a proporção) para caber no ecrã. */
async function imageFit(file) {
  const img = await ipc.imageSize(file);
  if (!img || !img.width || !img.height) return null;
  const k = Math.min(1, size.width / img.width, size.height / img.height);
  return { w: Math.max(8, Math.round(img.width * k)), h: Math.max(8, Math.round(img.height * k)) };
}

async function fitToImage(c, file) {
  const fit = await imageFit(file);
  if (!fit) return;
  c.w = fit.w;
  c.h = fit.h;
  c.x = clamp(c.x, 0, size.width - c.w);
  c.y = clamp(c.y, 0, size.height - c.h);
  placeBox(document.querySelector(`.box[data-id="${c.id}"]`), c);
  updateGeometryFields(c);
  commit();
}

/**
 * Componentes com uma imagem (propriedade "file"): pede logo o ficheiro e cria
 * o componente com o tamanho da imagem. Os outros são criados diretamente.
 */
async function addFromPalette(t) {
  const fileDef = t.properties.find((p) => p.type === 'file');
  if (!fileDef) return addComponent(t);
  const file = await ipc.pickImage();
  if (!file) return null;
  const fit = await imageFit(file);
  return addComponent(t, { [fileDef.key]: file }, fit?.w ?? t.size.w, fit?.h ?? t.size.h);
}

const PALETTE_GROUPS = ['component', 'shape', 'image'];

function renderPalette() {
  const box = $('#palette');
  box.innerHTML = '';
  const types = Object.values(catalog).sort((a, b) => (b.builtin - a.builtin) || a.name.localeCompare(b.name));
  for (const group of PALETTE_GROUPS) {
    const list = types.filter((type) => (type.category || 'component') === group);
    if (!list.length) continue;
    box.append(h('h3', { class: 'palette-group' }, t('palette.' + group)));
    for (const type of list) {
      box.append(h('button', { title: type.description, onclick: () => addFromPalette(type) },
        h('b', {}, type.name, type.builtin ? null : h('span', { class: 'chip' }, t('edit.own'))),
        h('small', {}, type.description)));
    }
  }
}

$('#openFolder').addEventListener('click', () => ipc.openComponentsFolder());
$('#reloadComponents').addEventListener('click', async () => {
  setCatalog(await ipc.reloadComponents());
  renderEditor();
});

/* ------------------------------------------------------------------------ */
/* Criar componente com IA                                                   */
/* ------------------------------------------------------------------------ */

async function importAiComponent(fn) {
  const res = await fn();
  if (res.canceled) return;
  if (!res.ok) {
    showMessage($('#aiMsg'), t('ai.failed', { error: res.error }), 'bad');
    return;
  }
  setCatalog(res.catalog);
  renderPalette();
  addComponent(catalog[res.type]);
  showMessage($('#aiMsg'), t('ai.imported', { name: res.name }), 'ok');
}

$('#aiCopy').addEventListener('click', async () => {
  await ipc.copyAiInstructions();
  showMessage($('#aiMsg'), t('ai.copied'), 'ok');
});
$('#aiPaste').addEventListener('click', () => importAiComponent(ipc.importComponentFromClipboard));
$('#aiFile').addEventListener('click', () => importAiComponent(ipc.importComponentFromFile));
