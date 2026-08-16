// NAV_rapid profiling capture. The wdio tauri-service cannot capture the
// app's stderr (known limitation, see e2e/wdio.conf.ts), so this script
// spawns the bench release exe itself with a piped stderr (SPICA_PERF=1
// serve log, wall-clock arrival timestamps) and drives the exact NAV_rapid
// protocol from e2e/specs/bench.perf.ts over the embedded W3C WebDriver
// server (tauri-plugin-wdio-webdriver, port via TAURI_WEBDRIVER_PORT).
// Output: e2e/.tmp/profile-nav-rapid-raw.json for analyze-nav-rapid.mjs.
// No app code is touched; the app-driving helpers mirror
// e2e/lib/bench-helpers.ts so the measured regime matches the bench.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const exe = join(here, "../../src-tauri/target/release/spica-photo-viewer.exe");
const largeDir = join(here, "../fixtures/corpus/large");
const OUT_FILE = join(here, "../.tmp/profile-nav-rapid-raw.json");

const RUNS = Number(process.env.PROFILE_RUNS ?? 7);
const STEPS = Number(process.env.PROFILE_STEPS ?? 12);
const RAPID_MIN_INTERVAL_MS = 250;
const PORT = Number(process.env.PROFILE_PORT ?? 4471);

if (!existsSync(exe))
  throw new Error(`release binary missing: ${exe} — run: npm run bench:build`);
if (!existsSync(largeDir))
  throw new Error(`corpus missing: ${largeDir} — run: npm run bench:corpus`);

const files = readdirSync(largeDir)
  .filter((f) => f.endsWith(".jpg"))
  .sort()
  .map((f) => join(largeDir, f));
if (files.length <= STEPS)
  throw new Error(`large corpus has ${files.length} images, need > ${STEPS}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- app process with piped stderr (serve log capture) ---------------------
const serves = [];
const child = spawn(exe, [], {
  env: {
    ...process.env,
    SPICA_PERF: "1",
    TAURI_WEBDRIVER_PORT: String(PORT),
    WDIO_EMBEDDED_SERVER: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.resume(); // drain, or the app blocks once the pipe buffer fills
let buf = "";
child.stderr.on("data", (chunk) => {
  buf += chunk.toString();
  let i = buf.indexOf("\n");
  while (i >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line.startsWith('{"perf"')) {
      try {
        // endWall: line arrival ≈ PerfTimer drop = end of the serve
        serves.push({ ...JSON.parse(line), endWall: Date.now() });
      } catch {
        console.warn(`torn perf line skipped: ${line.slice(0, 60)}`);
      }
    }
    i = buf.indexOf("\n");
  }
});
const childExit = new Promise((r) => child.once("exit", r));

// --- minimal W3C WebDriver client ------------------------------------------
const base = `http://127.0.0.1:${PORT}`;
let sessionId = null;
const wd = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok)
    throw new Error(
      `${method} ${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 300)}`,
    );
  return json.value;
};
const execute = (script, ...args) =>
  wd("POST", `/session/${sessionId}/execute/sync`, { script, args });

const waitFor = async (fn, { timeout, interval, msg }) => {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeout) throw new Error(msg);
    await sleep(interval);
  }
};

// --- app-driving helpers (mirror e2e/lib/bench-helpers.ts) -----------------
const clearPerf = () => execute("window.__SPICA_TEST__.clearPerf()");
const getPerf = () => execute("return window.__PERF__ ?? []");
const getStatus = () => execute("return window.__SPICA_TEST__.getStatus()");
const openImage = (p) =>
  execute("void window.__SPICA_TEST__.openImage(arguments[0])", p);
const navigateToImage = (i) =>
  execute("window.__SPICA_TEST__.navigateToImage(arguments[0])", i);

const waitForFullPaint = async (path, timeout = 60_000) => {
  await waitFor(
    () =>
      execute(
        'const p = arguments[0]; return (window.__PERF__ ?? []).some((e) => e.name === "paint:done" && e.detail && e.detail.path === p && e.detail.thumbnail === false)',
        path,
      ),
    {
      timeout,
      interval: 100,
      msg: `no full-resolution paint:done for ${path}`,
    },
  );
  return getPerf();
};

const waitForPreloadSettled = (min) =>
  waitFor(async () => ((await getStatus())?.preloadedCount ?? 0) >= min, {
    timeout: 120_000,
    interval: 250,
    msg: `preload cache never reached ${min} entries`,
  });

const waitForPreloadQuiet = async (quietMs = 1_500) => {
  let last = -1;
  let stableSince = Date.now();
  try {
    await waitFor(
      async () => {
        const count = (await getStatus())?.preloadedCount ?? 0;
        if (count !== last) {
          last = count;
          stableSince = Date.now();
          return false;
        }
        return Date.now() - stableSince >= quietMs;
      },
      { timeout: 120_000, interval: 200, msg: "preload never quiesced" },
    );
  } catch (error) {
    console.warn(`waitForPreloadQuiet: ${error.message}`);
  }
};

// --- main ------------------------------------------------------------------
try {
  await waitFor(
    async () => {
      try {
        return (await wd("GET", "/status"))?.ready === true;
      } catch {
        return false;
      }
    },
    {
      timeout: 120_000,
      interval: 500,
      msg: "embedded WebDriver server never became ready",
    },
  );
  await sleep(500); // same post-ready stabilization as the wdio embedded provider

  const session = await wd("POST", "/session", {
    capabilities: { alwaysMatch: { browserName: "tauri" } },
  });
  sessionId = session.sessionId;

  const timeOrigin = await execute("return performance.timeOrigin");
  const skewMs =
    (await execute("return performance.timeOrigin + performance.now()")) -
    Date.now();
  console.log(`timeOrigin=${timeOrigin} skew=${skewMs.toFixed(1)}ms`);

  const samples = [];
  await clearPerf();
  await openImage(files[0]);
  await waitForFullPaint(files[0]);
  await waitForPreloadSettled(5);
  await waitForPreloadQuiet();

  for (let run = 0; run < RUNS; run++) {
    if (run > 0) {
      // Reset guarantees index 0 + quiescent preloader only; in-memory cache
      // contents evolve over the session by design (same as the bench).
      await clearPerf();
      await navigateToImage(0);
      await waitForFullPaint(files[0]);
      await waitForPreloadQuiet();
    }
    for (let step = 1; step <= STEPS; step++) {
      await clearPerf();
      const navWall = Date.now();
      await navigateToImage(step);
      const entries = await waitForFullPaint(files[step]);
      samples.push({ run, step, path: files[step], navWall, entries });
      const elapsed = Date.now() - navWall;
      if (elapsed < RAPID_MIN_INTERVAL_MS)
        await sleep(RAPID_MIN_INTERVAL_MS - elapsed);
    }
    console.log(`run ${run} done (${samples.length} samples so far)`);
  }

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(
    OUT_FILE,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        runs: RUNS,
        steps: STEPS,
        corpus: "large",
        timeOrigin,
        skewMs,
        files,
        samples,
        serves,
      },
      null,
      1,
    ),
  );
  console.log(
    `raw profile written to ${OUT_FILE} (${samples.length} samples, ${serves.length} serve lines)`,
  );
} finally {
  if (sessionId) {
    try {
      await wd("DELETE", `/session/${sessionId}`);
    } catch {
      /* app may already be gone */
    }
  }
  child.kill();
  await Promise.race([childExit, sleep(3_000)]);
}
