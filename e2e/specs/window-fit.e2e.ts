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

    await clickOutsideImage();
    await waitForClientWidth(before.rect.width);
    const after = await snapshot();

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
