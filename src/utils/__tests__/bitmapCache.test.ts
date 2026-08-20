import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bitmapBytes,
  bitmapPaths,
  clearBitmaps,
  deleteBitmap,
  getBitmap,
  hasBitmap,
  setBitmap,
} from "../bitmapCache";

// jsdom has no ImageBitmap; the cache only touches width/height/close.
const fakeBitmap = (width: number, height: number) =>
  ({ width, height, close: vi.fn() }) as unknown as ImageBitmap;

describe("bitmapCache", () => {
  afterEach(() => {
    clearBitmaps();
  });

  it("stores and retrieves bitmaps by path", () => {
    const bmp = fakeBitmap(100, 50);
    setBitmap("/a.jpg", bmp);
    expect(hasBitmap("/a.jpg")).toBe(true);
    expect(getBitmap("/a.jpg")).toBe(bmp);
    expect(getBitmap("/missing.jpg")).toBeUndefined();
  });

  it("closes the previous bitmap when a path is overwritten", () => {
    const first = fakeBitmap(10, 10);
    const second = fakeBitmap(20, 20);
    setBitmap("/a.jpg", first);
    setBitmap("/a.jpg", second);
    expect(first.close).toHaveBeenCalledOnce();
    expect(getBitmap("/a.jpg")).toBe(second);
  });

  it("closes on delete and removes the entry", () => {
    const bmp = fakeBitmap(10, 10);
    setBitmap("/a.jpg", bmp);
    deleteBitmap("/a.jpg");
    expect(bmp.close).toHaveBeenCalledOnce();
    expect(hasBitmap("/a.jpg")).toBe(false);
  });

  it("delete of an unknown path is a no-op", () => {
    expect(() => deleteBitmap("/missing.jpg")).not.toThrow();
  });

  it("closes everything on clear", () => {
    const a = fakeBitmap(10, 10);
    const b = fakeBitmap(20, 20);
    setBitmap("/a.jpg", a);
    setBitmap("/b.jpg", b);
    clearBitmaps();
    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).toHaveBeenCalledOnce();
    expect(bitmapPaths()).toEqual([]);
  });

  it("accounts bytes as width*height*4", () => {
    setBitmap("/a.jpg", fakeBitmap(100, 50)); // 20_000
    setBitmap("/b.jpg", fakeBitmap(10, 10)); // 400
    expect(bitmapBytes()).toBe(100 * 50 * 4 + 10 * 10 * 4);
    deleteBitmap("/a.jpg");
    expect(bitmapBytes()).toBe(400);
  });

  it("lists cached paths", () => {
    setBitmap("/a.jpg", fakeBitmap(1, 1));
    setBitmap("/b.jpg", fakeBitmap(1, 1));
    expect(bitmapPaths().sort()).toEqual(["/a.jpg", "/b.jpg"]);
  });
});
