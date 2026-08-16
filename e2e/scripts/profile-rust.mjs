// Phase 4 profiling: launch the release exe with SPICA_PERF=1 and a large
// corpus image as the startup file (App.tsx auto-opens it), capture the
// Rust perf JSON lines from stderr, and print per-op medians.
// The wdio service cannot capture app stderr (known limitation), so this
// script spawns the exe directly with a pipe.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const exe = join(here, "../../src-tauri/target/release/spica-photo-viewer.exe");
const largeDir = join(here, "../fixtures/corpus/large");

if (!existsSync(exe)) throw new Error(`release binary missing: ${exe} — run: npm run bench:build`);
if (!existsSync(largeDir)) throw new Error(`corpus missing: ${largeDir} — run: npm run bench:corpus`);

const image = join(
  largeDir,
  readdirSync(largeDir).filter((f) => f.endsWith(".jpg")).sort()[0],
);

const CAPTURE_MS = 15000;
console.log(`profiling ${exe}\n  image: ${image}\n  capturing stderr for ${CAPTURE_MS}ms...`);

const child = spawn(exe, [image], { env: { ...process.env, SPICA_PERF: "1" } });
const samples = [];
let buffer = "";
child.stderr.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx = buffer.indexOf("\n");
  while (idx >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line.startsWith('{"perf"')) {
      try {
        samples.push(JSON.parse(line));
      } catch {
        console.warn(`torn perf line skipped: ${line.slice(0, 60)}`);
      }
    }
    idx = buffer.indexOf("\n");
  }
});

setTimeout(() => {
  child.kill();
  const byOp = new Map();
  for (const s of samples) {
    if (!byOp.has(s.op)) byOp.set(s.op, []);
    byOp.get(s.op).push(s.ms);
  }
  console.log(`\ncaptured ${samples.length} samples:`);
  for (const [op, list] of byOp) {
    const sorted = [...list].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    console.log(
      `  ${op.padEnd(12)} n=${String(list.length).padStart(3)} median=${median.toFixed(1)}ms max=${Math.max(...list).toFixed(1)}ms`,
    );
  }
  if (samples.length === 0) {
    console.error("no perf samples captured — did the app open the image?");
    process.exitCode = 1;
  }
}, CAPTURE_MS);
