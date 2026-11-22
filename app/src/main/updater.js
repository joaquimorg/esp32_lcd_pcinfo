'use strict';

// Atualizações: consulta a última release no GitHub, descarrega o instalador (com SHA-256 se a
// release o indicar) e devolve o caminho. Quem chama pede confirmação à pessoa e executa-o.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const REPO = 'joaquimorg/esp32_lcd_pcinfo';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_TIMEOUT_MS = 15000;

/** "v1.2.3" -> [1, 2, 3]; null se não for uma versão. */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** true se a versão `a` é mais recente do que `b`. */
function isNewer(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** Da resposta da API do GitHub: { version, page, notes, asset } ou null (rascunhos e pré-lançamentos ignorados). */
function parseRelease(json) {
  if (!json || json.draft || json.prerelease || !parseVersion(json.tag_name)) return null;
  const a = (json.assets || []).find((x) => /^USB-LCD-Widgets-Setup-.*\.exe$/i.test(x.name || ''));
  const digest = a && /^sha256:([0-9a-f]{64})$/i.exec(a.digest || '');
  return {
    version: parseVersion(json.tag_name).join('.'),
    page: json.html_url || `https://github.com/${REPO}/releases`,
    notes: String(json.body || '').trim(),
    asset: a ? { name: a.name, url: a.browser_download_url, size: a.size || 0, sha256: digest ? digest[1].toLowerCase() : null } : null,
  };
}

class Updater extends EventEmitter {
  /** @param {{fetch?: Function, dir?: string}} [opts] */
  constructor({ fetch: fetchFn = globalThis.fetch, dir = path.join(os.tmpdir(), 'usb-lcd-widgets-update') } = {}) {
    super();
    this.fetch = fetchFn;
    this.dir = dir;
    this.release = null;
    this.status = { state: 'idle' };   // idle | checking | none | available | downloading | error
  }

  _set(status) {
    this.status = status;
    this.emit('change');
  }

  /** Consulta a última versão. Devolve a release se for mais recente do que `current`, senão null. */
  async check(current) {
    if (['checking', 'downloading'].includes(this.status.state)) return null;
    this._set({ state: 'checking' });
    try {
      const res = await this.fetch(API_URL, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'USB-LCD-Widgets' },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      if (res.status === 404) { this.release = null; this._set({ state: 'none' }); return null; }   // ainda sem releases
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rel = parseRelease(await res.json());
      if (!rel || !isNewer(rel.version, current)) { this.release = null; this._set({ state: 'none' }); return null; }
      this.release = rel;
      this._set({ state: 'available', version: rel.version, notes: rel.notes });
      return rel;
    } catch (err) {
      this._set({ state: 'error', message: err.message });
      return null;
    }
  }

  /** Descarrega o instalador da release encontrada; devolve o caminho do ficheiro. */
  async download() {
    const rel = this.release;
    if (!rel || !rel.asset) throw new Error('no installer');
    const { asset } = rel;
    this._set({ state: 'downloading', version: rel.version, progress: 0 });
    const file = path.join(this.dir, asset.name);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const res = await this.fetch(asset.url, { headers: { 'User-Agent': 'USB-LCD-Widgets' } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || asset.size || 0;
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(file);
      let got = 0, lastPct = -1;
      for await (const chunk of res.body) {
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        got += chunk.length;
        const pct = total ? Math.floor((got / total) * 100) : 0;
        if (pct !== lastPct) { lastPct = pct; this._set({ state: 'downloading', version: rel.version, progress: pct }); }
      }
      await new Promise((resolve, reject) => { out.once('error', reject); out.end(resolve); });
      if (asset.size && got !== asset.size) throw new Error('incomplete download');
      if (asset.sha256 && hash.digest('hex') !== asset.sha256) throw new Error('checksum mismatch');
      this._set({ state: 'available', version: rel.version, notes: rel.notes });
      return file;
    } catch (err) {
      fs.rmSync(file, { force: true });
      this._set({ state: 'error', message: err.message });
      throw err;
    }
  }
}

module.exports = { Updater, parseVersion, isNewer, parseRelease, REPO };
