'use strict';

// Protocolo USB display — tem de coincidir com src/protocol.h (firmware).
// Pixels em RGB565 big-endian; ver protocol.h para o formato RLE.

const MAGIC0 = 0xA5;
const MAGIC1 = 0x5A;
const HEADER_SIZE = 16;

const PKT = { HELLO: 0x01, RECT_RAW: 0x02, RECT_RLE: 0x03, FILL: 0x04, SYNC: 0x05, SINK: 0x06, VIEWPORT: 0x07, LANG: 0x08, RECT_LZ4: 0x09, ROTATION: 0x0A, WIFI_SET: 0x0B };
const RSP = { HELLO: 0x81, ACK: 0x85, ERROR: 0x8E };
const ERROR_NAMES = { 1: 'BAD_TYPE', 2: 'BAD_RECT', 3: 'BAD_LEN', 4: 'RLE_DECODE', 5: 'RX_TIMEOUT' };

function packet(type, x = 0, y = 0, w = 0, h = 0, payload = null, flags = 0) {
  const len = payload ? payload.length : 0;
  const buf = Buffer.allocUnsafe(HEADER_SIZE + len);
  buf[0] = MAGIC0;
  buf[1] = MAGIC1;
  buf[2] = type;
  buf[3] = flags;
  buf.writeUInt16LE(x, 4);
  buf.writeUInt16LE(y, 6);
  buf.writeUInt16LE(w, 8);
  buf.writeUInt16LE(h, 10);
  buf.writeUInt32LE(len, 12);
  if (payload) payload.copy(buf, HEADER_SIZE);
  return buf;
}

// flags de PKT_RECT_LZ4: os pixels do pacote são metade da largura e da altura e o
// ESP32 duplica-os (blocos 2x2); x, y, w, h têm de ser pares. Só com HELLO.upscale.
const RECT_FLAG_2X = 0x01;
const SYNC_HOLD = 0x01;   // flags do SYNC: ainda há lotes deste frame; o LCD só o mostra no último

