import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bitmapTier, clearBitmaps, getBitmap } from "../bitmapCache";
import {
  loadBitmapViaProtocol,
  loadPreviewBitmap,
  retainElementAsBitmap,
} from "../bitmapLoader";
import { previewSrc } from "../imageSrc";

const fakeBitmap = (width: number, height: number) =>
  ({ width, height, close: vi.fn() }) as unknown as ImageBitmap;

describe("bitmapLoader", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, blob: async () => new Blob() })),
    );
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => fakeBitmap(800, 1200)),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearBitmaps();
  });

  it("fetches the protocol URL and returns bitmap-derived ImageData tagged 'full'", async () => {
    const { data, bitmap } = await loadBitmapViaProtocol("C:\\pics\\a.jpg");
    expect(fetch).toHaveBeenCalledWith(
      `http://spica-img.localhost/${encodeURIComponent("C:\\pics\\a.jpg")}`,
      { signal: undefined },
    );
    expect(bitmap.width).toBe(800);
    expect(data).toEqual({
      path: "C:\\pics\\a.jpg",
      src: `http://spica-img.localhost/${encodeURIComponent("C:\\pics\\a.jpg")}`,
      width: 800,
      height: 1200,
      format: "jpg",
      tier: "full",
    });
  });

  it("does not emit a src:set perf mark (bench pairing must stay clean)", async () => {
    window.__PERF__ = [];
    await loadBitmapViaProtocol("C:\\pics\\a.jpg");
    expect(
      (window.__PERF__ ?? []).find((e) => e.name === "src:set"),
    ).toBeUndefined();
  });

  it("throws on a non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
    } as Response);
    await expect(loadBitmapViaProtocol("C:\\pics\\a.jpg")).rejects.toThrow(
      /404/,
    );
  });

  it("forwards the abort signal to fetch", async () => {
    const controller = new AbortController();
    await loadBitmapViaProtocol("C:\\pics\\a.jpg", controller.signal);
    expect(fetch).toHaveBeenCalledWith(expect.any(String), {
      signal: controller.signal,
    });
  });

  it("retainElementAsBitmap enters the decoded element into the cache as tier 'full'", async () => {
    const element = new Image();
    retainElementAsBitmap("C:\\pics\\a.jpg", element);
    await vi.waitFor(() => {
      expect(getBitmap("C:\\pics\\a.jpg")).toBeDefined();
    });
    expect(createImageBitmap).toHaveBeenCalledWith(element);
    expect(bitmapTier("C:\\pics\\a.jpg")).toBe("full");
  });

  it("retainElementAsBitmap is a no-op without createImageBitmap support", () => {
    vi.stubGlobal("createImageBitmap", undefined);
    expect(() =>
      retainElementAsBitmap("C:\\pics\\a.jpg", new Image()),
    ).not.toThrow();
  });

  describe("loadPreviewBitmap", () => {
    const box = "1920x1080";

    const stubPreviewFetch = (
      headers: Record<string, string>,
      status = 200,
      ok = true,
    ) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok,
          status,
          headers: new Headers(headers),
          blob: async () => new Blob(),
        })),
      );
    };

    it("tags the result 'preview' when the decoded bitmap is smaller than the natural size", async () => {
      stubPreviewFetch({
        "X-Spica-Natural-Width": "5472",
        "X-Spica-Natural-Height": "3648",
      });
      vi.stubGlobal(
        "createImageBitmap",
        vi.fn(async () => fakeBitmap(1620, 1080)),
      );

      const { data, bitmap } = await loadPreviewBitmap("C:\\pics\\a.jpg", box);

      expect(fetch).toHaveBeenCalledWith(previewSrc("C:\\pics\\a.jpg", box), {
        signal: undefined,
      });
      expect(bitmap.width).toBe(1620);
      expect(data).toEqual({
        path: "C:\\pics\\a.jpg",
        src: previewSrc("C:\\pics\\a.jpg", box),
        width: 5472,
        height: 3648,
        format: "jpg",
        tier: "preview",
      });
    });

    it("tags the result 'full' when the decoded bitmap equals the natural size", async () => {
      stubPreviewFetch({
        "X-Spica-Natural-Width": "800",
        "X-Spica-Natural-Height": "1200",
      });
      vi.stubGlobal(
        "createImageBitmap",
        vi.fn(async () => fakeBitmap(800, 1200)),
      );

      const { data } = await loadPreviewBitmap("C:\\pics\\a.jpg", box);
      expect(data).toEqual({
        path: "C:\\pics\\a.jpg",
        src: previewSrc("C:\\pics\\a.jpg", box),
        width: 800,
        height: 1200,
        format: "jpg",
        tier: "full",
      });
    });

    it("falls back to the bitmap's own dimensions but tags 'preview' (upgradeable) when both natural headers are missing", async () => {
      // Was previously asserted "full" — a missing header must not silently
      // cap display quality by skipping the zoom upgrade (see F1 review fix).
      stubPreviewFetch({});
      vi.stubGlobal(
        "createImageBitmap",
        vi.fn(async () => fakeBitmap(640, 480)),
      );

      const { data } = await loadPreviewBitmap("C:\\pics\\a.jpg", box);
      expect(data).toMatchObject({ width: 640, height: 480, tier: "preview" });
    });

    it("falls back to the bitmap's own dimensions but tags 'preview' when only one natural header is present", async () => {
      stubPreviewFetch({ "X-Spica-Natural-Width": "5472" });
      vi.stubGlobal(
        "createImageBitmap",
        vi.fn(async () => fakeBitmap(640, 480)),
      );

      const { data } = await loadPreviewBitmap("C:\\pics\\a.jpg", box);
      expect(data).toMatchObject({ width: 640, height: 480, tier: "preview" });
    });

    it("throws on a non-ok response (404 = GIF or missing file)", async () => {
      stubPreviewFetch({}, 404, false);
      await expect(loadPreviewBitmap("C:\\pics\\a.jpg", box)).rejects.toThrow(
        /404/,
      );
    });

    it("forwards the abort signal to fetch", async () => {
      stubPreviewFetch({});
      const controller = new AbortController();
      await loadPreviewBitmap("C:\\pics\\a.jpg", box, controller.signal);
      expect(fetch).toHaveBeenCalledWith(expect.any(String), {
        signal: controller.signal,
      });
    });

    it("does not emit a src:set perf mark", async () => {
      stubPreviewFetch({});
      window.__PERF__ = [];
      await loadPreviewBitmap("C:\\pics\\a.jpg", box);
      expect(
        (window.__PERF__ ?? []).find((e) => e.name === "src:set"),
      ).toBeUndefined();
    });
  });
});
