# NAV_rapid / PLACEHOLDER_dur 計測系拡張 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ユーザー実機で確認された「高速ナビ時にぼやけたプレースホルダーが〜1s 見える」苦情を再現する新指標 **NAV_rapid**（連続ナビ各ステップの open:request→フル品質 paint）と **PLACEHOLDER_dur**（最初の paint→フル品質 paint の間隔）を bench に追加し、baseline を記録する。**最適化コードの変更は一切しない**（src/・src-tauri/ は不変更）。

**Architecture:** 既存の `bench.perf.ts` セッション（NAV_warm→NAV_cold の後）に NAV_rapid の it ブロックを追加し、セッション内で large コーパスフォルダへ切り替えて N=7 run × 12 ステップの連続ナビを実行する。ペーシングは「**フル品質 paint を待って次へ進む（下限 250ms）**」方式（理由は下記「設計判断」）。計測マークは既存のもの（`open:request` / `paint:done` detail.thumbnail / `preload` detail.hit / `src:set` / `decode:done`）だけで足りるため、アプリ側の変更はゼロ。large コーパスを 8→16 枚に拡張する（生成器は per-file 決定論なので既存 8 枚はバイト不変 = TTFI_cold の対象画像は不変）。あわせて park 済み follow-up「`bench:baseline` の bench 再実行仕様」を直接 canonize 方式に修正する（引き継ぎ文書が明示推奨）。

**Tech Stack:** 既存 bench ハーネス（WebdriverIO + `@wdio/tauri-service` embedded、`e2e/lib/bench-helpers.ts`、`e2e/lib/stats.ts`）。vitest（`e2e/lib/*.test.ts` は `npm test` に含まれる）。

**Spec:** `docs/PERFORMANCE_NAV_RAPID_HANDOFF.md`（「進め方 1」が本プランの範囲）。指標定義の正本は `docs/PERFORMANCE_AUTONOMY_PLAN.md` §2/§4（Task 6 で更新）。運用ゲートは `CLAUDE.md`「Performance changes」。

## 設計判断（レビュー対象。実装前に必ず読むこと）

1. **ペーシングは固定 250ms 間隔の fire-and-forget ではない。** `ImageViewer.tsx` の useEffect は `currentImage.path` 変更時に前のロードを **abort** する（`abortControllerRef` + `activeLoadPathRef` ガード）。固定間隔連打では MISS ステップ（フル解像度 ~400-550ms）は次のナビで中断され `paint:done thumbnail:false` が**永遠に発生しない**。残るサンプルは「preload ヒット（~23ms）+ バースト最終ステップ」だけになり、中央値が生存バイアスで 23ms 側に壊れる（baseline で既にゲート目標を「達成」してしまい、指標として機能しない）。そこで各ステップは `waitForFullPaint` で**フル品質 paint を待ってから**次のナビを発行し、ナビ間隔の下限を 250ms とする（`elapsed < 250ms` なら残りを pause）。これは「画像がシャープになった瞬間に次へ進むユーザー」の再現であり、全ステップが検閲なしの 1 サンプルを産む。挙動が良くなれば cadence は自然に 250ms（引き継ぎの想定間隔）へ収束する。
2. **ヒットとミスを両方サンプルに含める（除外ルールなし）。** NAV_warm（MISS 除外）/ NAV_cold（HIT 除外）と異なり、NAV_rapid は「サムネイルバー可視範囲を連続ナビしたときの体感」の指標なので、preload ヒット/ミスの混在そのものが測定対象。`n = runs × steps = 84` 固定（欠けたら計測失敗）。`hit_rate` を診断用に併記する。
3. **開始状態は決定論的に固定する。** 各 run は「index 0 表示、preload 静穏、preloaded = {0..5}」から開始（`waitForPreloadSettled(5)` → `waitForPreloadQuiet()`。preloader は `allGenerated` 後にしか走らないため settled はサムネイル全生成も含意する）。したがって最初の ~5 ステップはヒット（瞬時）、6 ステップ目以降は preloader を追い越して持続的 MISS になる。これはユーザー報告（アイドル位置から連続ナビを始めると途中からぼやける）と同型。run 間リセットは `navigateToImage(0)` → full paint 待ち → 静穏待ちで、preloader の cleanup が {0..5} 以外を確実に追い出す。
4. **preload は 250ms 連打中は一度も走らない**（`useImagePreloader` の 500ms タイマーは index 変更のたびにリセット）。ただしフル paint 待ち方式では MISS ステップが 500ms を超えることがあり、その時だけ preload が発火して以降のステップと競合する。これはアプリの実挙動そのものなので排除しない（分散は pooled n=84 と中央値主判定で吸収）。進め方 2 の profiling で内訳を取るため `breakdown.fetch_decode_rapid_miss`（MISS ステップの `src:set`→`decode:done`）を記録する。
5. **PLACEHOLDER_dur = fullPaint − firstPaint。** ヒット（最初の paint が既にフル品質）は 0。0 は正しい値（引き継ぎ文書どおり）。degenerate ガードは `median_ms === null` 判定なので median 0 の baseline 化を妨げない。
6. **large コーパス 8→16 枚。** 12 ステップには 13 枚以上必要。`generate-corpus.mjs` は seed = `name.length * 1000 + i` の per-file 決定論 + `existsSync` skip なので、count 変更で既存 img-000..007 は再生成されず、fresh 環境で全生成しても同一バイト。TTFI_cold は `files[coldIndex % 16]`、coldIndex 0..6 → img-000..006 で従来と同一。フォルダ内画像数 8→16 による TTFI_cold への影響は、サムネイル生成開始が open 後 500ms デバウンス以降（median 483.8ms の計測区間の後）である点と、生成順が現在 index 近傍からである点から無視できる（Task 7 の回帰 sanity 比較で実証する）。

