import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browser, expect } from "@wdio/globals";

// import.meta.dirname is not reliably populated by wdio's TS loader, so derive
// it from import.meta.url (same as the other specs).
const here = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(here, "../fixtures/corpus");

/**
 * Centering gate.
 *
 * PROJECT_SPEC: the image is shown fit-to-window, centered in the viewer. The
 * viewer has two display elements that share one inline style - <img> on a
 * bitmap-cache miss (and for the thumbnail placeholder) and <canvas> on a hit -
 * so the placement of BOTH is asserted, for a landscape, a portrait and an
 * EXIF-rotated image. The visual gate only checks that something non-blank is
 * painted, which let an off-center <canvas> through (2026-08-21 report).
 */

/** |displayed center - viewer-area center| tolerance, in CSS px. */
const CENTER_TOLERANCE_PX = 2;

/**
 * The thumbnail bar is position: fixed over the bottom of the window and the
 * store centers the image in the area above it (THUMBNAIL_BAR_HEIGHT). The
 * bar's height is measured from the DOM when it is mounted; this is the
 * fallback for when it is not.
 */
const THUMBNAIL_BAR_HEIGHT = 80;

type DisplayTag = "IMG" | "CANVAS";

interface Size {
  w: number;
  h: number;
}

interface Placement {
  tag: DisplayTag;
  /**
   * Natural (orientation-applied, full-resolution) size, read from
   * data-natural-width/height. Falls back to naturalWidth/Height (<img>) or
   * width/height (<canvas> - which is only the true natural size on a MISS
   * or a full-tier hit; a preview canvas has a smaller backing) for builds
   * that predate the attributes.
   */
  natural: Size;
  /** data-tier ("thumbnail" | "preview" | "full"), "" when absent. */
  tier: string;
  rect: { left: number; top: number; width: number; height: number };
  /** Viewer area the image must be centered in. */
  container: { width: number; height: number };
  /** Computed `position`; diagnostic only (left/top need a positioned box). */
  position: string;
}

/** Measures whichever display element is mounted. Runs in the page. */
const measurePlacement = (): Promise<Placement | null> =>
  browser.execute((fallbackBarHeight: number) => {
    const el =
      document.querySelector(".image-viewer canvas") ??
      document.querySelector(".image-viewer img");
    if (
      !(el instanceof HTMLCanvasElement) &&
      !(el instanceof HTMLImageElement)
    ) {
      return null;
    }
    const rect = el.getBoundingClientRect();
    const bar = document.querySelector(".thumbnail-bar");
    const barHeight = bar
      ? bar.getBoundingClientRect().height
      : fallbackBarHeight;
    const naturalWidthAttr = el.dataset.naturalWidth;
    const naturalHeightAttr = el.dataset.naturalHeight;
    const natural =
      naturalWidthAttr !== undefined && naturalHeightAttr !== undefined
        ? { w: Number(naturalWidthAttr), h: Number(naturalHeightAttr) }
        : el instanceof HTMLCanvasElement
          ? { w: el.width, h: el.height }
          : { w: el.naturalWidth, h: el.naturalHeight };
    return {
      tag: el.tagName as "IMG" | "CANVAS",
      natural,
      tier: el.dataset.tier ?? "",
      rect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
      container: {
        width: window.innerWidth,
        height: window.innerHeight - barHeight,
      },
      position: getComputedStyle(el).position,
    };
  }, THUMBNAIL_BAR_HEIGHT);

const centerOffset = (p: Placement): { dx: number; dy: number } => ({
  dx: p.rect.left + p.rect.width / 2 - p.container.width / 2,
  dy: p.rect.top + p.rect.height / 2 - p.container.height / 2,
});

const isCentered = (p: Placement): boolean => {
  const { dx, dy } = centerOffset(p);
  return (
    Math.abs(dx) <= CENTER_TOLERANCE_PX && Math.abs(dy) <= CENTER_TOLERANCE_PX
  );
};

const fitsContainer = (p: Placement): boolean =>
  p.rect.left >= -1 &&
  p.rect.top >= -1 &&
  p.rect.left + p.rect.width <= p.container.width + 1 &&
  p.rect.top + p.rect.height <= p.container.height + 1;

/**
 * True when the expected tag displays the expected NATURAL size with a
 * non-placeholder tier - i.e. it is not the thumbnail fallback (which has a
 * smaller natural size in every corpus case here, but Phase 3 previews can
 * share the full-resolution natural size on the canvas backing, so the tier
 * check is what actually rules the placeholder out).
 */
const showsDisplayedImage = (
  p: Placement,
  tag: DisplayTag,
  natural: Size,
): boolean =>
  p.tag === tag &&
  p.natural.w === natural.w &&
  p.natural.h === natural.h &&
  p.tier !== "thumbnail" &&
  p.rect.width > 0;

/**
 * Polls the display element until `accept` holds or `timeout` elapses, and
 * returns the LAST measurement either way so the caller can assert on it with
 * the real numbers in the failure message.
 */
