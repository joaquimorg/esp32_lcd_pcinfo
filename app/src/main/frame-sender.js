'use strict';

const P = require('./protocol');

// O ESP32 mostra o ecrã de espera ao fim de 3 s sem pacotes (IDLE_TIMEOUT_MS no
// firmware); sem alterações no ecrã enviamos um SYNC para o manter ativo.
const KEEPALIVE_MS = 1000;

// Tamanho máximo de cada envio (pacotes + SYNC). Tem de caber com folga no
// buffer de receção do ESP32 (RX_RING_SIZE = 32 KB no firmware): assim o ESP32
// nunca tem de travar o USB (NAK) a meio de um envio. No ESP32-S2, o USB
// travado durante muito tempo, com respostas a sair ao mesmo tempo, acabava
// por encravar (dados perdidos, ESP32 a reiniciar), por exemplo com GIFs.
const BATCH_BYTES = 16 * 1024;

const TYPE_NAMES = { [P.PKT.RECT_RAW]: 'raw', [P.PKT.RECT_RLE]: 'rle', [P.PKT.RECT_LZ4]: 'lz4', [P.PKT.FILL]: 'fill' };

function newCounters() {
  return { frames: 0, bytes: 0, rects: 0, changedPx: 0, sentPx: 0, byType: { raw: 0, rle: 0, lz4: 0, fill: 0 } };
}

/** Agrupa pacotes em lotes de até maxBytes (um pacote maior fica sozinho). */
function batchPackets(packets, maxBytes = BATCH_BYTES) {
  const batches = [];
  let cur = [], size = 0;
  for (const p of packets) {
    if (cur.length && size + p.length > maxBytes) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(p);
    size += p.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/**
 * Recebe frames RGB565 completos e envia ao ESP32 só o que mudou desde o
 * último frame enviado. Se o ESP32 estiver ocupado fica só o frame mais
 * recente (os intermédios são descartados).
 *
 * Cada frame vai em lotes de até BATCH_BYTES, um de cada vez: o próximo lote
 * só segue depois do ACK do anterior (ver Device, MAX_IN_FLIGHT).
 *
 * Os frames têm o tamanho da área desenhada (normalmente a área visível do
 * painel), que fica em (x, y) dentro do controlador do LCD.
 */
class FrameSender {
  constructor(device) {
    this.device = device;
    this.geom = { x: 0, y: 0, width: 0, height: 0 };
    this.controller = { width: 0, height: 0 };
    this.latest = null;     // último frame recebido
    this.pending = null;    // à espera de envio
    this.batches = [];      // lotes do frame em envio que ainda faltam
    this.lastSent = null;   // o que está no LCD
    this.needsClear = true; // pintar o controlador de preto antes do próximo frame completo
    this.counters = newCounters();
    this.screenEpoch = null;
    this.lastSendAt = 0;

    const fullRedraw = () => {
      this.batches = [];
      this.lastSent = null;
      this.needsClear = true;
      this.pending = this.latest;
      this.pump();
    };
    this.fullRedraw = fullRedraw;
    device.on('connected', () => {
      this.screenEpoch = null;
      fullRedraw();
    });
    device.on('resync', fullRedraw);
    device.on('device-error', fullRedraw);
    device.on('ack', (ack) => {
      // O ESP32 desenhou por cima (ecrã de espera): o que lá está já não é lastSent.
      if (ack.screenEpoch != null && this.screenEpoch != null && ack.screenEpoch !== this.screenEpoch) {
        this.screenEpoch = ack.screenEpoch;
        fullRedraw();
        return;
      }
      if (ack.screenEpoch != null) this.screenEpoch = ack.screenEpoch;
      this.pump();
    });

    setInterval(() => {
      if (Date.now() - this.lastSendAt >= KEEPALIVE_MS && this.device.canSend()) {
        this.device.sendFrame([]);
        this.lastSendAt = Date.now();
      }
    }, KEEPALIVE_MS / 2).unref();
  }

  /**
   * @param geom        { x, y, width, height } da área desenhada no controlador
   * @param controller  { width, height } do controlador do LCD
   */
  setGeometry(geom, controller) {
    const same = ['x', 'y', 'width', 'height'].every((k) => geom[k] === this.geom[k])
      && controller.width === this.controller.width && controller.height === this.controller.height;
    if (same) return;
    this.geom = { ...geom };
    this.controller = { ...controller };
    this.latest = this.pending = this.lastSent = null;
    this.batches = [];
    this.needsClear = true;
  }

  submit(frame) {
    if (frame.length !== this.geom.width * this.geom.height) return;
    this.latest = frame;
    this.pending = frame;
    this.pump();
  }

  pump() {
    if (!this.device.canSend()) return;
    if (!this.batches.length) {
      if (!this.pending) return;
      const frame = this.pending;
      this.pending = null;
      const { x, y, width, height } = this.geom;
      const packets = P.encodeFrame(this.lastSent, frame, width, height, x, y, { lz4: !!this.device.info?.lz4, align: this.device.info?.align || 1 });
      this.count(packets);
      if (this.needsClear && !this.lastSent) {
        // Limpa o que ficou fora da área (ecrã de espera, área antiga maior).
        const c = this.controller.width ? this.controller : { width: x + width, height: y + height };
        packets.unshift(P.fillPacket(0, 0, c.width, c.height, 0));
      }
      // O ESP32 recebe tudo pela ordem: os lotes que faltam já contam como enviados.
      this.lastSent = frame;
      this.needsClear = false;
      if (!packets.length) return;
      this.batches = batchPackets(packets);
      this.counters.frames++;
    }
    const batch = this.batches[0];
    if (this.device.sendFrame(batch)) {
      this.batches.shift();
      this.lastSendAt = Date.now();
      this.counters.bytes += batch.reduce((n, p) => n + p.length, 0);
    }
  }

  /** Contadores de diagnóstico (LCD_DEBUG): bytes por formato e quanto do que se enviou mudou mesmo. */
  count(packets) {
    const c = this.counters, st = packets.stats;
    if (st) {
      c.rects += st.rects;
      c.changedPx += st.changedPx;
      c.sentPx += st.sentPx;
    }
    for (const p of packets) {
      const name = TYPE_NAMES[p[2]];
      if (name) c.byType[name] += p.length;
    }
  }

  /** Devolve e reinicia os contadores (para fps e KB/s). */
  takeCounters() {
    const c = this.counters;
    this.counters = newCounters();
    return c;
  }
}

module.exports = { FrameSender, batchPackets, BATCH_BYTES };
