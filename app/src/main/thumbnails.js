'use strict';

const { BrowserWindow } = require('electron');

const MIN_SETTLE_MS = 700;     // tempo mínimo para os componentes desenharem
const MAX_WAIT_MS = 12000;     // espera máxima por imagens a carregar (GIFs grandes)
const PAINT_MS = 400;          // depois de tudo carregado, tempo para o último desenho

/**
 * Miniaturas dos widgets para a biblioteca: cada ecrã é desenhado numa janela
 * offscreen separada (a do LCD continua a mostrar o ecrã atual) e guardado
 * como data URL.
 */
class Thumbnailer {
  /**
   * @param opts.htmlFile  página que compõe o ecrã (display.html)
   * @param opts.preload   preload dessa página
   * @param opts.layoutFor (id) => layout ou null
   * @param opts.sensors   () => snapshot dos sensores
   * @param opts.size      () => { width, height }
   * @param opts.onThumb   (id, dataUrl) => void
   */
  constructor(opts) {
    this.opts = opts;
    this.queue = [];
    this.busy = false;
    this.win = null;
    this.lastImage = null;
  }

  request(ids) {
    for (const id of ids) if (!this.queue.includes(id)) this.queue.push(id);
    this.run();
  }

  async run() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift();
        const layout = this.opts.layoutFor(id);
        if (!layout) continue;
        await this.ensureWindow();
        if (this.win.isDestroyed()) return;
        const { width, height } = this.opts.size();
        this.win.setContentSize(width, height);
        this.lastImage = null;
        this.win.webContents.send('sensors', this.opts.sensors());
        this.win.webContents.send('layout', layout);
        await this.settle();
        if (this.win.isDestroyed()) return;
        if (this.lastImage) this.opts.onThumb(id, this.lastImage.toDataURL());
      }
    } finally {
      this.busy = false;
    }
  }

  /** Espera que os componentes (e as imagens deles) carreguem e desenhem. */
  async settle() {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = Date.now() + MAX_WAIT_MS;
    await sleep(MIN_SETTLE_MS);
    while (Date.now() < until && !this.win.isDestroyed()) {
      let pending = 0;
      try {
        pending = await this.win.webContents.executeJavaScript('window.__pendingLoads ? window.__pendingLoads() : 0');
      } catch {
        break;
      }
      if (!pending) break;
      await sleep(150);
    }
    await sleep(PAINT_MS);
  }

  async ensureWindow() {
    if (this.win && !this.win.isDestroyed()) return;
    const { width, height } = this.opts.size();
    this.win = new BrowserWindow({
      width, height, useContentSize: true, show: false, frame: false,
      webPreferences: { offscreen: true, backgroundThrottling: false, preload: this.opts.preload },
    });
    this.win.webContents.setFrameRate(10);
    this.win.webContents.on('paint', (_e, _dirty, image) => {
      const s = image.getSize();
      const { width: w, height: h } = this.opts.size();
      this.lastImage = s.width === w && s.height === h ? image : image.resize({ width: w, height: h, quality: 'best' });
    });
    await new Promise((resolve) => {
      this.win.webContents.once('did-finish-load', resolve);
      this.win.loadFile(this.opts.htmlFile);
    });
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
  }
}

module.exports = { Thumbnailer };
