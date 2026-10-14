'use strict';

// Vista Execução: biblioteca de widgets (ativos, duração, ordem), importação,
// o que está no LCD agora e a transição entre widgets.

function renderRun() {
  renderCards();
  renderNow();
  renderTransitionSettings();
}

function renderCards() {
  const box = $('#cards');
  box.innerHTML = '';
  const list = config.screens;

  if (!list.length) {
    box.append(h('p', { class: 'empty' }, t('run.empty')));
    return;
  }

  list.forEach((screen, i) => {
    const active = screen.enabled !== false;
    const current = screen.id === playerState.currentId;
    const move = (d) => () => {
      const j = i + d;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      commit();
      renderCards();
    };

    const thumbRatio = `${size.width} / ${size.height}`;
    const thumb = thumbs[screen.id]
      ? h('img', { src: thumbs[screen.id], alt: '' })
      : h('div', { class: 'thumb-empty' }, t('run.generating'));

    box.append(h('article', { class: 'card' + (active ? ' active' : '') + (current ? ' current' : ''), 'data-id': screen.id },
      h('div', {
        class: 'thumb',
        style: `aspect-ratio: ${thumbRatio}`,
        title: active ? t('run.showNow') : t('run.enableToShow'),
        onclick: () => { if (active) ipc.showScreen(screen.id); },
      }, thumb, current ? h('span', { class: 'badge' }, t('run.onLcd')) : null),
      h('div', { class: 'card-body' },
        h('div', { class: 'card-title', title: screen.name }, screen.name || t('run.unnamed')),
        h('div', { class: 'card-meta' }, screen.components.length === 1 ? t('run.component') : t('run.components', { n: screen.components.length })),
        h('div', { class: 'card-row' },
          h('div', { class: 'check' },
            toggle(active, (v) => { screen.enabled = v; commit(); renderCards(); }),
            h('span', {}, active ? t('run.active') : t('run.inactive'))),
          h('label', { class: 'dur', title: t('run.durationTitle') },
            h('input', {
              type: 'number', min: 1, value: screen.durationSec, disabled: !active,
              oninput: (e) => { if (e.target.valueAsNumber >= 1) { screen.durationSec = Math.round(e.target.valueAsNumber); commit(); } },
            }),
            h('span', {}, 's'))),
        h('div', { class: 'card-actions' },
          h('button', { class: 'btn icon', title: t('run.moveBack'), disabled: i === 0, onclick: move(-1) }, '←'),
          h('button', { class: 'btn icon', title: t('run.moveForward'), disabled: i === list.length - 1, onclick: move(1) }, '→'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn small primary', onclick: () => openEditor(screen.id) }, t('run.edit')),
          h('button', { class: 'btn icon', title: t('run.export'), onclick: () => exportScreen(screen, $('#runMsg')) }, '⤓'),
          h('button', {
            class: 'btn icon', title: t('run.duplicate'),
            onclick: () => { duplicateScreen(screen); commit(); renderCards(); },
          }, '⧉'),
          h('button', {
            class: 'btn icon danger', title: t('run.delete'),
            onclick: () => {
              if (!confirm(t('run.confirmDelete', { name: screen.name }))) return;
              list.splice(i, 1);
              commit();
              renderCards();
            },
          }, '✕'))),
    ));
  });
}

/** Atualiza só a miniatura de um cartão (sem redesenhar a grelha). */
function updateCardThumb(id) {
  const old = document.querySelector(`.card[data-id="${id}"] .thumb > img, .card[data-id="${id}"] .thumb > .thumb-empty`);
  if (old && thumbs[id]) old.replaceWith(h('img', { src: thumbs[id], alt: '' }));
}

/** Marca o cartão do widget que está no LCD. */
function updateCurrentCard() {
  for (const card of document.querySelectorAll('.card')) {
    const current = card.dataset.id === playerState.currentId;
    card.classList.toggle('current', current);
    const badge = card.querySelector('.badge');
    if (current && !badge) card.querySelector('.thumb').append(h('span', { class: 'badge' }, t('run.onLcd')));
    if (!current && badge) badge.remove();
  }
}

function renderNow() {
  const cur = screenById(playerState.currentId);
  $('#nowName').textContent = cur ? cur.name : t('now.none');
  const activeCount = config.screens.filter((s) => s.enabled !== false).length;
  $('#nowNext').textContent = playerState.mode === 'edit'
    ? t('now.paused')
    : playerState.remainingSec != null ? t('now.next', { s: playerState.remainingSec }) : activeCount === 1 ? t('now.only') : '';
  $('#prevScreen').disabled = $('#nextScreen').disabled = activeCount < 2;
}

/* ---- Transição entre widgets ---- */

function renderTransitionSettings() {
  const box = $('#transitionSettings');
  box.innerHTML = '';
  box.append(
    h('div', { class: 'two' },
      field(t('transitions.type'), choiceInput(config.transition?.type || 'fade', transitionOptions(), (v) => {
        config.transition = { ...config.transition, type: v };
        commit();
      })),
      field(t('settings.transitionMs'), numberInput(config.transition?.durationMs ?? 500, (v) => {
        config.transition = { ...config.transition, durationMs: clamp(Math.round(v), 100, 3000) };
        commit();
      }, { min: 100, max: 3000, step: 50 }))),
    h('p', { class: 'desc' }, t('settings.transitionHelp')),
  );
}

async function exportScreen(screen, msgEl) {
  const res = await ipc.exportScreen(screen.id);
  if (res.canceled) return;
  if (res.ok) showMessage(msgEl, t('run.exported', { name: screen.name, path: res.path }), 'ok');
  else showMessage(msgEl, t('run.exportFailed', { error: res.error }), 'bad');
}

$('#runNew').addEventListener('click', () => {
  const screen = newScreen(t('screen.newName', { n: config.screens.length + 1 }));
  config.screens.push(screen);
  commit();
  openEditor(screen.id);
});
$('#runImport').addEventListener('click', async () => {
  if ((await importScreens($('#runMsg'))).length) renderRun();
});
$('#prevScreen').addEventListener('click', () => ipc.stepScreen(-1));
$('#nextScreen').addEventListener('click', () => ipc.stepScreen(1));
