'use strict';

/**
 * Decide que ecrã está no LCD.
 *   modo 'run'  roda pelos ecrãs ativos (enabled), cada um durante durationSec
 *   modo 'edit' fixa o ecrã que está a ser editado
 */
class Player {
  constructor() {
    this.mode = 'run';
    this.editId = null;
    this.currentId = null;
    this.shownAt = 0;
  }

  static active(screens) {
    return screens.filter((s) => s.enabled !== false);
  }

  setMode(mode, editId = null, now = Date.now()) {
    const next = mode === 'edit' ? 'edit' : 'run';
    // Ao voltar à execução, o ecrã atual começa a contar o tempo de novo.
    if (next !== this.mode) this.shownAt = now;
    this.mode = next;
    this.editId = editId;
  }

  /** Atualiza o ecrã atual. Devolve true se mudou. */
  update(screens, now = Date.now()) {
    const before = this.currentId;

    if (this.mode === 'edit' && screens.some((s) => s.id === this.editId)) {
      this.currentId = this.editId;
    } else {
      const list = Player.active(screens);
      const idx = list.findIndex((s) => s.id === this.currentId);
      if (!list.length) {
        this.currentId = null;
      } else if (idx < 0) {
        this.currentId = list[0].id;
        this.shownAt = now;
      } else if (list.length > 1 && now - this.shownAt >= durationMs(list[idx])) {
        this.currentId = list[(idx + 1) % list.length].id;
        this.shownAt = now;
      }
    }

    if (this.currentId !== before && this.mode === 'edit') this.shownAt = now;
    return this.currentId !== before;
  }

  /** Salta para o ecrã ativo seguinte (dir = 1) ou anterior (dir = -1). */
  step(screens, dir, now = Date.now()) {
    const list = Player.active(screens);
    if (!list.length) return false;
    const idx = list.findIndex((s) => s.id === this.currentId);
    const next = list[(((idx < 0 ? 0 : idx + dir) % list.length) + list.length) % list.length];
    return this.show(next.id, now);
  }

  show(id, now = Date.now()) {
    const changed = id !== this.currentId;
    this.currentId = id;
    this.shownAt = now;
    return changed;
  }

  /** Segundos até ao próximo ecrã, ou null se não houver rotação. */
  remainingSec(screens, now = Date.now()) {
    if (this.mode !== 'run') return null;
    const list = Player.active(screens);
    const cur = list.find((s) => s.id === this.currentId);
    if (!cur || list.length < 2) return null;
    return Math.max(0, Math.ceil((durationMs(cur) - (now - this.shownAt)) / 1000));
  }
}

function durationMs(screen) {
  return Math.max(1, Number(screen.durationSec) || 10) * 1000;
}

module.exports = { Player };
