#!/usr/bin/env python3
"""
Benchmark do firmware "USB display" (src/main.cpp).

Mede o débito USB e os fps reais em vários cenários:
  sink   só USB: o ESP32 descarta os dados (limite máximo do canal)
  fill   comandos sem pixels: latência por comando + escrita SPI
  raw    ecrã completo em RGB565, sem compressão
  rle    ecrã completo comprimido com RLE
  dirty  só as zonas que mudaram entre frames (RLE ou raw, o que for menor)

Os frames de teste são um dashboard sintético (gauge, número, barra e
gráfico) desenhado com Pillow, para ter conteúdo parecido com um widget real.

Uso:
  python tools/usb_display_bench.py                      # deteta a porta
  python tools/usb_display_bench.py --port COM7 --tests raw,dirty --seconds 10
  python tools/usb_display_bench.py --demo               # anima até Ctrl+C

Dependências: pyserial, numpy, pillow
"""

import argparse
import collections
import math
import struct
import sys
import time

import numpy as np
import serial
from serial.tools import list_ports
from PIL import Image, ImageDraw, ImageFont

# --- Protocolo (tem de coincidir com src/protocol.h) ------------

MAGIC = b"\xA5\x5A"
PKT_HELLO, PKT_RECT_RAW, PKT_RECT_RLE, PKT_FILL, PKT_SYNC, PKT_SINK = 1, 2, 3, 4, 5, 6
RSP_HELLO, RSP_ACK, RSP_ERROR = 0x81, 0x85, 0x8E
ERROR_NAMES = {1: "BAD_TYPE", 2: "BAD_RECT", 3: "BAD_LEN", 4: "RLE_DECODE", 5: "RX_TIMEOUT"}
ESPRESSIF_VID = 0x303A


def packet(ptype, x=0, y=0, w=0, h=0, payload=b""):
    return MAGIC + struct.pack("<BBHHHHI", ptype, 0, x, y, w, h, len(payload)) + payload


class Device:
    def __init__(self, port):
        self.ser = serial.Serial(port, 115200, timeout=2, write_timeout=10)
        self.ser.reset_input_buffer()
        self.seq = 0
        self.pending = collections.deque()
        self.last_ack = None
        self.errors = collections.Counter()

    def close(self):
        self.ser.close()

    def write(self, data):
        self.ser.write(data)

    def _read_exact(self, n):
        data = self.ser.read(n)
        if len(data) != n:
            raise TimeoutError("o ESP32 não respondeu (o firmware USB display está gravado?)")
        return data

    def _read_reply(self):
        prev = b""
        while True:
            b = self._read_exact(1)
            if prev == MAGIC[:1] and b == MAGIC[1:]:
                break
            prev = b
        rtype, n = struct.unpack("<BH", self._read_exact(3))
        return rtype, self._read_exact(n)

    def _expect(self, want):
        while True:
            rtype, payload = self._read_reply()
            if rtype == RSP_ERROR:
                code, ptype = payload
                self.errors[(ERROR_NAMES.get(code, code), ptype)] += 1
            elif rtype == want:
                return payload

    def hello(self):
        self.write(packet(PKT_HELLO))
        version, w, h, flags = struct.unpack_from("<BHHB", self._expect(RSP_HELLO))
        return {"version": version, "width": w, "height": h, "dma": bool(flags & 1)}

    def sync_packet(self):
        """Pacote SYNC para juntar ao fim de um frame; o ACK confirma que foi desenhado."""
        self.seq += 1
        self.pending.append(self.seq)
        return packet(PKT_SYNC, payload=struct.pack("<I", self.seq))

    def wait_acks(self, max_pending):
        while len(self.pending) > max_pending:
            seq, packets, nbytes, errors, resync = struct.unpack_from("<5I", self._expect(RSP_ACK))
            expected = self.pending.popleft()
            if seq != expected:
                raise RuntimeError(f"ACK fora de ordem: esperava {expected}, recebi {seq}")
            self.last_ack = {"packets": packets, "bytes": nbytes, "errors": errors, "resync": resync}


def find_port():
    ports = [p for p in list_ports.comports() if p.vid == ESPRESSIF_VID]
    if len(ports) == 1:
        return ports[0].device
    if not ports:
        sys.exit("ESP32 não encontrado. Indica a porta com --port COMx")
    sys.exit("Vários dispositivos Espressif: " + ", ".join(p.device for p in ports) + ". Usa --port")


# --- Pixels e compressão ---------------------------------------------------

def to_rgb565(img):
    a = np.asarray(img.convert("RGB"), dtype=np.uint16)
    return ((a[..., 0] >> 3) << 11) | ((a[..., 1] >> 2) << 5) | (a[..., 2] >> 3)


