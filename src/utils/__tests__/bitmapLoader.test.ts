import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearBitmaps, getBitmap } from "../bitmapCache";
import { loadBitmapViaProtocol, retainElementAsBitmap } from "../bitmapLoader";

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

  it("fetches the protocol URL and returns bitmap-derived ImageData", async () => {
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

  it("retainElementAsBitmap enters the decoded element into the cache", async () => {
    const element = new Image();
    retainElementAsBitmap("C:\\pics\\a.jpg", element);
    await vi.waitFor(() => {
      expect(getBitmap("C:\\pics\\a.jpg")).toBeDefined();
    });
    expect(createImageBitmap).toHaveBeenCalledWith(element);
  });

  it("retainElementAsBitmap is a no-op without createImageBitmap support", () => {
    vi.stubGlobal("createImageBitmap", undefined);
    expect(() =>
      retainElementAsBitmap("C:\\pics\\a.jpg", new Image()),
    ).not.toThrow();
  });
});