## Global Constraints

- **本プランで src/ と src-tauri/ は 1 行も変更しない**（計測系なしの最適化禁止の逆: 最適化なしの計測系拡張）。変更が必要になったらプラン違反 — 停止してレビューに戻す。
- 既存 3 指標（TTFI_cold / NAV_warm / NAV_cold）の**計測条件を変えない**: NAV_rapid の it ブロックは NAV_cold の後に置く（medium コーパスでの両指標の実行順・セッション状態は現状維持）。`ttfi-cold.perf.ts` / `run-bench.mjs` は不変更。
- 計測は必ず release ビルド（`npm run bench:build` → `npm run bench`）。N=7（`BENCH_RUNS`）。ベンチ中は他の重負荷アプリ禁止。
- 採否（本プランは計測系のみなので）: `npm test`・`cd src-tauri && cargo test --lib`・`npm run type-check`・`npm run type-check:test` green + Task 7 の回帰 sanity（既存 3 指標が現 baseline の p95 幅内）+ `npm run test:e2e` green。
- **サブエージェント編集では biome の PostToolUse hook が発火しない**（CI 落ち実績 2 回）。各タスクのコミット前に、変更した全ファイルへ `npx biome format --write <paths>` と `npx biome lint <paths>` を実行し、差分・エラーゼロを確認してからコミットすること（`npm run lint` / `npm run format` は **src/ しか見ない**ため e2e/ の変更には使えない）。
- コミットメッセージは Conventional Commits、`Co-Authored-By: Claude <noreply@anthropic.com>` を付ける。

## ファイル構成

| ファイル | 責務 |
|---|---|
| Modify: `e2e/scripts/generate-corpus.mjs` | large count 8→16 |
| Modify: `e2e/lib/bench-helpers.ts` | `placeholderDuration()` 純関数の追加 |
| Modify: `e2e/lib/bench-helpers.test.ts` | 同関数の単体テスト |
| Modify: `e2e/specs/bench.perf.ts` | NAV_rapid it ブロック + after() 集計への NAV_rapid / PLACEHOLDER_dur / fetch_decode_rapid_miss 追加 |
| Modify: `e2e/scripts/save-baseline.mjs` | NAV_rapid / PLACEHOLDER_dur の degenerate ガード |
| Modify: `package.json` | `bench:baseline` を直接 canonize 方式へ |
| Modify: `docs/PERFORMANCE_AUTONOMY_PLAN.md` | §2 指標定義 / §4 スキーマ / §5 スクリプト / §8 baseline 表 |
| Modify: `CLAUDE.md` | 本ワークストリームの目標ゲートと NAV_rapid の n 規則 |
| Modify: `bench-results/baseline.json` | 新指標入り baseline（Task 7、判定 run と同一 JSON） |

