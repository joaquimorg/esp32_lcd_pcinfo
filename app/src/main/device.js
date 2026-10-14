'use strict';

const { EventEmitter } = require('events');
const { SerialPort } = require('serialport');
const P = require('./protocol');

const ESPRESSIF_VID = '303a';
// PIDs Espressif que nunca correm este firmware (que usa o USB nativo do S2):
// 0x1001 = USB-Serial-JTAG (S3/C3/C6...) — abrir a porta mexe no DTR/RTS e pode
// reiniciar essa placa; 0x0002 = bootloader da ROM.
const SKIP_PIDS = new Set(['1001', '0002']);
const PORT_OP_TIMEOUT_MS = 3000;   // abrir/fechar uma porta USB pode bloquear se o dispositivo estiver a desaparecer
const RETRY_MS = 2000;
const HELLO_TIMEOUT_MS = 1500;
const ACK_TIMEOUT_MS = 2000;
const STUCK_MS = 4000;          // frames pendentes e nenhum ACK durante este tempo: ESP32 preso
const HELLO_FAILS_TO_RESTART = 2;
const RESTART_BAUD = 2400;      // abrir e fechar a porta a esta velocidade reinicia o ESP32 (firmware)
const RESTART_WAIT_MS = 7000;   // o S2 demora alguns segundos a voltar a aparecer no USB
const CLOSE_DRAIN_MS = 500;
// Um envio de cada vez (ver BATCH_BYTES em frame-sender.js): com o próximo já
// a caminho enquanto o ESP32 desenha o anterior, o buffer dele enchia e o USB
// ficava travado com respostas a sair ao mesmo tempo, o que encrava o S2.
const MAX_IN_FLIGHT = 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ligação ao ESP32. Procura as portas Espressif, confirma com HELLO e volta a
 * ligar sozinha quando o cabo é desligado.
 *
 * Recuperação: no ESP32-S2, fechar a porta com dados USB a meio pode deixar
 * a comunicação presa (o canal de controlo continua a funcionar). Se a porta
 * que já foi do ESP32 deixar de responder, pede-se um reinício abrindo-a a
 * 2400 baud — o firmware reinicia ao ver o DTR descer a essa velocidade.
 *
 * Eventos: connected(info), disconnected(), ack(ack), device-error(err), resync(), log(msg)
 */
class Device extends EventEmitter {
  constructor() {
    super();
    this.port = null;
    this.info = null;
    this.portSetting = 'auto';
    this.lastPort = null;
    this.parser = new P.ReplyParser();
    this.helloWaiter = null;
    this.inFlight = [];
    this.seq = 0;
    this.lastAckAt = 0;
    this.helloFails = new Map();   // porta -> HELLOs falhados seguidos
    this.stopped = false;
  }

  start({ portSetting = 'auto', lastPort = null } = {}) {
    this.portSetting = portSetting;
    this.lastPort = lastPort;
    this._loop();
  }

  /**
   * Fecha a ligação de forma limpa: deixa de enviar e espera pelos ACKs
   * pendentes, para não deixar dados USB a meio (ver acima).
   */
  async stop() {
    this.stopped = true;
    const port = this.port;
    if (!port) return;
    const until = Date.now() + CLOSE_DRAIN_MS;
    while (this.inFlight.length && Date.now() < until) await sleep(20);
    await Promise.race([new Promise((r) => port.drain(() => r())), sleep(CLOSE_DRAIN_MS)]);
    await closePort(port);
  }

  /** Muda a porta configurada ('auto' ou 'COMx'); volta a ligar se for preciso. */
  setPortSetting(portSetting) {
    if (portSetting === this.portSetting) return;
    this.portSetting = portSetting;
    if (this.port && portSetting !== 'auto' && portSetting !== this.info?.path) this.port.close();
  }

  get ready() {
    return !!(this.port && this.info);
  }

  canSend() {
    return this.ready && !this.stopped && this.inFlight.length < MAX_IN_FLIGHT;
  }

  /** Diz ao ESP32 qual é a área visível do painel (usada no ecrã de espera). */
  setViewport(vp) {
    if (!this.ready) return;
    this.port.write(P.packet(P.PKT.VIEWPORT, vp.x, vp.y, vp.width, vp.height));
    this.info.viewport = { ...vp };
  }

