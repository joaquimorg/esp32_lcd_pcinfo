'use strict';

const dgram = require('dgram');
const { EventEmitter } = require('events');

/*
 * Fluxo de bytes fiável sobre UDP até ao ESP32 (formato em src/protocol.h, "Transporte
 * Wi-Fi"; o outro lado é src/wifi_link.h). Imita o subconjunto da SerialPort que o Device
 * usa (write, drain, close, eventos data/close/error, isOpen, path), por isso o resto da
 * app não sabe que não é uma porta série.
 *
 * Porque não TCP: a janela TCP do Arduino (5760 bytes) limita-o a ~0,3 MB/s. Aqui o PC
 * numera os bytes, o ESP32 confirma (contig + blocos SACK) e diz até onde pode receber
 * (consumed + ring); os buracos retransmitem-se logo que o SACK os mostra.
 */

const PORT = 7878;
const PAYLOAD = 1400;            // bytes por datagrama: cabe num MTU de 1500 sem fragmentar
const HEADER = 12;
const CONNECT_TRY_MS = 150;
const CONNECT_TIMEOUT_MS = 3000;
const DEAD_MS = 3000;            // nada recebido do ESP32 durante isto: a ligação caiu
const KEEPALIVE_MS = 400;
const TICK_MS = 10;
// O Wi-Fi tem muito jitter (5-40 ms de RTT numa rede doméstica) e as perdas vêm sobretudo do
// rádio, não de filas cheias: uma janela que encolhe a sério a cada perda deixa o débito
// por um quarto (medido). Por isso o RTO é largo e a janela só recua um pouco.
const MIN_RTO_MS = 100;
const MAX_RTO_MS = 1000;
// O ESP32 não escoa mais que ~0,7-1 MB/s: uma janela maior que o produto débito x RTT (~15-20
// datagramas) só cria fila (RTT de 15 para 100 ms), e com ela recuperar uma perda demora mais.
const MIN_CWND = 8 * PAYLOAD;
const START_CWND = 16 * PAYLOAD;
const MAX_CWND = 28 * PAYLOAD;   // < anel do ESP32 (64 KB)

// Offsets são números sem limite do lado do PC; no fio são u32 (dão a volta aos 4 GB).
// Converte um u32 recebido no offset absoluto mais próximo de `ref`.
const expand = (v32, ref) => ref + ((v32 - (ref >>> 0)) | 0);

class UdpLink extends EventEmitter {
  /**
   * @param opts.host
   * @param opts.port
   * @param opts.socketFactory  () => socket tipo dgram (os testes trocam-no)
   * @param opts.maxWindow      bytes em voo no máximo (por omissão o anel do ESP32)
   */
  constructor({ host, port = PORT, socketFactory = () => dgram.createSocket('udp4'), maxWindow = Infinity, now = () => Date.now(), deadMs = DEAD_MS, connectTimeoutMs = CONNECT_TIMEOUT_MS }) {
    super();
    this.host = host;
    this.port = port;
    this.path = `udp://${host}:${port}`;
    this.makeSocket = socketFactory;
    this.maxWindow = maxWindow;
    this.now = now;
    this.deadMs = deadMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.isOpen = false;
    this.socket = null;
    this.sid = 0;
    this.stats = { sent: 0, retx: 0, timeouts: 0, acks: 0, esp: { dup: 0, win: 0, ooo: 0 } };
    this._reset();
  }

  _reset() {
    this.queue = [];
    this.queued = 0;
    this.inflight = [];
    this.sndUna = 0;
    this.sndNxt = 0;
    this.consumed = 0;
    this.ring = 0;
    this.rxNext = 0;
    this.cwnd = START_CWND;
    this.srtt = 0;
    this.rttvar = 0;
    this.rto = 250;
    this.lastRx = 0;
    this.lastTx = 0;
    this.lossUntil = 0;
    this.drainWaiters = [];
  }

