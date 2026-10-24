'use strict';

// Protocolo USB display — tem de coincidir com src/protocol.h (firmware).
// Pixels em RGB565 big-endian; ver protocol.h para o formato RLE.

const MAGIC0 = 0xA5;
const MAGIC1 = 0x5A;
const HEADER_SIZE = 16;

const PKT = { HELLO: 0x01, RECT_RAW: 0x02, RECT_RLE: 0x03, FILL: 0x04, SYNC: 0x05, SINK: 0x06, VIEWPORT: 0x07, LANG: 0x08 };
const RSP = { HELLO: 0x81, ACK: 0x85, ERROR: 0x8E };
const ERROR_NAMES = { 1: 'BAD_TYPE', 2: 'BAD_RECT', 3: 'BAD_LEN', 4: 'RLE_DECODE', 5: 'RX_TIMEOUT' };

function packet(type, x = 0, y = 0, w = 0, h = 0, payload = null) {
  const len = payload ? payload.length : 0;
  const buf = Buffer.allocUnsafe(HEADER_SIZE + len);
  buf[0] = MAGIC0;
  buf[1] = MAGIC1;
  buf[2] = type;
  buf[3] = 0;
  buf.writeUInt16LE(x, 4);
  buf.writeUInt16LE(y, 6);
  buf.writeUInt16LE(w, 8);
  buf.writeUInt16LE(h, 10);
  buf.writeUInt32LE(len, 12);
  if (payload) payload.copy(buf, HEADER_SIZE);
  return buf;
}

function syncPacket(seq) {
  const p = Buffer.allocUnsafe(4);
  p.writeUInt32LE(seq >>> 0, 0);
  return packet(PKT.SYNC, 0, 0, 0, 0, p);
}

/** Bitmap BGRA (nativeImage.toBitmap no Windows) -> RGB565 */
function bgraToRgb565(bgra, out) {
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    out[i] = ((bgra[j + 2] & 0xF8) << 8) | ((bgra[j + 1] & 0xFC) << 3) | (bgra[j] >> 3);
  }
  return out;
}

function rectPixels(frame, stride, x, y, w, h) {
  const px = new Uint16Array(w * h);
  for (let row = 0; row < h; row++) {
    const start = (y + row) * stride + x;
    px.set(frame.subarray(start, start + w), row * w);
  }
  return px;
}

/** RGB565 -> bytes big-endian, a ordem que o LCD espera */
function toWire(px) {
  const buf = Buffer.allocUnsafe(px.length * 2);
  for (let i = 0; i < px.length; i++) {
    buf[2 * i] = px[i] >> 8;
    buf[2 * i + 1] = px[i] & 0xFF;
  }
  return buf;
}

/**
 * RLE de pixels de 16 bits:
 *   c < 0x80  -> c+1 pixels literais
 *   c >= 0x80 -> (c & 0x7F)+1 repetições do pixel seguinte
 */
function rleEncode(px) {
  const n = px.length;
  const out = Buffer.allocUnsafe(n * 2 + Math.ceil(n / 128) + 1);
  let o = 0;

  const literal = (s, e) => {
    while (s < e) {
      const k = Math.min(128, e - s);
      out[o++] = k - 1;
      for (let i = s; i < s + k; i++) {
        out[o++] = px[i] >> 8;
        out[o++] = px[i] & 0xFF;
      }
      s += k;
    }
  };

  let litStart = -1;
  let i = 0;
  while (i < n) {
    let j = i + 1;
    while (j < n && px[j] === px[i]) j++;
    let run = j - i;
    if (run >= 2) {
      if (litStart >= 0) {
        literal(litStart, i);
        litStart = -1;
      }
      while (run) {
        const k = Math.min(128, run);
        out[o++] = 0x80 | (k - 1);
        out[o++] = px[i] >> 8;
        out[o++] = px[i] & 0xFF;
        run -= k;
      }
    } else if (litStart < 0) {
      litStart = i;
    }
    i = j;
  }
  if (litStart >= 0) literal(litStart, n);
  return out.subarray(0, o);
}

function rleDecode(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const c = data[i];
    const n = (c & 0x7F) + 1;
    if (c & 0x80) {
      for (let k = 0; k < n; k++) out.push(data[i + 1], data[i + 2]);
      i += 3;
    } else {
      for (let k = 0; k < 2 * n; k++) out.push(data[i + 1 + k]);
      i += 1 + 2 * n;
    }
  }
  return Buffer.from(out);
}

/**
 * Retângulos alterados entre dois frames: um por faixa horizontal de `band`
 * linhas. Sem frame anterior devolve todas as faixas (o ecrã inteiro), para
 * nenhum pacote passar do tamanho de uma faixa.
 */
function dirtyRects(prev, cur, width, height, band = 16) {
  if (!prev || prev.length !== cur.length) {
    const all = [];
    for (let y = 0; y < height; y += band) all.push([0, y, width, Math.min(band, height - y)]);
    return all;
  }
  const rects = [];
  for (let y0 = 0; y0 < height; y0 += band) {
    const y1 = Math.min(height, y0 + band);
    let minX = width, maxX = -1, minY = -1, maxY = -1;
    for (let y = y0; y < y1; y++) {
      const base = y * width;
      let rowMin = -1, rowMax = -1;
      for (let x = 0; x < width; x++) {
        if (prev[base + x] !== cur[base + x]) {
          rowMin = x;
          break;
        }
      }
      if (rowMin < 0) continue;
      for (let x = width - 1; x >= rowMin; x--) {
        if (prev[base + x] !== cur[base + x]) {
          rowMax = x;
          break;
        }
      }
      if (minY < 0) minY = y;
      maxY = y;
      if (rowMin < minX) minX = rowMin;
      if (rowMax > maxX) maxX = rowMax;
    }
    if (minY >= 0) rects.push([minX, minY, maxX - minX + 1, maxY - minY + 1]);
  }
  return rects;
}

