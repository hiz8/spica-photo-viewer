/**
 * Navigation benchmarks (NAV_warm / NAV_cold) plus final result aggregation.
 *
 * Both navigation metrics share one app process on purpose: warm needs a live
 * preload cache, and cold evicts the decoded cache (bitmaps + cache.preloaded)
 * right before each jump so the target goes through the miss path whatever
 * the retained window is. TTFI_cold cannot share it - it needs a fresh process - so
 * it is measured by e2e/specs/ttfi-cold.perf.ts in separate wdio launches and
 * read back here from the JSONL scratch file.
 *
 * Run through `npm run bench` (e2e/scripts/run-bench.mjs), which orchestrates
 * both halves and produces bench-results/<git-sha>-<timestamp>.json.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browser } from "@wdio/globals";
import {
  COLD_SAMPLES_FILE,
  type ColdSample,
  N,
  type PerfEntry,
  RESULTS_DIR,
  type Summary,
  clearPerf,
  corpusFiles,
  evictDecoded,
  extractTimings,
  getPerf,
  getStatus,
  navigateToImage,
  openImage,
  placeholderDuration,
  preloadHit,
  waitForFullPaint,
} from "../lib/bench-helpers.ts";
import { median, p95 } from "../lib/stats.ts";

/** Mirrors PRELOAD_RANGE in src/constants/timing.ts (the app preloads +/-N). */
const PRELOAD_RANGE = 5;

/**
 * Stride between NAV_cold jumps. Kept > 2 * PRELOAD_RANGE from the original
 * "far jump" protocol so the index sequence is unchanged; since D5 the miss
 * is guaranteed by evictDecoded() rather than by distance.
 */
const COLD_JUMP_STRIDE = 13;

/** NAV_rapid: sequential steps per run over the large corpus. */
const RAPID_STEPS = 12;

/**
 * NAV_rapid pacing floor: never navigate faster than this, but a slow full
 * paint stretches the interval naturally (the harness waits for the
 * full-res paint before stepping - see the NAV_rapid block for why).
 */
const RAPID_MIN_INTERVAL_MS = Number(
  process.env.BENCH_RAPID_INTERVAL_MS ?? 250,
);

/**
 * The bench assumptions only hold for a corpus large enough that N forward
 * steps exist and a strided jump always lands outside the preload window.
 */
const assertCorpusFits = (files: string[]): void => {
  if (N >= files.length) {
    throw new Error(
      `corpus has ${files.length} images, too few for N=${N} sequential steps`,
    );
  }
  const stride = COLD_JUMP_STRIDE % files.length;
  const gap = Math.min(stride, files.length - stride);
  if (gap <= PRELOAD_RANGE) {
    throw new Error(
      `stride ${COLD_JUMP_STRIDE} over ${files.length} images lands ${gap} away, inside the +/-${PRELOAD_RANGE} preload window`,
    );
  }
};

/**
 * Paths the app has reported as preloaded at any point. `preload:done` fires
 * once per path, and clearPerf() wipes the buffer between steps, so the
 * knowledge has to be accumulated harness-side rather than re-read.
 */
const preloadedSeen = new Set<string>();

const harvestPreloads = (entries: PerfEntry[]): void => {
  for (const entry of entries) {
    const path = entry.detail?.path;
    if (entry.name === "preload:done" && typeof path === "string") {
      preloadedSeen.add(path);
    }
  }
};

/** Wait until the preloader has actually loaded `path` into the full-res cache. */
const waitForPreloadedPath = async (path: string): Promise<void> => {
  if (preloadedSeen.has(path)) return;
  await browser.waitUntil(
    async () => {
      harvestPreloads(await getPerf());
      return preloadedSeen.has(path);
    },
    {
      // Preloading only starts once EVERY thumbnail is generated
      // (thumbnailGeneration.allGenerated) plus PRELOAD_DELAY_MS, and the
      // medium corpus is 30 x 8MP - this legitimately takes a while.
      timeout: 120_000,
      interval: 250,
      timeoutMsg: `image was never preloaded: ${path}`,
    },
  );
};

/** Wait until the preload cache is populated, i.e. the preloader is running. */
const waitForPreloadSettled = async (minCount: number): Promise<void> => {
  await browser.waitUntil(
    async () => {
      const status = await getStatus();
      return (status?.preloadedCount ?? 0) >= minCount;
    },
    {
      timeout: 120_000,
      interval: 250,
      timeoutMsg: `preload cache never reached ${minCount} entries`,
    },
  );
};

/**
 * Wait until the preload cache size has stopped moving.
 *
 * Required before a NAV_cold jump: startPreloading() walks its queue without
 * re-checking the current index, so a still-running preload from the PREVIOUS
 * position keeps inserting entries after we have moved on - which both makes
 * "cold" targets accidentally warm and adds IPC contention to the measurement.
 * Non-fatal: if it never quiesces we still measure, and the preload-HIT check
 * excludes the sample if the jump turned out not to be cold.
 */
