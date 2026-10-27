'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { UdpLink, PAYLOAD } = require('../src/main/udp-link');

// Gerador pseudo-aleatório determinístico (os testes de perdas têm de ser repetíveis).
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const sd = (a, b) => (a - b) | 0;

/**
 * O lado do ESP32 (src/wifi_link.h) em JavaScript, ligado ao UdpLink por um "socket" falso
 * com latência, perdas e troca de ordem. Serve de especificação executável do protocolo.
 */
class FakeEsp {
  constructor({ ring = 65536, loss = 0, reorder = 0, latency = 1, seed = 1, consumeRate = Infinity } = {}) {
    this.RING = ring;
    this.loss = loss;
    this.reorder = reorder;
    this.latency = latency;
    this.rand = rng(seed);
    this.consumeRate = consumeRate;   // bytes por consume()
    this.contig = 1000;               // começa num valor qualquer: a sessão anuncia-o
    this.rd = 1000;
    this.ringBuf = Buffer.alloc(ring);
    this.seg = [];
    this.received = [];
    this.txWr = 77;
    this.txAcked = 77;
    this.sid = 0;
    this.active = false;
    this.cWin = 0;
    this.socket = null;
    this.txPending = Buffer.alloc(0); // bytes a enviar a partir de txAcked
    this.lastSent = -1;
    this.since = 0;
    this.txTimer = setInterval(() => this.tickTx(), 5);
    this.txTimer.unref();
  }

  // O "socket" que o UdpLink usa.
  makeSocket() {
    const sock = new EventEmitter();
    sock.bind = (_port, cb) => setImmediate(cb);
    sock.send = (msg, _port, _host, cb) => {
      const buf = Array.isArray(msg) ? Buffer.concat(msg) : Buffer.from(msg);
      this.fromPc(buf);
      if (cb) setImmediate(cb);
    };
    sock.close = () => { this.socket = null; };
    this.socket = sock;
    return sock;
  }

  deliver(fn) {
    if (this.rand() < this.loss) return;
    const extra = this.rand() < this.reorder ? 1 + this.rand() * 4 : 0;
    setTimeout(fn, this.latency + extra);
  }

  toPc(buf) {
    const sock = this.socket;
    if (!sock) return;
    this.deliver(() => { if (this.socket === sock) sock.emit('message', buf, { address: '10.0.0.2', port: 7878 }); });
  }

  fromPc(buf) {
    this.deliver(() => this.onDatagram(buf));
  }

  onDatagram(b) {
    if (b[0] === 0x58) {   // 'X'
      this.sid = b.readUInt16LE(1);
      this.seg = [];
      this.rd = this.contig;   // o que ficou por ler perde-se
      this.txAcked = this.txWr;
      this.txPending = Buffer.alloc(0);
      this.active = true;
      const y = Buffer.alloc(15);
      y[0] = 0x59; y.writeUInt16LE(this.sid, 1); y.writeUInt32LE(this.contig >>> 0, 3);
      y.writeUInt32LE(this.txWr >>> 0, 7); y.writeUInt32LE(this.RING, 11);
      this.toPc(y);
      return;
    }
    if (!this.active || b[0] !== 0x44 || b.readUInt16LE(2) !== this.sid) return;
    const rAck = b.readUInt32LE(8);
    if (sd(rAck, this.txAcked) > 0 && sd(this.txWr, rAck) >= 0) {
      this.txPending = this.txPending.subarray(sd(rAck, this.txAcked));
      this.txAcked = rAck;
    }
    if (b.length > 12) this.onData(b.readUInt32LE(4), b.subarray(12));
    if (b[1] & 1) this.sendAck();
  }

