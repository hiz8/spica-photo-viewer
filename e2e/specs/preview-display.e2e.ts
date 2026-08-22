import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browser, expect } from "@wdio/globals";

// import.meta.dirname is not reliably populated by wdio's TS loader, so derive
// it from import.meta.url (same as the other specs).
const here = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(here, "../fixtures/corpus");

/**
 * Preview-display gate (design spec 2026-08-21 §6.4-6.6, Phase 3).
 *
 * Exercises the display-resolution preview tier end to end: a preload hit
 * inside the visible-range window paints the preview (not a placeholder),
 * zooming past the preview's pixel density upgrades to the full-resolution
 * decode, navigating back inside the visible range never re-shows a
 * placeholder, and a preview that is on disk but not yet decoded (a "preview
 * miss") still resolves to the preview tier quickly. The four cases share
 * one browser session and run in order - (b) continues from (a), and (c)/(d)
 * depend on the window state (a)/(b) leave behind.
 */

/** |displayed center - viewer-area center| tolerance, in CSS px (centering.e2e.ts). */
const CENTER_TOLERANCE_PX = 2;

/** Fallback thumbnail-bar height when the bar isn't mounted (centering.e2e.ts). */
const THUMBNAIL_BAR_HEIGHT = 80;

type PerfEntry = {
  type: string;
  name: string;
  ts: number;
  detail?: Record<string, unknown>;
};

const largeFiles = (): string[] =>
  readdirSync(join(CORPUS, "large"))
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .map((f) => join(CORPUS, "large", f));

const openImage = (path: string): Promise<void> =>
  browser.execute((p: string) => {
    // openImage() resolves on folder scan, not on paint; never await it.
    void window.__SPICA_TEST__?.openImage(p);
  }, path);

const navigateToImage = (index: number): Promise<void> =>
  browser.execute((i: number) => {
    window.__SPICA_TEST__?.navigateToImage(i);
  }, index);

const getPerf = (): Promise<PerfEntry[]> =>
  browser.execute(() => window.__PERF__ ?? []);

const clearPerf = (): Promise<void> =>
  browser.execute(() => {
    window.__SPICA_TEST__?.clearPerf();
  });

const getStatus = () =>
  browser.execute(() => window.__SPICA_TEST__?.getStatus());

const evictDecoded = (): Promise<
  { evictedBitmaps: number; evictedPreloaded: number } | undefined
> => browser.execute(() => window.__SPICA_TEST__?.evictDecoded());

const zoomIn = (): Promise<void> =>
  browser.execute(() => {
    window.__SPICA_TEST__?.zoomIn();
  });

const resetZoom = (): Promise<void> =>
  browser.execute(() => {
    window.__SPICA_TEST__?.resetZoom();
  });

/** Waits until `path` has a retained bitmap (any tier) per getStatus(). */
const waitForRetainedBitmap = async (
  path: string,
  timeout = 60_000,
): Promise<void> => {
  await browser.waitUntil(
    async () => {
      const status = await getStatus();
      return status?.bitmapPaths.includes(path);
    },
    { timeout, timeoutMsg: `bitmap for ${path} was never retained` },
  );
};

/** Wait until a non-placeholder paint:done exists for `path`, then return the buffer. */
const waitForNonThumbnailPaint = async (
  path: string,
  timeout = 60_000,
): Promise<PerfEntry[]> => {
  await browser.waitUntil(
    () =>
      browser.execute(
        (p: string) =>
          (window.__PERF__ ?? []).some(
            (e) =>
              e.name === "paint:done" &&
              e.detail?.path === p &&
              e.detail?.thumbnail === false,
          ),
        path,
      ),
    {
      timeout,
      interval: 100,
      timeoutMsg: `no non-thumbnail paint:done for ${path} within ${timeout}ms`,
    },
  );
  return getPerf();
};

/** paint:done entries for `path`, in the order they were recorded. */
const paintsFor = (entries: PerfEntry[], path: string): PerfEntry[] =>
  entries
    .filter((e) => e.name === "paint:done" && e.detail?.path === path)
    .sort((a, b) => a.ts - b.ts);

/** open:request -> the first non-thumbnail paint:done for `path`, in ms. */
const openToNonThumbnailPaint = (
  entries: PerfEntry[],
  path: string,
): number => {
  const open = entries.find(
    (e) => e.name === "open:request" && e.detail?.path === path,
  );
  const paint = paintsFor(entries, path).find(
    (e) => e.detail?.thumbnail === false,
  );
  if (!open || !paint) {
    throw new Error(
      `incomplete marks for ${path} (open=${!!open} paint=${!!paint})`,
    );
  }
  return paint.ts - open.ts;
};

