'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const P = require('../src/main/protocol');
const { FrameSender, batchPackets, BATCH_BYTES } = require('../src/main/frame-sender');

const W = 240, H = 320;

/** ESP32 simulado: um envio de cada vez, aplica os pacotes a um ecrã RGB565. */
class FakeDevice extends EventEmitter {
  constructor() {
    super();
    this.screen = new Uint16Array(W * H);
    this.sends = [];
    this.holds = [];
    this.busy = false;
  }

  canSend() {
    return !this.busy;
  }

  sendFrame(packets, { hold = false } = {}) {
    if (this.busy) return false;
    this.busy = true;
    this.holds.push(hold);
    this.sends.push(packets.reduce((n, p) => n + p.length, 0));
    for (const p of packets) this.apply(p);
    return true;
  }

  ack() {
    this.busy = false;
    this.emit('ack', { seq: 0 });
  }

  apply(p) {
    const type = p[2];
    const x = p.readUInt16LE(4), y = p.readUInt16LE(6), w = p.readUInt16LE(8), h = p.readUInt16LE(10);
    const payload = p.subarray(16);
    if (type === P.PKT.FILL) {
      for (let r = y; r < y + h; r++) this.screen.fill((payload[0] << 8) | payload[1], r * W + x, r * W + x + w);
      return;
    }
    if (type === P.PKT.RECT_LZ4 && (p[3] & P.RECT_FLAG_2X)) {
      // Metade da resolução: cada pixel vira um bloco 2x2 (como no firmware).
      assert.ok(x % 2 === 0 && y % 2 === 0 && w % 2 === 0 && h % 2 === 0, 'rect 2x par');
      const half = P.lz4Decompress(payload, (w / 2) * (h / 2) * 2);
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const k = ((j >> 1) * (w / 2) + (i >> 1)) * 2;
          this.screen[(y + j) * W + x + i] = (half[k] << 8) | half[k + 1];
        }
      }
      return;
    }
    const bytes = type === P.PKT.RECT_RLE ? P.rleDecode(payload)
      : type === P.PKT.RECT_LZ4 ? P.lz4Decompress(payload, w * h * 2) : payload;
    for (let k = 0; k < w * h; k++) {
      this.screen[(y + Math.floor(k / w)) * W + x + (k % w)] = (bytes[2 * k] << 8) | bytes[2 * k + 1];
    }
  }
}

function noise(seed) {
  const f = new Uint16Array(W * H);
  let s = seed;
  for (let i = 0; i < f.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    f[i] = s & 0xffff;
  }
  return f;
}

test('batchPackets respeita o limite e mantém a ordem', () => {
  const packets = [5000, 7000, 6000, 3000, 20000, 100].map((n, i) => Buffer.alloc(n, i));
  const batches = batchPackets(packets, 16 * 1024);
  assert.deepStrictEqual(batches.map((b) => b.map((p) => p.length)), [[5000, 7000], [6000, 3000], [20000], [100]]);
  assert.deepStrictEqual(batches.flat(), packets);
});

test('um frame completo vai em lotes pequenos, um por ACK, e chega inteiro', () => {
  const dev = new FakeDevice();
  const sender = new FrameSender(dev);
  sender.setGeometry({ x: 0, y: 0, width: W, height: H }, { width: W, height: H });

  const frame = noise(1);   // não comprime: ~150 KB
  sender.submit(frame);
  assert.strictEqual(dev.sends.length, 1, 'só o primeiro lote antes do ACK');

  // Um frame novo a meio não interrompe o atual: fica à espera.
  const next = noise(2);
  sender.submit(next);
  while (dev.busy) dev.ack();

  assert.ok(dev.sends.length > 10, `${dev.sends.length} lotes`);
  for (const n of dev.sends) assert.ok(n <= BATCH_BYTES, `lote de ${n} bytes`);
  assert.deepStrictEqual(dev.screen, next);
});

test('com LZ4 no HELLO o frame vai comprimido, com contadores de diagnóstico', () => {
  const dev = new FakeDevice();
  dev.info = { lz4: true };
  const sender = new FrameSender(dev);
  sender.setGeometry({ x: 0, y: 0, width: W, height: H }, { width: W, height: H });

  const frame = new Uint16Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) frame[y * W + x] = ((x >> 3) * 31 + (y >> 4) * 7) & 0xFFFF;
  sender.submit(frame);
  while (dev.busy) dev.ack();

  assert.deepStrictEqual(dev.screen, frame);
  const c = sender.takeCounters();
  assert.ok(c.byType.lz4 > 0, 'usou LZ4');
  assert.ok(c.bytes < W * H * 2 / 4, `${c.bytes} bytes`);
  assert.ok(c.rects > 0 && c.sentPx >= c.changedPx);
});

