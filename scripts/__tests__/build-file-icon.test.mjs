import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIco, ICON_SIZES } from "../build-file-icon.mjs";

function readDirectory(ico) {
  const count = ico.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + 16 * i;
    entries.push({
      width: ico.readUInt8(o),
      height: ico.readUInt8(o + 1),
      paletteCount: ico.readUInt8(o + 2),
      planes: ico.readUInt16LE(o + 4),
      bitCount: ico.readUInt16LE(o + 6),
      bytesInRes: ico.readUInt32LE(o + 8),
      imageOffset: ico.readUInt32LE(o + 12),
    });
  }
  return { reserved: ico.readUInt16LE(0), type: ico.readUInt16LE(2), count, entries };
}

test("the header declares an icon file with one entry per image", () => {
  const ico = buildIco([
    { size: 16, png: Buffer.from("a") },
    { size: 32, png: Buffer.from("bb") },
  ]);
  const dir = readDirectory(ico);
  assert.equal(dir.reserved, 0);
  assert.equal(dir.type, 1);
  assert.equal(dir.count, 2);
});

test("256 is written as 0 because the field is one byte wide", () => {
  const [entry] = readDirectory(buildIco([{ size: 256, png: Buffer.from("a") }])).entries;
  assert.equal(entry.width, 0);
  assert.equal(entry.height, 0);
});

test("sizes below 256 are written verbatim", () => {
  const [entry] = readDirectory(buildIco([{ size: 48, png: Buffer.from("a") }])).entries;
  assert.equal(entry.width, 48);
  assert.equal(entry.height, 48);
});

test("each entry points at its own payload", () => {
  const first = Buffer.from("first");
  const second = Buffer.from("second-payload");
  const ico = buildIco([
    { size: 16, png: first },
    { size: 32, png: second },
  ]);
  const [a, b] = readDirectory(ico).entries;
  assert.equal(a.bytesInRes, first.length);
  assert.equal(b.bytesInRes, second.length);
  assert.deepEqual(ico.subarray(a.imageOffset, a.imageOffset + a.bytesInRes), first);
  assert.deepEqual(ico.subarray(b.imageOffset, b.imageOffset + b.bytesInRes), second);
});

test("the first payload starts immediately after the directory", () => {
  const ico = buildIco([
    { size: 16, png: Buffer.from("a") },
    { size: 32, png: Buffer.from("b") },
  ]);
  assert.equal(readDirectory(ico).entries[0].imageOffset, 6 + 16 * 2);
});

test("entries declare truecolor so Windows keeps the alpha channel", () => {
  const [entry] = readDirectory(buildIco([{ size: 16, png: Buffer.from("a") }])).entries;
  assert.equal(entry.paletteCount, 0);
  assert.equal(entry.planes, 1);
  assert.equal(entry.bitCount, 32);
});

test("the icon ships every size Explorer asks for", () => {
  assert.deepEqual(ICON_SIZES, [16, 24, 32, 48, 64, 256]);
});
