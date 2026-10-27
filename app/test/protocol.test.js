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
    else if (type === P.PKT.RECT_LZ4) bytes = P.lz4Decompress(payload, w * h * 2);
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

test('HELLO diz como o ESP32 está ligado (USB nativo ou UART)', () => {
  const p = Buffer.alloc(18);
  p[0] = 3; p.writeUInt16LE(240, 1); p.writeUInt16LE(320, 3);
  assert.strictEqual(P.parseHello(p).transport, 'usb');
  p[17] = 1;
  assert.strictEqual(P.parseHello(p).transport, 'uart');
  assert.strictEqual(P.parseHello(p.subarray(0, 17)).transport, 'usb', 'firmware sem o byte de transporte');
});

test('LZ4: codifica e descodifica sem perdas', () => {
  const rnd = (n, seed) => Buffer.from(Array.from({ length: n }, (_, i) => ((i + seed) * 2654435761) >>> 24));
  const cases = [Buffer.alloc(0), Buffer.from([1]), rnd(11, 1), rnd(12, 2), rnd(13, 3), rnd(300, 4),
    Buffer.alloc(5000, 7), Buffer.from('abcabcabcabcabcabcabcabcabcabc'.repeat(50)), P.toWire(makeFrame(5)).subarray(0, 16384)];
  for (const src of cases) {
    const z = P.lz4Compress(src);
    assert.deepStrictEqual(P.lz4Decompress(z, src.length), src, `tamanho ${src.length}`);
  }
  assert.ok(P.lz4Compress(Buffer.alloc(5000, 7)).length < 100, 'dados repetidos comprimem');
});

test('LZ4: bloco corrompido ou maior que o buffer é rejeitado', () => {
  const src = Buffer.alloc(1000, 9);
  const z = P.lz4Compress(src);
  assert.strictEqual(P.lz4Decompress(z, 999), null, 'não cabe no buffer');
  assert.strictEqual(P.lz4Decompress(Buffer.from([0x0F, 0x05, 0x00]), 100), null, 'offset antes do início');
  assert.strictEqual(P.lz4Decompress(Buffer.from([0xF0]), 100), null, 'literais em falta');
});

test('dirtyRects: um widget no meio do ecrã não arrasta a largura toda', () => {
  const prev = new Uint16Array(W * H), cur = prev.slice();
  for (let y = 100; y < 130; y++) for (let x = 80; x < 140; x++) cur[y * W + x] = 1;
  const rects = P.dirtyRects(prev, cur, W, H);
  assert.deepStrictEqual([...rects], [[80, 100, 60, 30]]);
  assert.strictEqual(rects.changedPx, 60 * 30);
});

test('dirtyRects: zonas separadas dão retângulos separados', () => {
  const prev = new Uint16Array(W * H), cur = prev.slice();
  cur[5 * W + 5] = 1;
  cur[300 * W + 200] = 1;
  assert.deepStrictEqual([...P.dirtyRects(prev, cur, W, H)], [[5, 5, 1, 1], [200, 300, 1, 1]]);
});

test('dirtyRects: o ecrã inteiro é cortado em retângulos que cabem no buffer do LZ4', () => {
  for (const r of P.dirtyRects(null, new Uint16Array(W * H), W, H)) assert.ok(r[2] * r[3] <= P.LZ4_MAX_PIXELS);
});

test('frames com LZ4: aplicar os pacotes reproduz o frame e comprime mais que o RLE', () => {
  const screen = new Uint16Array(W * H);
  let prev = null, withLz4 = 0, without = 0;
  for (let s = 0; s < 20; s++) {
    const cur = makeFrame(s);
    const packets = P.encodeFrame(prev, cur, W, H, 0, 0, { lz4: true });
    apply(screen, Buffer.concat(packets));
    assert.deepStrictEqual(screen, cur, `frame ${s}`);
    withLz4 += packets.reduce((n, p) => n + p.length, 0);
    without += P.encodeFrame(prev, cur, W, H).reduce((n, p) => n + p.length, 0);
    prev = cur;
  }
  assert.ok(withLz4 <= without, `${withLz4} <= ${without}`);
});

test('HELLO: bit 1 das flags indica suporte de LZ4', () => {
  const p = Buffer.alloc(14);
  p[5] = 2;
  assert.strictEqual(P.parseHello(p).lz4, true);
  p[5] = 1;
  assert.strictEqual(P.parseHello(p).lz4, false);
});

