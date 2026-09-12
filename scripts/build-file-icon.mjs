import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

// 16 は詳細/一覧/小アイコン表示が、256 は拡大アイコン表示が使う。
// 既存 src-tauri/icons/icon.ico と同じ構成に揃えている。
export const ICON_SIZES = [16, 24, 32, 48, 64, 256];

const HEADER_BYTES = 6;
const DIR_ENTRY_BYTES = 16;

export function buildIco(images) {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt16LE(1, 2); // 1 = アイコン (2 はカーソル)
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(DIR_ENTRY_BYTES * images.length);
  let offset = HEADER_BYTES + directory.length;
  images.forEach((image, i) => {
    const o = DIR_ENTRY_BYTES * i;
    // 幅と高さは 1 バイトしかないので、256 は 0 で表すのが ICO の約束。
    const dimension = image.size === 256 ? 0 : image.size;
    directory.writeUInt8(dimension, o);
    directory.writeUInt8(dimension, o + 1);
    directory.writeUInt16LE(1, o + 4);
    directory.writeUInt16LE(32, o + 6);
    directory.writeUInt32LE(image.png.length, o + 8);
    directory.writeUInt32LE(offset, o + 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

export async function renderIco(svgPath, icoPath) {
  const svg = await readFile(svgPath);
  const images = await Promise.all(
    ICON_SIZES.map(async (size) => ({
      size,
      png: await sharp(svg)
        .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png({ compressionLevel: 9 })
        .toBuffer(),
    })),
  );
  await writeFile(icoPath, buildIco(images));
  return images;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error("usage: node scripts/build-file-icon.mjs <input.svg> <output.ico>");
    process.exit(1);
  }
  const images = await renderIco(input, output);
  const summary = images.map((i) => `${i.size}px ${i.png.length}B`).join(", ");
  console.log(`wrote ${output} (${summary})`);
}
