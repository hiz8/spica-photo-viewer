import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browser, expect } from "@wdio/globals";
import sharp from "sharp";

// import.meta.dirname is not reliably populated depending on how wdio's TS
// loader evaluates spec files (see e2e/wdio.conf.ts), so derive it from
// import.meta.url instead, matching e2e/specs/smoke.e2e.ts.
const here = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(here, "../fixtures/corpus");
const SHOTS = join(here, "../screenshots");

describe("visual gate", () => {
  it("renders a large image without blank output", async () => {
    const files = readdirSync(join(CORPUS, "large")).sort();
    const target = join(CORPUS, "large", files[0]);

    await browser.execute((p: string) => {
      void window.__SPICA_TEST__?.openImage(p);
    }, target);
    // The viewer moves through display stages (thumbnail <img> -> full <img>
    // -> possibly a <canvas> swap once the decoded bitmap is retained), so a
    // "something visible" predicate can sample a transient stage. Wait for
    // the FULL-RESOLUTION pixels (5472 wide) on whichever element displays.
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const img = document.querySelector(".image-viewer img");
          if (
            img instanceof HTMLImageElement &&
            img.naturalWidth === 5472 &&
            img.getBoundingClientRect().width > 100
          ) {
            return true;
          }
          const canvas = document.querySelector(".image-viewer canvas");
          return (
            canvas instanceof HTMLCanvasElement &&
            canvas.width === 5472 &&
            canvas.getBoundingClientRect().width > 100
          );
        }),
      { timeout: 60000, timeoutMsg: "full-resolution image never displayed" },
    );

    mkdirSync(SHOTS, { recursive: true });
    const shot = join(SHOTS, "visual-large.png");
    await browser.saveScreenshot(shot);

    // A correctly rendered gradient corpus image has high pixel variance;
    // a blank/black/white window does not.
    const stats = await sharp(shot).stats();
    const maxStdev = Math.max(...stats.channels.map((c) => c.stdev));
    expect(maxStdev).toBeGreaterThan(15);
  });

  it("navigation keeps the image visible", async () => {
    await browser.execute(() => window.__SPICA_TEST__?.navigateNext());
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const img = document.querySelector(".image-viewer img");
          if (img instanceof HTMLImageElement && img.naturalWidth > 0)
            return true;
          const canvas = document.querySelector(".image-viewer canvas");
          return canvas instanceof HTMLCanvasElement && canvas.width > 0;
        }),
      {
        timeout: 60000,
        timeoutMsg: "no visible image or canvas after navigation",
      },
    );
  });

  it("applies EXIF orientation from original bytes", async () => {
    const exifPath = join(CORPUS, "exif", "img-000.jpg");
    await browser.execute(
      (p: string) => void window.__SPICA_TEST__?.openImage(p),
      exifPath,
    );
    // The viewer moves through display stages (unrotated thumbnail preview
    // -> full <img> -> possibly a <canvas> swap once the decoded bitmap is
    // retained). Sampling a transient stage flakes, so wait directly for the
    // full-resolution ORIENTED dimensions on whichever element displays:
    // encoded 1200x800 + orientation 6 must show as 800x1200. The wait
    // succeeding IS the EXIF assertion.
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const img = document.querySelector(".image-viewer img");
          if (
            img instanceof HTMLImageElement &&
            img.naturalWidth === 800 &&
            img.naturalHeight === 1200
          ) {
            return true;
          }
          const canvas = document.querySelector(".image-viewer canvas");
          return (
            canvas instanceof HTMLCanvasElement &&
            canvas.width === 800 &&
            canvas.height === 1200
          );
        }),
      {
        timeout: 60000,
        timeoutMsg: "oriented 800x1200 exif image never displayed",
      },
    );
  });

  it("applies EXIF orientation on the canvas hit path", async function () {
    this.timeout(180_000);
    // Open the plain companion; img-000 (orientation 6) becomes the window
    // neighbor and is decoded into the bitmap cache by the scheduler.
    const companion = join(CORPUS, "exif", "img-001.jpg");
    await browser.execute(
      (p: string) => void window.__SPICA_TEST__?.openImage(p),
      companion,
    );
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const status = window.__SPICA_TEST__?.getStatus();
          return (status?.preloadedCount ?? 0) >= 1 && !status?.isLoading;
        }),
      { timeout: 120_000, timeoutMsg: "exif neighbor was never preloaded" },
    );
    await browser.execute(() => window.__SPICA_TEST__?.navigateToImage(0));
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const canvas = document.querySelector(".image-viewer canvas");
          return canvas instanceof HTMLCanvasElement && canvas.width > 0;
        }),
      { timeout: 60_000, timeoutMsg: "hit navigation never painted a canvas" },
    );
    const dims = await browser.execute(() => {
      const canvas = document.querySelector(
        ".image-viewer canvas",
      ) as HTMLCanvasElement;
      return { w: canvas.width, h: canvas.height };
    });
    // encoded 1200x800 + orientation 6 -> createImageBitmap applies EXIF and
    // yields an 800x1200 bitmap, same as what <img> would display.
    expect(dims.w).toBe(800);
    expect(dims.h).toBe(1200);

    mkdirSync(SHOTS, { recursive: true });
    const shot = join(SHOTS, "visual-exif-canvas.png");
    await browser.saveScreenshot(shot);
    const stats = await sharp(shot).stats();
    const maxStdev = Math.max(...stats.channels.map((c) => c.stdev));
    expect(maxStdev).toBeGreaterThan(15);
  });
});
