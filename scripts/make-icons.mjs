// Draws the app's icons (a page on a blue square, as in the favicon) as PNG files: in public/, for
// installing the web app, and in android/, for the Android app's launcher icon and splash screen.
// Run once after changing the design:
//   docker compose run --rm dev node scripts/make-icons.mjs
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * An icon `w`×`h` pixels: the background (a rounded square, a circle, the whole canvas, or none) and
 * the page in white, centred, `glyph` times its size in the favicon.
 */
function draw(w, h, { shape = 'rounded', glyph = 1 } = {}) {
  const side = Math.min(w, h);
  const unit = (side / 32) * glyph;
  const ox = w / 2 - 16 * unit;
  const oy = h / 2 - 16 * unit;
  const radius = shape === 'rounded' ? (7 / 32) * side : shape === 'circle' ? side / 2 : 0;
  const onBackground = (x, y) => {
    if (shape === 'none') return false;
    if (shape === 'square') return true;
    const left = (w - side) / 2;
    const top = (h - side) / 2;
    const cx = Math.min(Math.max(x, left + radius), left + side - radius);
    const cy = Math.min(Math.max(y, top + radius), top + side - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  };
  const rgba = new Uint8Array(w * h * 4);
  const n = 4; // samples per side
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const x = px + (sx + 0.5) / n;
          const y = py + (sy + 0.5) / n;
          const page = SEGMENTS.some((s) => distance((x - ox) / unit, (y - oy) / unit, s) <= 1);
          const color = page ? WHITE : onBackground(x, y) ? BLUE : null;
          if (!color) continue;
          r += color[0];
          g += color[1];
          b += color[2];
          a += 1;
        }
      }
      const i = (py * w + px) * 4;
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
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.subarray(y * w * 4, (y + 1) * w * 4)).copy(raw, y * (w * 4 + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function write(file, w, h, options) {
  writeFileSync(file, png(w, h, draw(w, h, options)));
  console.log(file);
}

// The web app: rounded like the favicon; full squares where the system rounds the corners itself.
write('public/icon-192.png', 192, 192);
write('public/icon-512.png', 512, 512);
write('public/icon-maskable-512.png', 512, 512, { shape: 'square' });
write('public/apple-touch-icon.png', 180, 180, { shape: 'square' });

// The Android app: launcher icons at each density, the adaptive icon's foreground (the system draws
// the blue behind it and crops it to the phone's shape), and the splash screen at its sizes.
const RES = 'android/app/src/main/res';
if (existsSync(RES)) {
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [name, scale] of Object.entries(densities)) {
    write(`${RES}/mipmap-${name}/ic_launcher.png`, 48 * scale, 48 * scale);
    write(`${RES}/mipmap-${name}/ic_launcher_round.png`, 48 * scale, 48 * scale, { shape: 'circle', glyph: 0.85 });
    write(`${RES}/mipmap-${name}/ic_launcher_foreground.png`, 108 * scale, 108 * scale, { shape: 'none', glyph: 0.8 });
  }
  for (const dir of readdirSync(RES).filter((d) => d.startsWith('drawable'))) {
    const file = `${RES}/${dir}/splash.png`;
    if (!existsSync(file)) continue;
    const header = readFileSync(file).subarray(16, 24);
    write(file, header.readUInt32BE(0), header.readUInt32BE(4), { shape: 'square', glyph: 0.35 });
  }
  writeFileSync(`${RES}/values/ic_launcher_background.xml`, '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#2F6FD0</color>\n</resources>\n');
  console.log(`${RES}/values/ic_launcher_background.xml`);
}
