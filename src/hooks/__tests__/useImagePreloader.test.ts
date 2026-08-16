import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageData, ImageInfo } from "../../types";
import {
  clearBitmaps,
  getBitmap,
  hasBitmap,
  setBitmap,
} from "../../utils/bitmapCache";
import { _setPerfEnabledForTests } from "../../utils/perf";

const fakeBitmap = (width = 10, height = 10) =>
  ({ width, height, close: vi.fn() }) as unknown as ImageBitmap;

const imageInfo = (
  i: number,
  overrides: Partial<ImageInfo> = {},
): ImageInfo => ({
  path: `/test/image${i}.jpg`,
  filename: `image${i}.jpg`,
  size: 1024,
  modified: 1700000000000 - i,
  format: "jpeg",
  ...overrides,
});

const fullData = (path: string): ImageData => ({
  path,
  src: `http://spica-img.localhost/x`,
  width: 800,
  height: 600,
  format: "jpg",
});

// The scheduler reads live state via useAppStore.getState(), so the mock
// exposes the same object through both the hook call and getState.
const mockStore = {
  folder: { path: "/test", images: [] as ImageInfo[] },
  currentImage: {
    index: -1,
    path: "",
    data: null as ImageData | null,
  },
  cache: { preloaded: new Map<string, ImageData>() },
  thumbnailGeneration: { allGenerated: true },
  ui: { thumbnailDisplayed: false },
  // Mirrors the real store: the scheduler's no-retry guard reads
  // cache.preloaded, so the mock MUST actually write the entry — otherwise
  // a rejected load pumps itself forever.
  setPreloadedImage: vi.fn((path: string, data: ImageData) => {
    mockStore.cache.preloaded.set(path, data);
  }),
  removePreloadedImage: vi.fn((path: string) => {
    mockStore.cache.preloaded.delete(path);
  }),
};

vi.mock("../../store", () => {
  const mockUseAppStore = vi.fn(() => mockStore);
  (
    mockUseAppStore as unknown as { getState: () => typeof mockStore }
  ).getState = () => mockStore;
  return { useAppStore: mockUseAppStore };
});

vi.mock("../../utils/bitmapLoader", () => ({
  loadBitmapViaProtocol: vi.fn(),
  retainElementAsBitmap: vi.fn(),
}));

import { useImagePreloader } from "../useImagePreloader";
import { loadBitmapViaProtocol } from "../../utils/bitmapLoader";

const mockLoad = vi.mocked(loadBitmapViaProtocol);

/** Configure the store as "index navigated to i, full-res displayed". */
const showFullRes = (index: number) => {
  mockStore.currentImage.index = index;
  mockStore.currentImage.path = mockStore.folder.images[index]?.path ?? "";
  mockStore.currentImage.data = fullData(mockStore.currentImage.path);
  mockStore.ui.thumbnailDisplayed = false;
};

const flush = async () => {
  // Drain chained load->settle->pump microtask rounds (launch, settle,
  // finally-pump, second launch, ...).
  await act(async () => {
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
  });
};

