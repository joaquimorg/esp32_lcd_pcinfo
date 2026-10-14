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
    this.busy = false;
  }

  canSend() {
    return !this.busy;
  }

  sendFrame(packets) {
    if (this.busy) return false;
    this.busy = true;
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
    const bytes = type === P.PKT.RECT_RLE ? P.rleDecode(payload) : payload;
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