---

### Task 1: large コーパス拡張（8→16 枚）

（このプランファイル自体はプラン作成セッションでコミット済み — 消失事故の再発防止。）

**Files:**
- Modify: `e2e/scripts/generate-corpus.mjs`

**Interfaces:**
- Consumes: なし（sharp は devDependencies 済み）
- Produces: `e2e/fixtures/corpus/large/img-000.jpg` .. `img-015.jpg`（16 枚、git 管理外）。後続タスクは `corpusFiles("large").length === 16` を前提にできる

- [ ] **Step 1: SETS の large count を 16 に変更**

`e2e/scripts/generate-corpus.mjs` の該当行:

```js
// 変更前
  { name: "large", width: 5472, height: 3648, count: 8 },
// 変更後
  { name: "large", width: 5472, height: 3648, count: 16 },
```

- [ ] **Step 2: 決定論の実証（既存ファイルが変わらないこと）**

PowerShell で実行:

```powershell
Get-FileHash e2e/fixtures/corpus/large/img-000.jpg | Select-Object -ExpandProperty Hash | Set-Content "$env:TEMP\img000-before.txt"
Remove-Item e2e/fixtures/corpus/large/img-000.jpg
npm run bench:corpus
Get-FileHash e2e/fixtures/corpus/large/img-000.jpg | Select-Object -ExpandProperty Hash | Set-Content "$env:TEMP\img000-after.txt"
Compare-Object (Get-Content "$env:TEMP\img000-before.txt") (Get-Content "$env:TEMP\img000-after.txt")
```

Expected: `Compare-Object` の出力が空（ハッシュ一致 = 再生成しても同一バイト）。かつ `img-008.jpg`〜`img-015.jpg` が新規生成され、large が計 16 枚になっている（`(Get-ChildItem e2e/fixtures/corpus/large/*.jpg).Count` → `16`）。

- [ ] **Step 3: biome 検証**

```
npx biome format --write e2e/scripts/generate-corpus.mjs
npx biome lint e2e/scripts/generate-corpus.mjs
```

Expected: 差分なし・エラーなし。

- [ ] **Step 4: コミット**

```bash
git add e2e/scripts/generate-corpus.mjs
git commit -m "bench: grow large corpus to 16 images for NAV_rapid steps"
```

（コーパス自体は git 管理外 — 生成器コメント「Never commit the generated files」に従う。）

---

### Task 2: `placeholderDuration()` 純関数（TDD）

**Files:**
- Modify: `e2e/lib/bench-helpers.ts`
- Test: `e2e/lib/bench-helpers.test.ts`

**Interfaces:**
- Consumes: `Timings` 型（`bench-helpers.ts` 既存。`firstPaint: number; fullPaint: number; fetchDecode: number | null`）
- Produces: `export const placeholderDuration = (timings: Timings): number` — Task 3 の spec がステップ毎に呼ぶ。戻り値はミリ秒、プレースホルダー非表示（単段 paint）のとき 0

- [ ] **Step 1: 失敗するテストを書く**

`e2e/lib/bench-helpers.test.ts` の import に `placeholderDuration` を追加し、describe を追記:

```ts
import {
  extractTimings,
  type PerfEntry,
  placeholderDuration,
} from "./bench-helpers";

describe("placeholderDuration", () => {
  const path = "/corpus/large/img-01.jpg";

  it("returns the thumbnail->full-res gap for a two-stage paint", () => {
    const entries: PerfEntry[] = [
      { type: "mark", name: "open:request", ts: 0, detail: { path } },
      {
        type: "mark",
        name: "paint:done",
        ts: 30,
        detail: { path, thumbnail: true },
      },
      { type: "mark", name: "src:set", ts: 35, detail: { path } },
      {
        type: "mark",
        name: "decode:done",
        ts: 400,
        detail: { path, thumbnail: false },
      },
      {
        type: "mark",
        name: "paint:done",
        ts: 430,
        detail: { path, thumbnail: false },
      },
    ];
    expect(placeholderDuration(extractTimings(entries, path))).toBe(400); // 430 - 30
  });

  it("returns 0 when the first paint is already full resolution (preload hit)", () => {
    const entries: PerfEntry[] = [
      { type: "mark", name: "open:request", ts: 0, detail: { path } },
      {
        type: "mark",
        name: "paint:done",
        ts: 25,
        detail: { path, thumbnail: false },
      },
    ];
    expect(placeholderDuration(extractTimings(entries, path))).toBe(0);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest --run e2e/lib/bench-helpers.test.ts`
Expected: FAIL（`placeholderDuration` が export されていない import エラー）。

- [ ] **Step 3: 最小実装**

`e2e/lib/bench-helpers.ts` の `extractTimings` の直後に追加:

```ts
/**
 * Placeholder visibility interval for one navigation: first paint (usually
 * the blurry thumbnail fallback) -> full-resolution paint. 0 is a valid
 * value and means no placeholder was perceivable (the first paint already
 * was full resolution, e.g. a preload hit).
 */
export const placeholderDuration = (timings: Timings): number =>
  timings.fullPaint - timings.firstPaint;
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest --run e2e/lib/bench-helpers.test.ts` → PASS。続けて全体: `npm test` → 全件 green。

- [ ] **Step 5: biome 検証 + コミット**

```
npx biome format --write e2e/lib/bench-helpers.ts e2e/lib/bench-helpers.test.ts
npx biome lint e2e/lib/bench-helpers.ts e2e/lib/bench-helpers.test.ts
```

```bash
git add e2e/lib/bench-helpers.ts e2e/lib/bench-helpers.test.ts
git commit -m "bench: add placeholderDuration helper for PLACEHOLDER_dur metric"
```

---

### Task 3: NAV_rapid スペックと集計（bench.perf.ts）

**Files:**
- Modify: `e2e/specs/bench.perf.ts`

**Interfaces:**
- Consumes: `corpusFiles` / `clearPerf` / `openImage` / `navigateToImage` / `waitForFullPaint` / `extractTimings` / `preloadHit` / `placeholderDuration` / `summarize` / `defined`（既存 + Task 2）。既存ローカルヘルパー `waitForPreloadSettled` / `waitForPreloadQuiet`
- Produces: 出力 JSON の `metrics.NAV_rapid`（`{median_ms, p95_ms, n, steps, hit_rate}`）、`metrics.PLACEHOLDER_dur`（`{median_ms, p95_ms, n}`）、`metrics.breakdown.fetch_decode_rapid_miss`（`{median_ms, p95_ms, n}`）。Task 4 のガードと Task 6 の docs はこの形を正とする

- [ ] **Step 1: 定数とサンプル置き場を追加**

`bench.perf.ts` の `COLD_JUMP_STRIDE` 定義の下に:

```ts
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
```

`results` 定義の下に:

```ts
/** NAV_rapid pools every step of every run - hits AND misses both count. */
const rapid = {
  fullPaint: [] as number[],
  placeholderDur: [] as number[],
  missFetchDecode: [] as number[],
  hits: 0,
  total: 0,
};
```

import 文の `extractTimings` の並びに `placeholderDuration` を追加する。

- [ ] **Step 2: NAV_cold の it ブロックの直後に NAV_rapid の it ブロックを追加**

```ts
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
        // Reset to the deterministic start state: current = 0, preloader
        // quiet, preloaded = {0..5} (cleanupCache evicts everything else
        // during the quiet wait). The reset navigation is not measured.
        await clearPerf();
        await navigateToImage(0);
        await waitForFullPaint(files[0]);
        await waitForPreloadQuiet();
      }

      for (let step = 1; step <= RAPID_STEPS; step++) {
        await clearPerf();
        const navAt = Date.now();
        await navigateToImage(step);
        const entries = await waitForFullPaint(files[step]);

        const timings = extractTimings(entries, files[step]);
        rapid.total++;
        rapid.fullPaint.push(timings.fullPaint);
        rapid.placeholderDur.push(placeholderDuration(timings));
        const hit = preloadHit(entries, files[step]);
        if (hit === true) rapid.hits++;
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
    }
    console.log(
      `NAV_rapid samples: ${JSON.stringify(rapid.fullPaint)} (hits ${rapid.hits}/${rapid.total})`,
    );
    console.log(
      `PLACEHOLDER_dur samples: ${JSON.stringify(rapid.placeholderDur)}`,
    );
  });
```

