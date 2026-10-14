'use strict';

const { BrowserWindow } = require('electron');

const SETTLE_MS = 1500;   // tempo para os componentes carregarem e animarem

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
        await new Promise((r) => setTimeout(r, SETTLE_MS));
        if (this.win.isDestroyed()) return;
        if (this.lastImage) this.opts.onThumb(id, this.lastImage.toDataURL());
      }
    } finally {
      this.busy = false;
    }
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
