import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browser, expect } from "@wdio/globals";

const here = dirname(fileURLToPath(import.meta.url));
const tmpDir = join(here, "../.tmp");

/**
 * Minimal valid 1x1 PNG. The bench corpus (Task 6) does not exist yet, so the
 * smoke generates its own image rather than depending on a fixture.
 */
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const writeSmokeImage = (): string => {
  mkdirSync(tmpDir, { recursive: true });
  const imagePath = join(tmpDir, "smoke-1x1.png");
  writeFileSync(imagePath, Buffer.from(PNG_1X1_BASE64, "base64"));
  return imagePath;
};

describe("smoke", () => {
  it("launches the app and exposes perf/test hooks", async () => {
    const hooks = await browser.execute(() => ({
      hasTestHooks: typeof window.__SPICA_TEST__ !== "undefined",
      hasPerfBuffer: Array.isArray(window.__PERF__ ?? []),
    }));
    expect(hooks.hasTestHooks).toBe(true);
    expect(hooks.hasPerfBuffer).toBe(true);
  });

  it("records the full perf mark chain when opening an image", async () => {
    const imagePath = writeSmokeImage();

    await browser.execute(() => {
      window.__SPICA_TEST__?.clearPerf();
    });

    // openImage() resolves when the folder scan completes, NOT when the image
    // is painted - so deliberately do not await the returned promise here.
    await browser.execute((path: string) => {
      void window.__SPICA_TEST__?.openImage(path);
    }, imagePath);

    await browser.waitUntil(
      () =>
        browser.execute(
          (path: string) =>
            (window.__PERF__ ?? []).some(
              (entry) =>
                entry.name === "paint:done" && entry.detail?.path === path,
            ),
          imagePath,
        ),
      {
        timeout: 30_000,
        interval: 250,
        timeoutMsg: `No paint:done mark for ${imagePath} within 30s`,
      },
    );

    const markNames = await browser.execute(
      (path: string) =>
        (window.__PERF__ ?? [])
          .filter((entry) => entry.detail?.path === path)
          .map((entry) => entry.name),
      imagePath,
    );

    // decode:done is intentionally not asserted: it fired in every observed
    // run, but HTMLImageElement.decode() rejects on data-URL races (see
    // ImageViewer.tsx) so the app treats it as best-effort - a hard assertion
    // here would only be a flake source.
    for (const name of [
      "open:request",
      "ipc:sent",
      "ipc:received",
      "paint:done",
    ]) {
      expect(markNames).toContain(name);
    }

    const status = await browser.execute(() =>
      window.__SPICA_TEST__?.getStatus(),
    );
    expect(status?.hasData).toBe(true);
    expect(status?.path).toBe(imagePath);
  });
});