- [ ] **Step 3: after() の out.metrics に集計を追加**

`NAV_cold: summarize(results.NAV_cold),` の直後 + breakdown を拡張:

```ts
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
```

- [ ] **Step 4: 型・整形の検証**

```
npx biome format --write e2e/specs/bench.perf.ts
npx biome lint e2e/specs/bench.perf.ts
npm run type-check:test
npm test
```

Expected: すべて green（bench.perf.ts は wdio 実行ファイルなので vitest 対象外だが、helpers 経由の型は `type-check:test` が拾う。e2e/tsconfig.json が独立している場合は `npx tsc --project e2e/tsconfig.json --noEmit` も実行して green を確認）。

- [ ] **Step 5: スモーク実行（ロジック検証、数値は捨てる）**

release ビルドが無ければ `npm run bench:build`（〜10 分）。その後、短縮設定で NAV_rapid ブロックだけの動作を確認する:

```powershell
$env:BENCH_RUNS = "2"
node node_modules/@wdio/cli/bin/wdio.js run e2e/wdio.conf.ts --spec e2e/specs/bench.perf.ts
Remove-Item Env:BENCH_RUNS
```

Expected: NAV_warm / NAV_cold / NAV_rapid が run=2 で完走し、コンソールに `NAV_rapid samples: [...] (hits X/24)` が出る。`hits` が 0 でも 24 でもない（ヒット→ミス遷移が起きている）こと、`PLACEHOLDER_dur samples` に 0（ヒット由来）と正値（ミス由来）が混在することを確認。JSON は cold サンプル無しのため TTFI_cold が null になるが、それはこのスモークでは正常（`npm run bench` 経由でのみ完全な JSON になる）。生成された `bench-results/<sha>-*.json` スモーク産物は削除する（`baseline.json` 以外の新規 JSON）。

- [ ] **Step 6: コミット**

```bash
git add e2e/specs/bench.perf.ts
git commit -m "bench: add NAV_rapid + PLACEHOLDER_dur metrics for sustained navigation"
```

---

### Task 4: save-baseline の degenerate ガード拡張

**Files:**
- Modify: `e2e/scripts/save-baseline.mjs`

**Interfaces:**
- Consumes: Task 3 の JSON 形（`metrics.NAV_rapid.steps` / `.n` / `.median_ms`、`metrics.PLACEHOLDER_dur.n` / `.median_ms`、トップレベル `runs`）
- Produces: NAV_rapid / PLACEHOLDER_dur が欠損・不完全な run の baseline 化を拒否する挙動

- [ ] **Step 1: ガードを追加**

既存の `for (const key of ["TTFI_cold", "NAV_warm", "NAV_cold"])` ループの直後に:

```js
// NAV_rapid / PLACEHOLDER_dur pool steps x runs samples with no exclusion
// rule, so anything short of a full pool means steps failed to paint.
// median_ms === 0 is legitimate for PLACEHOLDER_dur (no placeholder shown).
const rapid = data.metrics?.NAV_rapid;
const expectedRapidN = data.runs * (rapid?.steps ?? 0);
for (const [key, m] of [
  ["NAV_rapid", rapid],
  ["PLACEHOLDER_dur", data.metrics?.PLACEHOLDER_dur],
]) {
  if (!m || m.median_ms === null || m.n !== expectedRapidN || expectedRapidN === 0) {
    throw new Error(
      `${newest.f}: ${key} is degenerate (median_ms=${m?.median_ms}, n=${m?.n}, expected n=${expectedRapidN}) - refusing to save as baseline`,
    );
  }
}
```

