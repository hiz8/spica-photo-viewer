// Startup timeline capture: process spawn -> window -> WebView -> first
// image paint -> thumbnail bar. Spawns the bench release exe with the image
// path as argv[1] (the file-association launch path), captures the
// SPICA_PERF stderr lines (each carrying its own wall-clock `wall` field or
// a PerfTimer `ms`), then reads window.__PERF__ over the embedded W3C
// WebDriver server and maps the browser marks to wall clock via
// performance.timeOrigin. Everything is reported relative to spawn time.
//
//   node e2e/scripts/profile-startup.mjs --file <image> [--runs 3] [--cold]
//       [--label name] [--wait-thumbs 21]
//
// --cold wipes %APPDATA%\SpicaPhotoViewer\cache before every run.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cacheDir = join(process.env.APPDATA ?? "", "SpicaPhotoViewer", "cache");

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);

// --exe lets a saved baseline binary be profiled back-to-back with the
// current build under the same machine conditions.
const exe = opt(
  "exe",
  join(here, "../../src-tauri/target/release/spica-photo-viewer.exe"),
);

const file = opt("file", null);
const RUNS = Number(opt("runs", 3));
const COLD = flag("cold");
const LABEL = opt("label", COLD ? "cold" : "warm");
const WAIT_THUMBS = Number(opt("wait-thumbs", 21));
// How long after the first full paint to keep waiting for WAIT_THUMBS.
const THUMB_TIMEOUT = Number(opt("thumb-timeout", 20_000));
const PORT = Number(opt("port", 4472));
const OUT_FILE = join(here, `../.tmp/profile-startup-${LABEL}.json`);

if (!file || !existsSync(file)) throw new Error(`--file missing: ${file}`);
if (!existsSync(exe))
  throw new Error(`release binary missing: ${exe} — run: npm run bench:build`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitFor = async (fn, { timeout, interval, msg }) => {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeout) throw new Error(msg);
    await sleep(interval);
  }
};

