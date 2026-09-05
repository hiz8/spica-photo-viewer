// Decode-path experiment inside the real WebView2: for the same 20MP JPEGs,
// time (a) fetch -> createImageBitmap(blob) full decode, (b) the same with
// resizeWidth/resizeHeight at 1/2 and 1/4 (does Chromium downscale-on-decode
// for JPEG?), (c) <img>.decode(), and (d) the Rust preview route. Each
// variant uses a fresh file so the renderer's decoded-image cache cannot
// help. Launches the bench exe with no startup file (nothing else decodes).
//
//   node e2e/scripts/experiment-decode.mjs <dir-with-8+-large-jpgs>
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const exe = join(here, "../../src-tauri/target/release/spica-photo-viewer.exe");
const dir = process.argv[2];
const PORT = 4473;
if (!dir || !existsSync(dir)) throw new Error(`dir missing: ${dir}`);
const files = readdirSync(dir)
  .filter((f) => /\.jpe?g$/i.test(f))
  .sort()
  .map((f) => join(dir, f));
if (files.length < 8) throw new Error("need >= 8 jpgs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(exe, [], {
  env: {
    ...process.env,
    SPICA_PERF: "1",
    TAURI_WEBDRIVER_PORT: String(PORT),
    WDIO_EMBEDDED_SERVER: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.resume();
child.stderr.resume();
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
    throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json.value;
};
const executeAsync = (script, ...args) =>
  wd("POST", `/session/${sessionId}/execute/async`, { script, args });

// Runs in the page. `mode` selects the variant; returns timings in ms.
const PAGE_SCRIPT = `
const [path, mode, done] = [arguments[0], arguments[1], arguments[arguments.length - 1]];
(async () => {
  const origin = "http://spica-img.localhost";
  const src = origin + "/" + encodeURIComponent(path);
  const t = {};
  try {
    if (mode === "img") {
      const t0 = performance.now();
      const el = new Image();
      el.src = src;
      await el.decode();
      t.total = performance.now() - t0;
      t.w = el.naturalWidth; t.h = el.naturalHeight;
      done(t); return;
    }
    if (mode === "preview") {
      const t0 = performance.now();
      // Box must be an allowlisted bucket (utils/preview.rs) or the route 404s.
      const r = await fetch(origin + "/preview/2560x1440/" + encodeURIComponent(path));
      const b = await r.blob();
      t.fetch = performance.now() - t0;
      const t1 = performance.now();
      const bmp = await createImageBitmap(b);
      t.decode = performance.now() - t1;
      t.total = performance.now() - t0;
      t.w = bmp.width; t.h = bmp.height; t.bytes = b.size;
      bmp.close();
      done(t); return;
    }
    const t0 = performance.now();
    const r = await fetch(src);
    const b = await r.blob();
    t.fetch = performance.now() - t0;
    t.bytes = b.size;
    const t1 = performance.now();
    let bmp;
    if (mode === "full") bmp = await createImageBitmap(b);
    else {
      const [den, q] = mode.split(":"); // e.g. "2:high"
      // natural size of the corpus large set is 5472x3648
      bmp = await createImageBitmap(b, {
        resizeWidth: Math.round(5472 / Number(den)),
        resizeHeight: Math.round(3648 / Number(den)),
        resizeQuality: q,
      });
    }
    t.decode = performance.now() - t1;
    t.total = performance.now() - t0;
    t.w = bmp.width; t.h = bmp.height;
    bmp.close();
    done(t);
  } catch (e) { done({ error: String(e) }); }
})();
`;

try {
  for (;;) {
    try {
      if ((await wd("GET", "/status"))?.ready === true) break;
    } catch {}
    await sleep(200);
  }
  await sleep(500);
  const session = await wd("POST", "/session", {
    capabilities: { alwaysMatch: { browserName: "tauri" } },
  });
  sessionId = session.sessionId;

  const modes = ["full", "2:high", "2:low", "4:high", "4:pixelated", "img", "preview", "preview"];
  // Round-robin distinct files per variant, 3 samples each.
  const results = {};
  let fi = 0;
  for (let sample = 0; sample < 3; sample++) {
    for (const mode of modes) {
      const f = files[fi++ % files.length];
      const r = await executeAsync(PAGE_SCRIPT, f, mode);
      const key = mode === "preview" ? `preview(${sample === 0 && mode === "preview" ? "" : ""})` : mode;
      (results[mode] ??= []).push(r);
      console.log(`${mode.padEnd(12)} ${f.split(/[\\/]/).pop()} ${JSON.stringify(r)}`);
    }
  }
  console.log("\nsummary (median total ms):");
  for (const [mode, arr] of Object.entries(results)) {
    const ok = arr.filter((r) => !r.error).map((r) => r.total).sort((a, b) => a - b);
    console.log(`${mode.padEnd(12)} ${ok.length ? ok[Math.floor(ok.length / 2)].toFixed(1) : "n/a"}  [${ok.map((v) => v.toFixed(0)).join(",")}]`);
  }
} finally {
  if (sessionId) {
    try {
      await wd("DELETE", `/session/${sessionId}`);
    } catch {}
  }
  child.kill();
  await Promise.race([childExit, sleep(3000)]);
}
