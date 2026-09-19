/**
 * Draws the extension icon, a 128 by 128 Magic 8 Ball, and writes it as a PNG.
 *   node scripts/make-icon.mjs
 * No dependencies: the pixels are computed here and the PNG container is
 * written by hand with node:zlib for the compression.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZE = 128;
/** Each pixel is the average of SUB by SUB samples, which smooths the edges. */
const SUB = 4;
const CENTRE = SIZE / 2;
const BALL_RADIUS = 62;
const FACE_RADIUS = 33;
/** The 8 is a 5 by 7 grid of square cells, centred in the white circle. */
const CELL = 6;
const EIGHT = ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'];

const mix = (a, b, t) => a.map((value, i) => value + (b[i] - value) * t);
const clamp01 = (value) => Math.min(1, Math.max(0, value));

/** Is this point inside a filled cell of the 8? */
function inEight(x, y) {
  const column = Math.floor((x - (CENTRE - (5 * CELL) / 2)) / CELL);
  const row = Math.floor((y - (CENTRE - (7 * CELL) / 2)) / CELL);
  return EIGHT[row]?.[column] === '#';
}

/** Colour of one sample point as [r, g, b, a], each 0 to 255. */
function sample(x, y) {
  const dx = x - CENTRE;
  const dy = y - CENTRE;
  const distance = Math.hypot(dx, dy);
  if (distance > BALL_RADIUS) return [0, 0, 0, 0];

  if (distance <= FACE_RADIUS) {
    if (inEight(x, y)) return [11, 11, 13, 255];
    // White, shading slightly towards the lower right so the circle looks printed on a curve.
    const shade = clamp01(Math.hypot(dx + 8, dy + 10) / (FACE_RADIUS * 1.6));
    return [...mix([255, 255, 255], [206, 206, 216], shade * shade), 255];
  }

  // The sphere: black, with a soft highlight from the upper left and a darker rim.
  const highlight = clamp01(1 - Math.hypot(dx + 22, dy + 26) / 60);
  const rim = clamp01((distance - BALL_RADIUS * 0.72) / (BALL_RADIUS * 0.28));
  let colour = mix([10, 10, 13], [96, 96, 108], highlight * highlight);
  colour = mix(colour, [0, 0, 0], rim * 0.85);
  return [...colour, 255];
}

/** RGBA bytes, averaged in premultiplied form so the transparent corners do not darken the edge. */
function render() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const [sr, sg, sb, sa] = sample(px + (sx + 0.5) / SUB, py + (sy + 0.5) / SUB);
          r += sr * sa; g += sg * sa; b += sb * sa; a += sa;
        }
      }
      const offset = (py * SIZE + px) * 4;
      if (a > 0) {
        pixels[offset] = Math.round(r / a);
        pixels[offset + 1] = Math.round(g / a);
        pixels[offset + 2] = Math.round(b / a);
      }
      pixels[offset + 3] = Math.round(a / (SUB * SUB));
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, then a CRC over the type and data. */
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

function encodePng(pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // colour type: RGBA
  // Every scanline starts with a filter byte. 0 means the row is stored as it is.
  const stride = SIZE * 4 + 1;
  const raw = Buffer.alloc(SIZE * stride);
  for (let y = 0; y < SIZE; y++) pixels.copy(raw, y * stride + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../packages/extension/static/icon-128.png');
const png = encodePng(render());
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
