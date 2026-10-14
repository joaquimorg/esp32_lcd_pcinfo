'use strict';

/*
 * Transições entre widgets no LCD. A animação é feita em display.js; aqui fica
 * a lista (partilhada com a janela de gestão) e a escolha da transição a usar.
 *
 * config.transition         { type, durationMs }  por omissão para todos os widgets
 * screen.transition         { type } | undefined  transição de entrada desse widget
 */

// Os nomes estão em src/i18n.js (chaves "tr.<tipo>").
const TRANSITIONS = [
  'none', 'fade',
  'slide-left', 'slide-right', 'slide-up', 'slide-down',
  'push-left', 'push-right', 'push-up', 'push-down',
  'zoom', 'wipe-right', 'wipe-down', 'circle', 'random',
];

const TYPES = new Set(TRANSITIONS);
const DEFAULT_TRANSITION = { type: 'fade', durationMs: 500 };
const MIN_MS = 100;
const MAX_MS = 3000;

/**
 * Transição para entrar em `screen`: a do widget, se tiver, senão a geral.
 * "random" é resolvida aqui (cada troca escolhe uma diferente).
 */
function resolveTransition(screen, config, random = Math.random) {
  const general = { ...DEFAULT_TRANSITION, ...(config && config.transition) };
  let type = screen && screen.transition && TYPES.has(screen.transition.type) ? screen.transition.type : general.type;
  if (!TYPES.has(type)) type = DEFAULT_TRANSITION.type;
  if (type === 'random') {
    const pool = TRANSITIONS.filter((t) => t !== 'none' && t !== 'random');
    type = pool[Math.floor(random() * pool.length) % pool.length];
  }
  const durationMs = Math.max(MIN_MS, Math.min(MAX_MS, Math.round(Number(general.durationMs) || DEFAULT_TRANSITION.durationMs)));
  return type === 'none' ? { type: 'none', durationMs: 0 } : { type, durationMs };
}

module.exports = { TRANSITIONS, DEFAULT_TRANSITION, resolveTransition, MIN_MS, MAX_MS };
