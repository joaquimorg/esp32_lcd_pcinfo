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
// Por Wi-Fi o anel do ESP32 é de 64 KB e o transporte controla a janela: lotes maiores,
// com dois em voo (ver Device.maxInFlight), mantêm o rádio ocupado.
const WIFI_BATCH_BYTES = 24 * 1024;

// "Fluidez das animações": nas zonas que mexem muito (animações, GIFs, transições) manda-se
// menos informação: metade da resolução (o ESP32 duplica os pixels, se o suportar) e/ou menos
// bits de cor (máscara RGB565 r5 g6 b5). Assim que a imagem acalma, a seguinte repõe tudo.
const LEVELS = {
  quality: { half: false, mask: 0xFFFF },
  balanced: { half: true, mask: 0xFFFF },
  smooth: { half: true, mask: 0xE71C },
};
const HEAVY_FRACTION = 0.06;   // fração do ecrã que muda para a imagem contar como "pesada"
const LOSSY_HOLD_MS = 800;     // depois de uma imagem pesada, continua com perdas até haver este tempo de calma

const TYPE_NAMES = { [P.PKT.RECT_RAW]: 'raw', [P.PKT.RECT_RLE]: 'rle', [P.PKT.RECT_LZ4]: 'lz4', [P.PKT.FILL]: 'fill' };

function newCounters() {
  return {
    frames: 0, bytes: 0, rects: 0, changedPx: 0, sentPx: 0, byType: { raw: 0, rle: 0, lz4: 0, fill: 0 },
    encodeMs: 0,   // tempo a codificar frames
    idleMs: 0,     // tempo com o cabo parado: do ACK até ao lote seguinte ser escrito
  };
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
    this.quality = 'quality';
    this.lossyUntil = 0;
    this.prevRaw = null;           // frame anterior, tal como chegou (para medir o movimento)
    this.now = () => Date.now();   // relógio (os testes trocam-no)
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
      this.ackAt = process.hrtime.bigint();
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

  /** 'quality' | 'balanced' | 'smooth' (ver QUALITY_MASKS). */
  setQuality(quality) {
    this.quality = LEVELS[quality] ? quality : 'quality';
  }

  submit(frame) {
    if (frame.length !== this.geom.width * this.geom.height) return;
    this.latest = frame;
    this.pending = frame;
    this.pump();
  }

  /**
   * O que enviar para este frame: ele próprio, ou (em movimento intenso) uma versão com
   * perdas só nos blocos que mexeram. Devolve { frame, half }; frame é o que fica no LCD.
   */
  adapt(frame) {
    const level = LEVELS[this.quality];
    const prevRaw = this.prevRaw;
    this.prevRaw = frame;
    if ((level.mask === 0xFFFF && !level.half) || !this.lastSent || !prevRaw || prevRaw.length !== frame.length) {
      return { frame, half: false };
    }
    // O movimento mede-se nas imagens originais, não no que está no LCD (que já tem perdas).
    let moved = 0;
    for (let i = 0; i < frame.length; i++) if (frame[i] !== prevRaw[i]) moved++;
    const now = this.now();
    // Histerese: durante a animação não se alterna entre perdas e cor completa (cada reposição
    // custaria um frame inteiro); só quando há calma é que o frame seguinte repõe tudo.
    if (moved > frame.length * HEAVY_FRACTION) this.lossyUntil = now + LOSSY_HOLD_MS;
    if (now >= this.lossyUntil) return { frame, half: false };

    const { width, height } = this.geom;
    const half = level.half && !!this.device.info?.upscale && width % 2 === 0 && height % 2 === 0;
    const out = Uint16Array.from(this.lastSent);   // o que não mexeu fica como está no LCD
    if (half) {
      for (let by = 0; by < height; by += 2) {
        for (let bx = 0; bx < width; bx += 2) {
          const i = by * width + bx, j = i + width;
          if (frame[i] === prevRaw[i] && frame[i + 1] === prevRaw[i + 1] && frame[j] === prevRaw[j] && frame[j + 1] === prevRaw[j + 1]) continue;
          const a = frame[i], b = frame[i + 1], c = frame[j], d = frame[j + 1];
          const r = ((a >> 11) + (b >> 11) + (c >> 11) + (d >> 11) + 2) >> 2;
          const g = (((a >> 5) & 63) + ((b >> 5) & 63) + ((c >> 5) & 63) + ((d >> 5) & 63) + 2) >> 2;
          const bl = ((a & 31) + (b & 31) + (c & 31) + (d & 31) + 2) >> 2;
          out[i] = out[i + 1] = out[j] = out[j + 1] = ((r << 11) | (g << 5) | bl) & level.mask;
        }
      }
    } else {
      for (let i = 0; i < frame.length; i++) if (frame[i] !== prevRaw[i]) out[i] = frame[i] & level.mask;
    }
    return { frame: out, half };
  }

  /** Codifica o frame pendente em lotes (fica pronto enquanto o anterior ainda segue no cabo). */
  prepare() {
    if (!this.pending) return false;
    const { frame, half } = this.adapt(this.pending);
    this.pending = null;
    const { x, y, width, height } = this.geom;
    const t0 = process.hrtime.bigint();
    const packets = P.encodeFrame(this.lastSent, frame, width, height, x, y, { lz4: !!this.device.info?.lz4, align: this.device.info?.align || 1, half });
    this.counters.encodeMs += Number(process.hrtime.bigint() - t0) / 1e6;
    this.count(packets);
    if (this.needsClear && !this.lastSent) {
      // Limpa o que ficou fora da área (ecrã de espera, área antiga maior).
      const c = this.controller.width ? this.controller : { width: x + width, height: y + height };
      packets.unshift(P.fillPacket(0, 0, c.width, c.height, 0));
    }
    // O ESP32 recebe tudo pela ordem: os lotes que faltam já contam como enviados.
    this.lastSent = frame;
    this.needsClear = false;
    if (!packets.length) return false;
    this.batches = batchPackets(packets, this.device.info?.transport === 'wifi' ? WIFI_BATCH_BYTES : BATCH_BYTES);
    this.counters.frames++;
    return true;
  }

  pump() {
    if (!this.device.canSend()) return;
    if (!this.batches.length && !this.prepare()) return;
    const batch = this.batches[0];
    const gapFrom = this.ackAt;
    // Todos menos o último lote do frame levam "hold": o LCD mostra o frame de uma vez.
    if (this.device.sendFrame(batch, { hold: this.batches.length > 1 })) {
      if (gapFrom) this.counters.idleMs += Number(process.hrtime.bigint() - gapFrom) / 1e6;
      this.ackAt = null;
      this.batches.shift();
      this.lastSendAt = Date.now();
      this.counters.bytes += batch.reduce((n, p) => n + p.length, 0);
      // Codifica já o frame seguinte, enquanto este segue no cabo.
      if (!this.batches.length) this.prepare();
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
