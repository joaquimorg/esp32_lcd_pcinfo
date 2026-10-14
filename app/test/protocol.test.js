'use strict';

const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/main/protocol');

const W = 240, H = 320;

/** Simula o firmware: aplica pacotes a um ecrã RGB565. */
function apply(screen, data) {
  let i = 0;
  while (i < data.length) {
    assert.strictEqual(data[i], 0xA5);
    assert.strictEqual(data[i + 1], 0x5A);
    const type = data[i + 2];
    const x = data.readUInt16LE(i + 4), y = data.readUInt16LE(i + 6);
    const w = data.readUInt16LE(i + 8), h = data.readUInt16LE(i + 10);
    const len = data.readUInt32LE(i + 12);
    const payload = data.subarray(i + 16, i + 16 + len);
    i += 16 + len;

    let bytes;
    if (type === P.PKT.RECT_RAW) bytes = payload;
    else if (type === P.PKT.RECT_RLE) bytes = P.rleDecode(payload);
    else continue;
    assert.strictEqual(bytes.length, w * h * 2);
    for (let k = 0; k < w * h; k++) {
      screen[(y + Math.floor(k / w)) * W + x + (k % w)] = (bytes[2 * k] << 8) | bytes[2 * k + 1];
    }
  }
}

function makeFrame(seed) {
  const f = new Uint16Array(W * H);
  // Fundo liso, um bloco que se move e algum ruído (força literais no RLE).
  const bx = (seed * 7) % (W - 40), by = (seed * 13) % (H - 40);
  for (let y = by; y < by + 40; y++) for (let x = bx; x < bx + 40; x++) f[y * W + x] = 0xF800;
  for (let k = 0; k < 50; k++) f[(seed * 997 + k * 4099) % f.length] = (seed * 31 + k) & 0xFFFF;
  return f;
}

test('RLE: codifica e descodifica sem perdas', () => {
  for (const px of [new Uint16Array([1]), new Uint16Array(300).fill(7), makeFrame(3)]) {
    const decoded = P.rleDecode(P.rleEncode(px));
    assert.deepStrictEqual(decoded, P.toWire(px));
  }
  const noisy = Uint16Array.from({ length: 1000 }, (_, i) => (i * 2654435761) & 0xFFFF);
  assert.deepStrictEqual(P.rleDecode(P.rleEncode(noisy)), P.toWire(noisy));
});

test('frames: aplicar os dirty rects reproduz o frame', () => {
  const screen = new Uint16Array(W * H);
  let prev = null;
  for (let s = 0; s < 20; s++) {
    const cur = makeFrame(s);
    apply(screen, Buffer.concat(P.encodeFrame(prev, cur, W, H)));
    assert.deepStrictEqual(screen, cur, `frame ${s}`);
    prev = cur;
  }
});

test('frames iguais não geram pacotes', () => {
  const f = makeFrame(1);
  assert.strictEqual(P.encodeFrame(f, f.slice(), W, H).length, 0);
});

test('ReplyParser: respostas partidas e lixo pelo meio', () => {
  const parser = new P.ReplyParser();
  const ack = Buffer.from([0xA5, 0x5A, 0x85, 20, 0, ...Buffer.alloc(20, 1)]);
  const data = Buffer.concat([Buffer.from([1, 2, 0xA5]), ack, ack]);
  const out = [];
  for (let i = 0; i < data.length; i += 7) out.push(...parser.push(data.subarray(i, i + 7)));
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].type, 0x85);
  assert.strictEqual(P.parseAck(out[1].payload).seq, 0x01010101);
});

test('área visível com desvio: os retângulos vão para a posição certa do controlador', () => {
  const CW = 240, CH = 320, VX = 0, VY = 20, VW = 240, VH = 280;
  const ctrl = new Uint16Array(CW * CH).fill(0x1234);   // lixo antigo (ex: ecrã de espera)

  const frame = new Uint16Array(VW * VH);
  for (let i = 0; i < frame.length; i++) frame[i] = (i * 7) & 0xFFFF;
  const data = Buffer.concat([P.fillPacket(0, 0, CW, CH, 0), ...P.encodeFrame(null, frame, VW, VH, VX, VY)]);

  let i = 0;
  while (i < data.length) {
    const type = data[i + 2];
    const x = data.readUInt16LE(i + 4), y = data.readUInt16LE(i + 6);
    const w = data.readUInt16LE(i + 8), h = data.readUInt16LE(i + 10);
    const len = data.readUInt32LE(i + 12);
    const payload = data.subarray(i + 16, i + 16 + len);
    i += 16 + len;
    assert.ok(x + w <= CW && y + h <= CH, 'retângulo dentro do controlador');
    if (type === P.PKT.FILL) {
      for (let yy = y; yy < y + h; yy++) ctrl.fill((payload[0] << 8) | payload[1], yy * CW + x, yy * CW + x + w);
      continue;
    }
    const bytes = type === P.PKT.RECT_RLE ? P.rleDecode(payload) : payload;
    for (let k = 0; k < w * h; k++) ctrl[(y + Math.floor(k / w)) * CW + x + (k % w)] = (bytes[2 * k] << 8) | bytes[2 * k + 1];
  }

  for (let y = 0; y < CH; y++) {
    for (let x = 0; x < CW; x++) {
      const inside = y >= VY && y < VY + VH;
      const want = inside ? frame[(y - VY) * VW + x] : 0;
      if (ctrl[y * CW + x] !== want) assert.fail(`pixel (${x},${y}) = ${ctrl[y * CW + x]}, esperado ${want}`);
    }
  }
});

test('HELLO v3 traz a área visível guardada no ESP32', () => {
  const p = Buffer.alloc(14);
  p[0] = 3; p.writeUInt16LE(240, 1); p.writeUInt16LE(320, 3);
  p.writeUInt16LE(0, 6); p.writeUInt16LE(20, 8); p.writeUInt16LE(240, 10); p.writeUInt16LE(280, 12);
  assert.deepStrictEqual(P.parseHello(p).viewport, { x: 0, y: 20, width: 240, height: 280 });
  assert.strictEqual(P.parseHello(p.subarray(0, 6)).viewport, null, 'firmware v2');
});
