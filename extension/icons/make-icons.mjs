/**
 * Regenerates icon16/48/128.png.
 *
 * Chrome MV3 will not accept an SVG for `action.default_icon` or `icons`, so the
 * raster files have to exist on disk. Rather than commit binaries with no source,
 * this draws them: a pointer arrow over a rounded square, rasterised with 4x4
 * supersampling and encoded to PNG using only node:zlib.
 *
 *   node extension/icons/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BG = [0x17, 0x1a, 0x1f, 0xff]; // near-black, reads on light and dark toolbars
const ARROW = [0x7a, 0xa2, 0xf7, 0xff]; // blue -- the pointer
const ACCENT = [0xf7, 0xb9, 0x55, 0xff]; // amber -- the "hover happened" bar

// A conventional cursor arrow in a 0..1 unit box.
const POINTER = [
  [0.30, 0.14], [0.30, 0.76], [0.44, 0.62], [0.53, 0.855],
  [0.635, 0.81], [0.545, 0.575], [0.725, 0.56],
];

/** Even-odd point-in-polygon. */
function inPoly(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Rounded square covering the full unit box, corner radius `r`. */
function inRounded(r, x, y) {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

const inAccent = (x, y) => x >= 0.30 && x <= 0.725 && y >= 0.90 && y <= 0.955;

/** Alpha-over composite of `src` (0..255 rgba) onto `dst` in place. */
function over(dst, i, src, cov) {
  const a = (src[3] / 255) * cov;
  if (a <= 0) return;
  for (let c = 0; c < 3; c++) dst[i + c] = Math.round(src[c] * a + dst[i + c] * (1 - a));
  dst[i + 3] = Math.round(src[3] * cov + dst[i + 3] * (1 - a));
}

const SS = 4; // supersampling grid per axis

function render(size) {
  const px = new Uint8Array(size * size * 4); // starts fully transparent
  const radius = 0.22;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let arrow = 0;
      let accent = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          if (inRounded(radius, u, v)) bg++;
          if (inPoly(POINTER, u, v)) arrow++;
          if (inAccent(u, v)) accent++;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      over(px, i, BG, bg / n);
      over(px, i, ARROW, arrow / n);
      over(px, i, ACCENT, accent / n);
    }
  }
  return px;
}

/* ------------------------------ PNG encoding ------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 stay 0: deflate, adaptive filtering, no interlace

  // One filter byte (0 = None) per scanline, as the PNG spec requires.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const at = y * (size * 4 + 1);
    raw[at] = 0;
    Buffer.from(px.buffer, px.byteOffset + y * size * 4, size * 4).copy(raw, at + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const here = dirname(fileURLToPath(import.meta.url));
for (const size of [16, 48, 128]) {
  const file = join(here, `icon${size}.png`);
  writeFileSync(file, png(size, render(size)));
  console.log(`wrote icon${size}.png`);
}
