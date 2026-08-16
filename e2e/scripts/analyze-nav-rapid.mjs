// Offline analysis for profile-nav-rapid.mjs raw output. Joins browser-side
// __PERF__ marks (mapped to wall clock via performance.timeOrigin) with the
// Rust serve log (endWall = stderr line arrival ≈ serve end) and prints:
//  A. per-class stats (miss / hit-fast / hit-slow, run 0 vs runs 1+)
//  B. slow-hit anatomy: refetch evidence (serve in window), open→decode:done
//  C. miss anatomy: fetch_decode vs matched serve ms (browser vs Rust split)
//  D. serve concurrency: overlapping serves inside each slow step's window
//  E. median decomposition + counterfactuals (pre-registered rules R1/R2/R3
//     in docs/superpowers/plans/2026-08-16-nav-rapid-profiling.md)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rawPath =
  process.argv[2] ?? join(here, "../.tmp/profile-nav-rapid-raw.json");
const raw = JSON.parse(readFileSync(rawPath, "utf8"));

const SLOW_HIT_MS = 100; // hit with full paint >= this is a "slow hit"
const JOIN_TOLERANCE_MS = 20; // pipe-latency slack when joining serve windows

// nearest-rank, mirrors e2e/lib/stats.ts
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? null : s[Math.floor((s.length - 1) / 2)];
};
const p95 = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? null : s[Math.ceil(0.95 * s.length) - 1];
};
const fmt = (v) => (v === null ? "-" : v.toFixed(1));
const stats = (xs) =>
  `median=${fmt(median(xs))} p95=${fmt(p95(xs))} n=${xs.length}`;