  onData(off, data) {
    let len = data.length;
    if (sd(off + len, this.contig) <= 0) { this.sendAck(); return; }
    if (sd(off, this.contig) < 0) { data = data.subarray(sd(this.contig, off)); len = data.length; off = this.contig; }
    if (sd(off + len, this.rd + this.RING) > 0) { this.cWin++; return; }
    for (let i = 0; i < len; i++) this.ringBuf[((off + i) >>> 0) % this.RING] = data[i];
    if (off === this.contig) {
      let c = (off + len) >>> 0;
      while (this.seg.length && sd(this.seg[0][0], c) <= 0) {
        c = sd(this.seg[0][1], c) > 0 ? this.seg[0][1] : c;
        this.seg.shift();
      }
      this.contig = c >>> 0;
      if (++this.since >= 3) this.sendAck();
    } else {
      let [s, e] = [off, (off + len) >>> 0];
      const out = [];
      for (const g of this.seg) {
        if (sd(g[1], s) < 0 || sd(g[0], e) > 0) out.push(g);
        else { s = sd(g[0], s) < 0 ? g[0] : s; e = sd(g[1], e) > 0 ? g[1] : e; }
      }
      out.push([s, e]);
      out.sort((x, y) => sd(x[0], y[0]));
      this.seg = out.slice(0, 8);
      this.sendAck();
    }
  }

  sendAck() {
    this.since = 0;
    const sacks = this.seg.slice(0, 4);
    const m = Buffer.alloc(13 + sacks.length * 8 + 6);
    m[0] = 0x41; m.writeUInt16LE(this.sid, 2);
    m.writeUInt32LE(this.contig >>> 0, 4); m.writeUInt32LE(this.rd >>> 0, 8); m[12] = sacks.length;
    sacks.forEach(([s, e], i) => { m.writeUInt32LE(s >>> 0, 13 + i * 8); m.writeUInt32LE(e >>> 0, 17 + i * 8); });
    this.toPc(m);
  }

  // O parser do ESP32: lê até `consumeRate` bytes de cada vez.
  consume(max = this.consumeRate) {
    const n = Math.min(max, sd(this.contig, this.rd));
    for (let i = 0; i < n; i++) this.received.push(this.ringBuf[((this.rd + i) >>> 0) % this.RING]);
    this.rd = (this.rd + n) >>> 0;
    if (n) this.sendAck();
    return n;
  }

  // O loop() escreve uma resposta.
  reply(buf) {
    this.txPending = Buffer.concat([this.txPending, buf]);
    this.txWr = (this.txWr + buf.length) >>> 0;
    this.lastSent = -1;
  }

  tickTx() {
    if (!this.active || !this.txPending.length) return;
    const now = Date.now();
    if (this.lastSent !== -1 && now - this.lastSent < 50) return;
    const len = Math.min(this.txPending.length, PAYLOAD);
    const m = Buffer.alloc(8 + len);
    m[0] = 0x52; m.writeUInt16LE(this.sid, 2); m.writeUInt32LE(this.txAcked >>> 0, 4);
    this.txPending.copy(m, 8, 0, len);
    this.lastSent = now;
    this.toPc(m);
  }

  stop() {
    clearInterval(this.txTimer);
  }
}

function connect(esp, opts = {}) {
  const link = new UdpLink({ host: '10.0.0.2', socketFactory: () => esp.makeSocket(), ...opts });
  link.on('error', () => {});
  return new Promise((resolve, reject) => link.open((err) => (err ? reject(err) : resolve(link))));
}

const until = (cond, ms = 20000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const timer = setInterval(() => {
    if (cond()) { clearInterval(timer); resolve(); }
    else if (Date.now() - t0 > ms) { clearInterval(timer); reject(new Error('tempo esgotado')); }
  }, 5);
});

function pattern(n, seed = 7) {
  const r = rng(seed);
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (r() * 256) | 0;
  return b;
}

async function transfer(esp, link, data, chunk = 5000) {
  for (let i = 0; i < data.length; i += chunk) link.write(data.subarray(i, i + chunk));
  const timer = setInterval(() => esp.consume(), 2);
  try {
    await until(() => esp.received.length >= data.length);
  } finally {
    clearInterval(timer);
  }
  assert.ok(Buffer.from(esp.received).equals(data), 'os bytes chegaram trocados ou em falta');
}

