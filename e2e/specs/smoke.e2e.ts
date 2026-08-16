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
  // Shared by the perf-mark test and the protocol test, so it is created once
  // at describe scope rather than inside a single `it`.
  let tempPngPath: string;

  before(() => {
    tempPngPath = writeSmokeImage();
  });

  it("launches the app and exposes perf/test hooks", async () => {
    const hooks = await browser.execute(() => ({
      hasTestHooks: typeof window.__SPICA_TEST__ !== "undefined",
      hasPerfBuffer: Array.isArray(window.__PERF__ ?? []),
    }));
    expect(hooks.hasTestHooks).toBe(true);
    expect(hooks.hasPerfBuffer).toBe(true);
  });

  it("records the full perf mark chain when opening an image", async () => {
    const imagePath = tempPngPath;

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
    // run, but HTMLImageElement.decode() rejects on races (see ImageViewer.tsx)
    // so the app treats it as best-effort - a hard assertion here would only be
    // a flake source.
    // ipc:sent/ipc:received are gone: the viewer no longer round-trips base64
    // through IPC, it points <img> at the spica-img protocol (src:set).
    for (const name of ["open:request", "src:set", "paint:done"]) {
      expect(markNames).toContain(name);
    }

    const status = await browser.execute(() =>
      window.__SPICA_TEST__?.getStatus(),
    );
    expect(status?.hasData).toBe(true);
    expect(status?.path).toBe(imagePath);
  });

  it("serves image bytes over the spica-img protocol", async () => {
    // URL construction is inlined rather than imported from src/utils/imageSrc:
    // e2e specs deliberately do not import app source, so this doubles as an
    // independent check that the builder's format is what the handler expects.
    const src = `http://spica-img.localhost/${encodeURIComponent(tempPngPath)}`;
    const result = await browser.executeAsync(
      (
        url: string,
        done: (r: {
          ok: boolean;
          status: number;
          size: number;
          type: string;
        }) => void,
      ) => {
        fetch(url)
          .then((r) =>
            r
              .blob()
              .then((b) =>
                done({
                  ok: r.ok,
                  status: r.status,
                  size: b.size,
                  type: b.type,
                }),
              ),
          )
          .catch(() =>
            done({ ok: false, status: -1, size: 0, type: "fetch-error" }),
          );
      },
      src,
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.size).toBeGreaterThan(0);
    expect(result.type).toBe("image/png");

    const missing = await browser.executeAsync(
      (url: string, done: (status: number) => void) => {
        fetch(url)
          .then((r) => done(r.status))
          .catch(() => done(-1));
      },
      `http://spica-img.localhost/${encodeURIComponent("C:\\nope\\missing.jpg")}`,
    );
    expect(missing).toBe(404);
  });
});
