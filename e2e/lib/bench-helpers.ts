/**
 * Shared plumbing for the perf bench specs.
 *
 * Lives in a module (rather than inline in one spec, as originally sketched)
 * because TTFI_cold has to run in its OWN wdio process: `browser.reloadSession()`
 * does NOT relaunch the app under @wdio/tauri-service's embedded provider - it
 * reuses the running process, so window state, __PERF__ and every in-memory
 * cache survive it (verified: same PID, same sentinel global, same store).
 * e2e/scripts/run-bench.mjs therefore launches `ttfi-cold.perf.ts` once per
 * cold sample and `bench.perf.ts` once for the navigation metrics; both import
 * from here.
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browser } from "@wdio/globals";

// import.meta.dirname is not reliably populated by wdio's TS loader (see the
// same note in e2e/wdio.conf.ts), so derive the directory from import.meta.url.
const here = dirname(fileURLToPath(import.meta.url));

/**
 * Repetitions per metric. Single values are never reported.
 * e2e/scripts/run-bench.mjs passes BENCH_RUNS so both halves of the bench
 * (cold launches and navigation) always agree on N.
 */
export const N = Number(process.env.BENCH_RUNS ?? 7);

export const CORPUS_DIR = join(here, "../fixtures/corpus");
export const RESULTS_DIR = join(here, "../../bench-results");

/** On-disk thumbnail cache written by src-tauri/src/commands/cache.rs. */
export const THUMB_CACHE_DIR = join(
  process.env.APPDATA ?? "",
  "SpicaPhotoViewer",
  "cache",
);

/**
 * JSONL scratch file: one cold sample per line, appended by each
 * ttfi-cold.perf.ts process and read back by bench.perf.ts.
 */
export const COLD_SAMPLES_FILE =
  process.env.BENCH_COLD_SAMPLES ??
  join(here, "../.tmp/bench-cold-samples.jsonl");

export type PerfEntry = {
  type: string;
  name: string;
  ts: number;
  detail?: Record<string, unknown>;
};

export type Timings = {
  /** open:request -> first paint:done (may be a thumbnail preview). */
  firstPaint: number;
  /** open:request -> first paint:done with thumbnail === false. */
  fullPaint: number;
  /** src:set -> full-res decode:done, or null when either mark is missing. */
  fetchDecode: number | null;
};

export type ColdSample = {
  index: number;
  path: string;
  firstPaint: number;
  fullPaint: number;
  fetchDecode: number | null;
};

export type Summary = {
  median_ms: number | null;
  p95_ms: number | null;
  n: number;
};

export const corpusFiles = (set: string): string[] =>
  readdirSync(join(CORPUS_DIR, set))
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .map((f) => join(CORPUS_DIR, set, f));

export const getPerf = (): Promise<PerfEntry[]> =>
  browser.execute(() => window.__PERF__ ?? []);

export const clearPerf = (): Promise<void> =>
  browser.execute(() => {
    window.__SPICA_TEST__?.clearPerf();
  });

export const getStatus = () =>
  browser.execute(() => window.__SPICA_TEST__?.getStatus());

/**
 * openImageFromPath() resolves at folder-scan completion, NOT at paint, so the
 * returned promise is deliberately not awaited inside the page - callers wait
 * on the paint:done mark instead.
 */
export const openImage = (path: string): Promise<void> =>
  browser.execute((p: string) => {
    void window.__SPICA_TEST__?.openImage(p);
  }, path);

export const navigateToImage = (index: number): Promise<void> =>
  browser.execute((i: number) => {
    window.__SPICA_TEST__?.navigateToImage(i);
  }, index);

/** Wait until a full-resolution paint:done exists for `path`, then return the buffer. */
export const waitForFullPaint = async (
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
      timeoutMsg: `no full-resolution paint:done for ${path} within ${timeout}ms`,
    },
  );
  return getPerf();
};

/** Intervals for `path`, paired offline from the marks in `entries`. */
export const extractTimings = (entries: PerfEntry[], path: string): Timings => {
  const open = entries.find(
    (e) => e.name === "open:request" && e.detail?.path === path,
  );
  const paints = entries.filter(
    (e) => e.name === "paint:done" && e.detail?.path === path,
  );
  const full = paints.find((e) => e.detail?.thumbnail === false);
  if (!open || paints.length === 0 || !full) {
    throw new Error(
      `incomplete marks for ${path} (open=${!!open} paints=${paints.length} full=${!!full})`,
    );
  }
  const srcSet = entries.find(
    (e) => e.name === "src:set" && e.detail?.path === path,
  );
  const fullDecode = entries.find(
    (e) =>
      e.name === "decode:done" &&
      e.detail?.path === path &&
      e.detail?.thumbnail === false,
  );
  return {
    firstPaint: paints[0].ts - open.ts,
    fullPaint: full.ts - open.ts,
    // decode:done is best-effort: img.decode() rejects on data-URL races.
    fetchDecode: srcSet && fullDecode ? fullDecode.ts - srcSet.ts : null,
  };
};

/**
 * Placeholder visibility interval for one navigation: first paint (usually
 * the blurry thumbnail fallback) -> full-resolution paint. 0 is a valid
 * value and means no placeholder was perceivable (the first paint already
 * was full resolution, e.g. a preload hit).
 */
export const placeholderDuration = (timings: Timings): number =>
  timings.fullPaint - timings.firstPaint;

/** The `preload` event tells us whether the navigation hit the preload cache. */
export const preloadHit = (
  entries: PerfEntry[],
  path: string,
): boolean | null => {
  const event = entries.find(
    (e) => e.name === "preload" && e.detail?.path === path,
  );
  if (!event) return null;
  return event.detail?.hit === true;
};
