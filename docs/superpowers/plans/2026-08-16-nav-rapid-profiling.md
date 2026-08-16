# NAV_rapid Profiling（進め方 2 / Step 1）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** NAV_rapid の「遅い hit」の支配要因（再フェッチ / 再デコード / serve 競合）を数値で確定し、仮説 C / A / B のどれに着手するかを決定できる profiling レポートを作る。**最適化コードは一切変更しない。**

**Architecture:** bench の wdio サービスは app の stderr を拾えない（既知の制限）ため、profiling 専用スクリプトが release exe を**自前で piped spawn** し（`SPICA_PERF=1` の serve ログを行到着時刻付きで捕捉）、同じ exe に組み込まれている **embedded W3C WebDriver サーバ**（`tauri-plugin-wdio-webdriver`、`TAURI_WEBDRIVER_PORT` で指定）へ素の HTTP で接続して `e2e/specs/bench.perf.ts` の NAV_rapid プロトコルを忠実に再現する。ブラウザ側マーク（`performance.now()` 基準）は `performance.timeOrigin` で wall clock に写像し、serve 行の到着時刻（= PerfTimer drop ≈ serve 終了）とオフラインで突き合わせる。capture と分析は別スクリプトに分離し、5 分超の capture を再実行せずに分析だけ反復できるようにする。

**Tech Stack:** Node .mjs（依存追加なし: `node:child_process` / `fetch` / W3C WebDriver HTTP）、既存の bench release ビルド（`VITE_PERF_LOG=1` + `--features e2e`）

**Spec:** `docs/PERFORMANCE_NAV_RAPID_PHASE2_HANDOFF.md`（特に「進め方 1 で判明した重要事実」1〜6 と「進め方（必須の順序）」1）

## Global Constraints

- **`src/` と `src-tauri/` は変更禁止**（profiling は計測のみ。アプリ側を触ると baseline 比較が無効になる）
- 新規ファイルはすべて `e2e/scripts/*.mjs` と docs のみ。`.mjs` なので `npm run type-check:test` に影響しない（main 由来の既存エラー 20 件はそのまま。修正しない）
- e2e/ は `npm run lint`/`format` の対象外 → 変更した各ファイルに **`npx biome format --write <paths>` と `npx biome lint <paths>` を明示的に実行**してからコミット（CI は全体を検査するため）
- capture 実行中（Task 1 Step 3 の smoke、Task 3 の本計測）は**他の重負荷処理を並走させない**
- 本計測は **runs × steps = 7 × 12 = 84 サンプル完全**でなければ無効（欠落したら原因調査してやり直し）
- コミットは worktree ブランチ `worktree-nav-rapid-phase2-profiling` 上で行う。コミットメッセージ末尾に `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## 前提（実行前に確認）

すでにバックグラウンドで実行済みのはずの 3 点を確認する。未完なら完了を待つ:

1. `npm test` が green（worktree の clean baseline 確認）
2. `e2e/fixtures/corpus/large/` に img-000.jpg 〜 img-015.jpg（16 枚、5472×3648）が存在（`npm run bench:corpus`。生成は seeded PRNG で決定的）
3. `src-tauri/target/release/spica-photo-viewer.exe` が存在し**現ソースと一致**（`npm run bench:build`）

## 事前登録する判定ルール（分析後の後付け解釈を防ぐ）

Task 3 のレポートは以下のルールで仮説を選ぶ（数値を見てからルールを変えない）:

- **R1（仮説 C: ビットマップ保持）**: hit-slow（hit かつ full paint ≥ 100ms）ステップの反実仮想置換（hit-slow の値を hit-fast 中央値に置換）で pooled 中央値が **≥ 30% 改善**する、かつ hit-slow の過半数で「serve 発火（再フェッチ実証）」または「open→decode:done ≥ 100ms（ブラウザ側再フェッチ+再デコード）」が確認できる → C を選ぶ。
- **R2（仮説 A: プレビューディスクキャッシュ）**: R1 が不成立で、miss ステップの反実仮想置換（miss の値を hit-fast 中央値に置換）の方が pooled 中央値を大きく動かす → A を選ぶ。
- **R3（serve 競合・直列化）**: hit-slow / miss の `open→decode:done` が対応 serve の `ms` を大幅に（> 150ms）超え、かつその窓内に他 path の serve が重なっている割合が高い場合は「競合/直列化」を主要因として記録し、C/A の選定にその影響を明記する（競合が支配的なら preload との排他制御を含む変種を brainstorming で検討）。
- どのルールにも明確に該当しない場合は結果をそのまま提示し、追加計測（何をどう測るか）を提案してレビューを受ける。

---

### Task 1: capture スクリプト `e2e/scripts/profile-nav-rapid.mjs`

**Files:**
- Create: `e2e/scripts/profile-nav-rapid.mjs`
- Modify: `package.json`（scripts に `profile:nav-rapid` を追加）

**Interfaces:**
- Consumes: bench release exe（embedded WebDriver、`TAURI_WEBDRIVER_PORT` / `WDIO_EMBEDDED_SERVER=true` で起動）、`window.__SPICA_TEST__` / `window.__PERF__`（VITE_PERF_LOG=1 ビルドで存在）
- Produces: `e2e/.tmp/profile-nav-rapid-raw.json` — 形は `{ capturedAt, runs, steps, corpus, timeOrigin, skewMs, files: string[], samples: [{run, step, path, navWall, entries: PerfEntry[]}], serves: [{perf, op, path, ms, endWall}] }`。`entries` は各ステップの `__PERF__` ダンプ（`{type, name, ts, detail}`）。`serves[].path` は percent-encoded URI path のまま（デコードは Task 2 の分析側で行う）。`endWall` は stderr 行の Node 到着時刻 `Date.now()`（≈ serve 終了時刻。パイプ遅延 ±10ms 程度は分析側で許容窓を持つ）。

- [ ] **Step 1: スクリプトを書く**

```js
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
    { timeout, interval: 100, msg: `no full-resolution paint:done for ${path}` },
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
```

- [ ] **Step 2: package.json の scripts に追加**

`"profile:rust"` の行の直後に:

```json
"profile:nav-rapid": "node e2e/scripts/profile-nav-rapid.mjs",
```

- [ ] **Step 3: smoke 実行（1 run × 3 steps）で動作検証**

Run: `PROFILE_RUNS=1 PROFILE_STEPS=3 npm run profile:nav-rapid`（PowerShell なら `$env:PROFILE_RUNS='1'; $env:PROFILE_STEPS='3'; npm run profile:nav-rapid`）

Expected:
- `timeOrigin=... skew=...ms` が出力され、**|skew| < 250ms**（これを超えたら timeOrigin 写像は使えない — 原因を調査）
- `run 0 done (3 samples so far)` と `raw profile written to ... (3 samples, N serve lines)`、**N ≥ 4**（初期 open 1 + preload ±5 分。0 なら SPICA_PERF が効いていない）
- 出力 JSON を開き、各 sample の `entries` に `open:request` / `preload`（event）/ `paint:done`(thumbnail:false) が含まれること、`serves[].op === "serve"` で `endWall` が付いていることを目視確認

- [ ] **Step 4: biome + コミット**

```bash
npx biome format --write e2e/scripts/profile-nav-rapid.mjs
npx biome lint e2e/scripts/profile-nav-rapid.mjs
git add e2e/scripts/profile-nav-rapid.mjs package.json
git commit -m "bench(profile): NAV_rapid capture via embedded webdriver + piped serve log"
```

---

### Task 2: 分析スクリプト `e2e/scripts/analyze-nav-rapid.mjs`

**Files:**
- Create: `e2e/scripts/analyze-nav-rapid.mjs`
- Modify: `package.json`（scripts に `profile:nav-rapid:analyze` を追加）

**Interfaces:**
- Consumes: Task 1 の `e2e/.tmp/profile-nav-rapid-raw.json`（引数でパス上書き可: `node e2e/scripts/analyze-nav-rapid.mjs [rawPath]`）
- Produces: stdout にレポート（下記セクション A〜E）。ファイルは書かない（レポート文書は Task 3 で人間が数値を転記する）

- [ ] **Step 1: スクリプトを書く**

```js
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
console.log(`total serve lines: ${serves.length}, ${stats(serves.map((s) => s.ms))}`);

