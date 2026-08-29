/** Spec: docs/superpowers/specs/2026-08-21-thumbnail-implies-cached-preview-tier-design.md */
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

const img = (i: number) => `/test/image${i}.jpg`;

const imageInfo = (
  i: number,
  overrides: Partial<ImageInfo> = {},
): ImageInfo => ({
  path: img(i),
  filename: `image${i}.jpg`,
  size: 1024,
  modified: 1700000000 - i,
  created: 1700000000 - i,
  format: "jpeg",
  ...overrides,
});

/** What loadPreviewBitmap resolves to: box-sized pixels, natural dimensions. */
const previewData = (path: string): ImageData => ({
  path,
  src: "http://spica-img.localhost/preview/1920x1080/x",
  width: 5472,
  height: 3648,
  format: "jpeg",
  tier: "preview",
});

type ThumbnailEntry =
  | { base64: string; width: number; height: number }
  | "error";

const thumbEntry = (): ThumbnailEntry => ({
  base64: "AAA",
  width: 30,
  height: 20,
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
  cache: {
    preloaded: new Map<string, ImageData>(),
    thumbnails: new Map<string, ThumbnailEntry>(),
  },
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

// loadPreviewBitmap is the only export the scheduler uses (the viewer owns
// loadBitmapViaProtocol / retainElementAsBitmap).
vi.mock("../../utils/bitmapLoader", () => ({
  loadPreviewBitmap: vi.fn(),
}));

vi.mock("../../utils/previewBox", () => ({
  currentPreviewBox: () => "1920x1080",
}));

import { loadPreviewBitmap } from "../../utils/bitmapLoader";
import { useImagePreloader } from "../useImagePreloader";

const mockLoad = vi.mocked(loadPreviewBitmap);

const loadedPaths = () => mockLoad.mock.calls.map((c) => c[0]);

/** jsdom's innerWidth is fixed; the visible radius is derived from it. */
const setInnerWidth = (width: number) => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
};

/** Invariant I1: a non-"error" thumbnail entry ⇒ the preview is on disk. */
const allThumbnails = () =>
  new Map<string, ThumbnailEntry>(
    mockStore.folder.images.map((info) => [info.path, thumbEntry()]),
  );

/** Mirrors the store: every thumbnail write produces a NEW Map identity. */
const setThumbnail = (path: string, entry: ThumbnailEntry) => {
  mockStore.cache.thumbnails = new Map(mockStore.cache.thumbnails).set(
    path,
    entry,
  );
};

/** Configure the store as "index navigated to i, full-res displayed". */
const showFullRes = (index: number) => {
  mockStore.currentImage.index = index;
  mockStore.currentImage.path = mockStore.folder.images[index]?.path ?? "";
  mockStore.currentImage.data = previewData(mockStore.currentImage.path);
  mockStore.ui.thumbnailDisplayed = false;
};

/** Mirrors the hook's own resize debounce. */
const RESIZE_DEBOUNCE_MS = 200;

/**
 * Retain five ~169MB bitmaps (6500 * 6500 * 4) over {current} ∪ window at
 * index 0 — ~845MB against the 500MiB budget, so the guard must evict.
 */
const saturateBudget = () => {
  for (let i = 0; i <= 4; i++) {
    setBitmap(img(i), fakeBitmap(6500, 6500), "preview");
  }
};

const flush = async () => {
  // Drain chained load->settle->pump microtask rounds (launch, settle,
  // finally-pump, second launch, ...).
  await act(async () => {
    for (let i = 0; i < 16; i++) {
      await Promise.resolve();
    }
  });
};

describe("useImagePreloader (visible-range preview window)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearBitmaps();
    setInnerWidth(360); // radius 4 — small enough to reason about by hand
    mockStore.folder.path = "/test";
    mockStore.folder.images = Array.from({ length: 16 }, (_, i) =>
      imageInfo(i),
    );
    mockStore.currentImage.index = -1;
    mockStore.currentImage.path = "";
    mockStore.currentImage.data = null;
    mockStore.cache.preloaded = new Map();
    mockStore.cache.thumbnails = allThumbnails();
    mockStore.thumbnailGeneration.allGenerated = true;
    mockStore.ui.thumbnailDisplayed = false;
    mockLoad.mockImplementation(async (path: string) => ({
      data: previewData(path),
      bitmap: fakeBitmap(),
    }));
  });

  afterEach(() => {
    clearBitmaps();
    _setPerfEnabledForTests(null);
    window.__PERF__ = [];
  });

  it("launches window decodes immediately (no delay timer), capped at 3", () => {
    showFullRes(0);
    renderHook(() => useImagePreloader());
    // synchronous launch on mount: [1,2,3,4] capped at MAX_CONCURRENT_LOADS
    expect(loadedPaths()).toEqual([img(1), img(2), img(3)]);
    // ...through the preview route, at the session's screen box
    expect(mockLoad.mock.calls[0][1]).toBe("1920x1080");
  });

  it("fills interleaved by distance, direction first, capped at 3", () => {
    showFullRes(5);
    renderHook(() => useImagePreloader());
    // [+1, -1, +2, ...] so the strip stays covered on both sides of the
    // current image, never more than MAX_CONCURRENT_LOADS at a time
    expect(loadedPaths()).toEqual([img(6), img(4), img(7)]);
  });

  it("retains the whole visible radius on both sides at a wide window", () => {
    setInnerWidth(1920); // radius 23
    mockStore.folder.images = Array.from({ length: 48 }, (_, i) =>
      imageInfo(i),
    );
    mockStore.cache.thumbnails = allThumbnails();
    const ahead = fakeBitmap();
    const behind = fakeBitmap();
    const beyond = fakeBitmap();
    setBitmap(img(44), ahead, "preview"); // 20 ahead of index 24
    setBitmap(img(4), behind, "preview"); // 20 behind index 24
    setBitmap(img(0), beyond, "preview"); // 24 behind — outside the radius
    showFullRes(24);
    renderHook(() => useImagePreloader());
    expect(hasBitmap(img(44))).toBe(true);
    expect(hasBitmap(img(4))).toBe(true);
    expect(hasBitmap(img(0))).toBe(false);
    expect(beyond.close).toHaveBeenCalledOnce();
  });

  it("evicts what falls outside the visible radius, keeps what is inside", () => {
    const inside = fakeBitmap();
    const outside = fakeBitmap();
    setBitmap(img(12), inside, "preview"); // index 8 + 4 = last kept
    setBitmap(img(13), outside, "preview"); // index 8 + 5 = out of range
    showFullRes(8); // radius 4 -> window [9..12, 7..4]
    renderHook(() => useImagePreloader());
    expect(hasBitmap(img(12))).toBe(true);
    expect(hasBitmap(img(13))).toBe(false);
    expect(outside.close).toHaveBeenCalledOnce();
  });

  it("pumps the next target when a slot frees, and caches + reports results", async () => {
    _setPerfEnabledForTests(true);
    showFullRes(0);
    renderHook(() => useImagePreloader());
    await flush();
    expect(loadedPaths()).toContain(img(4));
    expect(hasBitmap(img(1), "preview")).toBe(true);
    expect(hasBitmap(img(1), "full")).toBe(false);
    expect(mockStore.setPreloadedImage).toHaveBeenCalledWith(
      img(1),
      previewData(img(1)),
    );
    const done = (window.__PERF__ ?? []).filter(
      (e) => e.name === "preload:done",
    );
    expect(done.map((e) => e.detail?.path)).toContain(img(1));
    expect(done.find((e) => e.detail?.path === img(1))?.detail?.tier).toBe(
      "preview",
    );
  });

  it("does not load a path that has no thumbnail entry yet", () => {
    // I1 runs one way only: no thumbnail entry means no preview on disk, and
    // letting the protocol self-heal would double-decode against the
    // thumbnail generator.
    mockStore.cache.thumbnails = new Map([[img(2), thumbEntry()]]);
    showFullRes(0);
    renderHook(() => useImagePreloader());
    expect(loadedPaths()).toEqual([img(2)]);
  });

  it("starts the load as soon as the thumbnail entry appears", () => {
    mockStore.cache.thumbnails = new Map();
    showFullRes(0);
    const { rerender } = renderHook(() => useImagePreloader());
    expect(mockLoad).not.toHaveBeenCalled();
    setThumbnail(img(1), thumbEntry());
    rerender();
    expect(loadedPaths()).toEqual([img(1)]);
  });

  it("skips paths whose thumbnail entry is an error", () => {
    setThumbnail(img(1), "error");
    showFullRes(0);
    renderHook(() => useImagePreloader());
    expect(loadedPaths()).toEqual([img(2), img(3), img(4)]);
  });

  it("does not start while a thumbnail placeholder is displayed", () => {
    showFullRes(0);
    mockStore.ui.thumbnailDisplayed = true;
    renderHook(() => useImagePreloader());
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("starts before all thumbnails are generated (per-path gate only)", () => {
    showFullRes(0);
    mockStore.thumbnailGeneration.allGenerated = false;
    renderHook(() => useImagePreloader());
    expect(loadedPaths()).toEqual([img(1), img(2), img(3)]);
  });

  it("prefers the backward neighbor first when navigating backward", async () => {
    showFullRes(8);
    const { rerender } = renderHook(() => useImagePreloader());
    await flush();
    mockLoad.mockClear();
    clearBitmaps();
    showFullRes(7); // 8 -> 7 = backward
    rerender();
    expect(mockLoad.mock.calls[0][0]).toBe(img(6));
  });

  it("skips GIFs", () => {
    mockStore.folder.images[1] = imageInfo(1, { format: "gif" });
    showFullRes(0);
    renderHook(() => useImagePreloader());
    expect(loadedPaths()).not.toContain(img(1));
  });

  it("evicts bitmap + preload entry when a path leaves the window", () => {
    const far = fakeBitmap();
    setBitmap(img(15), far, "preview");
    mockStore.cache.preloaded.set(img(15), previewData(img(15)));
    showFullRes(0);
    renderHook(() => useImagePreloader());
    expect(far.close).toHaveBeenCalledOnce();
    expect(hasBitmap(img(15))).toBe(false);
    expect(mockStore.removePreloadedImage).toHaveBeenCalledWith(img(15));
    expect(mockStore.cache.preloaded.has(img(15))).toBe(false);
  });

  it("drops a non-current full bitmap but keeps its preview and preload entry", () => {
    const preview = fakeBitmap();
    const full = fakeBitmap(5472, 3648);
    setBitmap(img(1), preview, "preview");
    setBitmap(img(1), full, "full"); // e.g. retained by the viewer on a visit
    mockStore.cache.preloaded.set(img(1), previewData(img(1)));
    showFullRes(0);
    renderHook(() => useImagePreloader());
    expect(full.close).toHaveBeenCalledOnce();
    expect(hasBitmap(img(1), "full")).toBe(false);
    expect(hasBitmap(img(1), "preview")).toBe(true);
    expect(preview.close).not.toHaveBeenCalled();
    // the preview still backs the entry, so the hit stays honest (I3)
    expect(mockStore.removePreloadedImage).not.toHaveBeenCalledWith(img(1));
    expect(mockStore.cache.preloaded.has(img(1))).toBe(true);
  });

  it("drops the preload entry when a full-only bitmap loses its last tier", () => {
    const full = fakeBitmap(5472, 3648);
    setBitmap(img(1), full, "full");
    mockStore.cache.preloaded.set(img(1), {
      ...previewData(img(1)),
      tier: "full",
    });
    showFullRes(0);
    renderHook(() => useImagePreloader());
    expect(hasBitmap(img(1))).toBe(false);
    expect(mockStore.removePreloadedImage).toHaveBeenCalledWith(img(1));
  });

  it("keeps the current image's full bitmap", () => {
    const full = fakeBitmap(5472, 3648);
    setBitmap(img(0), full, "full");
    showFullRes(0);
    renderHook(() => useImagePreloader());
    expect(full.close).not.toHaveBeenCalled();
    expect(hasBitmap(img(0), "full")).toBe(true);
  });

  it("does not re-fetch a preview the server served unscaled", async () => {
    // loadPreviewBitmap tags an unscaled preview "full" so the viewer skips
    // a redundant upgrade. If the scheduler retained it under the "full"
    // tier, the next pump's "full is current-only" sweep would drop it and
    // the fill phase would fetch it again, forever.
    mockLoad.mockImplementation(async (path: string) => ({
      data: { ...previewData(path), width: 800, height: 600, tier: "full" },
      bitmap: fakeBitmap(800, 600),
    }));
    showFullRes(0);
    renderHook(() => useImagePreloader());
    await flush();
    expect(loadedPaths().filter((p) => p === img(1))).toHaveLength(1);
    expect(hasBitmap(img(1), "preview")).toBe(true);
  });

  it("does not let a stale (superseded) load win over a fresh load for the same path", async () => {
    // bitmapLoader only passes the AbortSignal to fetch(); once the
    // response has arrived, abort() cannot stop blob()/createImageBitmap().
    // So: P's load starts (L1), P leaves the window (aborted + dropped from
    // pendingRef), P re-enters the window before L1 settles (fresh load
    // L2, new controller), then L1 finally resolves. L1 must lose: its
    // bitmap gets close()'d and discarded, and it must not evict L2's
    // pending-map entry. L2 must still win when it resolves afterward.
    type Deferred = {
      promise: Promise<{ data: ImageData; bitmap: ImageBitmap }>;
      resolve: (v: { data: ImageData; bitmap: ImageBitmap }) => void;
    };
    const makeDeferred = (): Deferred => {
      let resolve!: Deferred["resolve"];
      const promise = new Promise<{ data: ImageData; bitmap: ImageBitmap }>(
        (res) => {
          resolve = res;
        },
      );
      return { promise, resolve };
    };

    const target = img(1);
    const deferredCalls: Deferred[] = [];
    mockLoad.mockImplementation((path: string) => {
      if (path === target) {
        const deferred = makeDeferred();
        deferredCalls.push(deferred);
        return deferred.promise;
      }
      return Promise.resolve({ data: previewData(path), bitmap: fakeBitmap() });
    });

    showFullRes(0);
    const { rerender } = renderHook(() => useImagePreloader());
    // Initial window [1,2,3] (capped at 3) launches L1 for the target path.
    expect(deferredCalls).toHaveLength(1);

    // P leaves the window: pump() aborts L1's controller and drops it from
    // pendingRef, but our deferred (standing in for an unstoppable
    // in-flight decode) stays unsettled.
    showFullRes(10);
    rerender();

    // P re-enters the window: pump() starts a fresh load (L2) for the same
    // path under a new controller.
    showFullRes(0);
    rerender();
    expect(deferredCalls).toHaveLength(2);

    // L1 (stale) resolves after L2 has already started.
    const staleBitmap = fakeBitmap();
    deferredCalls[0].resolve({
      data: previewData(target),
      bitmap: staleBitmap,
    });
    await flush();
    expect(staleBitmap.close).toHaveBeenCalledOnce();
    expect(getBitmap(target)).not.toBe(staleBitmap);

    // L2 (fresh) resolves; it must win — cached and reported.
    const freshBitmap = fakeBitmap();
    deferredCalls[1].resolve({
      data: previewData(target),
      bitmap: freshBitmap,
    });
    await flush();
    expect(getBitmap(target)).toBe(freshBitmap);
    expect(mockStore.setPreloadedImage).toHaveBeenCalledWith(
      target,
      previewData(target),
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
    expect(mockStore.setPreloadedImage).toHaveBeenCalledWith(img(1), {
      path: img(1),
      src: "",
      width: 0,
      height: 0,
      format: "error",
    });
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
    expect(getBitmap(img(1))).toBeDefined();
    mockStore.folder.path = "/other";
    rerender();
    expect(getBitmap(img(1))).toBeUndefined();
  });

  it("runs eviction while the fill phase is gated, launching no loads", () => {
    // Regression: eviction/budget enforcement must never be skippable, even
    // while the current image is still showing its thumbnail placeholder.
    // retainElementAsBitmap retains unconditionally, so maintenance must too.
    const far = fakeBitmap();
    setBitmap(img(15), far, "preview");
    mockStore.cache.preloaded.set(img(15), previewData(img(15)));
    showFullRes(0);
    mockStore.ui.thumbnailDisplayed = true; // gate the fill phase
    renderHook(() => useImagePreloader());
    expect(far.close).toHaveBeenCalledOnce();
    expect(hasBitmap(img(15))).toBe(false);
    expect(mockStore.removePreloadedImage).toHaveBeenCalledWith(img(15));
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("enforces the byte budget by evicting farthest-first, keeping the current bitmap", () => {
    // ~169MB per bitmap (6500 * 6500 * 4 bytes); 5 of them (current + the
    // radius-4 window for index 0) total ~805MB, over the 500MB budget.
    const bigBitmap = () => fakeBitmap(6500, 6500);
    const current = bigBitmap();
    const b1 = bigBitmap();
    const b2 = bigBitmap();
    const b3 = bigBitmap();
    const b4 = bigBitmap();
    setBitmap(img(0), current, "preview");
    setBitmap(img(1), b1, "preview");
    setBitmap(img(2), b2, "preview");
    setBitmap(img(3), b3, "preview");
    setBitmap(img(4), b4, "preview");

    showFullRes(0); // window (direction +1) = [1, 2, 3, 4], farthest = 4
    renderHook(() => useImagePreloader());

    expect(b4.close).toHaveBeenCalledOnce();
    expect(b3.close).toHaveBeenCalledOnce();
    expect(hasBitmap(img(4))).toBe(false);
    expect(hasBitmap(img(3))).toBe(false);
    expect(b1.close).not.toHaveBeenCalled();
    expect(b2.close).not.toHaveBeenCalled();
    expect(current.close).not.toHaveBeenCalled();
    expect(hasBitmap(img(1))).toBe(true);
    expect(hasBitmap(img(2))).toBe(true);
    expect(hasBitmap(img(0))).toBe(true);
    // ...and no refill of what the budget just displaced: the window is
    // worth more than the budget, so loading img(3)/img(4) again would only
    // evict img(2), and every completion pumps — an endless evict/refetch
    // cycle for any window wider than the budget (radius 31 at a 2560 box
    // already asks for ~900MB).
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("does not refill on later pumps while the budget stays saturated", () => {
    // cache.thumbnails is an effect dependency, so a large folder pumps
    // once per generated thumbnail. Those pumps evict nothing (the budget
    // guard already brought the retained set under the line) but would
    // happily refetch the tail it displaced — hundreds of round trips
    // competing with the generator, and an oscillating preloadedCount.
    saturateBudget();
    showFullRes(0);
    const { rerender } = renderHook(() => useImagePreloader());
    expect(mockLoad).not.toHaveBeenCalled();
    expect(hasBitmap(img(3))).toBe(false); // displaced by the budget guard

    setThumbnail(img(5), thumbEntry()); // external pump: a thumbnail landed
    rerender();
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("refills once an index change re-tests the budget", () => {
    saturateBudget();
    showFullRes(0);
    const { rerender } = renderHook(() => useImagePreloader());
    expect(mockLoad).not.toHaveBeenCalled();

    showFullRes(1); // the window moved: its demand is a different question
    rerender();
    expect(mockLoad).toHaveBeenCalled();
  });

  it("refills once a resize re-tests the budget", () => {
    vi.useFakeTimers();
    try {
      saturateBudget();
      showFullRes(0);
      renderHook(() => useImagePreloader());
      expect(mockLoad).not.toHaveBeenCalled();

      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
      act(() => {
        vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
      });
      expect(mockLoad).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sweeps bitmap-less preload entries (error and plain) outside the window", () => {
    // Eviction historically only walked bitmapPaths(), so preload entries
    // with no bitmap (permanent error entries, stale entries surviving a
    // folder switch) were invisible to it and never left cache.preloaded.
    mockStore.cache.preloaded.set(img(14), {
      path: img(14),
      src: "",
      width: 0,
      height: 0,
      format: "error",
    });
    mockStore.cache.preloaded.set(img(15), previewData(img(15)));
    expect(hasBitmap(img(14))).toBe(false);
    expect(hasBitmap(img(15))).toBe(false);

    showFullRes(0);
    renderHook(() => useImagePreloader());

    expect(mockStore.removePreloadedImage).toHaveBeenCalledWith(img(14));
    expect(mockStore.removePreloadedImage).toHaveBeenCalledWith(img(15));
    expect(mockStore.cache.preloaded.has(img(14))).toBe(false);
    expect(mockStore.cache.preloaded.has(img(15))).toBe(false);
  });

  it("re-pumps on resize so the radius follows the window width", () => {
    vi.useFakeTimers();
    try {
      setInnerWidth(1920); // radius 23 — image14 is inside the window
      const stale = fakeBitmap();
      setBitmap(img(14), stale, "preview");
      showFullRes(0);
      renderHook(() => useImagePreloader());
      expect(hasBitmap(img(14))).toBe(true);

      setInnerWidth(200); // radius 4 — image14 now falls outside
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
      act(() => {
        vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS - 1);
      });
      expect(hasBitmap(img(14))).toBe(true); // still debouncing
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(hasBitmap(img(14))).toBe(false);
      expect(stale.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