const waitForPreloadQuiet = async (quietMs = 1_500): Promise<void> => {
  let lastCount = -1;
  let stableSince = Date.now();
  try {
    await browser.waitUntil(
      async () => {
        const count = (await getStatus())?.preloadedCount ?? 0;
        if (count !== lastCount) {
          lastCount = count;
          stableSince = Date.now();
          return false;
        }
        return Date.now() - stableSince >= quietMs;
      },
      { timeout: 120_000, interval: 200, timeoutMsg: "preload never quiesced" },
    );
  } catch (error) {
    console.warn(`waitForPreloadQuiet: ${(error as Error).message}`);
  }
};

const results: Record<"NAV_warm" | "NAV_cold", number[]> = {
  NAV_warm: [],
  NAV_cold: [],
};

/** NAV_rapid pools every step of every run - hits AND misses both count. */
const rapid = {
  fullPaint: [] as number[],
  placeholderDur: [] as number[],
  missFetchDecode: [] as number[],
  hits: 0,
  total: 0,
};

const readColdSamples = (): ColdSample[] => {
  if (!existsSync(COLD_SAMPLES_FILE)) {
    console.warn(
      `no cold samples at ${COLD_SAMPLES_FILE} - run 'npm run bench' instead of this spec alone`,
    );
    return [];
  }
  const lines = readFileSync(COLD_SAMPLES_FILE, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const samples: ColdSample[] = [];
  for (const line of lines) {
    try {
      samples.push(JSON.parse(line) as ColdSample);
    } catch (error) {
      // A torn/partial line shouldn't throw inside after() and lose the
      // whole run's output - skip it and keep the rest of the samples.
      console.warn(
        `skipping unparseable line in ${COLD_SAMPLES_FILE}: ${(error as Error).message}`,
      );
    }
  }
  return samples;
};

const summarize = (values: number[]): Summary =>
  values.length > 0
    ? { median_ms: median(values), p95_ms: p95(values), n: values.length }
    : { median_ms: null, p95_ms: null, n: 0 };

const defined = (values: (number | null)[]): number[] =>
  values.filter((v): v is number => v !== null);

describe("bench", () => {
  it("NAV_warm (medium corpus, sequential with preload hits)", async function () {
    this.timeout(900_000);
    const files = corpusFiles("medium");
    assertCorpusFits(files);

    await clearPerf();
    await openImage(files[0]);
    await waitForFullPaint(files[0]);
    // Gate on the preloader being alive at all before trusting per-path waits.
    await waitForPreloadSettled(5);

    for (let step = 1; step <= N; step++) {
      await waitForPreloadedPath(files[step]);
      // NAV_warm is the ideal preload-hit case, so measure against an idle app:
      // a concurrent preload (3 x 8MP over base64 IPC) otherwise blocks the
      // main thread and turns the sample into a bimodal outlier.
      await waitForPreloadQuiet();
      harvestPreloads(await getPerf());
      await clearPerf();
      await navigateToImage(step);
      const entries = await waitForFullPaint(files[step]);
      harvestPreloads(entries);

      if (preloadHit(entries, files[step]) !== true) {
        console.warn(`NAV_warm step ${step}: preload MISS - sample excluded`);
        continue;
      }
      results.NAV_warm.push(extractTimings(entries, files[step]).fullPaint);
    }
    console.log(`NAV_warm samples: ${JSON.stringify(results.NAV_warm)}`);
  });

  it("NAV_cold (medium corpus, memory-cold jumps: decoded cache evicted first)", async function () {
    this.timeout(900_000);
    const files = corpusFiles("medium");
    assertCorpusFits(files);

    // Continue in the same session, starting from wherever NAV_warm left off.
    let index = (await getStatus())?.index ?? 0;

    for (let i = 0; i < N; i++) {
      index = (index + COLD_JUMP_STRIDE) % files.length;
      // Memory-cold, disk-warm (design spec 2026-08-21 D5): once the
      // preloader is quiet, drop every decoded bitmap and preload entry so
      // the jump target is served through the miss path regardless of how
      // wide the retained window is. Thumbnails and the on-disk cache stay,
      // as they would for any image the user has browsed past before.
      // Quiet first: evictDecoded() does not abort in-flight loads, and a
      // load completing after the eviction would re-insert its entry.
      await waitForPreloadQuiet();
      const evicted = await evictDecoded();
      await clearPerf();
      await navigateToImage(index);
      const entries = await waitForFullPaint(files[index]);

      if (preloadHit(entries, files[index]) === true) {
        console.warn(
          `NAV_cold run ${i} (index ${index}): unexpected preload HIT after evicting ${JSON.stringify(evicted)} - sample excluded`,
        );
        continue;
      }
      results.NAV_cold.push(extractTimings(entries, files[index]).fullPaint);
    }
    console.log(`NAV_cold samples: ${JSON.stringify(results.NAV_cold)}`);
  });

  it("NAV_rapid (large corpus, sustained navigation, >=250ms cadence)", async function () {
    this.timeout(900_000);
    const files = corpusFiles("large");
    if (files.length <= RAPID_STEPS) {
      throw new Error(
        `large corpus has ${files.length} images, need > ${RAPID_STEPS} for NAV_rapid`,
      );
    }

    // Switch the session to the large-corpus folder. The folder change
    // resets thumbnails/preload state; waitForPreloadSettled implies
    // allGenerated for the NEW folder because the preloader only runs after
    // every thumbnail is generated.
    await clearPerf();
    await openImage(files[0]);
    await waitForFullPaint(files[0]);
    await waitForPreloadSettled(5);
    await waitForPreloadQuiet();

    for (let run = 0; run < N; run++) {
      if (run > 0) {
        // Reset only guarantees: current index back to 0, preloader
        // quiescent. In-memory cache contents are NOT pinned to a fixed
        // state - they evolve over the session by design. The measured
        // protocol is the whole fixed sequence; compare full protocol
        // executions, not individual runs. The reset navigation itself is
        // not measured.
        await clearPerf();
        await navigateToImage(0);
        await waitForFullPaint(files[0]);
        await waitForPreloadQuiet();
      }

      const runFullPaints: number[] = [];
      let runHits = 0;

      for (let step = 1; step <= RAPID_STEPS; step++) {
        await clearPerf();
        const navAt = Date.now();
        await navigateToImage(step);
        const entries = await waitForFullPaint(files[step]);

        const timings = extractTimings(entries, files[step]);
        rapid.total++;
        rapid.fullPaint.push(timings.fullPaint);
        rapid.placeholderDur.push(placeholderDuration(timings));
        runFullPaints.push(timings.fullPaint);
        const hit = preloadHit(entries, files[step]);
        if (hit === true) {
          rapid.hits++;
          runHits++;
        }
        if (hit === false && timings.fetchDecode !== null) {
          rapid.missFetchDecode.push(timings.fetchDecode);
        }

        // Pacing floor. A fixed fire-and-forget cadence is NOT usable here:
        // ImageViewer aborts superseded loads, so under rapid stepping most
        // images would never reach a full-res paint and the surviving
        // samples would be survivorship-biased toward preload hits.
        const elapsed = Date.now() - navAt;
        if (elapsed < RAPID_MIN_INTERVAL_MS) {
          await browser.pause(RAPID_MIN_INTERVAL_MS - elapsed);
        }
      }
      console.log(
        `NAV_rapid run ${run}: ${JSON.stringify(runFullPaints)} (hits ${runHits}/${RAPID_STEPS})`,
      );
    }
    console.log(
      `NAV_rapid samples: ${JSON.stringify(rapid.fullPaint)} (hits ${rapid.hits}/${rapid.total})`,
    );
    console.log(
      `PLACEHOLDER_dur samples: ${JSON.stringify(rapid.placeholderDur)}`,
    );
  });

  after(() => {
    const cold = readColdSamples();
    mkdirSync(RESULTS_DIR, { recursive: true });
    const sha = execSync("git rev-parse --short HEAD").toString().trim();
    const timestamp = new Date().toISOString();

    const out = {
      gitSha: sha,
      timestamp,
      buildProfile: "release",
      runs: N,
      corpus: ["small", "medium", "large"],
      metrics: {
        // Top level is TTFI to the first paint of any kind; `full` is TTFI to
        // the full-resolution paint (identical when no preview is shown).
        TTFI_cold: {
          ...summarize(cold.map((s) => s.firstPaint)),
          full: summarize(cold.map((s) => s.fullPaint)),
        },
        NAV_warm: summarize(results.NAV_warm),
        NAV_cold: summarize(results.NAV_cold),
        NAV_rapid: {
          ...summarize(rapid.fullPaint),
          steps: RAPID_STEPS,
          hit_rate: rapid.total > 0 ? rapid.hits / rapid.total : null,
        },
        PLACEHOLDER_dur: summarize(rapid.placeholderDur),
        breakdown: {
          fetch_decode_cold: summarize(defined(cold.map((s) => s.fetchDecode))),
          fetch_decode_rapid_miss: summarize(rapid.missFetchDecode),
        },
      },
    };

    const file = join(
      RESULTS_DIR,
      `${sha}-${timestamp.replace(/[:.]/g, "-")}.json`,
    );
    writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(`bench results written to ${file}`);
    console.log(JSON.stringify(out.metrics, null, 2));
  });
});
