#!/usr/bin/env node
/**
 * Generates public/icon/{16,32,48,128}.png — a little receipt with a torn
 * edge and printed lines. Dependency-free PNG encoder.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'public', 'icon');

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function encodePNG(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PAPER = [246, 241, 230];
const INK = [43, 38, 32];
const ACCENT = [181, 70, 47];
const SHADOW = [60, 45, 25];

function receipt(size) {
  const s = size;
  const left = Math.round(s * 0.18);
  const right = Math.round(s * 0.82);
  const top = Math.round(s * 0.08);
  const bottom = Math.round(s * 0.92);
  const tooth = Math.max(1, Math.round(s / 16));
  const lineH = Math.max(1, Math.round(s / 16));
  const gap = Math.max(2, Math.round(s / 8));

  return (x, y) => {
    // drop shadow
    const sx = x - Math.max(1, Math.round(s / 32));
    const sy = y - Math.max(1, Math.round(s / 32));
    const inShadow = sx >= left && sx < right && sy >= top && sy < bottom;

    let inPaper = x >= left && x < right && y >= top && y < bottom;
    if (inPaper) {
      // torn edges: zigzag on top and bottom
      const phase = Math.floor((x - left) / tooth) % 2;
      if (y - top < tooth && phase === 0) inPaper = false;
      if (bottom - 1 - y < tooth && phase === 1) inPaper = false;
    }
    if (!inPaper) return inShadow ? [...SHADOW, 90] : [0, 0, 0, 0];

    // printed lines
    const innerL = left + Math.round(s * 0.1);
    const innerR = right - Math.round(s * 0.1);
    const startY = top + tooth + gap;
    const rel = y - startY;
    if (rel >= 0 && rel % gap < lineH && y < bottom - tooth - gap) {
      const row = Math.floor(rel / gap);
      const lenFrac = [0.9, 0.55, 0.75, 0.45, 0.85, 0.6][row % 6];
      const lineEnd = innerL + Math.round((innerR - innerL) * lenFrac);
      if (x >= innerL && x < lineEnd) {
        // highlight the second row in accent (a "found" line)
        return row === 1 ? [...ACCENT, 255] : [...INK, 235];
      }
      // right-aligned "qty" tick
      if (x >= innerR - lineH * 2 && x < innerR) return [...INK, 200];
    }
    return [...PAPER, 255];
  };
}

await mkdir(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await writeFile(path.join(outDir, `${size}.png`), encodePNG(size, receipt(size)));
}
console.log('icons written to', outDir);