def to_wire(px):
    """RGB565 em big-endian, como o LCD espera."""
    return px.astype(">u2").tobytes()


def rle_encode(px):
    """px: array 1-D uint16. Formato descrito em protocol.h."""
    n = len(px)
    wire = to_wire(px)
    change = np.flatnonzero(px[1:] != px[:-1]) + 1
    starts = np.concatenate(([0], change)).tolist()
    ends = starts[1:] + [n]

    out = bytearray()

    def literal(s, e):
        while s < e:
            k = min(128, e - s)
            out.append(k - 1)
            out.extend(wire[2 * s:2 * (s + k)])
            s += k

    lit_start = None
    for s, e in zip(starts, ends):
        run = e - s
        if run >= 2:
            if lit_start is not None:
                literal(lit_start, s)
                lit_start = None
            pixel = wire[2 * s:2 * s + 2]
            while run:
                k = min(128, run)
                out.append(0x80 | (k - 1))
                out += pixel
                run -= k
        elif lit_start is None:
            lit_start = s
    if lit_start is not None:
        literal(lit_start, n)
    return bytes(out)


def rle_decode(data):
    out = bytearray()
    i = 0
    while i < len(data):
        c = data[i]
        n = (c & 0x7F) + 1
        if c & 0x80:
            out += data[i + 1:i + 3] * n
            i += 3
        else:
            out += data[i + 1:i + 1 + 2 * n]
            i += 1 + 2 * n
    return bytes(out)


def rect_packet(frame, x, y, w, h):
    """Escolhe RLE ou raw, o que for mais pequeno."""
    px = frame[y:y + h, x:x + w].ravel()
    rle = rle_encode(px)
    if len(rle) < len(px) * 2:
        return packet(PKT_RECT_RLE, x, y, w, h, rle)
    return packet(PKT_RECT_RAW, x, y, w, h, to_wire(px))


def dirty_rects(prev, cur, band=16):
    """Um retângulo por faixa horizontal com alterações."""
    diff = prev != cur
    rects = []
    for y0 in range(0, cur.shape[0], band):
        d = diff[y0:y0 + band]
        rows = np.flatnonzero(d.any(axis=1))
        if len(rows) == 0:
            continue
        cols = np.flatnonzero(d.any(axis=0))
        rects.append((int(cols[0]), y0 + int(rows[0]),
                      int(cols[-1] - cols[0] + 1), int(rows[-1] - rows[0] + 1)))
    return rects


# --- Frames sintéticos -----------------------------------------------------

def font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


