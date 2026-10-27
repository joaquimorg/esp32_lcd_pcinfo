'use strict';

// Verifica na placa real que o que o LCD mostra é exatamente o último frame enviado (com deflate,
// diferença XOR, etc.). Precisa de firmware compilado com -D LCD_CHECK: o pacote 0x7F faz o ESP32
// ler o LCD de volta (readRect) e devolver o CRC32 do que leu, que se compara com o do frame.
// Uso: node scripts/check-lcd.js <ip|COMx> <frames.u16>

const fs = require('fs');
const { Device } = require('../src/main/device');
const { FrameSender } = require('../src/main/frame-sender');
const P = require('../src/main/protocol');

const host = process.argv[2];
const file = process.argv[3];
const W = 240, H = 320;
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) { c ^= b; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return (~c) >>> 0;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const device = new Device();
  const sender = new FrameSender(device);
  const connected = new Promise((r) => device.once('connected', r));
  if (/^COM/i.test(host)) device.start({ portSetting: host });   // cabo série
  else device.start({ link: { mode: 'wifi', host } });
  const info = await Promise.race([connected, sleep(8000).then(() => null)]);
  if (!info) throw new Error('não ligou');
  if (process.env.NOZ) info.deflate = false;
  if (process.env.NOXOR) info.shadowRows = 0;
  console.log(`shadowRows ${info.shadowRows}`);
  sender.setGeometry({ x: 0, y: 0, width: W, height: H }, { width: W, height: H });
  sender.setQuality('quality');
  await sleep(500);

  const raw = fs.readFileSync(file);
  const n = raw.length / (W * H * 2);
  const frames = Array.from({ length: n }, (_, k) => new Uint16Array(raw.buffer.slice(raw.byteOffset + k * W * H * 2, raw.byteOffset + (k + 1) * W * H * 2)));

  let xorPackets = 0, plainPackets = 0;
  const origWrite = device.port.write.bind(device.port);
  device.port.write = (buf, cb) => {
    // conta os retângulos por diferença que seguem para a placa
    let o = 0;
    while (o + 16 <= buf.length && buf[o] === 0xA5 && buf[o + 1] === 0x5A) {
      const len = buf.readUInt32LE(o + 12);
      if (buf[o + 2] === P.PKT.RECT_LZ4) (buf[o + 3] & P.RECT_FLAG_XOR ? xorPackets++ : plainPackets++);
      o += 16 + len;
    }
    return origWrite(buf, cb);
  };

  const t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < 8000) {
    sender.submit(frames[i++ % n]);
    await sleep(30);
  }
  await sleep(3000);   // tudo desenhado
  console.log(`retângulos LZ4 enviados: ${xorPackets} por diferença, ${plainPackets} completos (${i} frames)`);

  const result = new Promise((resolve) => {
    device.on('ack', (a) => { if (a.payloadBytes > 0 && a.payloadBytes <= H && a.packets > 10000 && a.payloadBytes === H) resolve(a); });
  });
  device.port.write(P.packet(0x7F));
  const a = await Promise.race([result, sleep(20000).then(() => null)]);
  if (!a) throw new Error('sem resposta do diagnóstico (firmware sem LCD_CHECK?)');
  const last = frames[(i - 1) % n];
  const expected = crc32(P.toWire(last.subarray(0, W * a.payloadBytes)));
  console.log(`CRC do LCD ${a.errors.toString(16)} / CRC do frame esperado ${expected.toString(16)} -> ${a.errors === expected ? 'IGUAL' : 'DIFERENTE'}`);
  console.log(`LCD lido de volta: ${a.seq} pixels diferentes em ${a.packets} (${a.payloadBytes} linhas)`);
  await device.stop();
  return a.seq === 0 && a.errors === expected ? 0 : 2;
}

main().then((code) => process.exit(code), (e) => { console.log('falhou:', e.message); process.exit(1); });