describe("useImagePreloader (bitmap window scheduler)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearBitmaps();
    mockStore.folder.path = "/test";
    mockStore.folder.images = Array.from({ length: 16 }, (_, i) =>
      imageInfo(i),
    );
    mockStore.currentImage.index = -1;
    mockStore.currentImage.path = "";
    mockStore.currentImage.data = null;
    mockStore.cache.preloaded = new Map();
    mockStore.thumbnailGeneration.allGenerated = true;
    mockStore.ui.thumbnailDisplayed = false;
    mockLoad.mockImplementation(async (path: string) => ({
      data: fullData(path),
      bitmap: fakeBitmap(),
    }));
  });

  afterEach(() => {
    clearBitmaps();
    _setPerfEnabledForTests(null);
    window.__PERF__ = [];
  });

  it("launches window decodes immediately (no delay timer), capped at 3", async () => {
    showFullRes(0);
    renderHook(() => useImagePreloader());
    // synchronous launch on mount: [1,2,3,4] capped at MAX_CONCURRENT_LOADS
    expect(mockLoad.mock.calls.map((c) => c[0])).toEqual([
      "/test/image1.jpg",
      "/test/image2.jpg",
      "/test/image3.jpg",
    ]);
  });

  it("pumps the next target when a slot frees, and caches + reports results", async () => {
    _setPerfEnabledForTests(true);
    showFullRes(0);
    renderHook(() => useImagePreloader());
    await flush();
    // 4th target launched after a completion freed a slot
    expect(mockLoad.mock.calls.map((c) => c[0])).toContain("/test/image4.jpg");
    await flush();
    expect(hasBitmap("/test/image1.jpg")).toBe(true);
    expect(mockStore.setPreloadedImage).toHaveBeenCalledWith(
      "/test/image1.jpg",
      fullData("/test/image1.jpg"),
    );
    const done = (window.__PERF__ ?? []).filter(
      (e) => e.name === "preload:done",
    );
    expect(done.map((e) => e.detail?.path)).toContain("/test/image1.jpg");
  });

  it("does not start while a thumbnail placeholder is displayed", () => {
    showFullRes(0);
    mockStore.ui.thumbnailDisplayed = true;
    renderHook(() => useImagePreloader());
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("does not start before all thumbnails are generated", () => {
    showFullRes(0);
    mockStore.thumbnailGeneration.allGenerated = false;
    renderHook(() => useImagePreloader());
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("prefers the backward neighbor first when navigating backward", async () => {
    showFullRes(8);
    const { rerender } = renderHook(() => useImagePreloader());
    await flush();
    mockLoad.mockClear();
    clearBitmaps();
    showFullRes(7); // 8 -> 7 = backward
    rerender();
    expect(mockLoad.mock.calls[0][0]).toBe("/test/image6.jpg");
  });

  it("skips GIFs", async () => {
    mockStore.folder.images[1] = imageInfo(1, { format: "gif" });
    showFullRes(0);
    renderHook(() => useImagePreloader());
    const paths = mockLoad.mock.calls.map((c) => c[0]);
    expect(paths).not.toContain("/test/image1.jpg");
  });

  it("evicts bitmap + preload entry when a path leaves the window", async () => {
    const far = fakeBitmap();
    setBitmap("/test/image15.jpg", far);
    mockStore.cache.preloaded.set(
      "/test/image15.jpg",
      fullData("/test/image15.jpg"),
    );
    showFullRes(0);
    renderHook(() => useImagePreloader());
    expect(far.close).toHaveBeenCalledOnce();
    expect(hasBitmap("/test/image15.jpg")).toBe(false);
    expect(mockStore.removePreloadedImage).toHaveBeenCalledWith(
      "/test/image15.jpg",
    );
  });

  it("marks failed loads as error entries and does not retry them", async () => {
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    mockLoad.mockRejectedValue(new Error("boom"));
    showFullRes(0);
    const { rerender } = renderHook(() => useImagePreloader());
    await flush();
    expect(mockStore.setPreloadedImage).toHaveBeenCalledWith(
      "/test/image1.jpg",
      {
        path: "/test/image1.jpg",
        src: "",
        width: 0,
        height: 0,
        format: "error",
      },
    );
    // the mock wrote the error entries into cache.preloaded; re-render: no retry
    mockLoad.mockClear();
    rerender();
    await flush();
    expect(mockLoad).not.toHaveBeenCalled();
    consoleWarnSpy.mockRestore();
  });

  it("clears all bitmaps when the folder changes", async () => {
    showFullRes(0);
    const { rerender } = renderHook(() => useImagePreloader());
    await flush();
    expect(getBitmap("/test/image1.jpg")).toBeDefined();
    mockStore.folder.path = "/other";
    rerender();
    expect(getBitmap("/test/image1.jpg")).toBeUndefined();
  });
});
