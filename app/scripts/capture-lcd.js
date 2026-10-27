'use strict';

// Tira "fotografias" exatas do LCD: o ESP32 lê o painel de volta (readRect) e envia-o linha a linha.
// Precisa de firmware compilado com -D LCD_CHECK (pacote 0x7E) e do cabo série.
// Uso: node scripts/capture-lcd.js COMx <ficheiro.png> [--hello] [--lang pt|en]
//   --hello  manda um HELLO antes (o ecrã de espera passa a "App connected, no data")
//   --lang   muda o idioma do ecrã de espera antes de capturar (fica guardado na placa)
// O ecrã de espera só aparece ao fim de ~3 s sem pacotes: o script espera por isso.

const fs = require('fs');
const zlib = require('zlib');
const { SerialPort } = require('serialport');
const P = require('../src/main/protocol');

const [com, out] = process.argv.slice(2);
const hello = process.argv.includes('--hello');
const li = process.argv.indexOf('--lang');
const lang = li >= 0 ? process.argv[li + 1] : null;
if (!com || !out) {
  console.log('uso: node scripts/capture-lcd.js COMx ficheiro.png [--hello] [--lang pt|en]');
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) {
    c ^= b;
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function png(width, height, rgb) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

async function main() {
  const port = new SerialPort({ path: com, baudRate: 2000000, autoOpen: false });
  await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
  await new Promise((r) => port.set({ dtr: false, rts: false }, () => r()));
  const parser = new P.ReplyParser();
  const rows = new Map();
  port.on('data', (chunk) => {
    for (const { type, payload } of parser.push(chunk)) {
      if (type === 0x8D) rows.set(payload.readUInt16LE(0), payload.subarray(2));
    }
  });
  await sleep(2500);   // arranque da placa
  if (lang) {
    port.write(P.packet(P.PKT.LANG, lang === 'pt' ? 1 : 0));
    await sleep(500);
  }
  if (hello) {
    await sleep(3500);   // ecrã de espera + estado "ninguém a falar"
    port.write(P.packet(P.PKT.HELLO));
    await sleep(1200);
  } else {
    await sleep(5000);
  }
  // Uma linha pode perder-se (a placa responde depressa demais para o cabo): repete até haver todas.
  for (let attempt = 0; attempt < 4 && rows.size < 320; attempt++) {
    port.write(P.packet(0x7E));
    const until = Date.now() + 4000;
    while (rows.size < 320 && Date.now() < until) await sleep(50);
  }
  const height = rows.size;
  const width = height ? rows.get([...rows.keys()][0]).length / 2 : 0;
  if (!height) throw new Error('sem resposta (firmware sem LCD_CHECK?)');
  for (let y = 0; y < height; y++) if (!rows.has(y)) throw new Error(`falta a linha ${y}`);
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const r = rows.get(y);
    for (let x = 0; x < width; x++) {
      const v = r.readUInt16BE(x * 2);
      const o = (y * width + x) * 3;
      rgb[o] = ((v >> 11) & 31) * 255 / 31;
      rgb[o + 1] = ((v >> 5) & 63) * 255 / 63;
      rgb[o + 2] = (v & 31) * 255 / 31;
    }
  }
  fs.writeFileSync(out, png(width, height, rgb));
  console.log(`${out}: ${width}x${height}`);
  await new Promise((r) => port.close(() => r()));
}

main().then(() => process.exit(0), (e) => { console.log('falhou:', e.message); process.exit(1); });