test('align 2 (AMOLED): todos os retângulos têm x, y, largura e altura pares e o frame chega inteiro', () => {
  const CW = 410, CH = 502, VX = 4, VY = 20, VW = 400, VH = 480;   // área visível com desvio par
  const ctrl = new Uint16Array(CW * CH);
  let prev = null;
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let step = 0; step < 12; step++) {
    const cur = prev ? prev.slice() : new Uint16Array(VW * VH);
    // Alterações pequenas em sítios ímpares: 1 pixel, linhas finas e um bloco.
    for (let k = 0; k < 5; k++) cur[rnd(VH) * VW + rnd(VW)] = 1 + rnd(60000);
    const bx = 1 + rnd(300) * 1, by = 3 + rnd(400);
    for (let y = by; y < by + 7; y++) for (let x = bx; x < bx + 13; x++) cur[y * VW + x] = 0x1234 + step;
    const packets = P.encodeFrame(prev, cur, VW, VH, VX, VY, { lz4: true, align: 2 });
    for (const p of packets) {
      const x = p.readUInt16LE(4), y = p.readUInt16LE(6), w = p.readUInt16LE(8), h = p.readUInt16LE(10);
      assert.deepStrictEqual([x % 2, y % 2, w % 2, h % 2], [0, 0, 0, 0], `rect ${x},${y} ${w}x${h}`);
      assert.ok(x >= VX && y >= VY && x + w <= VX + VW && y + h <= VY + VH, 'dentro da área visível');
      const payload = p.subarray(16);
      const bytes = p[2] === P.PKT.RECT_LZ4 ? P.lz4Decompress(payload, w * h * 2) : p[2] === P.PKT.RECT_RLE ? P.rleDecode(payload) : payload;
      for (let k = 0; k < w * h; k++) ctrl[(y + Math.floor(k / w)) * CW + x + (k % w)] = (bytes[2 * k] << 8) | bytes[2 * k + 1];
    }
    for (let y = 0; y < VH; y++) {
      for (let x = 0; x < VW; x++) {
        if (ctrl[(y + VY) * CW + x + VX] !== cur[y * VW + x]) assert.fail(`passo ${step}: pixel (${x},${y}) difere`);
      }
    }
    prev = cur;
  }
});

test('align: as faixas do ecrã inteiro têm linhas pares e cabem no buffer do LZ4', () => {
  for (const r of P.dirtyRects(null, new Uint16Array(410 * 502), 410, 502, { align: 2 })) {
    assert.ok(r[3] % 2 === 0 && r[2] * r[3] <= P.LZ4_MAX_PIXELS, `${r}`);
  }
});

test('alignViewport arredonda para baixo só quando o LCD pede', () => {
  const vp = { x: 3, y: 21, width: 401, height: 479 };
  assert.deepStrictEqual(P.alignViewport(vp, 1), vp);
  assert.deepStrictEqual(P.alignViewport(vp, 2), { x: 2, y: 20, width: 400, height: 478 });
});

test('HELLO: byte de alinhamento (firmwares antigos = 1)', () => {
  const p = Buffer.alloc(19);
  p[17] = 0; p[18] = 2;
  assert.strictEqual(P.parseHello(p).align, 2);
  assert.strictEqual(P.parseHello(p.subarray(0, 18)).align, 1);
});

test('HELLO diz se o LCD roda e em que posição está', () => {
  const p = Buffer.alloc(20);
  p[0] = 3; p.writeUInt16LE(320, 1); p.writeUInt16LE(240, 3);
  assert.strictEqual(P.parseHello(p).rotatable, false);
  p[5] = 0x10; p[19] = 1;
  assert.strictEqual(P.parseHello(p).rotatable, true);
  assert.strictEqual(P.parseHello(p).rotation, 1);
  assert.strictEqual(P.parseHello(p.subarray(0, 19)).rotation, 0, 'firmware sem o byte de rotação');
});

test('HELLO traz o estado do Wi-Fi e o transporte wifi', () => {
  const p = Buffer.alloc(26);
  p[0] = 3; p.writeUInt16LE(240, 1); p.writeUInt16LE(320, 3);
  p[5] = 0x20; p[17] = 2; p[20] = 2; p.writeInt8(-55, 21); p[22] = 192; p[23] = 168; p[24] = 1; p[25] = 173;
  const h = P.parseHello(p);
  assert.strictEqual(h.wifiCapable, true);
  assert.strictEqual(h.transport, 'wifi');
  assert.deepStrictEqual(h.wifi, { state: 2, rssi: -55, ip: '192.168.1.173' });
  assert.strictEqual(P.parseHello(p.subarray(0, 20)).wifi, null, 'firmware sem Wi-Fi');
});

test('PKT_WIFI_SET leva SSID e palavra-passe com os tamanhos à frente', () => {
  const pk = P.wifiSetPacket('casa', 'segredo');
  assert.strictEqual(pk[2], P.PKT.WIFI_SET);
  assert.deepStrictEqual([...pk.subarray(16)], [4, ...Buffer.from('casa'), 7, ...Buffer.from('segredo')]);
  assert.throws(() => P.wifiSetPacket('x'.repeat(33)));
});