- [ ] **Step 2: 動作検証（合成 JSON でネガティブ/ポジティブ確認）**

`bench-results/` に触れずに検証するため、一時ディレクトリで node -e により直接関数ロジックを試すのは構造上できない（スクリプトはディレクトリ固定）。代わりに: 現 `bench-results/baseline.json`（NAV_rapid なし）より新しい mtime のダミー JSON を `bench-results/` に置いて実行し、拒否されることを確認する。

```powershell
Copy-Item bench-results/baseline.json bench-results/tmp-degenerate-test.json
node e2e/scripts/save-baseline.mjs
```

Expected: `NAV_rapid is degenerate ... refusing to save as baseline` で異常終了（baseline.json は書き換わらない）。確認後 `Remove-Item bench-results/tmp-degenerate-test.json`。ポジティブ側は Task 7 の実 run で確認する。

- [ ] **Step 3: biome 検証 + コミット**

```
npx biome format --write e2e/scripts/save-baseline.mjs
npx biome lint e2e/scripts/save-baseline.mjs
```

```bash
git add e2e/scripts/save-baseline.mjs
git commit -m "bench: guard baseline canonization on NAV_rapid/PLACEHOLDER_dur completeness"
```

---

### Task 5: `bench:baseline` を直接 canonize 方式へ（park 済み follow-up）

**Files:**
- Modify: `package.json`
- Modify: `e2e/scripts/save-baseline.mjs`（ヘッダコメントのみ）
- Modify: `CLAUDE.md`（該当 1 行）

**Interfaces:**
- Consumes: `save-baseline.mjs` の「最新 JSON を baseline へコピー + degenerate ガード」挙動（Task 4 済み）
- Produces: `npm run bench:baseline` = 「bench を**再実行せず**、直近の判定 run の JSON をそのまま baseline 化」。以降の採否サイクルは判定に使った run と baseline が同一データになる

- [ ] **Step 1: package.json のスクリプト変更**

```jsonc
// 変更前
"bench:baseline": "npm run bench && node e2e/scripts/save-baseline.mjs",
// 変更後
"bench:baseline": "node e2e/scripts/save-baseline.mjs",
```

- [ ] **Step 2: save-baseline.mjs のヘッダコメント更新**

```js
// 変更前
// Copies the newest bench result to bench-results/baseline.json.
// 変更後
// Canonizes the newest bench result as bench-results/baseline.json.
// Intentionally does NOT re-run the bench: the JSON that passed the
// adoption gate must itself become the baseline (a re-run under tight
// thresholds can land on the other side of the gate by noise alone).
```

- [ ] **Step 3: CLAUDE.md の該当行を更新**

「Performance changes」節の行:

```markdown
<!-- 変更前 -->
- 採用時は `npm run bench:baseline` で `baseline.json` を更新し、同じコミットに含める。
<!-- 変更後 -->
- 採用時は `npm run bench:baseline` で `baseline.json` を更新し、同じコミットに含める（bench は再実行されず、判定に使った直近 run の JSON がそのまま baseline になる）。
```

- [ ] **Step 4: 検証 + コミット**

`npm run bench:baseline` を実行し、（Task 4 Step 2 のダミーを消していれば）「最新 = 現 baseline のコピー元」か Task 3 スモークの残骸かに応じてガードが動くことを確認（スモーク JSON を削除済みなら `no bench results found` か、既存の古い result への拒否）。bench が走り出さないことだけが確認点。

```
npx biome format --write e2e/scripts/save-baseline.mjs
npx biome lint e2e/scripts/save-baseline.mjs
```

```bash
git add package.json e2e/scripts/save-baseline.mjs CLAUDE.md
git commit -m "bench: canonize the judged run directly instead of re-running bench"
```

---

### Task 6: 指標定義ドキュメントの更新（baseline 記録の前に）

**Files:**
- Modify: `docs/PERFORMANCE_AUTONOMY_PLAN.md`（§2 / §4 / §5）
- Modify: `CLAUDE.md`（「Performance changes」節）

**Interfaces:**
- Consumes: Task 3 の実装済み挙動（正本は docs ではなくコード側 — docs をコードに一致させる）
- Produces: 以降のセッションが NAV_rapid / PLACEHOLDER_dur を同じ意味で測り続けるための定義文書

