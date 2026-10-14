'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { imageSize } = require('../src/main/images');
const { scanWidgets } = require('../src/main/widgets');

function png(w, h) {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

function gif(w, h) {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}

function jpeg(w, h) {
  // SOI, APP0 (16 bytes de dados), SOF0
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff; sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function webpVp8x(w, h) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}

test('PNG, GIF, JPEG e WebP (animado)', () => {
  assert.deepStrictEqual(imageSize(png(240, 320)), { width: 240, height: 320 });
  assert.deepStrictEqual(imageSize(gif(64, 48)), { width: 64, height: 48 });
  assert.deepStrictEqual(imageSize(jpeg(800, 600)), { width: 800, height: 600 });
  assert.deepStrictEqual(imageSize(webpVp8x(500, 375)), { width: 500, height: 375 });
});

test('SVG: width/height ou viewBox', () => {
  assert.deepStrictEqual(imageSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"></svg>')), { width: 32, height: 16 });
  assert.deepStrictEqual(imageSize(Buffer.from('<?xml version="1.0"?><svg viewBox="0 0 100 50"></svg>')), { width: 100, height: 50 });
  assert.deepStrictEqual(imageSize(Buffer.from('<svg width="200" viewBox="0 0 100 50"></svg>')), { width: 200, height: 100 });
});

test('ficheiro desconhecido devolve null', () => {
  assert.strictEqual(imageSize(Buffer.from('isto não é uma imagem')), null);
  assert.strictEqual(imageSize(Buffer.alloc(0)), null);
});

test('formas e imagem incluídas aparecem nas categorias certas', () => {
  const catalog = scanWidgets([path.join(__dirname, '..', 'widgets')]);
  for (const t of ['line', 'rect', 'ellipse', 'arc', 'polygon']) assert.strictEqual(catalog[t]?.category, 'shape', t);
  assert.strictEqual(catalog.image.category, 'image');
  assert.strictEqual(catalog.gauge.category, 'component');
});