def render_dashboard(w, h, t, history):
    img = Image.new("RGB", (w, h), (0, 0, 0))
    d = ImageDraw.Draw(img)
    load = 50 + 45 * math.sin(t)
    temp = 55 + 20 * math.sin(t * 0.7 + 1)

    d.text((12, 8), "CPU  Ryzen 5", fill=(230, 230, 230), font=font(20))

    # Gauge
    cx, cy, r = w // 2, 40 + min(w, h) // 3, min(w, h) // 3 - 10
    box = (cx - r, cy - r, cx + r, cy + r)
    d.arc(box, 135, 405, fill=(45, 45, 45), width=14)
    hue = int(255 * load / 100)
    d.arc(box, 135, 135 + 270 * load / 100, fill=(hue, 255 - hue, 60), width=14)
    d.text((cx, cy - 6), f"{temp:.0f}°", fill=(255, 255, 255), font=font(40), anchor="mm")
    d.text((cx, cy + 26), "temp", fill=(140, 140, 140), font=font(16), anchor="mm")

    # Barra
    by = cy + r + 22
    d.text((12, by - 20), f"Load {load:.0f}%", fill=(200, 200, 200), font=font(16))
    d.rounded_rectangle((12, by, w - 12, by + 12), 6, fill=(40, 40, 40))
    d.rounded_rectangle((12, by, 12 + int((w - 24) * load / 100), by + 12), 6, fill=(0, 170, 255))

    # Gráfico histórico
    gy0, gy1 = by + 26, h - 10
    if gy1 - gy0 > 20:
        for gy in range(gy0, gy1 + 1, max(1, (gy1 - gy0) // 4)):
            d.line((12, gy, w - 12, gy), fill=(30, 30, 30))
        history.append(load)
        pts = list(history)[-(w - 24):]
        d.line([(12 + i, gy1 - (gy1 - gy0) * v / 100) for i, v in enumerate(pts)],
               fill=(0, 220, 200), width=2)
    return to_rgb565(img)


def make_frames(w, h, count):
    history = collections.deque(maxlen=w)
    # Aquece o histórico para o gráfico já estar cheio no primeiro frame.
    for i in range(w):
        history.append(50 + 45 * math.sin(2 * math.pi * (i - w) / count))
    return [render_dashboard(w, h, 2 * math.pi * i / count, history) for i in range(count)]


# --- Testes ----------------------------------------------------------------

def run(dev, frames, seconds, depth):
    """Envia frames em ciclo, com até `depth` frames por confirmar."""
    t0 = time.perf_counter()
    n = nbytes = 0
    while time.perf_counter() - t0 < seconds:
        data = frames[n % len(frames)]
        dev.write(data + dev.sync_packet())
        dev.wait_acks(depth)
        n += 1
        nbytes += len(data)
    dev.wait_acks(0)
    return n, nbytes, time.perf_counter() - t0


def build_tests(names, w, h, frames):
    raw_size = w * h * 2
    tests = {}
    if "sink" in names:
        tests["sink"] = [packet(PKT_SINK, payload=bytes(64 * 1024))]
    if "fill" in names:
        tests["fill"] = [packet(PKT_FILL, 0, 0, w, h, c) for c in (b"\xF8\x00", b"\x07\xE0", b"\x00\x1F")]
    if "raw" in names:
        tests["raw"] = [packet(PKT_RECT_RAW, 0, 0, w, h, to_wire(f.ravel())) for f in frames]
    if "rle" in names:
        tests["rle"] = [packet(PKT_RECT_RLE, 0, 0, w, h, rle_encode(f.ravel())) for f in frames]
    if "dirty" in names:
        tests["dirty"] = [
            b"".join(rect_packet(f, *r) for r in dirty_rects(frames[i - 1], f))
            for i, f in enumerate(frames)
        ]
    return tests, raw_size


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", help="porta série (ex: COM7); por omissão deteta o ESP32")
    ap.add_argument("--tests", default="sink,fill,raw,rle,dirty")
    ap.add_argument("--seconds", type=float, default=5, help="duração de cada teste")
    ap.add_argument("--depth", type=int, default=2, help="frames enviados sem esperar pelo ACK")
    ap.add_argument("--frames", type=int, default=120, help="frames distintos na animação")
    ap.add_argument("--demo", action="store_true", help="anima o dashboard (dirty rects) até Ctrl+C")
    args = ap.parse_args()

    dev = Device(args.port or find_port())
    info = dev.hello()
    w, h = info["width"], info["height"]
    print(f"ESP32: protocolo v{info['version']}, ecrã {w}x{h}, DMA {'on' if info['dma'] else 'off'}")

    print(f"A gerar {args.frames} frames...", end=" ", flush=True)
    frames = make_frames(w, h, args.frames)
    sample = frames[0].ravel()
    assert rle_decode(rle_encode(sample)) == to_wire(sample), "RLE encoder com erro"
    print("ok")

    if args.demo:
        tests, _ = build_tests({"dirty"}, w, h, frames)
        dev.write(rect_packet(frames[-1], 0, 0, w, h))
        print("Demo a correr (Ctrl+C para sair)")
        try:
            while True:
                n, nbytes, elapsed = run(dev, tests["dirty"], 2, args.depth)
                print(f"\r{n / elapsed:6.1f} fps  {nbytes / elapsed / 1e6:5.2f} MB/s", end="", flush=True)
        except KeyboardInterrupt:
            print()
        dev.close()
        return

    names = [t.strip() for t in args.tests.split(",") if t.strip()]
    tests, raw_size = build_tests(set(names), w, h, frames)

    print(f"\n{'teste':<7}{'fps':>8}{'MB/s':>8}{'KB/frame':>10}{'vs raw':>8}")
    for name in names:
        if name not in tests:
            print(f"{name:<7} teste desconhecido")
            continue
        # O dirty precisa que o ecrã tenha o frame anterior ao primeiro do ciclo.
        if name == "dirty":
            dev.write(rect_packet(frames[-1], 0, 0, w, h) + dev.sync_packet())
            dev.wait_acks(0)
        n, nbytes, elapsed = run(dev, tests[name], args.seconds, args.depth)
        per_frame = nbytes / n
        ratio = f"{100 * per_frame / raw_size:5.1f}%" if name in ("raw", "rle", "dirty") else ""
        unit = "pkt/s" if name in ("sink", "fill") else ""
        print(f"{name:<7}{n / elapsed:8.1f}{nbytes / elapsed / 1e6:8.2f}{per_frame / 1024:10.1f}{ratio:>8}  {unit}")

    ack = dev.last_ack or {}
    print(f"\nESP32: {ack.get('packets', 0)} pacotes, {ack.get('errors', 0)} erros, "
          f"{ack.get('resync', 0)} bytes de resync")
    for (err, ptype), count in dev.errors.items():
        print(f"  erro {err} no pacote tipo {ptype}: {count}x")
    dev.close()


if __name__ == "__main__":
    main()
