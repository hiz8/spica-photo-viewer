// Bench orchestrator (`npm run bench`).
//
// TTFI_cold needs a NEW app process per sample: the full-resolution preload
// cache and the folder scan live in process memory. `browser.reloadSession()`
// does not provide that under @wdio/tauri-service's embedded provider - it
// reuses the running app (verified: identical PID, window globals and store
// survive the call) - so cold samples are collected by launching wdio once per
// sample against e2e/specs/ttfi-cold.perf.ts, wiping the on-disk thumbnail
// cache in between. The navigation metrics then run once, in a single session,
// and e2e/specs/bench.perf.ts writes the combined bench-results JSON.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const here = import.meta.dirname;
const repoRoot = join(here, "../..");
const wdioBin = join(repoRoot, "node_modules/@wdio/cli/bin/wdio.js");
const samplesFile = join(here, "../.tmp/bench-cold-samples.jsonl");

// %APPDATA%\SpicaPhotoViewer\cache - the app's on-disk thumbnail cache
// (src-tauri/src/commands/cache.rs).
const thumbCacheDir = join(
  process.env.APPDATA ?? "",
  "SpicaPhotoViewer",
  "cache",
);

// Repetitions per metric. Passed down so the specs aggregate the same N.
const runs = Number(process.env.BENCH_RUNS ?? 7);

const appBinary = join(
  repoRoot,
  "src-tauri/target/release/spica-photo-viewer.exe",
);
if (!existsSync(appBinary)) {
  throw new Error(
    `release build not found at ${appBinary} - run 'npm run bench:build' first`,
  );
}
if (!existsSync(join(repoRoot, "e2e/fixtures/corpus/medium"))) {
  throw new Error("bench corpus missing - run 'npm run bench:corpus' first");
}

const wdio = (spec, env) =>
  execFileSync(
    process.execPath,
    [wdioBin, "run", "e2e/wdio.conf.ts", "--spec", spec],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        BENCH_RUNS: String(runs),
        BENCH_COLD_SAMPLES: samplesFile,
        ...env,
      },
    },
  );

// Start from a clean sample file so a partial previous run cannot leak in.
mkdirSync(dirname(samplesFile), { recursive: true });
rmSync(samplesFile, { force: true });

for (let i = 0; i < runs; i++) {
  // Cold also means an empty disk thumbnail cache. Safe to delete while no app
  // is running; the app recreates the directory on demand.
  rmSync(thumbCacheDir, { recursive: true, force: true });
  console.log(`\n=== TTFI_cold ${i + 1}/${runs} (fresh app process) ===`);
  wdio("e2e/specs/ttfi-cold.perf.ts", { BENCH_COLD_INDEX: String(i) });
}

console.log("\n=== NAV_warm / NAV_cold + aggregation ===");
wdio("e2e/specs/bench.perf.ts");