const observe = async (
  what: string,
  accept: (p: Placement) => boolean,
  timeout: number,
): Promise<Placement> => {
  const seen: { last: Placement | null } = { last: null };
  await browser
    .waitUntil(
      async () => {
        seen.last = await measurePlacement();
        return seen.last !== null && accept(seen.last);
      },
      { timeout, interval: 50 },
    )
    .catch(() => undefined);
  if (seen.last === null) {
    throw new Error(`${what}: no display element mounted in .image-viewer`);
  }
  return seen.last;
};

const expectCenteredFit = async (
  what: string,
  tag: DisplayTag,
  natural: Size,
): Promise<void> => {
  // Stage 1: the expected NATURAL size is displayed on the expected element
  // with a non-placeholder tier (the thumbnail fallback is skipped).
  await observe(what, (p) => showsDisplayedImage(p, tag, natural), 60_000);
  // Stage 2: the transform has a 0.1s transition, so let the placement settle
  // instead of sampling a single frame.
  const p = await observe(
    what,
    (q) =>
      showsDisplayedImage(q, tag, natural) && isCentered(q) && fitsContainer(q),
    3_000,
  );

  const problems: string[] = [];
  if (p.tag !== tag) {
    problems.push(
      `displayed by <${p.tag.toLowerCase()}>, expected <${tag.toLowerCase()}>`,
    );
  }
  if (p.natural.w !== natural.w || p.natural.h !== natural.h) {
    problems.push(
      `natural size ${p.natural.w}x${p.natural.h}, expected ${natural.w}x${natural.h}`,
    );
  }
  if (!isCentered(p)) {
    const { dx, dy } = centerOffset(p);
    problems.push(`off-center by (${dx.toFixed(1)}, ${dy.toFixed(1)})px`);
  }
  if (!fitsContainer(p)) {
    problems.push(
      `overflows the ${p.container.width}x${p.container.height} viewer area`,
    );
  }
  if (problems.length > 0) {
    problems.push(`placement: ${JSON.stringify(p)}`);
  }
  expect(problems).toEqual([]);
};

const openImage = (path: string): Promise<void> =>
  browser.execute((p: string) => {
    // openImage() resolves on folder scan, not on paint; never await it.
    void window.__SPICA_TEST__?.openImage(p);
  }, path);

/**
 * A navigation paints via <canvas> only when the target's decoded bitmap is
 * retained. cache.preloaded is not a proxy for that: a viewer-loaded entry
 * survives a folder switch while its bitmap retention races the
 * folder-change clearBitmaps(), so wait for the bitmap itself.
 */
const waitForRetainedBitmap = async (path: string): Promise<void> => {
  await browser.waitUntil(
    async () =>
      browser.execute((p: string) => {
        const status = window.__SPICA_TEST__?.getStatus();
        return (
          status !== undefined &&
          !status.isLoading &&
          status.bitmapPaths.includes(p)
        );
      }, path),
    {
      timeout: 120_000,
      timeoutMsg: `bitmap for ${path} was never retained`,
    },
  );
};

interface CorpusCase {
  label: string;
  dir: string;
  /**
   * Opened fresh: rendered by <img>, because the decoded bitmap is retained
   * only after the image data is already displayed (and the element choice is
   * latched per data).
   */
  miss: { file: string; natural: Size };
  /**
   * `file` (at `index`) reached by navigating from `via` once the window
   * scheduler has retained its bitmap: rendered by <canvas>.
   */
  hit: { via: string; file: string; index: number; natural: Size };
}

const CASES: CorpusCase[] = [
  {
    label: "landscape",
    dir: "small",
    miss: { file: "img-000.jpg", natural: { w: 1024, h: 768 } },
    hit: {
      via: "img-000.jpg",
      file: "img-001.jpg",
      index: 1,
      natural: { w: 1024, h: 768 },
    },
  },
  {
    label: "portrait",
    dir: "portrait",
    miss: { file: "img-000.jpg", natural: { w: 1200, h: 1600 } },
    hit: {
      via: "img-000.jpg",
      file: "img-001.jpg",
      index: 1,
      natural: { w: 1200, h: 1600 },
    },
  },
  {
    // img-000 is encoded 1200x800 with orientation 6 and must display as
    // 800x1200 on both elements; img-001 is its plain companion.
    label: "exif-rotated",
    dir: "exif",
    miss: { file: "img-000.jpg", natural: { w: 800, h: 1200 } },
    hit: {
      via: "img-001.jpg",
      file: "img-000.jpg",
      index: 0,
      natural: { w: 800, h: 1200 },
    },
  },
];

describe("centering gate", () => {
  for (const c of CASES) {
    describe(c.label, () => {
      it("fresh open renders a centered fit-to-window <img>", async function () {
        this.timeout(120_000);
        await openImage(join(CORPUS, c.dir, c.miss.file));
        await expectCenteredFit(`${c.label} miss`, "IMG", c.miss.natural);
      });

      it("bitmap-cache hit renders a centered fit-to-window <canvas>", async function () {
        this.timeout(300_000);
        await openImage(join(CORPUS, c.dir, c.hit.via));
        await waitForRetainedBitmap(join(CORPUS, c.dir, c.hit.file));
        await browser.execute(
          (i: number) => window.__SPICA_TEST__?.navigateToImage(i),
          c.hit.index,
        );
        await expectCenteredFit(`${c.label} hit`, "CANVAS", c.hit.natural);
      });
    });
  }
});