console.log(`\n=== E. median decomposition / counterfactuals ===`);
const fastMedian = median(fp(hitFast)) ?? 0;
const cfSlowFixed = rows.map((r) =>
  r.hit && r.fullPaint >= SLOW_HIT_MS ? fastMedian : r.fullPaint,
);
const cfMissFixed = rows.map((r) => (!r.hit ? fastMedian : r.fullPaint));
console.log(`pooled median          ${fmt(median(fp(rows)))}`);
console.log(`cf: slow-hits -> fast  ${fmt(median(cfSlowFixed))}  (rule R1)`);
console.log(`cf: misses    -> fast  ${fmt(median(cfMissFixed))}  (rule R2)`);
```

- [ ] **Step 2: package.json の scripts に追加**

`"profile:nav-rapid"` の行の直後に:

```json
"profile:nav-rapid:analyze": "node e2e/scripts/analyze-nav-rapid.mjs",
```

- [ ] **Step 3: smoke データで実行し整合性を目視検証**

Run: `npm run profile:nav-rapid:analyze`（Task 1 Step 3 の 1×3 raw を読む。`sample count 3 != runs*steps 3` にならないこと — smoke は runs=1, steps=3 なので expected=3 で通る）

Expected:
- セクション A〜E が例外なく出力される
- A の `pooled n=3`、run 0 のみ
- 各ステップの hit/miss 分類が raw JSON の `preload` イベント（`detail.hit`）と一致（目視で 3 件照合）
- B/C で serve の対応付けが不自然でない（例: miss ステップに own serve が 1 件付く。0 件なら WebView2 の HTTP キャッシュが効いた可能性 — その事実も分析上意味があるのでレポートに書く）

- [ ] **Step 4: biome + コミット**

```bash
npx biome format --write e2e/scripts/analyze-nav-rapid.mjs
npx biome lint e2e/scripts/analyze-nav-rapid.mjs
git add e2e/scripts/analyze-nav-rapid.mjs package.json
git commit -m "bench(profile): NAV_rapid offline analyzer (mark/serve join, counterfactuals)"
```

---

### Task 3: 本計測（7×12）とレポート作成

**Files:**
- Create: `docs/PERFORMANCE_NAV_RAPID_PHASE2_PROFILING.md`（レポート）
- Modify: `docs/PERFORMANCE_NAV_RAPID_PHASE2_HANDOFF.md`（冒頭に進捗ブロック追記）

**Interfaces:**
- Consumes: Task 1 の capture、Task 2 の analyzer
- Produces: 仮説選定（C / A / B / 追加計測）とその根拠数値を含むレポート。次フェーズ（brainstorming → writing-plans）の入力

- [ ] **Step 1: マシンを静穏にして本計測**

他の重負荷アプリ・ビルド・ベンチを止めてから:

Run: `npm run profile:nav-rapid`（既定 RUNS=7 STEPS=12。~5-15 分）

Expected: `raw profile written to ... (84 samples, N serve lines)`。84 未満なら無効 — 原因を調査して再実行。

- [ ] **Step 2: 分析実行**

Run: `npm run profile:nav-rapid:analyze | tee e2e/.tmp/profile-nav-rapid-report.txt`

Expected: A〜E 全セクション出力。sanity check: pooled median が baseline NAV_rapid 377.25ms と同じレジーム（±50% 程度）にあること。大きく外れていたら計測条件（駆動経路の差・マシン状態）を疑い、原因を説明できるまでレポートを書かない。

- [ ] **Step 3: レポート `docs/PERFORMANCE_NAV_RAPID_PHASE2_PROFILING.md` を書く**

構成（数値は analyzer 出力から転記。「事前登録する判定ルール」R1〜R3 に照らした判定を明記）:

```markdown
# NAV_rapid Profiling 結果（進め方 2 / Step 1）