/** Measures the mounted <canvas>'s placement/tier/backing. Runs in the page. */
const measureCanvas = (): Promise<{
  tier: string;
  naturalWidth: string;
  naturalHeight: string;
  backingWidth: number;
  backingHeight: number;
  /** offset of the rect's center from the viewer-area center, in CSS px. */
  dx: number;
  dy: number;
} | null> =>
  browser.execute((fallbackBarHeight: number) => {
    const el = document.querySelector(".image-viewer canvas");
    if (!(el instanceof HTMLCanvasElement)) return null;
    const rect = el.getBoundingClientRect();
    const bar = document.querySelector(".thumbnail-bar");
    const barHeight = bar
      ? bar.getBoundingClientRect().height
      : fallbackBarHeight;
    const containerWidth = window.innerWidth;
    const containerHeight = window.innerHeight - barHeight;
    return {
      tier: el.dataset.tier ?? "",
      naturalWidth: el.dataset.naturalWidth ?? "",
      naturalHeight: el.dataset.naturalHeight ?? "",
      backingWidth: el.width,
      backingHeight: el.height,
      dx: rect.left + rect.width / 2 - containerWidth / 2,
      dy: rect.top + rect.height / 2 - containerHeight / 2,
    };
  }, THUMBNAIL_BAR_HEIGHT);

describe("preview display gate", () => {
  it("preload hit inside the visible window paints the preview tier, not a placeholder", async function () {
    this.timeout(120_000);
    const files = largeFiles();

    await openImage(files[1]); // img-001.jpg
    await waitForRetainedBitmap(files[3]); // img-003.jpg, filled by the visible-range scheduler
    await browser.waitUntil(
      async () => {
        const status = await getStatus();
        return status !== undefined && !status.isLoading;
      },
      { timeout: 30_000, timeoutMsg: "still loading after the window filled" },
    );

    await clearPerf();
    await navigateToImage(3);
    const entries = await waitForNonThumbnailPaint(files[3]);

    // No placeholder paint was ever recorded for this navigation.
    const placeholderPaints = paintsFor(entries, files[3]).filter(
      (e) => e.detail?.thumbnail === true,
    );
    expect(placeholderPaints).toEqual([]);

    const canvas = await measureCanvas();
    expect(canvas).not.toBeNull();
    if (!canvas) return;
    expect(canvas.tier).toBe("preview");
    expect(canvas.naturalWidth).toBe("5472");
    expect(canvas.naturalHeight).toBe("3648");
    expect(canvas.backingWidth).toBeLessThan(5472);
    expect(
      Math.abs(canvas.backingWidth / canvas.backingHeight - 5472 / 3648),
    ).toBeLessThan(0.01);
    expect(Math.abs(canvas.dx)).toBeLessThanOrEqual(CENTER_TOLERANCE_PX);
    expect(Math.abs(canvas.dy)).toBeLessThanOrEqual(CENTER_TOLERANCE_PX);
  });

  it("zoom upgrades the preview to the full-resolution decode", async function () {
    this.timeout(30_000);
    const files = largeFiles();

    await clearPerf();
    await zoomIn();
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const canvas = document.querySelector(".image-viewer canvas");
          return (
            canvas instanceof HTMLCanvasElement &&
            canvas.dataset.tier === "full" &&
            canvas.width === 5472
          );
        }),
      {
        timeout: 15_000,
        timeoutMsg: "zoom never upgraded img-003 to the full-resolution decode",
      },
    );

    const entries = await getPerf();
    const zoomRequest = entries.find(
      (e) => e.name === "zoom:request" && e.detail?.path === files[3],
    );
    const fullPaint = paintsFor(entries, files[3]).find(
      (e) => e.detail?.tier === "full",
    );
    expect(zoomRequest).toBeDefined();
    expect(fullPaint).toBeDefined();
    if (zoomRequest && fullPaint) {
      expect(zoomRequest.ts).toBeLessThanOrEqual(fullPaint.ts);
    }

    await resetZoom();
  });

  it("backward navigation inside the visible window shows no placeholder", async function () {
    this.timeout(120_000);
    const files = largeFiles();

    await navigateToImage(12); // img-012.jpg
    await waitForNonThumbnailPaint(files[12]);
    // The window re-fills around the new current index; img-003's full-tier
    // bitmap (retained by the zoom test) is swept, but its preview survives
    // because it stays inside the visible range for this 16-image corpus.
    await waitForRetainedBitmap(files[3]);

    await clearPerf();
    await navigateToImage(3);
    const entries = await waitForNonThumbnailPaint(files[3]);

    const placeholderPaints = paintsFor(entries, files[3]).filter(
      (e) => e.detail?.thumbnail === true,
    );
    expect(placeholderPaints).toEqual([]);

    const firstPaint = paintsFor(entries, files[3])[0];
    expect(firstPaint?.detail?.tier).toBe("preview");
  });

  it("a preview on disk but not yet decoded still resolves to the preview tier quickly", async function () {
    this.timeout(60_000);
    const files = largeFiles();

    await evictDecoded();
    await clearPerf();
    await navigateToImage(7); // img-007.jpg
    const entries = await waitForNonThumbnailPaint(files[7]);

    const firstNonThumbnailPaint = paintsFor(entries, files[7]).find(
      (e) => e.detail?.thumbnail === false,
    );
    expect(firstNonThumbnailPaint?.detail?.tier).toBe("preview");

    // Generous: proves the path (disk fetch + ~a few-MP decode), not the
    // gate metric itself (that's the bench's job).
    expect(openToNonThumbnailPaint(entries, files[7])).toBeLessThan(400);

    const tag = await browser.execute(() => {
      const el = document.querySelector(
        ".image-viewer canvas, .image-viewer img",
      );
      return el?.tagName ?? null;
    });
    expect(tag).toBe("CANVAS");
  });
});
