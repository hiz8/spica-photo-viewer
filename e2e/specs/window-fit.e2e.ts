import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browser, expect } from "@wdio/globals";

// import.meta.dirname is not reliably populated by wdio's TS loader, so derive
// it from import.meta.url (same as the other specs).
const here = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(here, "../fixtures/corpus");

/**
 * Windowed-mode gate (PROJECT_SPEC "Click outside the image",
 * docs/code-rationale.md#W1).
 *
 * The click must leave the client area exactly on the displayed image, keep
 * the image where it was on screen, honor the 544px minimum width, and grow
 * past the screen for a zoomed-in image. Sizes are asserted through
 * innerWidth/innerHeight and the display element's rect; the on-screen
 * position through screenX/screenY, which WebView2 reports for its own
 * (client-area) window.
 */

const SIZE_TOLERANCE_PX = 1;
const POSITION_TOLERANCE_PX = 2;
const MIN_WINDOWED_WIDTH = 544;
/** Every image in the "small" corpus folder is 1024x768. */
const NATURAL_WIDTH = 1024;
/** Fixed bar the maximized layout centers above (src/utils/viewerLayout.ts). */
const THUMBNAIL_BAR_HEIGHT = 80;
/** Covers a slow restore; the resize itself completes within ~100ms. */
const FRAME_RECORD_BUDGET_MS = 3_000;

interface Snapshot {
  innerWidth: number;
  innerHeight: number;
  screenX: number;
  screenY: number;
  screenWidth: number;
  rect: { left: number; top: number; width: number; height: number };
  zoom: number;
  isMaximized: boolean;
  windowed: boolean;
}

/** Runs in the page. */
const snapshot = (): Promise<Snapshot> =>
  browser.execute(() => {
    const el =
      document.querySelector(".image-viewer canvas") ??
      document.querySelector(".image-viewer img");
    const r = el?.getBoundingClientRect();
    const view = window.__SPICA_TEST__?.getView();
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      screenX: window.screenX,
      screenY: window.screenY,
      screenWidth: window.screen.width,
      rect: {
        left: r?.left ?? Number.NaN,
        top: r?.top ?? Number.NaN,
        width: r?.width ?? Number.NaN,
        height: r?.height ?? Number.NaN,
      },
      zoom: view?.zoom ?? Number.NaN,
      isMaximized: view?.isMaximized ?? false,
      windowed: view?.windowed ?? false,
    };
  });

const openImage = (path: string): Promise<void> =>
  browser.execute((p: string) => {
    // openImage() resolves on folder scan, not on paint; never await it.
    void window.__SPICA_TEST__?.openImage(p);
  }, path);

/** Opening an image maximizes the window; wait for both that and a real paint. */
const waitForMaximizedPaint = async (): Promise<void> => {
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const status = window.__SPICA_TEST__?.getStatus();
        const view = window.__SPICA_TEST__?.getView();
        return (
          status !== undefined &&
          view !== undefined &&
          status.hasData &&
          !status.isLoading &&
          status.displayedTier !== "thumbnail" &&
          view.isMaximized &&
          !view.windowed
        );
      }),
    {
      timeout: 120_000,
      timeoutMsg: "image never painted in the maximized window",
    },
  );
};

/**
 * The viewer's click handler treats any target other than the display
 * element as "outside"; dispatching on the container is that case without
 * needing WebDriver pointer support.
 */
