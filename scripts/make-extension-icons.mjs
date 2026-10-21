#!/usr/bin/env node
// Generates extension/icons/icon{16,32,48,128}.png: a teal rounded square with a white check mark.
// Pure Node (zlib only) so there is nothing to install. Replace the PNGs with real artwork any time.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xFFFFFFFF; for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const distToSegment = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
const inRoundedSquare = (x, y, r) => { // unit square, corner radius r
  const cx = Math.min(Math.max(x, r), 1 - r), cy = Math.min(Math.max(y, r), 1 - r);
  return Math.hypot(x - cx, y - cy) <= r;
};

function icon(size) {
  const SS = 4, TEAL = [15, 118, 110];
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const u = (x + (sx + .5) / SS) / size, v = (y + (sy + .5) / SS) / size;
        if (!inRoundedSquare(u, v, 0.22)) continue;
        bg++;
        const d = Math.min(distToSegment(u, v, .27, .52, .43, .68), distToSegment(u, v, .43, .68, .74, .34));
        if (d <= .055) fg++;
      }
      const n = SS * SS, a = bg / n, w = bg ? fg / bg : 0;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = Math.round(TEAL[0] * (1 - w) + 255 * w);
      raw[o + 1] = Math.round(TEAL[1] * (1 - w) + 255 * w);
      raw[o + 2] = Math.round(TEAL[2] * (1 - w) + 255 * w);
      raw[o + 3] = Math.round(a * 255);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const dir = new URL('../extension/icons/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(new URL(`icon${s}.png`, dir), icon(s));
console.log('wrote extension/icons/icon{16,32,48,128}.png');
