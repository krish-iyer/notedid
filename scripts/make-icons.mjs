// Draws the app's icons (a page on a blue square, as in the favicon) as PNG files in public/,
// for installing the app on a phone or computer. Run once after changing the design:
//   docker compose run --rm dev node scripts/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BLUE = [0x2f, 0x6f, 0xd0];
const WHITE = [0xff, 0xff, 0xff];
// The design on a 32-unit grid: the page's outline (folded corner) and two lines of text, 2 units wide.
const SEGMENTS = [
  [10, 9, 19, 9],
  [19, 9, 23, 13],
  [23, 13, 23, 23],
  [23, 23, 10, 23],
  [10, 23, 10, 9],
  [13, 17, 20, 17],
  [13, 21, 18, 21],
];

function distance(px, py, [ax, ay, bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Whether a point is on the background: a rounded square, or the whole square for icons the system masks itself. */
function onBackground(x, y, radius) {
  if (x < 0 || y < 0 || x > 32 || y > 32) return false;
  const cx = Math.min(Math.max(x, radius), 32 - radius);
  const cy = Math.min(Math.max(y, radius), 32 - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
}

function draw(size, radius) {
  const rgba = new Uint8Array(size * size * 4);
  const n = 4; // samples per side
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const x = ((px + (sx + 0.5) / n) / size) * 32;
          const y = ((py + (sy + 0.5) / n) / size) * 32;
          if (!onBackground(x, y, radius)) continue;
          const color = SEGMENTS.some((s) => distance(x, y, s) <= 1) ? WHITE : BLUE;
          r += color[0];
          g += color[1];
          b += color[2];
          a += 1;
        }
      }
      const i = (py * size + px) * 4;
      if (a > 0) {
        rgba[i] = Math.round(r / a);
        rgba[i + 1] = Math.round(g / a);
        rgba[i + 2] = Math.round(b / a);
      }
      rgba[i + 3] = Math.round((a / (n * n)) * 255);
    }
  }
  return rgba;
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) Buffer.from(rgba.subarray(y * size * 4, (y + 1) * size * 4)).copy(raw, y * (size * 4 + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Rounded like the favicon; full squares where the system rounds the corners itself (Android's maskable icons, iOS).
for (const [file, size, radius] of [
  ['icon-192.png', 192, 7],
  ['icon-512.png', 512, 7],
  ['icon-maskable-512.png', 512, 0],
  ['apple-touch-icon.png', 180, 0],
]) {
  writeFileSync(`public/${file}`, png(size, draw(size, radius)));
  console.log(`public/${file}`);
}