/** hold = há mais lotes deste frame a seguir: o ESP32 com framebuffer espera para mostrar tudo de uma vez. */
function syncPacket(seq, hold = false) {
  const p = Buffer.allocUnsafe(4);
  p.writeUInt32LE(seq >>> 0, 0);
  const buf = packet(PKT.SYNC, 0, 0, 0, 0, p);
  if (hold) buf[3] = SYNC_HOLD;
  return buf;
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

/**
 * LZ4 (formato de bloco) greedy, sem dependências. Cumpre as regras do formato:
 * os últimos 5 bytes são literais e nenhuma sequência começa nos últimos 12.
 * O firmware (lz4Decode em main.cpp) descomprime-o.
 */
const LZ4_HASH_BITS = 14;
const LZ4_CHAIN_DEPTH = 24;   // candidatos testados por posição: mais = melhor compressão, mais CPU
const lz4Head = new Int32Array(1 << LZ4_HASH_BITS);
const lz4Stamp = new Uint32Array(1 << LZ4_HASH_BITS);
let lz4Epoch = 0;

function lz4Compress(src) {
  const n = src.length;
  const out = Buffer.allocUnsafe(n + Math.floor(n / 255) + 16);
  let o = 0, anchor = 0, i = 0;
  lz4Epoch = (lz4Epoch + 1) >>> 0 || 1;

  const emitLength = (len) => {
    while (len >= 255) { out[o++] = 255; len -= 255; }
    out[o++] = len;
  };
  const emit = (litEnd, offset, matchLen) => {
    const lit = litEnd - anchor;
    out[o++] = (Math.min(lit, 15) << 4) | (matchLen ? Math.min(matchLen - 4, 15) : 0);
    if (lit >= 15) emitLength(lit - 15);
    src.copy(out, o, anchor, litEnd);
    o += lit;
    if (!matchLen) return;
    out[o++] = offset & 0xFF;
    out[o++] = offset >> 8;
    if (matchLen - 4 >= 15) emitLength(matchLen - 4 - 15);
  };

  const matchLimit = n - 5;   // um match não passa daqui
  const chain = new Int32Array(n);   // posição anterior com o mesmo hash
  const insert = (pos) => {
    const h = Math.imul(src.readUInt32LE(pos), 2654435761) >>> (32 - LZ4_HASH_BITS);
    chain[pos] = lz4Stamp[h] === lz4Epoch ? lz4Head[h] : -1;
    lz4Stamp[h] = lz4Epoch;
    lz4Head[h] = pos;
    return chain[pos];
  };
  while (i + 12 <= n) {
    let cand = insert(i), bestLen = 0, bestOff = 0;
    const word = src.readUInt32LE(i);
    for (let depth = 0; cand >= 0 && i - cand <= 0xFFFF && depth < LZ4_CHAIN_DEPTH; depth++, cand = chain[cand]) {
      if (src.readUInt32LE(cand) !== word) continue;
      let len = 4;
      while (i + len < matchLimit && src[cand + len] === src[i + len]) len++;
      if (len > bestLen) { bestLen = len; bestOff = i - cand; }
    }
    if (bestLen >= 4) {
      emit(i, bestOff, bestLen);
      // Indexa o que o match cobriu, para os seguintes o poderem referir.
      for (let k = i + 1; k < i + bestLen && k + 12 <= n; k++) insert(k);
      i += bestLen;
      anchor = i;
    } else {
      i++;
    }
  }
  emit(n, 0, 0);
  return out.subarray(0, o);
}

/** Descomprime um bloco LZ4 (a mesma validação do firmware). Devolve null se estiver corrompido. */
function lz4Decompress(src, maxOut) {
  const out = Buffer.allocUnsafe(maxOut);
  let s = 0, d = 0;
  while (s < src.length) {
    const token = src[s++];
    let lit = token >> 4;
    if (lit === 15) {
      let b;
      do { if (s >= src.length) return null; b = src[s++]; lit += b; } while (b === 255);
    }
    if (lit > src.length - s || lit > maxOut - d) return null;
    src.copy(out, d, s, s + lit);
    d += lit; s += lit;
    if (s >= src.length) break;
    if (src.length - s < 2) return null;
    const off = src[s] | (src[s + 1] << 8);
    s += 2;
    if (!off || off > d) return null;
    let len = token & 15;
    if (len === 15) {
      let b;
      do { if (s >= src.length) return null; b = src[s++]; len += b; } while (b === 255);
    }
    len += 4;
    if (len > maxOut - d) return null;
    for (let k = 0; k < len; k++, d++) out[d] = out[d - off];
  }
  return out.subarray(0, d);
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

// Um retângulo comprimido com LZ4 é descomprimido de uma vez no ESP32, num
// buffer de LZ4_MAX_PIXELS pixels (LZ4_BUF no firmware): tem de ser igual lá.
const LZ4_MAX_PIXELS = 8192;

const TILE_W = 16, TILE_H = 16;
const MERGE_GAP = 1;   // tiles limpos que ainda se juntam a dois alterados vizinhos

/**
 * Parte um retângulo em faixas de até LZ4_MAX_PIXELS pixels. Com align > 1 as
 * faixas têm um número de linhas múltiplo de align.
 */
function splitRect([x, y, w, h], align = 1, maxPixels = LZ4_MAX_PIXELS) {
  let rows = Math.max(1, Math.floor(maxPixels / w));
  if (align > 1) rows = Math.max(align, rows - (rows % align));
  const out = [];
  for (let y0 = 0; y0 < h; y0 += rows) out.push([x, y + y0, w, Math.min(rows, h - y0)]);
  return out;
}

/**
 * Alarga um retângulo (em coordenadas do frame) para que, deslocado de offX/offY
 * para o controlador, x, y, largura e altura sejam múltiplos de align (os
 * AMOLED não aceitam janelas ímpares). Fica sempre dentro do frame, que tem de
 * ter o início e o tamanho alinhados (ver alignViewport).
 */
function alignRect([x, y, w, h], align, offX, offY, width, height) {
  if (align <= 1) return [x, y, w, h];
  const lo = (v, off) => Math.floor((v + off) / align) * align - off;
  const hi = (v, off) => Math.ceil((v + off) / align) * align - off;
  const x0 = Math.max(0, lo(x, offX)), x1 = Math.min(width, hi(x + w, offX));
  const y0 = Math.max(0, lo(y, offY)), y1 = Math.min(height, hi(y + h, offY));
  return [x0, y0, x1 - x0, y1 - y0];
}

/** Área visível com início e tamanho múltiplos de align (para os AMOLED). */
function alignViewport(vp, align = 1) {
  if (align <= 1) return vp;
  const down = (v) => Math.floor(v / align) * align;
  return { x: down(vp.x), y: down(vp.y), width: down(vp.width), height: down(vp.height) };
}

/**
 * Retângulos alterados entre dois frames. O frame é dividido em tiles de
 * TILE_W x TILE_H; tiles alterados vizinhos na mesma linha juntam-se num troço
 * e troços iguais em linhas seguidas num retângulo, que depois é cortado ao
 * mínimo que contém as diferenças. Assim, um widget que muda no meio do ecrã
 * não arrasta a largura toda. Sem frame anterior devolve o ecrã inteiro.
 * O array traz changedPx, o número de pixels diferentes.
 */
function dirtyRects(prev, cur, width, height, { align = 1, offX = 0, offY = 0, maxPixels = LZ4_MAX_PIXELS } = {}) {
  let rects;
  if (!prev || prev.length !== cur.length) {
    rects = splitRect(alignRect([0, 0, width, height], align, offX, offY, width, height), align, maxPixels);
    rects.changedPx = width * height;
    return rects;
  }

  const cols = Math.ceil(width / TILE_W), rows = Math.ceil(height / TILE_H);
  const n = cols * rows;
  // Por tile: caixa (inclusiva) das diferenças; minX = -1 se limpo.
  const minX = new Int32Array(n).fill(-1), maxX = new Int32Array(n);
  const minY = new Int32Array(n), maxY = new Int32Array(n);
  let changedPx = 0;

  for (let ty = 0; ty < rows; ty++) {
    const y1 = Math.min(height, (ty + 1) * TILE_H);
    for (let tx = 0; tx < cols; tx++) {
      const x0 = tx * TILE_W, x1 = Math.min(width, x0 + TILE_W), t = ty * cols + tx;
      let bx0 = x1, bx1 = -1, by0 = -1, by1 = -1;
      for (let y = ty * TILE_H; y < y1; y++) {
        const base = y * width;
        let hit = false;
        for (let x = x0; x < x1; x++) {
          if (prev[base + x] !== cur[base + x]) {
            changedPx++;
            hit = true;
            if (x < bx0) bx0 = x;
            if (x > bx1) bx1 = x;
          }
        }
        if (hit) {
          if (by0 < 0) by0 = y;
          by1 = y;
        }
      }
      if (by0 >= 0) {
        minX[t] = bx0; maxX[t] = bx1; minY[t] = by0; maxY[t] = by1;
      }
    }
  }

  const all = [], open = new Map();
  for (let ty = 0; ty < rows; ty++) {
    let tx = 0;
    while (tx < cols) {
      if (minX[ty * cols + tx] < 0) { tx++; continue; }
      let last = tx;
      for (let k = tx + 1; k < cols && k - last - 1 <= MERGE_GAP; k++) {
        if (minX[ty * cols + k] >= 0) last = k;
      }
      let bx0 = Infinity, bx1 = -1, by0 = Infinity, by1 = -1;
      for (let k = tx; k <= last; k++) {
        const t = ty * cols + k;
        if (minX[t] < 0) continue;
        bx0 = Math.min(bx0, minX[t]); bx1 = Math.max(bx1, maxX[t]);
        by0 = Math.min(by0, minY[t]); by1 = Math.max(by1, maxY[t]);
      }
      const key = tx * 1000 + last;
      const r = open.get(key);
      if (r && r.ty === ty - 1) {
        r.ty = ty;
        r.x0 = Math.min(r.x0, bx0); r.x1 = Math.max(r.x1, bx1); r.y1 = by1;
      } else {
        const nr = { ty, x0: bx0, x1: bx1, y0: by0, y1: by1 };
        open.set(key, nr);
        all.push(nr);
      }
      tx = last + 1;
    }
  }

  rects = [];
  for (const r of all) {
    rects.push(...splitRect(alignRect([r.x0, r.y0, r.x1 - r.x0 + 1, r.y1 - r.y0 + 1], align, offX, offY, width, height), align, maxPixels));
  }
  rects.changedPx = changedPx;
  return rects;
}

/**
 * Pacote para um retângulo: o formato mais pequeno entre raw, RLE e LZ4
 * (este só com lz4 = true, quando o firmware o suporta).
 */
function rectPacket(frame, stride, x, y, w, h, offX = 0, offY = 0, lz4 = false) {
  const px = rectPixels(frame, stride, x, y, w, h);
  const wire = toWire(px);
  let type = PKT.RECT_RAW, data = wire;
  const rle = rleEncode(px);
  if (rle.length < data.length) { type = PKT.RECT_RLE; data = rle; }
  if (lz4 && px.length <= LZ4_MAX_PIXELS) {
    const z = lz4Compress(wire);
    if (z.length < data.length) { type = PKT.RECT_LZ4; data = z; }
  }
  return packet(type, x + offX, y + offY, w, h, data);
}

/** Retângulo (x, y, w, h pares) enviado a metade da resolução, em LZ4: o ESP32 duplica cada pixel. */
function halfRectPacket(frame, stride, x, y, w, h, offX = 0, offY = 0) {
  const hw = w >> 1, hh = h >> 1;
  const px = new Uint16Array(hw * hh);
  for (let j = 0; j < hh; j++) {
    const row = (y + 2 * j) * stride + x;
    for (let i = 0; i < hw; i++) px[j * hw + i] = frame[row + 2 * i];
  }
  return packet(PKT.RECT_LZ4, x + offX, y + offY, w, h, lz4Compress(toWire(px)), RECT_FLAG_2X);
}

/**
 * Pacotes para passar de prev a cur. O frame tem o tamanho da área visível;
 * offX/offY deslocam-no para a posição dessa área no controlador do LCD.
 * O array traz stats: { rects, changedPx, sentPx }.
 */
function encodeFrame(prev, cur, width, height, offX = 0, offY = 0, { lz4 = false, align = 1, half = false } = {}) {
  // half: `cur` só tem blocos 2x2 de cor única nas zonas alteradas; seguem a metade da resolução.
  if (half) align = Math.max(align, 2);
  const rects = dirtyRects(prev, cur, width, height, { align, offX, offY, maxPixels: half ? LZ4_MAX_PIXELS * 4 : LZ4_MAX_PIXELS });
  const packets = rects.map(([x, y, w, h]) => (half ? halfRectPacket(cur, width, x, y, w, h, offX, offY) : rectPacket(cur, width, x, y, w, h, offX, offY, lz4)));
  packets.stats = { rects: rects.length, changedPx: rects.changedPx, sentPx: rects.reduce((n, r) => n + r[2] * r[3], 0) };
  return packets;
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

/** PKT_WIFI_SET: SSID e palavra-passe (ssid vazio desliga o Wi-Fi da placa). */
function wifiSetPacket(ssid, password = '') {
  const s = Buffer.from(ssid, 'utf8'), w = Buffer.from(password, 'utf8');
  if (s.length > 32 || w.length > 63) throw new Error('SSID até 32 e palavra-passe até 63 bytes');
  return packet(PKT.WIFI_SET, 0, 0, 0, 0, Buffer.concat([Buffer.from([s.length]), s, Buffer.from([w.length]), w]));
}

function parseHello(p) {
  return {
    version: p[0],
    width: p.readUInt16LE(1),     // controlador do LCD
    height: p.readUInt16LE(3),
    dma: !!(p[5] & 1),
    lz4: !!(p[5] & 2),   // aceita PKT_RECT_LZ4
    buffered: !!(p[5] & 4),   // framebuffer: mostra cada frame de uma vez (SYNC_HOLD)
    upscale: !!(p[5] & 8),    // aceita RECT_FLAG_2X
    // v3: área visível guardada no ESP32
    viewport: p.length >= 14
      ? { x: p.readUInt16LE(6), y: p.readUInt16LE(8), width: p.readUInt16LE(10), height: p.readUInt16LE(12) }
      : null,
    // Porque reiniciou o ESP32 da última vez (firmwares antigos não mandam).
    reset: p.length >= 16 ? { reason: p[14], cause: p[15] } : null,
    // Idioma do ecrã de espera guardado no ESP32 (LANG_*), ou null em firmwares antigos.
    lang: p.length >= 17 ? p[16] : null,
    // Como o ESP32 está ligado ao PC (TRANSPORT_*); firmwares antigos usam o USB nativo.
    transport: p.length >= 18 ? ({ 1: 'uart', 2: 'wifi' }[p[17]] || 'usb') : 'usb',
    // 2 = o LCD só aceita retângulos com x, y, largura e altura pares (AMOLED).
    align: p.length >= 19 && p[18] >= 2 ? p[18] : 1,
    // Rotação do LCD (0..3, x90°); rotatable = aceita PKT_ROTATION (firmwares antigos: não).
    rotatable: !!(p[5] & 16),
    rotation: p.length >= 20 ? p[19] & 3 : 0,
    // Wi-Fi (só firmwares com HELLO_FLAG_WIFI): state 0 desligado, 1 a ligar, 2 ligado, 3 falhou.
    wifiCapable: !!(p[5] & 32),
    wifi: p.length >= 26 ? { state: p[20], rssi: p.readInt8(21), ip: p[20] === 2 ? `${p[22]}.${p[23]}.${p[24]}.${p[25]}` : null } : null,
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
  PKT, RSP, SYNC_HOLD, RECT_FLAG_2X, packet, syncPacket, bgraToRgb565, rectPixels, toWire, rleEncode, rleDecode,
  dirtyRects, splitRect, alignRect, alignViewport, rectPacket, lz4Compress, lz4Decompress, LZ4_MAX_PIXELS, encodeFrame, fillPacket, ReplyParser, parseHello, wifiSetPacket, parseAck, parseError, describeReset, LCD_LANGS,
};