const runOnce = async (runIndex) => {
  if (COLD) rmSync(cacheDir, { recursive: true, force: true });

  const rustLines = [];
  const t0 = Date.now();
  const child = spawn(exe, [file], {
    env: {
      ...process.env,
      SPICA_PERF: "1",
      TAURI_WEBDRIVER_PORT: String(PORT),
      WDIO_EMBEDDED_SERVER: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  let buf = "";
  child.stderr.on("data", (chunk) => {
    buf += chunk.toString();
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith('{"perf"')) {
        try {
          rustLines.push({ ...JSON.parse(line), arrivalWall: Date.now() });
        } catch {
          /* torn line */
        }
      }
      i = buf.indexOf("\n");
    }
  });
  const childExit = new Promise((r) => child.once("exit", r));

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

  let result = null;
  try {
    await waitFor(
      async () => {
        try {
          return (await wd("GET", "/status"))?.ready === true;
        } catch {
          return false;
        }
      },
      { timeout: 60_000, interval: 100, msg: "WebDriver never ready" },
    );
    const session = await wd("POST", "/session", {
      capabilities: { alwaysMatch: { browserName: "tauri" } },
    });
    sessionId = session.sessionId;

    // Wait for: full paint of the startup file, folder scanned, and either
    // WAIT_THUMBS thumbnails done or a timeout (whichever first).
    const started = Date.now();
    await waitFor(
      async () => {
        const perf = await execute("return window.__PERF__ ?? []");
        const painted = perf.some(
          (e) =>
            e.name === "paint:done" &&
            e.detail?.path === file &&
            e.detail?.thumbnail === false,
        );
        const scanned = perf.some((e) => e.name === "folder:scanned");
        const thumbs = perf.filter((e) => e.name === "thumb:done").length;
        if (painted && scanned && thumbs >= WAIT_THUMBS) return true;
        return painted && scanned && Date.now() - started > THUMB_TIMEOUT;
      },
      {
        timeout: THUMB_TIMEOUT + 90_000,
        interval: 250,
        msg: "startup never completed",
      },
    );
    await sleep(300);
    const timeOrigin = await execute("return performance.timeOrigin");
    const perf = await execute("return window.__PERF__ ?? []");
    const innerWidth = await execute("return window.innerWidth");
    result = { run: runIndex, t0, timeOrigin, innerWidth, perf, rustLines };
  } finally {
    if (sessionId) {
      try {
        await wd("DELETE", `/session/${sessionId}`);
      } catch {
        /* gone */
      }
    }
    child.kill();
    await Promise.race([childExit, sleep(3_000)]);
    // Make sure the process is really gone before the next spawn reuses the port.
    await sleep(500);
  }
  return result;
};

// --- timeline summary -------------------------------------------------------
const summarize = (r) => {
  const rel = (wall) => Math.round(wall - r.t0);
  const js = (name, pred = () => true) => {
    const e = r.perf.find((e) => e.name === name && pred(e));
    return e ? rel(r.timeOrigin + e.ts) : null;
  };
  const rust = (phase) => {
    const e = r.rustLines.find(
      (l) => l.op === "startup" && l.phase === phase,
    );
    return e ? rel(e.wall) : null;
  };
  const rustTimer = (op) =>
    r.rustLines.filter((l) => l.op === op).map((l) => l.ms);
  const scanEnd = r.rustLines.find(
    (l) => l.op === "startup" && l.phase === "folder_scan_end",
  );
  const thumbs = r.perf
    .filter((e) => e.name === "thumb:done")
    .map((e) => rel(r.timeOrigin + e.ts));
  const paints = r.perf
    .filter((e) => e.name === "paint:done" && e.detail?.path === file)
    .map((e) => ({ t: rel(r.timeOrigin + e.ts), tier: e.detail?.tier }));
  const median = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  return {
    run: r.run,
    innerWidth: r.innerWidth,
    rust_run_start: rust("run_start"),
    rust_setup: rust("setup"),
    rust_window_created: rust("window_created"),
    rust_page_load_started: rust("page_load_started"),
    js_timeOrigin: rel(r.timeOrigin),
    js_script_start: js("app:script_start"),
    js_script_innerWidth:
      r.perf.find((e) => e.name === "app:script_start")?.detail?.innerWidth ??
      null,
    rust_page_load_finished: rust("page_load_finished"),
    rust_prefetch_start: rust("prefetch_start"),
    rust_prefetch_thumb_done: rust("prefetch_thumb_done"),
    rust_prefetch_folder_done: rust("prefetch_folder_done"),
    prefetch_thumb_ms: rustTimer("prefetch_thumb")[0] ?? null,
    js_startup_check: js("app:startup_check"),
    rust_get_startup_file: rust("get_startup_file"),
    rust_get_startup_file_end: rust("get_startup_file_end"),
    js_startup_file: js("app:startup_file"),
    js_startup_thumb:
      r.perf.find((e) => e.name === "app:startup_file")?.detail?.thumb ?? null,
    rust_folder_scan_prefetched: rust("folder_scan_prefetched"),
    js_open_request: js("open:request"),
    rust_maximize_start: rust("maximize_start"),
    rust_maximize_end: rust("maximize_end"),
    rust_folder_scan_start: rust("folder_scan_start"),
    rust_folder_scan_end: rust("folder_scan_end"),
    scan_n: scanEnd?.n ?? null,
    scan_walk_ms: scanEnd?.walk_ms ?? null,
    scan_meta_ms: scanEnd?.meta_ms ?? null,
    scan_probe_wait_ms: scanEnd?.probe_wait_ms ?? null,
    js_folder_scanned: js("folder:scanned"),
    js_thumbbar_committed: js("thumbbar:committed"),
    js_thumbbar_painted: js("thumbbar:painted"),
    js_src_set: js("src:set"),
    js_decode_done: js("decode:done", (e) => e.detail?.path === file),
    paints,
    js_first_full_paint: paints.find((p) => p.tier !== "thumbnail")?.t ?? null,
    cache_sweep_ms: rustTimer("cache_sweep")[0] ?? null,
    cache_stats_ms: rustTimer("cache_stats")[0] ?? null,
    js_thumbgen_start: js("thumbgen:start"),
    thumb_first: thumbs[0] ?? null,
    thumb_5th: thumbs[4] ?? null,
    thumb_21st: thumbs[20] ?? null,
    thumb_count: thumbs.length,
    thumb_lookup_ms_median: median(rustTimer("thumb_lookup")),
    thumb_lookup_n: rustTimer("thumb_lookup").length,
    thumb_preview_ms_median: median(rustTimer("thumb_preview")),
    thumb_preview_n: rustTimer("thumb_preview").length,
    serve_ms: rustTimer("serve"),
    serve_preview_ms: rustTimer("serve_preview"),
  };
};

const runs = [];
for (let i = 0; i < RUNS; i++) {
  console.log(`--- run ${i} (${LABEL}) ---`);
  const r = await runOnce(i);
  const s = summarize(r);
  runs.push({ summary: s, raw: r });
  console.log(JSON.stringify(s));
}

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(
  OUT_FILE,
  JSON.stringify(
    { capturedAt: new Date().toISOString(), file, label: LABEL, cold: COLD, runs },
    null,
    1,
  ),
);
console.log(`written ${OUT_FILE}`);

// Compact table: median across runs of each timeline point.
const keys = Object.keys(runs[0].summary).filter(
  (k) => typeof runs[0].summary[k] === "number" || runs[0].summary[k] === null,
);
console.log("\nmetric\tmedian(ms from spawn)\tvalues");
for (const k of keys) {
  const vals = runs.map((r) => r.summary[k]).filter((v) => v !== null);
  const s = [...vals].sort((a, b) => a - b);
  const med = s.length ? s[Math.floor(s.length / 2)] : null;
  console.log(`${k}\t${med}\t${vals.join(",")}`);
}
