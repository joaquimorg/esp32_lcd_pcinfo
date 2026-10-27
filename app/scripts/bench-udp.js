'use strict';

// Mede o débito real do transporte Wi-Fi (UdpLink) até ao ESP32.
// Uso: node scripts/bench-udp.js <ip> [--tests sink,raw,dirty] [--seconds 5] [--depth 2]

const P = require('../src/main/protocol');
const { UdpLink } = require('../src/main/udp-link');

const args = process.argv.slice(2);
const host = args.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
};
if (!host) {
  console.log('uso: node scripts/bench-udp.js <ip> [--tests sink,raw,dirty] [--seconds 5] [--depth 2]');
  process.exit(1);
}
const tests = opt('tests', 'sink,raw,dirty').split(',');
const seconds = Number(opt('seconds', 5));
const depth = Number(opt('depth', 2));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const link = new UdpLink({ host, maxWindow: Number(opt('window', 1e9)) * 1400 });
  link.on('error', (e) => console.log('erro:', e.message));
  await new Promise((res, rej) => link.open((e) => (e ? rej(e) : res())));

  const parser = new P.ReplyParser();
  const waiters = { hello: null, acks: [] };
  let acked = 0;
  link.on('data', (chunk) => {
    for (const { type, payload } of parser.push(chunk)) {
      if (type === P.RSP.HELLO && waiters.hello) waiters.hello(P.parseHello(payload));
      else if (type === P.RSP.ACK) acked++;
      else if (type === P.RSP.ERROR) console.log('erro do ESP32:', P.parseError(payload));
    }
  });

  link.write(P.packet(P.PKT.HELLO));
  const info = await new Promise((res, rej) => {
    waiters.hello = res;
    setTimeout(() => rej(new Error('sem HELLO')), 3000);
  });
  console.log(`ESP32: ecrã ${info.width}x${info.height}, transporte ${info.transport}, Wi-Fi ${info.wifi && info.wifi.ip} (${info.wifi && info.wifi.rssi} dBm), lz4 ${info.lz4}`);
  const { width: W, height: H } = info;

  // Frames sintéticos: um gradiente que anda (tudo muda) e um quadrado a mover-se (poucas zonas mudam).
  const frame = (i, moving) => {
    const f = new Uint16Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) f[y * W + x] = moving ? 0x0000 : (((x + i * 3) & 31) << 11) | (((y * 2 + i) & 63) << 5) | ((x + y) & 31);
    }
    if (moving) {
      const bx = (i * 4) % (W - 60), by = (i * 3) % (H - 60);
      for (let y = by; y < by + 60; y++) for (let x = bx; x < bx + 60; x++) f[y * W + x] = 0xFFE0;
    }
    return f;
  };

  const run = async (name, makePackets) => {
    const before = { ...link.stats };
    let seq = 0, n = 0, bytes = 0;
    acked = 0;
    const t0 = process.hrtime.bigint();
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      const pk = makePackets(n);
      link.write(Buffer.concat([...pk, P.syncPacket(++seq)]));
      bytes += pk.reduce((a, b) => a + b.length, 0);
      n++;
      while (seq - acked >= depth) await sleep(0);
    }
    while (acked < seq) await sleep(1);
    const sec = Number(process.hrtime.bigint() - t0) / 1e9;
    const s = link.stats;
    console.log(`${name.padEnd(6)} ${(n / sec).toFixed(1).padStart(6)} fps ${(bytes / sec / 1e6).toFixed(2).padStart(6)} MB/s  `
      + `${Math.round(bytes / n / 1024)} KB/frame  retx ${s.retx - before.retx}, timeouts ${s.timeouts - before.timeouts}, `
      + `ESP32 dup/win/ooo ${s.esp.dup}/${s.esp.win}/${s.esp.ooo}, cwnd ${Math.round(link.cwnd / 1400)}, rto ${Math.round(link.rto)} ms, srtt ${link.srtt.toFixed(1)} ms`);
  };

  const sinkPkt = P.packet(P.PKT.SINK, 0, 0, 0, 0, Buffer.alloc(32 * 1024));
  const gradient = Array.from({ length: 24 }, (_, i) => frame(i, false));
  const squares = Array.from({ length: 60 }, (_, i) => frame(i, true));
  let prev = null;
  if (tests.includes('sink')) await run('sink', () => [sinkPkt]);
  if (tests.includes('raw')) {
    await run('raw', (i) => [P.packet(P.PKT.RECT_RAW, 0, 0, W, H, P.toWire(gradient[i % gradient.length]))]);
  }
  if (tests.includes('lz4')) {
    prev = null;
    await run('lz4', (i) => {
      const cur = gradient[i % gradient.length];
      const pk = P.encodeFrame(prev, cur, W, H, 0, 0, { lz4: info.lz4, align: info.align || 1 });
      prev = cur;
      return pk;
    });
  }
  if (tests.includes('dirty')) {
    prev = null;
    await run('dirty', (i) => {
      const cur = squares[i % squares.length];
      const pk = P.encodeFrame(prev, cur, W, H, 0, 0, { lz4: info.lz4, align: info.align || 1 });
      prev = cur;
      return pk;
    });
  }
  await new Promise((r) => link.drain(r));
  link.close();
}

main().then(() => process.exit(0), (e) => { console.log('falhou:', e.message); process.exit(1); });