  /** Abre a sessão: repete 'X' até chegar 'Y'. cb(err). */
  open(cb) {
    this._reset();
    this.sid = 1 + Math.floor(Math.random() * 0xFFFE);
    const sock = this.socket = this.makeSocket();
    sock.on('error', (err) => this._fail(err));
    sock.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearInterval(tryTimer);
      clearTimeout(giveUp);
      this._connectDone = null;
      if (err) this._teardown();
      cb(err || null);
    };
    this._connectDone = finish;
    const hello = Buffer.alloc(3);
    hello[0] = 0x58;   // 'X'
    hello.writeUInt16LE(this.sid, 1);
    const tryTimer = setInterval(() => this._send(hello), CONNECT_TRY_MS);
    const giveUp = setTimeout(() => finish(new Error(`sem resposta de ${this.host}`)), this.connectTimeoutMs);
    sock.bind(0, () => this._send(hello));
  }

  _send(buf, cb) {
    try {
      this.socket.send(buf, this.port, this.host, cb);
    } catch (err) {
      this._fail(err);
    }
  }

  _onMessage(msg, rinfo) {
    if (rinfo.address !== this.host || msg.length < 4) return;
    if (msg.readUInt16LE(msg[0] === 0x59 ? 1 : 2) !== this.sid) return;   // 'Y' leva o sid no byte 1, os outros no 2
    this.lastRx = this.now();
    switch (msg[0]) {
      case 0x59: this._onConnected(msg); break;   // 'Y'
      case 0x41: if (this.isOpen) this._onAck(msg); break;   // 'A'
      case 0x52: if (this.isOpen) this._onReply(msg); break;   // 'R'
      default: break;
    }
  }

  _onConnected(msg) {
    if (this.isOpen || msg.length < 15) return;
    this.sndUna = this.sndNxt = this.consumed = msg.readUInt32LE(3);
    this.rxNext = msg.readUInt32LE(7);
    this.ring = msg.readUInt32LE(11);
    this.isOpen = true;
    this.lastRx = this.lastTx = this.now();
    this.timer = setInterval(() => this._tick(), TICK_MS);
    if (this._connectDone) this._connectDone(null);
  }

  /* ---- Envio ---- */

  write(buf, cb) {
    if (!this.isOpen) {
      if (cb) setImmediate(cb, new Error('ligação fechada'));
      return false;
    }
    if (buf.length) {
      this.queue.push(buf);
      this.queued += buf.length;
      this._pump();
    }
    if (cb) setImmediate(cb);
    return true;
  }

  _take(n) {
    const parts = [];
    let left = n;
    while (left) {
      const head = this.queue[0];
      if (head.length <= left) {
        parts.push(head);
        left -= head.length;
        this.queue.shift();
      } else {
        parts.push(head.subarray(0, left));
        this.queue[0] = head.subarray(left);
        left = 0;
      }
    }
    this.queued -= n;
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }

  _pump() {
    while (this.queued) {
      const room = Math.min(this.consumed + this.ring, this.sndUna + Math.min(this.cwnd, this.maxWindow)) - this.sndNxt;
      const n = Math.min(PAYLOAD, this.queued);
      if (room < n) break;   // sem espaço para um datagrama inteiro: espera por um ACK
      const rec = { off: this.sndNxt, len: n, buf: this._take(n), sentAt: 0, tx: 0, sacked: false };
      this.inflight.push(rec);
      this.sndNxt += n;
      this._sendRec(rec, this.queued === 0 || room - n < PAYLOAD);   // POLL no fim da rajada
    }
  }

  _sendRec(rec, poll) {
    const hdr = Buffer.allocUnsafe(HEADER);
    hdr[0] = 0x44;   // 'D'
    hdr[1] = poll ? 1 : 0;
    hdr.writeUInt16LE(this.sid, 2);
    hdr.writeUInt32LE(rec.off >>> 0, 4);
    hdr.writeUInt32LE(this.rxNext >>> 0, 8);
    rec.sentAt = this.lastTx = this.now();
    rec.tx++;
    this.stats.sent++;
    this._send([hdr, rec.buf]);
  }

  /** Datagrama sem dados: confirma respostas e funciona de keepalive/POLL. */
  _sendEmpty(poll) {
    const hdr = Buffer.allocUnsafe(HEADER);
    hdr[0] = 0x44;
    hdr[1] = poll ? 1 : 0;
    hdr.writeUInt16LE(this.sid, 2);
    hdr.writeUInt32LE(this.sndNxt >>> 0, 4);
    hdr.writeUInt32LE(this.rxNext >>> 0, 8);
    this.lastTx = this.now();
    this._send(hdr);
  }

  _retransmit(rec) {
    this.stats.retx++;
    this._sendRec(rec, true);
  }

  /* ---- Receção ---- */

  _onAck(msg) {
    if (msg.length < 13) return;
    this.stats.acks++;
    const now = this.now();
    const contig = expand(msg.readUInt32LE(4), this.sndUna);
    this.consumed = Math.max(this.consumed, expand(msg.readUInt32LE(8), this.consumed));
    const nSack = Math.min(msg[12], 4);
    let p = 13;
    const blocks = [];
    for (let i = 0; i < nSack && p + 8 <= msg.length; i++, p += 8) {
      blocks.push([expand(msg.readUInt32LE(p), contig), expand(msg.readUInt32LE(p + 4), contig)]);
    }
    if (p + 6 <= msg.length) {
      this.stats.esp = { dup: msg.readUInt16LE(p), win: msg.readUInt16LE(p + 2), ooo: msg.readUInt16LE(p + 4) };
    }

    let progressed = false;
    if (contig > this.sndUna) {
      progressed = true;
      this.sndUna = contig;
      while (this.inflight.length && this.inflight[0].off + this.inflight[0].len <= contig) {
        const r = this.inflight.shift();
        if (r.tx === 1 && !r.sacked) this._rtt(now - r.sentAt);   // Karn: só amostras sem retransmissão
      }
      this.rto = Math.max(MIN_RTO_MS, Math.min(MAX_RTO_MS, this.srtt + 4 * this.rttvar));
    }
    for (const [s, e] of blocks) {
      for (const r of this.inflight) {
        if (!r.sacked && r.off >= s && r.off + r.len <= e) {
          r.sacked = true;
        }
      }
    }

    // Buracos: algo mais recente já chegou e este não.
    let sackedAfter = 0;
    for (let i = this.inflight.length - 1; i >= 0; i--) {
      const r = this.inflight[i];
      if (r.sacked) {
        sackedAfter++;
        continue;
      }
      if (!sackedAfter) continue;
      const age = now - r.sentAt;
      const wait = r.tx > 1 ? Math.max(2 * this.srtt, MIN_RTO_MS / 2) : (sackedAfter >= 2 ? 0.5 * this.srtt : 1.25 * this.srtt);
      if (age >= wait) {
        this._retransmit(r);
        if (now >= this.lossUntil) {
          this.cwnd = Math.max(MIN_CWND, Math.floor(this.cwnd * 0.9));
          this.lossUntil = now + this.srtt + 5;
        }
      }
    }

    if (progressed && now >= this.lossUntil) this.cwnd = Math.min(MAX_CWND, this.ring || Infinity, this.cwnd + PAYLOAD);
    this._pump();
    this._checkDrain();
  }

  _rtt(sample) {
    if (!this.srtt) {
      this.srtt = sample;
      this.rttvar = sample / 2;
    } else {
      this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - sample);
      this.srtt = 0.875 * this.srtt + 0.125 * sample;
    }
  }

  _onReply(msg) {
    if (msg.length < 8) return;
    const off = expand(msg.readUInt32LE(4), this.rxNext);
    const len = msg.length - 8;
    if (off <= this.rxNext && off + len > this.rxNext) {
      const data = Buffer.from(msg.subarray(8 + (this.rxNext - off)));
      this.rxNext += data.length;
      this.emit('data', data);
    }
    this._sendEmpty(false);   // confirma (também as repetidas: o ACK anterior perdeu-se)
  }

  /* ---- Temporizadores ---- */

  _tick() {
    const now = this.now();
    if (now - this.lastRx > this.deadMs) return this._fail(new Error(`${this.host} deixou de responder`));

    const oldest = this.inflight.find((r) => !r.sacked);
    // Sonda de fim de rajada: se o mais antigo não foi confirmado ao fim de ~1,5 RTT, retransmite-o
    // já (sem encolher a janela). Se a causa era só o último datagrama perdido, poupa-se um RTO.
    if (oldest && oldest.tx === 1 && this.srtt && now - oldest.sentAt >= Math.max(45, 1.5 * this.srtt) && now - oldest.sentAt < this.rto) {
      this._retransmit(oldest);
    } else if (oldest && now - oldest.sentAt >= this.rto) {
      this.stats.timeouts++;
      this.cwnd = Math.max(MIN_CWND, Math.floor(this.cwnd * 0.75));
      this.rto = Math.min(MAX_RTO_MS, this.rto * 2);
      this.lossUntil = now + this.srtt + 5;
      let n = 0;
      for (const r of this.inflight) {
        if (!r.sacked && now - r.sentAt >= this.rto / 2 && n++ < 4) this._retransmit(r);
      }
    } else if (!this.inflight.length && now - this.lastTx >= KEEPALIVE_MS) {
      this._sendEmpty(true);
    }
    this._pump();
  }

  /* ---- Fecho ---- */

  /** cb quando tudo o que foi escrito foi confirmado. */
  drain(cb) {
    this.drainWaiters.push(cb);
    this._checkDrain();
  }

  _checkDrain() {
    if (this.queued || this.inflight.length || !this.drainWaiters.length) return;
    const w = this.drainWaiters;
    this.drainWaiters = [];
    for (const cb of w) cb();
  }

  set(_opts, cb) {
    if (cb) setImmediate(cb);
  }

  _teardown() {
    clearInterval(this.timer);
    this.timer = null;
    this.isOpen = false;
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.removeAllListeners();
      s.on('error', () => {});
      try { s.close(); } catch { /* já fechado */ }
    }
    const w = this.drainWaiters;
    this.drainWaiters = [];
    for (const cb of w) cb();
  }

  _fail(err) {
    if (this._connectDone) return this._connectDone(err);
    if (!this.socket) return;
    this._teardown();
    this.emit('error', err);
    this.emit('close');
  }

  close(cb) {
    const wasOpen = this.isOpen || !!this.socket;
    this._teardown();
    if (wasOpen) this.emit('close');
    if (cb) setImmediate(cb);
  }
}

module.exports = { UdpLink, PORT, PAYLOAD };
