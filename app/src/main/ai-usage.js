'use strict';

// Utilização das subscrições de IA (Claude Code e Codex) como sensores:
//   ai/<serviço>/primary   janela curta (Claude: 5 h; Codex: a que o plano tiver)
//   ai/<serviço>/secondary janela longa (Claude: 7 dias), se existir
// Usa os logins que o Claude Code e o Codex guardam no perfil do utilizador, só para leitura:
// nunca os renova nem os escreve (renovar trocaria o token e estragaria a sessão desses
// programas), nunca os regista. Os pedidos não são APIs públicas: podem mudar sem aviso.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const POLL_MS = 90 * 1000;
const MAX_POLL_MS = 10 * 60 * 1000;

function toPercent(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Resposta de /api/oauth/usage -> janelas. */
function parseClaude(json) {
  const out = [];
  const add = (key, w, windowSec) => {
    if (!w || toPercent(w.utilization) == null) return;
    const resetAt = Date.parse(w.resets_at);
    out.push({ key, percent: toPercent(w.utilization), windowSec, resetAt: Number.isFinite(resetAt) ? resetAt : null });
  };
  add('primary', json && json.five_hour, 5 * 3600);
  add('secondary', json && json.seven_day, 7 * 86400);
  return out;
}

/** Resposta de /backend-api/wham/usage -> janelas (a secundária pode não existir). */
function parseCodex(json) {
  const rl = (json && json.rate_limit) || {};
  const out = [];
  const add = (key, w) => {
    if (!w || toPercent(w.used_percent) == null) return;
    const reset = Number(w.reset_at);
    out.push({
      key,
      percent: toPercent(w.used_percent),
      windowSec: Number(w.limit_window_seconds) || null,
      resetAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : null,
    });
  };
  add('primary', rl.primary_window);
  add('secondary', rl.secondary_window);
  return out;
}

/** 18000 -> "5h", 604800 -> "7d". */
function windowLabel(sec) {
  if (!sec) return '';
  return sec < 48 * 3600 ? `${Math.round(sec / 3600)}h` : `${Math.round(sec / 86400)}d`;
}

const SERVICES = {
  claude: {
    name: 'Claude Code',
    file: ['.claude', '.credentials.json'],
    /** Devolve { headers } ou { state } quando não há login utilizável. */
    auth(json, now) {
      const o = json && json.claudeAiOauth;
      if (!o || !o.accessToken) return { state: 'noLogin' };
      if (o.expiresAt && Number(o.expiresAt) <= now) return { state: 'expired' };
      return { headers: { Authorization: `Bearer ${o.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' } };
    },
    url: 'https://api.anthropic.com/api/oauth/usage',
    parse: parseClaude,
  },
  codex: {
    name: 'Codex',
    file: ['.codex', 'auth.json'],
    auth(json) {
      const t = json && json.tokens;
      if (!t || !t.access_token) return { state: 'noLogin' };
      const headers = { Authorization: `Bearer ${t.access_token}` };
      if (t.account_id) headers['chatgpt-account-id'] = t.account_id;
      return { headers };
    },
    url: 'https://chatgpt.com/backend-api/wham/usage',
    parse: parseCodex,
  },
};

/**
 * Consulta cada serviço ligado a cada POLL_MS (o dobro a cada 429/5xx seguido, até MAX_POLL_MS).
 * Evento: change() quando os dados ou o estado mudam.
 */
class AiUsage extends EventEmitter {
  constructor({ home = os.homedir(), fetch = globalThis.fetch, now = Date.now } = {}) {
    super();
    this.home = home;
    this.fetch = fetch;
    this.now = now;
    this.enabled = { claude: false, codex: false };
    this.status = { claude: { state: 'off' }, codex: { state: 'off' } };
    this.windows = { claude: [], codex: [] };
    this.failures = { claude: 0, codex: 0 };
    this.timers = {};
    this.started = false;
  }

  configure(enabled = {}) {
    for (const id of Object.keys(SERVICES)) {
      const on = !!enabled[id];
      if (on === this.enabled[id]) continue;
      this.enabled[id] = on;
      clearTimeout(this.timers[id]);
      this.failures[id] = 0;
      this.windows[id] = [];
      this.status[id] = { state: 'off' };
      if (on && this.started) this.schedule(id, 0);
      this.emit('change');
    }
  }

  start() {
    this.started = true;
    for (const id of Object.keys(SERVICES)) if (this.enabled[id]) this.schedule(id, 0);
  }

  stop() {
    this.started = false;
    for (const id of Object.keys(SERVICES)) clearTimeout(this.timers[id]);
  }

  schedule(id, ms) {
    clearTimeout(this.timers[id]);
    this.timers[id] = setTimeout(async () => {
      const next = await this.poll(id);
      if (this.started && this.enabled[id]) this.schedule(id, next);
    }, ms);
  }

  /** Uma consulta. Devolve o intervalo até à próxima (ms). */
  async poll(id) {
    const svc = SERVICES[id];
    let next = POLL_MS;
    let status;
    try {
      // Lido em cada consulta: o Claude Code e o Codex trocam os tokens.
      let json;
      try {
        json = JSON.parse(fs.readFileSync(path.join(this.home, ...svc.file), 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') throw Object.assign(new Error('noLogin'), { state: 'noLogin' });
        throw err;
      }
      const auth = svc.auth(json, this.now());
      if (auth.state) throw Object.assign(new Error(auth.state), { state: auth.state });

      const res = await this.fetch(svc.url, { headers: auth.headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.backoff = res.status === 429 || res.status >= 500;
        throw err;
      }
      const windows = svc.parse(await res.json());
      if (!this.enabled[id]) return next;   // desligado durante o pedido
      this.windows[id] = windows;
      this.failures[id] = 0;
      status = { state: 'ok' };
    } catch (err) {
      if (err.backoff) {
        this.failures[id]++;
        next = Math.min(POLL_MS * 2 ** this.failures[id], MAX_POLL_MS);
      }
      // Sem login deixa de haver dados; noutros erros ficam os últimos (o reset continua certo).
      if (err.state) this.windows[id] = [];
      status = err.state ? { state: err.state } : { state: 'error', message: err.name === 'TimeoutError' ? 'timeout' : err.message };
    }
    if (!this.enabled[id]) return next;
    this.status[id] = status;
    this.emit('change');
    return next;
  }

  /** Acrescenta os sensores ai/* a out. */
  read(out) {
    for (const [id, svc] of Object.entries(SERVICES)) {
      if (!this.enabled[id]) continue;
      for (const w of this.windows[id]) {
        const sid = `ai/${id}/${w.key}`;
        const label = windowLabel(w.windowSec);
        out[sid] = {
          id: sid,
          name: label ? `${svc.name} · ${label}` : svc.name,
          hardware: 'AI',
          group: svc.name,
          type: 'Load',
          value: w.percent,
          unit: '%',
          min: 0,
          max: 100,
          resetAt: w.resetAt,
          windowSec: w.windowSec,
        };
      }
    }
  }
}

module.exports = { AiUsage, parseClaude, parseCodex, windowLabel, POLL_MS, MAX_POLL_MS, SERVICES };