// serve.path is the percent-encoded URI path ("/C%3A%5C...")
const decodeServePath = (p) =>
  decodeURIComponent(p.replace(/^\//, "")).toLowerCase();
const serves = raw.serves
  .filter((s) => s.op === "serve")
  .map((s) => ({
    path: decodeServePath(s.path),
    ms: s.ms,
    startWall: s.endWall - s.ms,
    endWall: s.endWall,
  }));

const toWall = (ts) => raw.timeOrigin + ts;

const rows = raw.samples.map((sample) => {
  const { run, step, path, entries } = sample;
  const lower = path.toLowerCase();
  const open = entries.find(
    (e) => e.name === "open:request" && e.detail?.path === path,
  );
  const paints = entries.filter(
    (e) => e.name === "paint:done" && e.detail?.path === path,
  );
  const full = paints.find((e) => e.detail?.thumbnail === false);
  const preload = entries.find(
    (e) => e.name === "preload" && e.detail?.path === path,
  );
  const srcSet = entries.find(
    (e) => e.name === "src:set" && e.detail?.path === path,
  );
  const decodeDone = entries.find(
    (e) =>
      e.name === "decode:done" &&
      e.detail?.path === path &&
      e.detail?.thumbnail === false,
  );
  if (!open || !full || !preload)
    throw new Error(
      `incomplete marks run=${run} step=${step} (open=${!!open} full=${!!full} preload=${!!preload})`,
    );
  const openWall = toWall(open.ts);
  const fullWall = toWall(full.ts);
  const winStart = openWall - JOIN_TOLERANCE_MS;
  const winEnd = fullWall + JOIN_TOLERANCE_MS;
  const ownServes = serves.filter(
    (s) => s.path === lower && s.endWall > winStart && s.startWall < winEnd,
  );
  const otherServes = serves.filter(
    (s) => s.path !== lower && s.endWall > winStart && s.startWall < winEnd,
  );
  return {
    run,
    step,
    path,
    hit: preload.detail?.hit === true,
    thumbnailFallback: preload.detail?.thumbnailFallback === true,
    fullPaint: full.ts - open.ts,
    firstPaint: paints[0].ts - open.ts,
    openToDecode: decodeDone ? decodeDone.ts - open.ts : null,
    fetchDecode: srcSet && decodeDone ? decodeDone.ts - srcSet.ts : null,
    ownServes,
    otherServes,
  };
});

const expected = raw.runs * raw.steps;
if (rows.length !== expected)
  throw new Error(`sample count ${rows.length} != runs*steps ${expected}`);

const misses = rows.filter((r) => !r.hit);
const hits = rows.filter((r) => r.hit);
const hitFast = hits.filter((r) => r.fullPaint < SLOW_HIT_MS);
const hitSlow = hits.filter((r) => r.fullPaint >= SLOW_HIT_MS);
const fp = (rs) => rs.map((r) => r.fullPaint);

console.log(`\n=== A. per-class full-paint stats (${rows.length} samples) ===`);
console.log(`pooled       ${stats(fp(rows))}`);
console.log(`miss         ${stats(fp(misses))}`);
console.log(`hit-fast     ${stats(fp(hitFast))} (< ${SLOW_HIT_MS}ms)`);
console.log(`hit-slow     ${stats(fp(hitSlow))} (>= ${SLOW_HIT_MS}ms)`);
console.log(`run 0        ${stats(fp(rows.filter((r) => r.run === 0)))}`);
console.log(`runs 1+      ${stats(fp(rows.filter((r) => r.run > 0)))}`);
for (let k = 0; k < raw.runs; k++) {
  const rr = rows.filter((r) => r.run === k);
  console.log(
    ` run ${k}: hits ${rr.filter((r) => r.hit).length}/${rr.length}, slow-hits ${rr.filter((r) => r.hit && r.fullPaint >= SLOW_HIT_MS).length}, ${stats(fp(rr))}`,
  );
}

console.log(`\n=== B. slow-hit anatomy (n=${hitSlow.length}) ===`);
const slowWithServe = hitSlow.filter((r) => r.ownServes.length > 0);
console.log(
  `refetch proven (own serve in window): ${slowWithServe.length}/${hitSlow.length}`,
);
console.log(
  `own serve ms          ${stats(slowWithServe.flatMap((r) => r.ownServes.map((s) => s.ms)))}`,
);
console.log(
  `open->decode:done     ${stats(hitSlow.map((r) => r.openToDecode).filter((v) => v !== null))}`,
);
console.log(
  `decode->paint residual ${stats(
    hitSlow
      .filter((r) => r.openToDecode !== null)
      .map((r) => r.fullPaint - r.openToDecode),
  )}`,
);
for (const r of hitSlow)
  console.log(
    ` run${r.run} step${r.step}: full=${r.fullPaint.toFixed(0)} o2d=${r.openToDecode === null ? "-" : r.openToDecode.toFixed(0)} ownServe=[${r.ownServes.map((s) => s.ms.toFixed(0)).join(",")}] others=${r.otherServes.length}`,
  );

console.log(`\n=== C. miss anatomy (n=${misses.length}) ===`);
console.log(
  `fetch_decode (src:set->decode) ${stats(misses.map((r) => r.fetchDecode).filter((v) => v !== null))}`,
);
console.log(
  `own serve ms                   ${stats(misses.flatMap((r) => r.ownServes.map((s) => s.ms)))}`,
);
console.log(
  `own serves per miss            ${stats(misses.map((r) => r.ownServes.length))}`,
);

console.log(`\n=== D. serve concurrency in slow windows ===`);
const slowish = rows.filter((r) => r.fullPaint >= SLOW_HIT_MS);
console.log(
  `overlapping other-path serves per slow step ${stats(slowish.map((r) => r.otherServes.length))}`,
);
console.log(
  `total serve lines: ${serves.length}, ${stats(serves.map((s) => s.ms))}`,
);

console.log(`\n=== E. median decomposition / counterfactuals ===`);
const fastMedian = median(fp(hitFast)) ?? 0;
const cfSlowFixed = rows.map((r) =>
  r.hit && r.fullPaint >= SLOW_HIT_MS ? fastMedian : r.fullPaint,
);
const cfMissFixed = rows.map((r) => (!r.hit ? fastMedian : r.fullPaint));
console.log(`pooled median          ${fmt(median(fp(rows)))}`);
console.log(`cf: slow-hits -> fast  ${fmt(median(cfSlowFixed))}  (rule R1)`);
console.log(`cf: misses    -> fast  ${fmt(median(cfMissFixed))}  (rule R2)`);
