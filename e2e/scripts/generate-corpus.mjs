// Deterministic bench corpus generator. Images are gradient+noise so JPEG
// decode cost is realistic (pure flat color compresses to nothing and would
// make decode artificially cheap). Never commit the generated files.
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const OUT = join(import.meta.dirname, "../fixtures/corpus");

// mulberry32: tiny seeded PRNG, deterministic across runs/platforms
const mulberry32 = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const SETS = [
  { name: "small", width: 1024, height: 768, count: 8 },
  { name: "medium", width: 3264, height: 2448, count: 30 },
  { name: "large", width: 5472, height: 3648, count: 16 },
  // Portrait set for the centering gate (e2e/specs/centering.e2e.ts). Two
  // images, so the second one is a bitmap-window hit.
  { name: "portrait", width: 1200, height: 1600, count: 2 },
];

for (const { name, width, height, count } of SETS) {
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const file = join(dir, `img-${String(i).padStart(3, "0")}.jpg`);
    if (existsSync(file)) continue;
    const rand = mulberry32(name.length * 1000 + i);
    const raw = Buffer.alloc(width * height * 3);
    for (let p = 0; p < raw.length; p += 3) {
      const x = (p / 3) % width;
      const y = Math.floor(p / 3 / width);
      raw[p] = (x * 255) / width + rand() * 40;
      raw[p + 1] = (y * 255) / height + rand() * 40;
      raw[p + 2] = ((x + y) * 128) / (width + height) + rand() * 40;
    }
    await sharp(raw, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 88 })
      .toFile(file);
    console.log(`generated ${file}`);
  }
}
// EXIF orientation fixture: encoded 1200x800, orientation=6 (rotate 90 CW).
// The protocol pipeline hands original bytes to the browser, which applies
// EXIF orientation - displayed size must be 800x1200.
{
  const dir = join(OUT, "exif");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "img-000.jpg");
  if (!existsSync(file)) {
    const width = 1200;
    const height = 800;
    const rand = mulberry32(99001);
    const raw = Buffer.alloc(width * height * 3);
    for (let p = 0; p < raw.length; p += 3) {
      const x = (p / 3) % width;
      const y = Math.floor(p / 3 / width);
      raw[p] = (x * 255) / width + rand() * 40;
      raw[p + 1] = (y * 255) / height + rand() * 40;
      raw[p + 2] = ((x + y) * 128) / (width + height) + rand() * 40;
    }
    await sharp(raw, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 88 })
      .withMetadata({ orientation: 6 })
      .toFile(file);
    console.log(`generated ${file}`);
  }
}
// Plain companion image in the exif set, so the hit-canvas visual test can
// open it first and then navigate to img-000 as a preload hit.
{
  const dir = join(OUT, "exif");
  const file = join(dir, "img-001.jpg");
  if (!existsSync(file)) {
    const width = 1200;
    const height = 800;
    const rand = mulberry32(99002);
    const raw = Buffer.alloc(width * height * 3);
    for (let p = 0; p < raw.length; p += 3) {
      const x = (p / 3) % width;
      const y = Math.floor(p / 3 / width);
      raw[p] = (x * 255) / width + rand() * 40;
      raw[p + 1] = (y * 255) / height + rand() * 40;
      raw[p + 2] = ((x + y) * 128) / (width + height) + rand() * 40;
    }
    await sharp(raw, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 88 })
      .toFile(file);
    console.log(`generated ${file}`);
  }
}

console.log("corpus ready");
