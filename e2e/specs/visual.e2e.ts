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
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const img = document.querySelector(".image-viewer img");
          return (
            img instanceof HTMLImageElement &&
            img.naturalWidth > 0 &&
            img.getBoundingClientRect().width > 100
          );
        }),
      { timeout: 60000, timeoutMsg: "image element never became visible" },
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
          return img instanceof HTMLImageElement && img.naturalWidth > 0;
        }),
      {
        timeout: 60000,
        timeoutMsg: "image element never became visible after navigation",
      },
    );
  });
});
