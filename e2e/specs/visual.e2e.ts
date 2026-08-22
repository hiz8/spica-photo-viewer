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
    // The viewer moves through display stages (thumbnail <img> -> preview or
    // full <img> -> possibly a <canvas> swap once the decoded bitmap is
    // retained), so a "something visible" predicate can sample a transient
    // stage. Wait for the NATURAL size (5472 wide, from data-natural-width)
    // on whichever element displays, with a non-thumbnail tier - the canvas
    // backing itself may only be a smaller preview.
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const el =
            document.querySelector(".image-viewer img") ??
            document.querySelector(".image-viewer canvas");
          return (
            (el instanceof HTMLImageElement ||
              el instanceof HTMLCanvasElement) &&
            el.dataset.naturalWidth === "5472" &&
            el.dataset.tier !== "thumbnail" &&
            el.getBoundingClientRect().width > 100
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

  it("thumbnail slots draw no button chrome (transparent background and border)", async () => {
    // .thumbnail-item is a <button>. The UA stylesheet paints ButtonFace
    // behind a button unless the author sets a background, and that colour
    // also shows through the 2px transparent border (background-clip is
    // border-box). A thumbnail that is not generated yet must be blank
    // (Picasa-style) and a loaded one must not get a light rim, so every
    // non-active, non-error, non-hovered slot has to compute to a fully
    // transparent background and border - whether or not its <img> has
    // arrived yet (the rule sits on the button, not on its content).
    const readSlots = () =>
      browser.execute(() => {
        const slots = Array.from(
          document.querySelectorAll(
            ".thumbnail-item:not(.active):not(.error):not(:hover)",
          ),
        ).map((el) => {
          const cs = getComputedStyle(el);
          return {
            background: cs.backgroundColor,
            backgroundImage: cs.backgroundImage,
            border: cs.borderTopColor,
          };
        });
        const chrome = [
          ...new Set(
            slots
              .filter(
                (s) =>
                  s.background !== "rgba(0, 0, 0, 0)" ||
                  s.backgroundImage !== "none" ||
                  s.border !== "rgba(0, 0, 0, 0)",
              )
              .map((s) => JSON.stringify(s)),
          ),
        ];
        return { count: slots.length, chrome };
      });

    // The previous test just navigated, and .thumbnail-item transitions its
    // border-color over 0.2s, so the slot that stopped being active is still
    // fading out if sampled immediately. Poll until everything has settled;
    // the final expect then reports the offending computed values, if any.
    let sample = await readSlots();
    await browser
      .waitUntil(
        async () => {
          sample = await readSlots();
          return sample.count > 0 && sample.chrome.length === 0;
        },
        { timeout: 3000 },
      )
      .catch(() => undefined);
    expect(sample.count).toBeGreaterThan(0);
    expect(sample.chrome).toEqual([]);
  });

  it("applies EXIF orientation from original bytes", async () => {
    const exifPath = join(CORPUS, "exif", "img-000.jpg");
    await browser.execute(
      (p: string) => void window.__SPICA_TEST__?.openImage(p),
      exifPath,
    );
    // The viewer moves through display stages (unrotated thumbnail preview
    // -> display-resolution preview or full <img> -> possibly a <canvas>
    // swap once the decoded bitmap is retained). Sampling a transient stage
    // flakes, so wait directly for the ORIENTED natural dimensions (from
    // data-natural-width/height) on whichever element displays, with a
    // non-thumbnail tier: encoded 1200x800 + orientation 6 must show as
    // 800x1200. The wait succeeding IS the EXIF assertion.
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const el =
            document.querySelector(".image-viewer img") ??
            document.querySelector(".image-viewer canvas");
          return (
            (el instanceof HTMLImageElement ||
              el instanceof HTMLCanvasElement) &&
            el.dataset.naturalWidth === "800" &&
            el.dataset.naturalHeight === "1200" &&
            el.dataset.tier !== "thumbnail"
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
    // neighbor and is decoded into the bitmap cache by the scheduler. Wait
    // for THAT bitmap, not for cache.preloaded: the previous test's
    // viewer-loaded img-000 entry already sits in cache.preloaded while its
    // bitmap retention races the folder-change clearBitmaps(), and a hit
    // navigation without a retained bitmap latches onto <img> for good.
    const exifTarget = join(CORPUS, "exif", "img-000.jpg");
    const companion = join(CORPUS, "exif", "img-001.jpg");
    await browser.execute(
      (p: string) => void window.__SPICA_TEST__?.openImage(p),
      companion,
    );
    await browser.waitUntil(
      async () =>
        browser.execute((p: string) => {
          const status = window.__SPICA_TEST__?.getStatus();
          return (
            status !== undefined &&
            !status.isLoading &&
            status.bitmapPaths.includes(p)
          );
        }, exifTarget),
      {
        timeout: 120_000,
        timeoutMsg: "exif neighbor bitmap was never retained",
      },
    );
    await browser.execute(() => window.__SPICA_TEST__?.navigateToImage(0));
    // Wait for the ORIENTED natural size with a non-thumbnail tier - the
    // canvas backing itself is the preview (or an unscaled preview that
    // reports as tier "full"; either way it is not the full 800x1200 unless
    // the session's preview box happens not to downscale it).
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const canvas = document.querySelector(".image-viewer canvas");
          return (
            canvas instanceof HTMLCanvasElement &&
            canvas.dataset.naturalWidth === "800" &&
            canvas.dataset.naturalHeight === "1200" &&
            canvas.dataset.tier !== "thumbnail"
          );
        }),
      { timeout: 60_000, timeoutMsg: "hit navigation never painted a canvas" },
    );
    const dims = await browser.execute(() => {
      const canvas = document.querySelector(
        ".image-viewer canvas",
      ) as HTMLCanvasElement;
      return { w: canvas.width, h: canvas.height };
    });
    // The canvas backing is the preview bitmap: encoded 1200x800 +
    // orientation 6 -> createImageBitmap applies EXIF, so the backing keeps
    // the oriented 2:3 aspect ratio (800x1200) even when it is scaled down,
    // and is never wider than the natural 800px.
    expect(Math.abs(dims.w / dims.h - 800 / 1200)).toBeLessThan(0.01);
    expect(dims.w).toBeLessThanOrEqual(800);

    mkdirSync(SHOTS, { recursive: true });
    const shot = join(SHOTS, "visual-exif-canvas.png");
    await browser.saveScreenshot(shot);
    const stats = await sharp(shot).stats();
    const maxStdev = Math.max(...stats.channels.map((c) => c.stdev));
    expect(maxStdev).toBeGreaterThan(15);
  });
});
