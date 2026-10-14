'use strict';

const fs = require('fs');

/*
 * Tamanho (em pixels) de uma imagem a partir do cabeçalho do ficheiro, sem a
 * descodificar: PNG, GIF, JPEG, WebP (VP8, VP8L e VP8X, incluindo animadas),
 * BMP e SVG (width/height ou viewBox). Devolve { width, height } ou null.
 */
function imageSize(buf) {
  if (!buf || buf.length < 10) return null;

  // PNG (e APNG): IHDR logo a seguir à assinatura.
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // GIF87a / GIF89a: tamanho do ecrã lógico.
  if (buf.toString('ascii', 0, 4) === 'GIF8') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // BMP
  if (buf.toString('ascii', 0, 2) === 'BM' && buf.length >= 26) {
    return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
  }

  // WebP
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    }
    if (chunk === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
    }
    if (chunk === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    return null;
  }

  // JPEG: procura o segmento SOFn.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xff) { i++; continue; }
      const len = buf.readUInt16BE(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isSof) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
    return null;
  }

  // SVG
  const head = buf.toString('utf8', 0, Math.min(buf.length, 4096));
  const svg = /<svg\b[^>]*>/i.exec(head);
  if (svg) {
    const attr = (name) => {
      const m = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, 'i').exec(svg[0]);
      return m ? Number(m[1]) : null;
    };
    let width = attr('width'), height = attr('height');
    const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(svg[0]);
    if (vb) {
      const vw = Number(vb[1]), vh = Number(vb[2]);
      if (width && !height) height = (width * vh) / vw;
      else if (height && !width) width = (height * vw) / vh;
      else if (!width && !height) { width = vw; height = vh; }
    }
    if (width && height) return { width: Math.round(width), height: Math.round(height) };
  }
  return null;
}

function imageFileSize(file) {
  try {
    return imageSize(fs.readFileSync(file));
  } catch {
    return null;
  }
}

module.exports = { imageSize, imageFileSize };