/** Pacote para um retângulo: RLE ou raw, o que for mais pequeno. */
function rectPacket(frame, stride, x, y, w, h, offX = 0, offY = 0) {
  const px = rectPixels(frame, stride, x, y, w, h);
  const rle = rleEncode(px);
  if (rle.length < px.length * 2) return packet(PKT.RECT_RLE, x + offX, y + offY, w, h, rle);
  return packet(PKT.RECT_RAW, x + offX, y + offY, w, h, toWire(px));
}

/**
 * Pacotes para passar de prev a cur. O frame tem o tamanho da área visível;
 * offX/offY deslocam-no para a posição dessa área no controlador do LCD.
 */
function encodeFrame(prev, cur, width, height, offX = 0, offY = 0) {
  return dirtyRects(prev, cur, width, height).map(([x, y, w, h]) => rectPacket(cur, width, x, y, w, h, offX, offY));
}

/** Pinta um retângulo do controlador de uma cor (RGB565). */
function fillPacket(x, y, w, h, color = 0) {
  return packet(PKT.FILL, x, y, w, h, Buffer.from([color >> 8, color & 0xFF]));
}

/** Parser incremental das respostas do ESP32. */
class ReplyParser {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const replies = [];
    for (;;) {
      const start = this.buf.indexOf(Buffer.from([MAGIC0, MAGIC1]));
      if (start < 0) {
        // Guarda o último byte: pode ser o início de um magic.
        this.buf = this.buf.subarray(Math.max(0, this.buf.length - 1));
        break;
      }
      if (this.buf.length < start + 5) {
        this.buf = this.buf.subarray(start);
        break;
      }
      const type = this.buf[start + 2];
      const len = this.buf.readUInt16LE(start + 3);
      if (this.buf.length < start + 5 + len) {
        this.buf = this.buf.subarray(start);
        break;
      }
      replies.push({ type, payload: Buffer.from(this.buf.subarray(start + 5, start + 5 + len)) });
      this.buf = this.buf.subarray(start + 5 + len);
    }
    return replies;
  }
}

function parseHello(p) {
  return {
    version: p[0],
    width: p.readUInt16LE(1),     // controlador do LCD
    height: p.readUInt16LE(3),
    dma: !!(p[5] & 1),
    // v3: área visível guardada no ESP32
    viewport: p.length >= 14
      ? { x: p.readUInt16LE(6), y: p.readUInt16LE(8), width: p.readUInt16LE(10), height: p.readUInt16LE(12) }
      : null,
    // Porque reiniciou o ESP32 da última vez (firmwares antigos não mandam).
    reset: p.length >= 16 ? { reason: p[14], cause: p[15] } : null,
    // Idioma do ecrã de espera guardado no ESP32 (LANG_*), ou null em firmwares antigos.
    lang: p.length >= 17 ? p[16] : null,
    // Como o ESP32 está ligado ao PC (TRANSPORT_*); firmwares antigos usam o USB nativo.
    transport: p.length >= 18 && p[17] === 1 ? 'uart' : 'usb',
  };
}

// esp_reset_reason_t do ESP-IDF e RestartCause do firmware -> chaves de src/i18n.js
const RESET_REASONS = {
  1: 'reset.power', 2: 'reset.pin', 3: 'reset.software', 4: 'reset.panic', 5: 'reset.intWdt',
  6: 'reset.taskWdt', 7: 'reset.wdt', 8: 'reset.deepSleep', 9: 'reset.brownout',
};
const RESTART_CAUSES = { 1: 'reset.txStall', 2: 'reset.byApp', 3: 'reset.rxStall' };

/** Texto da razão do último reinício (t = função de tradução). */
function describeReset(reset, t) {
  if (!reset) return null;
  const key = RESTART_CAUSES[reset.cause] || RESET_REASONS[reset.reason];
  return key ? t(key) : t('reset.other', { n: reset.reason });
}

// Idiomas do ecrã de espera do firmware (protocol.h, LANG_*).
const LCD_LANGS = { en: 0, pt: 1 };

function parseAck(p) {
  return {
    seq: p.readUInt32LE(0),
    packets: p.readUInt32LE(4),
    payloadBytes: p.readUInt32LE(8),
    errors: p.readUInt32LE(12),
    resyncBytes: p.readUInt32LE(16),
    // v2: muda quando o ESP32 desenhou o seu próprio ecrã (ex: espera)
    screenEpoch: p.length >= 24 ? p.readUInt32LE(20) : null,
  };
}

function parseError(p) {
  return { code: ERROR_NAMES[p[0]] || p[0], packetType: p[1] };
}

module.exports = {
  PKT, RSP, packet, syncPacket, bgraToRgb565, rectPixels, toWire, rleEncode, rleDecode,
  dirtyRects, rectPacket, encodeFrame, fillPacket, ReplyParser, parseHello, parseAck, parseError, describeReset, LCD_LANGS,
};