  /** Idioma do ecrã de espera do ESP32 ('en' | 'pt'); é guardado na flash dele. */
  setLanguage(lang) {
    const code = P.LCD_LANGS[lang] ?? 0;
    if (!this.ready || this.info.lang === code || this.info.lang == null) return;
    this.port.write(P.packet(P.PKT.LANG, code));
    this.info.lang = code;
  }

  /** Envia os pacotes de um frame seguidos de SYNC; o ACK liberta o próximo. */
  sendFrame(packets) {
    if (!this.canSend()) return false;
    this.seq = (this.seq + 1) >>> 0;
    const data = Buffer.concat([...packets, P.syncPacket(this.seq)]);
    this.inFlight.push({ seq: this.seq, time: Date.now() });
    this.port.write(data);
    return true;
  }

  async _loop() {
    while (!this.stopped) {
      if (!this.port) {
        try {
          await this._connect();
        } catch (err) {
          this.emit('log', `ligação falhou: ${err.message}`);
        }
      } else if (this.inFlight.length && Date.now() - this.inFlight[0].time > ACK_TIMEOUT_MS) {
        if (Date.now() - this.lastAckAt > STUCK_MS) {
          await this._recover(this.info?.path, 'sem ACKs');
          continue;
        }
        // Perdeu-se um ACK: recomeça com um frame completo.
        this.emit('log', `ACK ${this.inFlight[0].seq} não chegou em ${ACK_TIMEOUT_MS} ms: frame completo`);
        this.inFlight = [];
        this.emit('resync');
      }
      await sleep(this.port ? 250 : RETRY_MS);
    }
  }

  async _candidates() {
    if (this.portSetting && this.portSetting !== 'auto') return [this.portSetting];
    const ports = (await withTimeout(SerialPort.list(), PORT_OP_TIMEOUT_MS, 'listar portas'))
      .filter((p) => (p.vendorId || '').toLowerCase() === ESPRESSIF_VID)
      .filter((p) => !SKIP_PIDS.has((p.productId || '').toLowerCase().padStart(4, '0')))
      .map((p) => p.path);
    // A última porta que respondeu primeiro.
    ports.sort((a, b) => (b === this.lastPort) - (a === this.lastPort));
    return ports;
  }

  /** Portas que sabemos serem do ESP32: só a essas se pede um reinício. */
  _isOurPort(path) {
    return path === this.lastPort || (this.portSetting !== 'auto' && path === this.portSetting);
  }

  async _connect() {
    for (const path of await this._candidates()) {
      if (this.stopped) return;
      const port = new SerialPort({ path, baudRate: 115200, autoOpen: false });
      port.on('error', () => {});
      try {
        await openPort(port);
      } catch {
        continue;
      }
      this._attach(port);
      try {
        const hello = await this._hello();
        this.info = { ...hello, path };
        this.lastPort = path;
        this.lastAckAt = Date.now();
        this.helloFails.delete(path);
        this.emit('connected', this.info);
        return;
      } catch {
        this._detach();
        await closePort(port);
        if (this._isOurPort(path)) {
          const fails = (this.helloFails.get(path) || 0) + 1;
          this.helloFails.set(path, fails);
          if (fails >= HELLO_FAILS_TO_RESTART) {
            await this._requestRestart(path, 'não responde ao HELLO');
            return;
          }
        }
      }
    }
  }

  /** Fecha a ligação atual e reinicia o ESP32. */
  async _recover(path, reason) {
    const port = this.port;
    const wasReady = this.ready;
    this._detach();
    if (wasReady) this.emit('disconnected');
    if (port) await closePort(port);
    if (path) await this._requestRestart(path, reason);
  }

  async _requestRestart(path, reason) {
    this.emit('log', `${path} ${reason}: a reiniciar o ESP32`);
    this.helloFails.delete(path);
    const port = new SerialPort({ path, baudRate: RESTART_BAUD, autoOpen: false });
    port.on('error', () => {});
    try {
      await openPort(port);
      await withTimeout(new Promise((r) => port.set({ dtr: false }, () => r())), PORT_OP_TIMEOUT_MS, 'DTR');
      await closePort(port);
    } catch (err) {
      this.emit('log', `pedido de reinício falhou: ${err.message}`);
    }
    await sleep(RESTART_WAIT_MS);
  }

  _attach(port) {
    this.port = port;
    this.parser = new P.ReplyParser();
    this.inFlight = [];
    port.on('data', (chunk) => {
      for (const r of this.parser.push(chunk)) this._onReply(r);
    });
    port.on('close', () => this._onClose(port));
    port.on('error', (err) => this.emit('log', `erro na porta: ${err.message}`));
  }

