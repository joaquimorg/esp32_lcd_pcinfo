'use strict';

// Teste de ponta a ponta do modo Wi-Fi: Device (UdpLink) + FrameSender reais contra a placa.
// Uso: node scripts/e2e-wifi.js <ip> [--seconds 8]
// Envia animações sintéticas como a app faria (frame completo que muda, e um quadrado a mexer)
// e mostra os frames por segundo e KB/s que o FrameSender conseguiu.

const { Device } = require('../src/main/device');
const { FrameSender } = require('../src/main/frame-sender');

const host = process.argv.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
const ci = process.argv.indexOf('--serial');
const com = ci >= 0 ? process.argv[ci + 1] : null;   // para comparar com o cabo
const si = process.argv.indexOf('--seconds');
const seconds = si >= 0 ? Number(process.argv[si + 1]) : 8;
if (!host && !com) {
  console.log('uso: node scripts/e2e-wifi.js <ip> [--seconds 8]   ou   --serial COMx');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const device = new Device();
  const sender = new FrameSender(device);
  let errors = 0;
  device.on('device-error', (e) => { errors++; console.log('erro do ESP32:', e); });
  device.on('log', (m) => console.log('[device]', m));
  const connected = new Promise((r) => device.once('connected', r));
  if (com) device.start({ portSetting: com });
  else device.start({ link: { mode: 'wifi', host } });
  const info = await Promise.race([connected, sleep(8000).then(() => null)]);
  if (!info) throw new Error('não ligou por Wi-Fi');
  console.log(`ligado: ${info.path}, ${info.width}x${info.height}, transporte ${info.transport}, ${info.wifi && info.wifi.rssi} dBm, maxInFlight ${device.maxInFlight}`);
  const { width: W, height: H } = info;
  sender.setGeometry({ x: 0, y: 0, width: W, height: H }, { width: W, height: H });
  if (info.transport !== 'wifi') sender.setQuality('quality');
  await sleep(500);

  const run = async (name, makeFrame, fps = 30) => {
    sender.takeCounters();
    const t0 = Date.now();
    let i = 0;
    while (Date.now() - t0 < seconds * 1000) {
      sender.submit(makeFrame(i++));
      await sleep(1000 / fps);
    }
    await sleep(500);
    const c = sender.takeCounters();
    const sec = (Date.now() - t0 - 500) / 1000;
    console.log(`${name.padEnd(9)} enviados ${(c.frames / sec).toFixed(1)} fps, ${(c.bytes / 1024 / sec).toFixed(0)} KB/s, `
      + `${c.rects} retângulos, codificar ${c.encodeMs.toFixed(0)} ms, parado ${c.idleMs.toFixed(0)} ms (ligação: ${device.port.stats ? `retx ${device.port.stats.retx}, timeouts ${device.port.stats.timeouts}` : 'cabo'})`);
  };

  const gradient = (i) => {
    const f = new Uint16Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) f[y * W + x] = (((x + i * 3) & 31) << 11) | (((y + i) & 63) << 5) | ((x + y) & 31);
    return f;
  };
  const square = (i) => {
    const f = new Uint16Array(W * H);
    const bx = (i * 4) % (W - 60), by = (i * 3) % (H - 60);
    for (let y = by; y < by + 60; y++) for (let x = bx; x < bx + 60; x++) f[y * W + x] = 0xFFE0;
    return f;
  };

  await run('quadrado', square);
  sender.setQuality('balanced');
  await run('gradiente', gradient);
  sender.setQuality('quality');
  await run('grad-full', gradient, 60);
  await run('quad-60', square, 60);
  console.log(`erros do ESP32: ${errors}`);
  await device.stop();
}

main().then(() => process.exit(0), (e) => { console.log('falhou:', e.message); process.exit(1); });