- [ ] **Step 1: PERFORMANCE_AUTONOMY_PLAN.md §2 に指標定義を追記**

「集計する指標:」リストの `NAV_cold` の行の後に追加:

```markdown
- **NAV_rapid**: preload の定常化を待たない連続ナビゲーション（large コーパス、12 ステップ × N run、ステップ間隔はフル品質 paint 待ち + 下限 250ms）での各ステップの `open:request` → `paint:done`(thumbnail: false)。**ヒット/ミスを除外せず全ステップを pool する**（n = runs × steps）。固定間隔の fire-and-forget を使わない理由: ImageViewer は後続ナビで進行中ロードを abort するため、固定間隔では MISS ステップのフル品質 paint が発生せず、生存サンプルが preload ヒットに偏って中央値が壊れる。`hit_rate` を診断用に併記。
- **PLACEHOLDER_dur**: NAV_rapid の同一サンプルにおける「最初の `paint:done`（サムネイル fallback）→ フル品質 `paint:done`」の間隔。プレースホルダー非表示（最初の paint が既にフル品質）のときは **0 が正しい値**。
```

直後に注記:

```markdown
> NAV_rapid / PLACEHOLDER_dur の n は runs × steps（既定 7 × 12 = 84）で固定。除外ルールがないため n < runs × steps は計測失敗を意味する（save-baseline がガードする）。n=84 の nearest-rank p95 は n=7 と違い外れ値 1 個では汚染されないため、この 2 指標に限り p95 も参考値以上に使ってよい。
```

- [ ] **Step 2: §4 スキーマの JSON 例を更新**

`"NAV_cold": { "median_ms": 0, "p95_ms": 0, "n": 7 },` の後に:

```json
    "NAV_rapid": {
      "median_ms": 0,
      "p95_ms": 0,
      "n": 84,
      "steps": 12,
      "hit_rate": 0.42
    },
    "PLACEHOLDER_dur": { "median_ms": 0, "p95_ms": 0, "n": 84 },
```

`breakdown` に `"fetch_decode_rapid_miss": { "median_ms": 0, "p95_ms": 0, "n": 0 }` を追加。

- [ ] **Step 3: §5 のスクリプト一覧の `bench:baseline` を現実に合わせる**

```jsonc
"bench:baseline": "node e2e/scripts/save-baseline.mjs"
```

- [ ] **Step 4: CLAUDE.md「Performance changes」に本ワークストリームの目標ゲートを追記**

節末に追加:

```markdown
- 体感ナビゲーション（NAV_rapid ワークストリーム）の目標: NAV_rapid フル品質 paint 中央値 < 100ms かつ PLACEHOLDER_dur 中央値 < 80ms（またはプレースホルダー非表示 = 0）。NAV_rapid / PLACEHOLDER_dur の n は runs × steps（7 × 12 = 84）に満たなければその run は無効。
```

- [ ] **Step 5: コミット**

```bash
git add docs/PERFORMANCE_AUTONOMY_PLAN.md CLAUDE.md
git commit -m "docs(perf): define NAV_rapid / PLACEHOLDER_dur metrics and goal gates"
```

---

### Task 7: フルベンチ実行と baseline 記録

**Files:**
- Modify: `bench-results/baseline.json`（新指標入り）
- Modify: `docs/PERFORMANCE_AUTONOMY_PLAN.md`（§8 baseline 表）

**Interfaces:**
- Consumes: Task 1–6 のすべて。release ビルド（`npm run bench:build`）
- Produces: NAV_rapid / PLACEHOLDER_dur の baseline 数値（以降の最適化サイクルの比較基準）

- [ ] **Step 1: 正しさゲートを先に全部通す**

```
npm test
cd src-tauri && cargo test --lib && cd ..
npm run type-check
npm run type-check:test
```

Expected: 全件 green（src/ 無変更なので Rust は既存どおり通るはず。落ちたら環境問題 — 原因を特定してから進む）。

- [ ] **Step 2: release ビルドとフルベンチ**