  _detach() {
    if (this.port) {
      this.port.removeAllListeners();
      // Uma escrita ainda pendente é cancelada ao fechar ("Operation aborted") e
      // chega como evento 'error': sem listener, seria uma exceção não tratada.
      this.port.on('error', () => {});
    }
    this.port = null;
    this.info = null;
    this.inFlight = [];
  }

  _onClose(port) {
    if (port !== this.port) return;
    const wasReady = this.ready;
    this._detach();
    if (wasReady) this.emit('disconnected');
  }

  _hello() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.helloWaiter = null;
        reject(new Error('sem resposta ao HELLO'));
      }, HELLO_TIMEOUT_MS);
      this.helloWaiter = (info) => {
        clearTimeout(timer);
        this.helloWaiter = null;
        resolve(info);
      };
      this.port.write(P.packet(P.PKT.HELLO));
    });
  }

  _onReply({ type, payload }) {
    if (type === P.RSP.HELLO && this.helloWaiter) {
      this.helloWaiter(P.parseHello(payload));
    } else if (type === P.RSP.ACK) {
      const ack = P.parseAck(payload);
      this.lastAckAt = Date.now();
      const idx = this.inFlight.findIndex((f) => f.seq === ack.seq);
      if (idx >= 0) this.inFlight.splice(0, idx + 1);
      this.emit('ack', ack);
    } else if (type === P.RSP.ERROR) {
      this.emit('device-error', P.parseError(payload));
    }
  }
}

// Adaptadores USB-série comuns (placas ESP32 sem USB nativo, Arduinos, ...).
const USB_UART_VIDS = { '10c4': 'Silicon Labs CP210x', '1a86': 'WCH CH340/CH9102', '0403': 'FTDI', '067b': 'Prolific PL2303' };

/**
 * Classifica uma porta para a lista de escolha na app. kind é um código
 * (jtag, boot, native, uart, system, other) que a janela traduz; short é o
 * nome curto quando não depende do idioma.
 */
function describePort(p) {
  const vid = (p.vendorId || '').toLowerCase();
  const pid = (p.productId || '').toLowerCase().padStart(4, '0');
  let kind, short = null, uart = null;
  let usable = false;   // pode ter o firmware do LCD?
  if (vid === ESPRESSIF_VID && pid === '1001') [kind, short] = ['jtag', 'Espressif JTAG'];
  else if (vid === ESPRESSIF_VID && pid === '0002') [kind, short] = ['boot', 'bootloader'];
  else if (vid === ESPRESSIF_VID) { [kind, short] = ['native', 'ESP32-S2']; usable = true; }
  else if (USB_UART_VIDS[vid]) [kind, short, uart] = ['uart', USB_UART_VIDS[vid], USB_UART_VIDS[vid]];
  else if (!vid) kind = 'system';
  else kind = 'other';
  return {
    path: p.path,
    kind,
    short,
    uart,
    usable,
    name: p.friendlyName || '',
    manufacturer: p.manufacturer || '',
    vid: vid ? vid.toUpperCase() : '',
    pid: vid ? pid.toUpperCase() : '',
    serialNumber: p.serialNumber || '',
  };
}

/** Todas as portas série do PC, as que podem ter o LCD primeiro. */
async function listPorts() {
  const ports = (await withTimeout(SerialPort.list(), PORT_OP_TIMEOUT_MS, 'listar portas')).map(describePort);
  const num = (path) => Number((/\d+/.exec(path) || [0])[0]);
  return ports.sort((a, b) => (b.usable - a.usable) || num(a.path) - num(b.path));
}

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: sem resposta em ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Abre uma porta com limite de tempo; se abrir depois do limite, é fechada. */
async function openPort(port) {
  const opened = new Promise((resolve, reject) => port.open((err) => (err ? reject(err) : resolve())));
  try {
    await withTimeout(opened, PORT_OP_TIMEOUT_MS, `abrir ${port.path}`);
  } catch (err) {
    opened.then(() => port.close(() => {}), () => {});
    throw err;
  }
}

/** Fecha uma porta sem rebentar se já estiver fechada, com escritas pendentes ou a bloquear. */
function closePort(port) {
  const closed = new Promise((resolve) => {
    if (!port.isOpen) return resolve();
    port.close(() => resolve());
  });
  return withTimeout(closed, PORT_OP_TIMEOUT_MS, `fechar ${port.path}`).catch(() => {});
}

module.exports = { Device, listPorts, describePort };