test('SYNC com hold em todos os lotes de um frame menos no último', () => {
  const dev = new FakeDevice();
  const sender = new FrameSender(dev);
  sender.setGeometry({ x: 0, y: 0, width: W, height: H }, { width: W, height: H });
  sender.submit(noise(1));            // não comprime: vários lotes
  while (dev.busy) dev.ack();
  assert.ok(dev.holds.length > 5);
  assert.deepStrictEqual(dev.holds.slice(0, -1).every(Boolean), true);
  assert.strictEqual(dev.holds[dev.holds.length - 1], false, 'o último mostra o frame');
  // Um frame pequeno (um só lote) não leva hold.
  const next = noise(1);
  next[5] ^= 0xFFFF;
  dev.holds.length = 0;
  sender.submit(next);
  while (dev.busy) dev.ack();
  assert.deepStrictEqual(dev.holds, [false]);
  assert.strictEqual(P.syncPacket(7, true)[3], P.SYNC_HOLD);
  assert.strictEqual(P.syncPacket(7)[3], 0);
});

test('o frame seguinte fica codificado enquanto o anterior segue no cabo', () => {
  const dev = new FakeDevice();
  const sender = new FrameSender(dev);
  sender.setGeometry({ x: 0, y: 0, width: W, height: H }, { width: W, height: H });
  const a = noise(1), b = noise(2);
  sender.submit(a);
  // Enquanto o primeiro lote está no cabo (sem ACK), chega outro frame.
  sender.submit(b);
  assert.ok(sender.batches.length > 0);
  while (dev.busy) dev.ack();
  assert.deepStrictEqual(dev.screen, b, 'chega o mais recente, sem perder o estado');
});

test('fluidez: só perde bits nas imagens pesadas e repõe a cor ao acalmar', () => {
  const dev = new FakeDevice();
  const sender = new FrameSender(dev);
  sender.setQuality('smooth');
  let clock = 1000;
  sender.now = () => clock;
  sender.setGeometry({ x: 0, y: 0, width: W, height: H }, { width: W, height: H });
  const base = new Uint16Array(W * H);
  sender.submit(base);
  while (dev.busy) dev.ack();

  // Pequena alteração (< 6 %): sem perdas.
  const small = base.slice();
  for (let i = 0; i < 500; i++) small[i] = 0x1234 | 0x0021;
  sender.submit(small);
  while (dev.busy) dev.ack();
  assert.deepStrictEqual(dev.screen, small);

  // Imagem pesada (ruído): perde bits (0xE71C).
  const heavy = noise(3);
  sender.submit(heavy);
  while (dev.busy) dev.ack();
  for (let i = 0; i < heavy.length; i += 997) assert.strictEqual(dev.screen[i], heavy[i] & 0xE71C);

  // Ainda a mexer (dentro da espera): continua com perdas, sem reposição a meio.
  clock += 300;
  sender.submit(heavy.slice());
  while (dev.busy) dev.ack();
  for (let i = 0; i < heavy.length; i += 997) assert.strictEqual(dev.screen[i], heavy[i] & 0xE71C);

  // Acalmou: o mesmo conteúdo, agora sem perdas (um frame de reposição).
  clock += 2000;
  sender.submit(heavy.slice());
  while (dev.busy) dev.ack();
  assert.deepStrictEqual(dev.screen, heavy);
});

test('fluidez com metade da resolução: só os blocos que mexem, 4x menos dados, e repõe ao acalmar', () => {
  const dev = new FakeDevice();
  dev.info = { lz4: true, upscale: true, align: 2 };
  const sender = new FrameSender(dev);
  sender.setQuality('balanced');
  let clock = 1000;
  sender.now = () => clock;
  sender.setGeometry({ x: 0, y: 0, width: W, height: H }, { width: W, height: H });

  const smooth = (k) => {   // imagem suave que se desloca: comprime bem, mexe em todo o ecrã
    const f = new Uint16Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) f[y * W + x] = (((x + k * 7) >> 3) & 31) << 11 | (((y + k * 5) >> 3) & 63) << 5;
    return f;
  };
  const f0 = smooth(0);
  sender.submit(f0);
  while (dev.busy) dev.ack();
  assert.deepStrictEqual(dev.screen, f0);

  sender.takeCounters();
  const f1 = smooth(1);
  sender.submit(f1);
  while (dev.busy) dev.ack();
  const c = sender.takeCounters();
  // Cada bloco 2x2 do LCD tem uma só cor (a média do original).
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const v = dev.screen[y * W + x];
      assert.ok(dev.screen[y * W + x + 1] === v && dev.screen[(y + 1) * W + x] === v && dev.screen[(y + 1) * W + x + 1] === v, `bloco ${x},${y}`);
    }
  }
  assert.ok(c.bytes < W * H * 2 / 4, `${c.bytes} bytes`);

  // Acalma: a imagem original repõe-se por inteiro.
  clock += 3000;
  sender.submit(f1.slice());
  while (dev.busy) dev.ack();
  assert.deepStrictEqual(dev.screen, f1);
});