- 計測日 / gitSha / 計測条件（RUNS=7, STEPS=12, large corpus, release, SPICA_PERF=1）
- 計測方法の要約（embedded WebDriver 直駆動 + piped stderr。bench との差分: wdio を介さない点のみ、プロトコルは同一）
- A. クラス別分布（pooled / miss / hit-fast / hit-slow / run 0 vs 1+ / per-run 表）
- B. 遅い hit の解剖(件数、再フェッチ実証率、serve ms、open→decode、残差)
- C. miss の解剖（fetch_decode vs serve — ブラウザ側/Rust 側の分担）
- D. serve 競合（遅い窓での他 path serve 重なり）
- E. 中央値分解と反実仮想（R1/R2 の判定値）
- 結論: 採用仮説（C / A / B / 追加計測）と R1〜R3 のどれが成立したか
- 限界と注意（パイプ遅延 ±10ms、WebView2 HTTP キャッシュで serve が出ないケースの解釈、など観察されたもの）
```

- [ ] **Step 4: handoff 進捗ブロック追記**

`docs/PERFORMANCE_NAV_RAPID_PHASE2_HANDOFF.md` の blockquote 直後に:

```markdown
## 進捗（2026-08-16 更新）

- [x] worktree 作成・handoff 永続化
- [x] profiling ハーネス（e2e/scripts/profile-nav-rapid.mjs / analyze-nav-rapid.mjs）
- [x] 本計測 7×12 完了 — 結果と仮説選定: docs/PERFORMANCE_NAV_RAPID_PHASE2_PROFILING.md
- [ ] 選定仮説の brainstorming → writing-plans → 実装（レビュー待ち）
```

- [ ] **Step 5: コミットしてレビュー依頼**

```bash
git add docs/PERFORMANCE_NAV_RAPID_PHASE2_PROFILING.md docs/PERFORMANCE_NAV_RAPID_PHASE2_HANDOFF.md
git commit -m "docs(perf): NAV_rapid profiling results and hypothesis selection"
```

その後**停止してレビューを受ける**（handoff「進め方」2 に進むのは承認後。brainstorming から）。

---

## Self-Review

- **Spec coverage**: handoff「進め方 1」の確定事項 3 点 — (a) 遅い hit の件数・分布と serve 対応 → セクション A/B、(b) hit の open→decode と miss の fetch_decode の対比 + serve 並行度 → セクション B/C/D、(c) 中央値への hit/miss 寄与分解 → セクション E。カバー済み。
- **事実 4 の competing-src:set 注意**: analyzer は viewer/preloader を `src:set` で区別せず、serve の path+時刻窓で対応付ける設計（handoff の推奨通り）。
- **事実 6**: fire-and-forget を使わず full paint 待ち + 250ms 下限を bench と同一に再現。
- **Placeholder scan**: 全コード実体あり。TBD なし。
- **Type consistency**: raw JSON スキーマ（Task 1 Produces）と analyzer の参照（`raw.samples[].entries` / `raw.serves[].op/ms/endWall` / `raw.timeOrigin` / `raw.runs` / `raw.steps`）一致。npm script 名 `profile:nav-rapid` / `profile:nav-rapid:analyze` 一致。