```
npm run bench:build
npm run bench
```

（〜25 分。他の重負荷アプリを起動しない。再起動直後なら捨て run を 1 回挟む。）

- [ ] **Step 3: sanity チェック（canonize 前に必ず）**

生成された `bench-results/<sha>-<timestamp>.json` を読み、以下を確認:

1. **回帰 sanity**: TTFI_cold / NAV_warm / NAV_cold の median が現 baseline（TTFI_cold 483.8 / NAV_warm 23.1 / NAV_cold 179.9）に対し現 baseline の p95 幅（629.2 / 32.9 / 252.9）内。アプリコード無変更なので大きくズレたら計測環境かコーパス拡張の影響 — 原因を説明できるまで canonize しない（特に TTFI_cold: large フォルダ 16 枚化の影響が出ていないことの実証点）。
2. **n の完全性**: TTFI_cold n=7、NAV_warm n=7（MISS 除外が発生していない）、NAV_cold n=7、NAV_rapid n=84、PLACEHOLDER_dur n=84。n 不足は原因調査（CLAUDE.md 規則）。
3. **NAV_rapid の妥当性**: hit_rate が 0 でも 1 でもない（開始 5 ステップのヒット→以降ミスの遷移が出ている。期待値 ~5/12 ≈ 0.42 近辺）。PLACEHOLDER_dur に 0 と正値が混在。fetch_decode_rapid_miss の median が fetch_decode_cold（395.4ms）と同オーダー。
4. 期待される数値感（外れていたら設計判断 1〜4 を再検証）: NAV_rapid median 300〜800ms / PLACEHOLDER_dur median 300〜700ms（ユーザー苦情「体感 ~1s」の計測値化。100ms 未満なら苦情を再現できておらず設計見直し）。

- [ ] **Step 4: canonize と §8 更新を同一コミットで**

```
npm run bench:baseline
```

Expected: `baseline.json <- <newest>.json`（Task 4 のガードを通過）。

`docs/PERFORMANCE_AUTONOMY_PLAN.md` §8 の表に NAV_rapid / PLACEHOLDER_dur / fetch_decode_rapid_miss の行を実測値で追加し（corpus 列は large、目標列: NAV_rapid < 100、PLACEHOLDER_dur < 80 または 0）、見出しの gitSha / timestamp / 注記を新 baseline に合わせて更新。旧 baseline 値（TTFI_cold 483.8 等）は本文の履歴注記として残す。

```bash
git add bench-results/baseline.json docs/PERFORMANCE_AUTONOMY_PLAN.md
git commit -m "bench: record NAV_rapid/PLACEHOLDER_dur baseline (reproduces perceived nav latency)"
```

- [ ] **Step 5: 視覚ゲート**

```
npm run test:e2e
```

Expected: smoke + visual green（計測系のみの変更なので落ちる理由がない。落ちたら原因調査）。

- [ ] **Step 6: 最終検証**

`superpowers:verification-before-completion` に従い、全コミットが green であること、`git log --oneline` がプランのタスク構成と一致することを確認。ブランチ統合は `superpowers:finishing-a-development-branch` で判断（PR 作成はユーザー確認後）。

---

## Self-Review 済みの確認点

- スペック（引き継ぎ「進め方 1」）のカバレッジ: NAV_rapid 追加（Task 3）/ PLACEHOLDER_dur 追加(Task 2+3) / baseline 記録（Task 7）/ 既存 3 指標の回帰ゲート維持（Global Constraints + Task 7 Step 3）/ park 済み bench:baseline 修正（Task 5、引き継ぎが明示推奨）— 全対応。
- 250ms「間隔」の解釈変更（fire-and-forget → フル paint 待ち + 下限 250ms)は引き継ぎ本文からの意図的な逸脱。理由は設計判断 1。**レビューで最優先に確認してほしい点。**
- 型整合: `placeholderDuration(timings: Timings): number`（Task 2 定義 = Task 3 使用）。JSON スキーマ（Task 3 産出 = Task 4 ガード = Task 6 文書）。
- steps=12 / interval=250ms / large 16 枚 / n=84 の数値は全タスクで一貫。
