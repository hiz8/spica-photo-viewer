import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browser, expect } from "@wdio/globals";

// import.meta.dirname is not reliably populated by wdio's TS loader, so derive
// it from import.meta.url (same as the other specs).
const here = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(here, "../fixtures/corpus");
const IMAGE = join(CORPUS, "small", "img-000.jpg");

/**
 * Pointer-anchored zoom gate.
 *
 * PROJECT_SPEC: "Mouse wheel on image: Zoom (cursor-based)" - the image point
 * under the pointer must not move, during the gesture as well as after it.
 * Two independent regressions are covered (docs/code-rationale.md#Z1):
 *
 *  - zooming about the VIEWER's centre instead of the image's transform
 *    origin. The two are half a thumbnail-bar apart, which walked the anchor
 *    `d * (1 - ratio)` per notch - +8px, then +17.6, +29.1 ... (2026-08-30
 *    report). Caught by the settled cases, which only move `zoom`.
 *  - a `scale() translate()` transform, whose per-function transition
 *    interpolation bulges the anchor out and back mid-flight, proportional to
 *    the pointer's distance from the origin (dx reached -108px over 8 rapid
 *    notches). Caught by the rapid case, which samples DURING the 0.1s
 *    transition.
 */

/**
 * |anchor displacement| tolerance, in CSS px. The anchored form holds the
 * point EXACTLY still - all three cases measure 0.00px (2026-08-30) - so the
 * 1px budget is headroom for device-pixel snapping of the composited layer,
 * not for real drift. The regressions this gate replaced measured +59.5px
 * (settled x5) and -108px (mid-flight).
 */
const ANCHOR_TOLERANCE_PX = 1;

interface Drift {
  /** Displacement of the anchored image point after notch `t`. */
  frames: { t: number; dx: number; dy: number }[];
}

/**
 * Wheels `notches` times at one fixed pointer position and reports where the
 * image point that started under the pointer ended up after each notch.
 *
 * The anchor is tracked as a FRACTION of the displayed element, so it needs no
 * knowledge of the store's pan/zoom units - only that a uniform scale keeps
 * `rect.left + fx * rect.width` on the same image pixel.
 */
const measureDrift = async (
  fx: number,
  fy: number,
  deltaY: number,
  notches: number,
  settleMs: number,
): Promise<Drift> =>
  // The in-page callback is async (the notch spacing has to be timed in the
  // page, not over the WebDriver round-trip), so execute() types as a nested
  // promise; awaiting it here flattens that back to Drift.
  await browser.execute(
    async (ax: number, ay: number, dy: number, n: number, settle: number) => {
      const el = (document.querySelector(".image-viewer canvas") ??
        document.querySelector(".image-viewer img")) as HTMLElement;
      const viewer = document.querySelector(".image-viewer") as HTMLElement;
      const before = el.getBoundingClientRect();
      // MouseEvent.clientX/Y are `long`: the constructor TRUNCATES a
      // fractional coordinate, so round first and derive the anchor fraction
      // from the rounded pointer. Skipping this leaves the anchor up to 1px
      // off the pointer, which then compounds like a real origin error
      // (1px * 1.2^n) and reads as a product bug.
      const x = Math.round(before.left + ax * before.width);
      const y = Math.round(before.top + ay * before.height);
      const fx = (x - before.left) / before.width;
      const fy = (y - before.top) / before.height;

      const frames: { t: number; dx: number; dy: number }[] = [];
      for (let i = 0; i < n; i++) {
        viewer.dispatchEvent(
          new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            deltaY: dy,
          }),
        );
        await new Promise((r) => setTimeout(r, settle));
        const now = el.getBoundingClientRect();
        frames.push({
          t: i + 1,
          dx: now.left + fx * now.width - x,
          dy: now.top + fy * now.height - y,
        });
      }
      return { frames };
    },
    fx,
    fy,
    deltaY,
    notches,
    settleMs,
  );

const worstFrame = (d: Drift) =>
  d.frames.reduce((a, b) =>
    Math.max(Math.abs(b.dx), Math.abs(b.dy)) >
    Math.max(Math.abs(a.dx), Math.abs(a.dy))
      ? b
      : a,
  );

const expectAnchored = (what: string, d: Drift): void => {
  const worst = worstFrame(d);
  const problems: string[] = [];
  if (
    Math.abs(worst.dx) > ANCHOR_TOLERANCE_PX ||
    Math.abs(worst.dy) > ANCHOR_TOLERANCE_PX
  ) {
    problems.push(
      `${what}: anchor moved by (${worst.dx.toFixed(2)}, ${worst.dy.toFixed(2)})px ` +
        `at notch ${worst.t}; frames: ${JSON.stringify(d.frames)}`,
    );
  }
  expect(problems).toEqual([]);
};

/** Off-centre on both axes: the wobble is proportional to that distance. */
const ANCHOR_FX = 0.12;
const ANCHOR_FY = 0.22;

const resetZoom = async (): Promise<void> => {
  await browser.execute(() => window.__SPICA_TEST__?.resetZoom());
  // Outlast the 0.1s transform transition so the next gesture starts settled.
  await browser.pause(400);
};

describe("pointer-anchored zoom gate", () => {
  before(async function () {
    this.timeout(180_000);
    await browser.execute((p: string) => {
      // openImage() resolves on folder scan, not on paint; never await it.
      void window.__SPICA_TEST__?.openImage(p);
    }, IMAGE);
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const s = window.__SPICA_TEST__?.getStatus();
          return !!s && s.hasData && !s.isLoading;
        }),
      { timeout: 120_000, timeoutMsg: "image never displayed" },
    );
    await browser.pause(1_000);
  });

  it("holds the pointed-at image point still while zooming in", async () => {
    await resetZoom();
    expectAnchored(
      "zoom in x5",
      await measureDrift(ANCHOR_FX, ANCHOR_FY, -100, 5, 250),
    );
  });

  it("holds the pointed-at image point still while zooming out", async () => {
    await resetZoom();
    expectAnchored(
      "zoom out x5",
      await measureDrift(ANCHOR_FX, ANCHOR_FY, 100, 5, 250),
    );
  });

  it("holds it still mid-transition during a rapid gesture", async () => {
    await resetZoom();
    expectAnchored(
      "rapid zoom in x8",
      await measureDrift(ANCHOR_FX, ANCHOR_FY, -100, 8, 16),
    );
  });
});