test('transferência sem perdas chega inteira e em ordem', async () => {
  const esp = new FakeEsp();
  const link = await connect(esp);
  await transfer(esp, link, pattern(300000));
  assert.strictEqual(esp.cWin, 0);
  link.close();
  esp.stop();
});

test('com 5% de perdas e troca de ordem os bytes chegam certos', async () => {
  const esp = new FakeEsp({ loss: 0.05, reorder: 0.1, seed: 3 });
  const link = await connect(esp);
  await transfer(esp, link, pattern(400000, 11));
  assert.ok(link.stats.retx > 0, 'devia ter havido retransmissões');
  link.close();
  esp.stop();
});

test('com 20% de perdas ainda chega tudo', async () => {
  const esp = new FakeEsp({ loss: 0.2, reorder: 0.2, seed: 5 });
  const link = await connect(esp);
  await transfer(esp, link, pattern(120000, 13));
  link.close();
  esp.stop();
});

test('o controlo de janela respeita o anel do ESP32 (nada é descartado por falta de espaço)', async () => {
  const esp = new FakeEsp({ ring: 8192, consumeRate: 700, latency: 2 });
  const link = await connect(esp);
  await transfer(esp, link, pattern(100000, 17));
  assert.strictEqual(esp.cWin, 0, 'o PC enviou para lá do consumed + anel');
  link.close();
  esp.stop();
});

test('as respostas do ESP32 chegam uma vez, em ordem, mesmo com perdas', async () => {
  const esp = new FakeEsp({ loss: 0.2, seed: 9 });
  const link = await connect(esp);
  const got = [];
  link.on('data', (d) => got.push(d));
  const sent = [];
  for (let i = 0; i < 40; i++) {
    const r = Buffer.from(`resposta-${i}-${'x'.repeat(i)}`);
    sent.push(r);
    esp.reply(r);
    await new Promise((r2) => setTimeout(r2, 3));
  }
  const all = Buffer.concat(sent);
  await until(() => Buffer.concat(got).length >= all.length);
  assert.ok(Buffer.concat(got).equals(all));
  link.close();
  esp.stop();
});

test('os offsets dão a volta aos 4 GB sem se perder nada', async () => {
  const esp = new FakeEsp();
  esp.contig = esp.rd = 0xFFFFFFFF - 20000;
  esp.txWr = esp.txAcked = 0xFFFFFFFF - 50;
  const link = await connect(esp);
  const got = [];
  link.on('data', (d) => got.push(d));
  esp.reply(Buffer.alloc(200, 7));
  await transfer(esp, link, pattern(80000, 19));
  await until(() => Buffer.concat(got).length >= 200);
  link.close();
  esp.stop();
});

test('uma sessão nova descarta o que a anterior deixou por ler', async () => {
  const esp = new FakeEsp();
  let link = await connect(esp);
  link.write(Buffer.alloc(3000, 1));
  await until(() => sd(esp.contig, esp.rd) >= 3000);   // chegou mas o parser não leu
  link.close();
  link = await connect(esp);
  esp.received = [];
  await transfer(esp, link, pattern(5000, 23));
  link.close();
  esp.stop();
});

test('sem resposta do ESP32 o open falha e uma ligação que morre emite close', async () => {
  const dead = new UdpLink({ host: '10.0.0.9', connectTimeoutMs: 300, socketFactory: () => { const e = new FakeEsp(); e.loss = 1; return e.makeSocket(); } });
  dead.on('error', () => {});
  await assert.rejects(new Promise((res, rej) => dead.open((e) => (e ? rej(e) : res()))), /sem resposta/);

  const esp = new FakeEsp();
  const link = await connect(esp, { deadMs: 300 });
  let closed = false;
  link.on('close', () => { closed = true; });
  esp.loss = 1;   // o ESP32 deixa de chegar
  await until(() => closed, 3000);
  esp.stop();
});
