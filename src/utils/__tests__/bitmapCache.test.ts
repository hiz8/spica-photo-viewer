import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bitmapBytes,
  bitmapPaths,
  bitmapTier,
  clearBitmaps,
  deleteBitmap,
  effectiveTier,
  fullBitmapPaths,
  getBitmap,
  getBitmapOfTier,
  getRetained,
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

  it("defaults the tier to full when omitted (backward compat)", () => {
    setBitmap("/a.jpg", fakeBitmap(1, 1));
    expect(hasBitmap("/a.jpg", "full")).toBe(true);
    expect(hasBitmap("/a.jpg", "preview")).toBe(false);
    expect(bitmapTier("/a.jpg")).toBe("full");
  });

  it("keeps preview and full as independent slots per path", () => {
    const preview = fakeBitmap(1620, 1080);
    const full = fakeBitmap(5472, 3648);
    setBitmap("/a.jpg", preview, "preview");
    setBitmap("/a.jpg", full, "full");
    expect(preview.close).not.toHaveBeenCalled();
    expect(getBitmapOfTier("/a.jpg", "preview")).toBe(preview);
    expect(getBitmapOfTier("/a.jpg", "full")).toBe(full);
  });

  it("replacing the same tier closes only that tier's previous bitmap", () => {
    const preview = fakeBitmap(1620, 1080);
    const previewReplacement = fakeBitmap(1620, 1080);
    const full = fakeBitmap(5472, 3648);
    setBitmap("/a.jpg", preview, "preview");
    setBitmap("/a.jpg", full, "full");
    setBitmap("/a.jpg", previewReplacement, "preview");
    expect(preview.close).toHaveBeenCalledOnce();
    expect(full.close).not.toHaveBeenCalled();
    expect(getBitmapOfTier("/a.jpg", "preview")).toBe(previewReplacement);
    expect(getBitmapOfTier("/a.jpg", "full")).toBe(full);
  });

  it("getBitmap and getRetained prefer full over preview", () => {
    const preview = fakeBitmap(1620, 1080);
    const full = fakeBitmap(5472, 3648);
    setBitmap("/a.jpg", preview, "preview");
    setBitmap("/a.jpg", full, "full");
    expect(getBitmap("/a.jpg")).toBe(full);
    expect(getRetained("/a.jpg")).toEqual({ bitmap: full, tier: "full" });
  });

  it("getBitmap and getRetained fall back to preview when full is absent", () => {
    const preview = fakeBitmap(1620, 1080);
    setBitmap("/a.jpg", preview, "preview");
    expect(getBitmap("/a.jpg")).toBe(preview);
    expect(getRetained("/a.jpg")).toEqual({ bitmap: preview, tier: "preview" });
    expect(bitmapTier("/a.jpg")).toBe("preview");
  });

  it("deleteBitmap(path, 'full') closes only full and leaves preview retained", () => {
    const preview = fakeBitmap(1620, 1080);
    const full = fakeBitmap(5472, 3648);
    setBitmap("/a.jpg", preview, "preview");
    setBitmap("/a.jpg", full, "full");
    deleteBitmap("/a.jpg", "full");
    expect(full.close).toHaveBeenCalledOnce();
    expect(preview.close).not.toHaveBeenCalled();
    expect(hasBitmap("/a.jpg", "full")).toBe(false);
    expect(hasBitmap("/a.jpg", "preview")).toBe(true);
    expect(getBitmap("/a.jpg")).toBe(preview);
  });

  it("deleteBitmap without a tier closes both tiers and removes the entry", () => {
    const preview = fakeBitmap(1620, 1080);
    const full = fakeBitmap(5472, 3648);
    setBitmap("/a.jpg", preview, "preview");
    setBitmap("/a.jpg", full, "full");
    deleteBitmap("/a.jpg");
    expect(preview.close).toHaveBeenCalledOnce();
    expect(full.close).toHaveBeenCalledOnce();
    expect(hasBitmap("/a.jpg")).toBe(false);
    expect(bitmapPaths()).not.toContain("/a.jpg");
  });

  it("bitmapBytes sums both tiers across all paths", () => {
    setBitmap("/a.jpg", fakeBitmap(1620, 1080), "preview"); // 6_998_400
    setBitmap("/a.jpg", fakeBitmap(5472, 3648), "full"); // 79_866_624
    setBitmap("/b.jpg", fakeBitmap(10, 10), "full"); // 400
    expect(bitmapBytes()).toBe(1620 * 1080 * 4 + 5472 * 3648 * 4 + 10 * 10 * 4);
  });

  it("bitmapPaths lists paths with either tier", () => {
    setBitmap("/a.jpg", fakeBitmap(1, 1), "preview");
    setBitmap("/b.jpg", fakeBitmap(1, 1), "full");
    expect(bitmapPaths().sort()).toEqual(["/a.jpg", "/b.jpg"]);
  });

  it("fullBitmapPaths lists only paths that hold a full bitmap", () => {
    setBitmap("/a.jpg", fakeBitmap(1, 1), "preview");
    setBitmap("/b.jpg", fakeBitmap(1, 1), "full");
    setBitmap("/c.jpg", fakeBitmap(1, 1), "preview");
    setBitmap("/c.jpg", fakeBitmap(1, 1), "full");
    expect(fullBitmapPaths().sort()).toEqual(["/b.jpg", "/c.jpg"]);
  });

  it("hasBitmap without a tier is true when either tier is present", () => {
    setBitmap("/a.jpg", fakeBitmap(1, 1), "preview");
    expect(hasBitmap("/a.jpg")).toBe(true);
    expect(hasBitmap("/a.jpg", "preview")).toBe(true);
    expect(hasBitmap("/a.jpg", "full")).toBe(false);
  });

  describe("effectiveTier", () => {
    it("returns 'preview' when the retained preview bitmap is smaller than natural size", () => {
      setBitmap("/a.jpg", fakeBitmap(1620, 1080), "preview");
      expect(effectiveTier("/a.jpg", 5472, 3648)).toBe("preview");
    });

    it("returns 'full' when the retained preview bitmap equals natural size (unscaled preview)", () => {
      setBitmap("/a.jpg", fakeBitmap(1024, 768), "preview");
      expect(effectiveTier("/a.jpg", 1024, 768)).toBe("full");
    });

    it("returns 'full' when a full-tier bitmap is retained", () => {
      setBitmap("/a.jpg", fakeBitmap(5472, 3648), "full");
      expect(effectiveTier("/a.jpg", 5472, 3648)).toBe("full");
    });

    it("returns undefined when nothing is retained", () => {
      expect(effectiveTier("/missing.jpg", 5472, 3648)).toBeUndefined();
    });
  });
});