const clickOutsideImage = (): Promise<void> =>
  browser.execute(() => {
    document
      .querySelector(".image-viewer")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

/**
 * Every layout the WebView passes through on the way to the final size fires
 * a resize event; a resize-to-image must not visit any other geometry (W1).
 */
const recordResizes = (): Promise<void> =>
  browser.execute(() => {
    const w = window as Window & { __RESIZES__?: [number, number][] };
    w.__RESIZES__ = [];
    window.addEventListener("resize", () => {
      w.__RESIZES__?.push([window.innerWidth, window.innerHeight]);
    });
  });

// Serialized in the page: wdio widens returned tuple types with Element
// members, which does not type-check against [number, number][].
const recordedResizes = async (): Promise<[number, number][]> =>
  JSON.parse(
    await browser.execute(() =>
      JSON.stringify(
        (window as Window & { __RESIZES__?: [number, number][] }).__RESIZES__ ??
          [],
      ),
    ),
  );

const waitForClientWidth = async (expected: number): Promise<void> => {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (w: number, tol: number) =>
          window.__SPICA_TEST__?.getView().windowed === true &&
          Math.abs(window.innerWidth - w) <= tol,
        expected,
        SIZE_TOLERANCE_PX,
      ),
    {
      timeout: 15_000,
      timeoutMsg: `window never reached client width ${expected}`,
    },
  );
  // Let the resize event's re-layout settle before measuring.
  await browser.pause(300);
};

const zoomUntil = async (
  step: "zoomIn" | "zoomOut",
  done: (zoom: number) => boolean,
): Promise<void> => {
  for (let i = 0; i < 20; i++) {
    const zoom = await browser.execute(() => {
      const view = window.__SPICA_TEST__?.getView();
      return view?.zoom ?? Number.NaN;
    });
    if (done(zoom)) return;
    await browser.execute((s: "zoomIn" | "zoomOut") => {
      window.__SPICA_TEST__?.[s]();
    }, step);
  }
  throw new Error(`zoom target not reached by ${step}`);
};

/** The 0.1s transform transition must finish before the rect is read. */
const waitForZoomToSettle = async (): Promise<void> => {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (naturalWidth: number, tol: number) => {
          const el =
            document.querySelector(".image-viewer canvas") ??
            document.querySelector(".image-viewer img");
          const zoom = window.__SPICA_TEST__?.getView().zoom ?? Number.NaN;
          return (
            el !== null &&
            Math.abs(
              el.getBoundingClientRect().width - (naturalWidth * zoom) / 100,
            ) <= tol
          );
        },
        NATURAL_WIDTH,
        SIZE_TOLERANCE_PX,
      ),
    { timeout: 5_000, timeoutMsg: "zoom transition never settled" },
  );
};

/**
 * A pan is applied through the same 0.1s transform transition; wait until
 * the rect sits at the panned position (maximized layout: centered above the
 * bar, then offset by the pan).
 */
const waitForPanToSettle = async (
  panX: number,
  panY: number,
): Promise<void> => {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (px: number, py: number, barHeight: number, tol: number) => {
          const el =
            document.querySelector(".image-viewer canvas") ??
            document.querySelector(".image-viewer img");
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const expectedLeft = window.innerWidth / 2 + px - r.width / 2;
          const expectedTop =
            (window.innerHeight - barHeight) / 2 + py - r.height / 2;
          return (
            Math.abs(r.left - expectedLeft) <= tol &&
            Math.abs(r.top - expectedTop) <= tol
          );
        },
        panX,
        panY,
        THUMBNAIL_BAR_HEIGHT,
        SIZE_TOLERANCE_PX,
      ),
    { timeout: 5_000, timeoutMsg: "pan transition never settled" },
  );
};

interface FrameSample {
  innerWidth: number;
  left: number;
  top: number;
}

/**
 * Samples the display element's rect on every animation frame. A frame is
 * the finest visible unit, so "the image never moves while the window
 * changes" is asserted on these rather than on the settled state.
 */
