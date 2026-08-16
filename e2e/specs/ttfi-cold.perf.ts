/**
 * ONE cold TTFI sample per wdio process.
 *
 * Cold requires a brand new app process (the full-resolution preload cache and
 * the folder scan live in process memory) plus an empty on-disk thumbnail
 * cache. `browser.reloadSession()` does not give us that under the embedded
 * tauri provider - it reuses the running app - so e2e/scripts/run-bench.mjs
 * wipes %APPDATA%\SpicaPhotoViewer\cache and launches this spec N times, each
 * with a different BENCH_COLD_INDEX. Samples are appended as JSONL and
 * aggregated by bench.perf.ts.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  COLD_SAMPLES_FILE,
  type ColdSample,
  clearPerf,
  corpusFiles,
  extractTimings,
  openImage,
  waitForFullPaint,
} from "../lib/bench-helpers.ts";

const coldIndex = Number(process.env.BENCH_COLD_INDEX ?? "0");

describe("TTFI_cold", () => {
  it("opens a large image in a freshly launched app", async function () {
    // Cold decode of a ~20MP JPEG plus app warm-up; keep well clear of the
    // 60s waitForFullPaint timeout so the timeout message wins over mocha's.
    this.timeout(300_000);

    const files = corpusFiles("large");
    const target = files[coldIndex % files.length];

    await clearPerf();
    await openImage(target);
    const entries = await waitForFullPaint(target);
    const timings = extractTimings(entries, target);

    const sample: ColdSample = {
      index: coldIndex,
      path: target,
      firstPaint: timings.firstPaint,
      fullPaint: timings.fullPaint,
      fetchDecode: timings.fetchDecode,
    };

    mkdirSync(dirname(COLD_SAMPLES_FILE), { recursive: true });
    appendFileSync(COLD_SAMPLES_FILE, `${JSON.stringify(sample)}\n`);
    console.log(`TTFI_cold sample ${coldIndex}: ${JSON.stringify(sample)}`);
  });
});