const recordFrames = (): Promise<void> =>
  browser.execute((budgetMs: number) => {
    const w = window as Window & { __FRAMES__?: FrameSample[] };
    w.__FRAMES__ = [];
    // Time-based rather than a frame count so a high-refresh display or a
    // slow restore cannot end the recording before the window has resized.
    const until = performance.now() + budgetMs;
    const tick = () => {
      const el =
        document.querySelector(".image-viewer canvas") ??
        document.querySelector(".image-viewer img");
      const r = el?.getBoundingClientRect();
      w.__FRAMES__?.push({
        innerWidth: window.innerWidth,
        left: r?.left ?? Number.NaN,
        top: r?.top ?? Number.NaN,
      });
      if (performance.now() < until) {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  }, FRAME_RECORD_BUDGET_MS);

const recordedFrames = async (): Promise<FrameSample[]> =>
  JSON.parse(
    await browser.execute(() =>
      JSON.stringify(
        (window as Window & { __FRAMES__?: FrameSample[] }).__FRAMES__ ?? [],
      ),
    ),
  );

/**
 * Frames between the window reaching its final width and the image reaching
 * its final place. The resize event re-lays out within the same frame, so
 * anything beyond a couple of frames is an animation the user can see.
 */
const MAX_SETTLE_FRAMES = 2;

const expectImageSettledWithWindow = (
  frames: FrameSample[],
  finalWidth: number,
  finalLeft: number,
  finalTop: number,
) => {
  const resized = frames.findIndex(
    (f) => Math.abs(f.innerWidth - finalWidth) <= SIZE_TOLERANCE_PX,
  );
  if (resized < 0) {
    throw new Error(
      `window never reached width ${finalWidth} within the ${FRAME_RECORD_BUDGET_MS}ms frame recording (${frames.length} frames)`,
    );
  }
  const settled = frames.findIndex(
    (f, i) =>
      i >= resized &&
      Math.abs(f.left - finalLeft) <= SIZE_TOLERANCE_PX &&
      Math.abs(f.top - finalTop) <= SIZE_TOLERANCE_PX,
  );
  expect(settled).toBeGreaterThanOrEqual(0);
  const settleFrames = settled - resized;
  if (settleFrames > MAX_SETTLE_FRAMES) {
    const path = frames
      .slice(resized, settled + 1)
      .map((f) => `(${f.left.toFixed(1)}, ${f.top.toFixed(1)})`)
      .join(" -> ");
    throw new Error(
      `image took ${settleFrames} frames to settle after the window resized (max ${MAX_SETTLE_FRAMES}): ${path}`,
    );
  }
};

const expectSameScreenPosition = (before: Snapshot, after: Snapshot) => {
  expect(
    Math.abs(
      after.screenX + after.rect.left - (before.screenX + before.rect.left),
    ),
  ).toBeLessThanOrEqual(POSITION_TOLERANCE_PX);
  expect(
    Math.abs(
      after.screenY + after.rect.top - (before.screenY + before.rect.top),
    ),
  ).toBeLessThanOrEqual(POSITION_TOLERANCE_PX);
};

describe("windowed mode gate", () => {
  it("shrinks the client area onto the displayed image without moving it", async function () {
    this.timeout(180_000);
    // 1024x768 fits a maximized window at 100%, so the displayed rect is the
    // natural size and well above the minimum width.
    await openImage(join(CORPUS, "small", "img-000.jpg"));
    await waitForMaximizedPaint();
    const before = await snapshot();
    await recordResizes();

    await clickOutsideImage();
    await waitForClientWidth(before.rect.width);
    const after = await snapshot();

    const intermediate = (await recordedResizes()).filter(
      ([w, h]) =>
        Math.abs(w - after.innerWidth) > SIZE_TOLERANCE_PX ||
        Math.abs(h - after.innerHeight) > SIZE_TOLERANCE_PX,
    );
    expect(intermediate).toEqual([]);
    expect(after.isMaximized).toBe(false);
    expect(after.zoom).toBe(before.zoom);
    expect(Math.abs(after.innerWidth - before.rect.width)).toBeLessThanOrEqual(
      SIZE_TOLERANCE_PX,
    );
    expect(
      Math.abs(after.innerHeight - before.rect.height),
    ).toBeLessThanOrEqual(SIZE_TOLERANCE_PX);
    // The image fills the client area from its top-left corner.
    expect(Math.abs(after.rect.left)).toBeLessThanOrEqual(SIZE_TOLERANCE_PX);
    expect(Math.abs(after.rect.top)).toBeLessThanOrEqual(SIZE_TOLERANCE_PX);
    expectSameScreenPosition(before, after);
  });

  it("keeps the 544px minimum width and centers a small image at its zoom", async function () {
    this.timeout(180_000);
    // A different path re-maximizes (same-path reopen is a no-op).
    await openImage(join(CORPUS, "small", "img-001.jpg"));
    await waitForMaximizedPaint();
    await zoomUntil("zoomOut", (zoom) => zoom < 50);
    await waitForZoomToSettle();
    const before = await snapshot();
    expect(before.rect.width).toBeLessThan(MIN_WINDOWED_WIDTH);
    const expectedHeight = Math.round(
      (MIN_WINDOWED_WIDTH * before.rect.height) / before.rect.width,
    );

    await clickOutsideImage();
    await waitForClientWidth(MIN_WINDOWED_WIDTH);
    const after = await snapshot();

    expect(after.zoom).toBe(before.zoom);
    expect(after.innerWidth).toBe(MIN_WINDOWED_WIDTH);
    expect(Math.abs(after.innerHeight - expectedHeight)).toBeLessThanOrEqual(
      SIZE_TOLERANCE_PX,
    );
    expect(
      Math.abs(after.rect.left - (after.innerWidth - after.rect.width) / 2),
    ).toBeLessThanOrEqual(SIZE_TOLERANCE_PX);
    expect(
      Math.abs(after.rect.top - (after.innerHeight - after.rect.height) / 2),
    ).toBeLessThanOrEqual(SIZE_TOLERANCE_PX);
    expectSameScreenPosition(before, after);
  });

  it("keeps a dragged image still while the window changes around it", async function () {
    this.timeout(180_000);
    // Zoomed out and dragged to the left: the pan must be folded into the
    // final layout in the same frame as the resize, not animated away.
    await openImage(join(CORPUS, "small", "img-002.jpg"));
    await waitForMaximizedPaint();
    await zoomUntil("zoomOut", (zoom) => zoom < 60);
    await browser.execute(() => {
      window.__SPICA_TEST__?.setPan(-300, 40);
    });
    await waitForZoomToSettle();
    await waitForPanToSettle(-300, 40);
    const before = await snapshot();
    await recordFrames();

    await clickOutsideImage();
    await waitForClientWidth(
      Math.max(MIN_WINDOWED_WIDTH, Math.round(before.rect.width)),
    );
    const after = await snapshot();
    const frames = await recordedFrames();

    expectSameScreenPosition(before, after);
    expectImageSettledWithWindow(
      frames,
      after.innerWidth,
      (after.innerWidth - after.rect.width) / 2,
      (after.innerHeight - after.rect.height) / 2,
    );
  });

  it("grows past the screen when the image is zoomed beyond it", async function () {
    this.timeout(180_000);
    await openImage(join(CORPUS, "small", "img-000.jpg"));
    await waitForMaximizedPaint();
    const { screenWidth } = await snapshot();
    await zoomUntil(
      "zoomIn",
      (zoom) => (NATURAL_WIDTH * zoom) / 100 > screenWidth + 100,
    );
    await waitForZoomToSettle();
    const before = await snapshot();

    // The image covers the whole viewport, so there is no background to
    // click; drive the same store action the click handler calls.
    await browser.execute(() => {
      void window.__SPICA_TEST__?.resizeToImage();
    });
    await waitForClientWidth(before.rect.width);
    const after = await snapshot();

    expect(after.innerWidth).toBeGreaterThan(screenWidth);
    expect(
      Math.abs(after.innerHeight - before.rect.height),
    ).toBeLessThanOrEqual(SIZE_TOLERANCE_PX);
    expectSameScreenPosition(before, after);
  });
});
