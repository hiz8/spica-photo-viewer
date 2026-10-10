# プレビュー層 Phase 3 — フロント（可視範囲窓 / preview tier 表示 / ズーム時フル解像度）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** サムネイルバーに見えている画像へのナビゲーション（順方向・逆方向・ジャンプ）で、Phase 2 がディスクに用意した表示解像度プレビューをデコード済み `ImageBitmap` として保持・即描画し、**NAV_visible 中央値 ≥10% 改善（最終目標 < 100ms かつ hit_rate 1.0）、PLACEHOLDER_dur_visible p95 < 80ms（目標 0）**を達成する。ズーム時のみフル解像度へ遅延アップグレードする（ZOOM_full は悪化監視のみ）。

**Architecture:** (1) `bitmapCache` を tier 付き（preview / full）に拡張し、(2) `bitmapLoader.loadPreviewBitmap` が `spica-img://…/preview/<box>/` からフェッチして `createImageBitmap`、原寸は `X-Spica-Natural-Width/Height` から取る。(3) スケジューラ `useImagePreloader` は保持集合を「current ± 可視半径」（バーは現在画像を中央に置くため片側 `floor((innerWidth − 40) / 80)`）に広げ、`allGenerated` ゲートを撤廃して **`cache.thumbnails` に有効 entry がある path（I1 によりプレビューがディスクにある）から順にプレビューをデコード**する。full ビットマップは current のみ保持。(4) store の hit 判定は従来通り `cache.preloaded` だが tier を bitmapCache から導出し、(5) ImageViewer は preview miss（thumbnail あり）でフルではなくプレビューをロード、表示は既存の canvas 経路（バッキング = ビットマップ寸法、CSS = 原寸）、`view.zoom` が `previewWidth / naturalWidth` を超えたら full をロードして再描画。cold（thumbnail なし）と GIF は既存 `<img>` 経路を無変更で使う。E2E は表示要素に `data-natural-width/height` / `data-tier` を付けて原寸と tier を検証する。

**Tech Stack:** TypeScript strict + React 19 + Zustand + vitest（既存）。Rust 無変更（Phase 2 のルートと契約をそのまま使う）。WebdriverIO E2E。新規依存なし。

**Spec:** `docs/superpowers/specs/2026-08-21-thumbnail-implies-cached-preview-tier-design.md` §5（I2/I3/I4）, §6.4–6.8, §7, §8 R3/R4/R9、決定 D1/D4(a)。Phase 2 の契約: プレビュー URL `http://spica-img.localhost/preview/<W>x<H>/<encodeURIComponent(path)>`（`currentPreviewBox()` が返す "WxH" をそのまま使う。キャッシュキーは path 文字列のハッシュ — **必ず `ImageInfo.path` と同じ文字列を使う**）、応答ヘッダ `X-Spica-Natural-Width/Height`、GIF は 404。baseline は `bench-results/baseline.json`（gitSha ab5b223 を 24977d1 で canonize: NAV_visible 457.5 / hit 0、PLACEHOLDER_dur_visible 405.1、TTFI_cold 481.7 / 833.8、NAV_warm 19.1 / 32.9、NAV_rapid 28.6 / 269.1、NAV_cold 178.0 / 354.6）。

## Global Constraints

- **Rust（`src-tauri/`）無変更**。プロトコル契約・ボックス文字列は Phase 2 のまま
- **TTFI_cold 経路は構造的に無変更**: thumbnail entry が無い画像（初回オープン・キャッシュ削除後）は既存の `<img>` フルロード（`loadImageViaProtocol`）をそのまま通る。GIF も既存 `<img>` 経路
- **不変条件**: I2（fill 完了後、`{current} ∪ 可視窓` の非 GIF は preview tier を持つ）、I3（`cache.preloaded` の entry ⇒ `bitmapCache` に対応ビットマップ。evict は両方から）、I4（`zoom/100 > previewWidth/naturalWidth` で full をロード、完了後 full で描画）
- **メモリ予算** `BITMAP_CACHE_BUDGET_BYTES = 500MB` は preview + full の合算。予算超過は遠い順に preview を evict（current は除外）。full は current 以外を常に evict
- **メトリクス定義・bench プロトコル無変更**（`bench-helpers.ts` / `bench.perf.ts` は触らない）。`paint:done` の `tier` は `"preview"` を取り得るようになる（D1 で定義済み）。`perfEvent("preload:done", { path, tier })`、`preload`（hit 判定）に `tier` を追加、`getStatus().preloadedCount` / `bitmapPaths` 互換
- E2E の既存ケース（`visual.e2e.ts` の exif hit-canvas、`centering.e2e.ts` の canvas）は **canvas のバッキングが原寸であること**を前提にしているため、原寸の検証を `data-natural-width/height` 属性に切り替える（テストの弱体化ではなく、検証対象を「原寸 + 中央配置 + 非プレースホルダー」に正確化する）
- 採否ゲート（CLAUDE.md）: NAV_visible 中央値 ≥10% 改善（baseline 457.5 → ≤ 411.8。最終目標 < 100ms）かつ hit_rate 1.0、PLACEHOLDER_dur_visible p95 < 80（目標 0）、TTFI_cold / NAV_warm / NAV_rapid が baseline の p95 を超えて悪化しない、ZOOM_full 中央値 ≤ 500（悪化監視）、全 n 完全、`npm test` / `cargo test --lib` / `npm run test:e2e` green。採用時 `npm run bench:baseline` を同一コミット。**判定 run の前に同日のマシン状態を確認する**（孤立プロセス、アイドル CPU 10–20%）
- **サブエージェント編集では biome hook が発火しない**: 変更ファイルに `npx biome format --write` と `npx biome lint`。`npm run type-check` / `npx tsc -p e2e/tsconfig.json --noEmit --pretty false` clean
- ブランチ `worktree-preview-tier-phase3-frontend`（Phase 2 ブランチに stack）。Conventional Commits + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## ファイル構成

| ファイル | 責務 |
|---|---|
| Modify: `src/types/index.ts` | `ImageData.tier?: "preview" \| "full"` |
| Modify: `src/utils/displayTier.ts` + test | `displayTierOf` が `data.tier` を反映 |
| Modify: `src/utils/imageSrc.ts` + test | `previewSrc(path, box)` |
| Modify: `src/utils/bitmapCache.ts` + test | tier 付き API |
| Modify: `src/utils/bitmapLoader.ts` + test | `loadPreviewBitmap`、`retainElementAsBitmap` を full tier で |
| Modify: `src/utils/preloadWindow.ts` + test | `visibleThumbnailRadius`、`computeVisibleWindow` |
| Modify: `src/constants/memory.ts` | `THUMBNAIL_ITEM_PITCH_PX`、`PREVIEW_WINDOW_MIN/MAX_RADIUS`、`FULL_UPGRADE_DEBOUNCE_MS` |
| Modify: `src/hooks/useImagePreloader.ts` + test | 可視範囲窓・thumbnails 連動・tier evict |
| Modify: `src/store/index.ts` + test | hit の tier 導出、`preload` イベントに tier |
| Modify: `src/components/ImageViewer.tsx` + test | preview miss 経路、zoom アップグレード、data 属性 |
| Modify: `e2e/types.d.ts`, `e2e/specs/visual.e2e.ts`, `e2e/specs/centering.e2e.ts`, Create: `e2e/specs/preview-display.e2e.ts`, `package.json` | 原寸/tier の検証、新規 4 ケース |
| Modify: `docs/PERFORMANCE_AUTONOMY_PLAN.md` §2/§8、spec §9、`PROJECT_SPEC.md`（Image Loading Strategy） | 定義・結果 |

---

### Task 1: 型・tier ヘルパ・プレビュー URL

**Files:** `src/types/index.ts`, `src/utils/displayTier.ts`, `src/utils/__tests__/displayTier.test.ts`, `src/utils/imageSrc.ts`, `src/utils/__tests__/imageSrc.test.ts`

**Interfaces:**
- `ImageData.tier?: "preview" | "full"`（未指定 = full）
- `displayTierOf(data, thumbnailDisplayed)`: `!data → "none"`、`thumbnailDisplayed → "thumbnail"`、`data.tier === "preview" → "preview"`、それ以外 `"full"`
- `previewSrc(path: string, box: string): string` = `${IMAGE_PROTOCOL_ORIGIN}/preview/${box}/${encodeURIComponent(path)}`

- [ ] **Step 1: テスト追加（失敗）**

```ts
// displayTier.test.ts に追加
  it("is 'preview' for preview-tier data that is not a placeholder", () => {
    expect(displayTierOf({ ...mockImageData, tier: "preview" }, false)).toBe("preview");
    expect(displayTierOf({ ...mockImageData, tier: "preview" }, true)).toBe("thumbnail");
    expect(displayTierOf({ ...mockImageData, tier: "full" }, false)).toBe("full");
  });
// imageSrc.test.ts に追加
  it("builds preview URLs under /preview/<box>/", () => {
    expect(previewSrc("C:\\pics\\a b.jpg", "1920x1080")).toBe(
      "http://spica-img.localhost/preview/1920x1080/C%3A%5Cpics%5Ca%20b.jpg",
    );
  });
```

- [ ] **Step 2: 実装**

```ts
// types/index.ts ImageData に追加
  /** Decoded tier behind this entry: display-resolution preview or full resolution. Undefined = full (legacy). */
  tier?: "preview" | "full";
```
```ts
// displayTier.ts
export const displayTierOf = (data: ImageData | null, thumbnailDisplayed: boolean | undefined): DisplayTier => {
  if (!data) return "none";
  if (thumbnailDisplayed) return "thumbnail";
  return data.tier === "preview" ? "preview" : "full";
};
```
```ts
// imageSrc.ts
export const previewSrc = (path: string, box: string): string =>
  `${IMAGE_PROTOCOL_ORIGIN}/preview/${box}/${encodeURIComponent(path)}`;
```

- [ ] **Step 3: `npx vitest --run src/utils/__tests__/displayTier.test.ts src/utils/__tests__/imageSrc.test.ts` green → biome → commit `feat(preview): tier-aware ImageData, displayTierOf and previewSrc`**

---

### Task 2: tier 付き `bitmapCache`

**Files:** `src/utils/bitmapCache.ts`, `src/utils/__tests__/bitmapCache.test.ts`

**Interfaces（Task 3/4/5/6 が使用）:**
```ts
export type BitmapTier = "preview" | "full";
export interface RetainedBitmap { bitmap: ImageBitmap; tier: BitmapTier }
setBitmap(path: string, bitmap: ImageBitmap, tier: BitmapTier): void   // 同 tier の既存は close() して置換
getBitmap(path: string): RetainedBitmap | undefined                    // full 優先、なければ preview
getBitmapOfTier(path: string, tier: BitmapTier): ImageBitmap | undefined
hasBitmap(path: string, tier?: BitmapTier): boolean
bitmapTier(path: string): BitmapTier | undefined                       // getBitmap(path)?.tier
deleteBitmap(path: string, tier?: BitmapTier): void                    // tier 省略で両方 close()
clearBitmaps(): void
bitmapBytes(): number                                                  // 両 tier 合算 width*height*4
bitmapPaths(): string[]                                                // いずれかの tier を持つ path
fullBitmapPaths(): string[]                                            // full を持つ path（current 以外の evict 用）
```

- [ ] **Step 1: 既存テストを tier API に書き換え + 追加（失敗）** — 「set/get」「置換時 close」「delete/clear の close」「bytes」に加え: `getBitmap` が full 優先で返す / `deleteBitmap(path, "full")` は preview を残す / `fullBitmapPaths` / `hasBitmap(path, "preview")`
- [ ] **Step 2: 実装** — `Map<string, { preview?: ImageBitmap; full?: ImageBitmap }>`。空になった entry は Map から削除
- [ ] **Step 3: green → biome → commit `feat(preview): tiered bitmap cache (preview/full per path)`**

---

### Task 3: `loadPreviewBitmap` と full tier の保持

**Files:** `src/utils/bitmapLoader.ts`, `src/utils/__tests__/bitmapLoader.test.ts`

**Interfaces:**
```ts
loadPreviewBitmap(path: string, box: string, signal?: AbortSignal): Promise<{ data: ImageData; bitmap: ImageBitmap }>
// fetch(previewSrc(path, box), { signal }) → !ok で throw（404 = GIF/欠損）→ blob → createImageBitmap →
// natural = ヘッダ X-Spica-Natural-Width/Height（無ければ bitmap 寸法）→
// tier = (bitmap.width === natural.w && bitmap.height === natural.h) ? "full" : "preview"
// data = { path, src: previewSrc(path, box), width: natural.w, height: natural.h, format: imageFormat(path), tier }
loadBitmapViaProtocol(path, signal)  // 既存。data に tier: "full" を付ける
retainElementAsBitmap(path, element) // 既存。setBitmap(path, bmp, "full")
```

- [ ] **Step 1: テスト（fetch / createImageBitmap をモック、`Headers` で natural を返す）** — preview tier（natural 5472×3648、bitmap 1620×1080）/ full tier（natural == bitmap）/ 404 で throw / abort シグナルが fetch に渡る / `src:set` を発行しない
- [ ] **Step 2: 実装 → green → biome → commit `feat(preview): load display-resolution previews into the bitmap cache`**

---

### Task 4: 可視範囲窓の計算

**Files:** `src/utils/preloadWindow.ts`, `src/utils/__tests__/preloadWindow.test.ts`, `src/constants/memory.ts`

**Interfaces:**
```ts
// memory.ts
export const THUMBNAIL_ITEM_PITCH_PX = 40;     // .thumbnail-item 30px + margin 5px×2（App.css のミラー。bench-helpers と同値）
export const PREVIEW_WINDOW_MIN_RADIUS = 4;    // 極端に狭いウィンドウでも現行窓以上を保つ
export const PREVIEW_WINDOW_MAX_RADIUS = 48;   // 予算ガードが効く前の上限（3840px 幅 = 47）
export const FULL_UPGRADE_DEBOUNCE_MS = 150;
// preloadWindow.ts
visibleThumbnailRadius(innerWidth: number): number  // clamp(floor((innerWidth − 40) / 80), MIN, MAX)
computeVisibleWindow(index: number, direction: 1 | -1, length: number, radius: number): number[]
// 順序 = デコード順: 進行方向 +1..+radius、次に逆方向 −1..−radius（範囲外は除外、index 自身は含めない）
```
`computeWindow` と `BITMAP_WINDOW_SIZE` は削除（利用箇所は Task 5 で置換。テストも置換）。

- [ ] **Step 1: テスト** — `visibleThumbnailRadius(1920) === 23`、`(2560) === 31`、`(640) === 7`、`(200) === 4（MIN）`、`(8000) === 48（MAX）`; `computeVisibleWindow(0, 1, 16, 3) → [1,2,3]`、`(5, 1, 16, 2) → [6,7,4,3]`、`(5, -1, 16, 2) → [4,3,6,7]`、`(15, 1, 16, 3) → [14,13,12]`
- [ ] **Step 2: 実装 → green → biome → commit `feat(preview): visible-range window (one-sided radius from the thumbnail bar geometry)`**

---

### Task 5: スケジューラ — 可視範囲のプレビュー窓

**Files:** `src/hooks/useImagePreloader.ts`, `src/hooks/__tests__/useImagePreloader.test.ts`

**Interfaces:** 外部インターフェース不変（フック）。内部の契約:
- 保持集合 `keep = {current} ∪ computeVisibleWindow(index, direction, length, visibleThumbnailRadius(window.innerWidth))`
- **Maintenance（常時）**: (a) `fullBitmapPaths()` のうち current 以外 → `deleteBitmap(p, "full")`（preview が残らなければ `removePreloadedImage`）; (b) `bitmapPaths() ∪ cache.preloaded.keys()` のうち `keep` 外 → `deleteBitmap(p)` + `removePreloadedImage(p)`; (c) `bitmapBytes() > BUDGET` の間、`keep` の遠い順（窓の逆順）に current 以外の preview を evict; (d) 窓外の in-flight を abort
- **Fill（ゲート: 現在画像が非プレースホルダー表示済み = `data.width > 0 && !thumbnailDisplayed`。`allGenerated` ゲートは撤廃）**: 窓順に、`format !== "gif"`、`hasBitmap(path)` でない、pending でない、`cache.preloaded.get(path)?.format !== "error"`、**`cache.thumbnails.get(path)` が有効 entry（`"error"` でない）である** path を `MAX_CONCURRENT_LOADS` まで `loadPreviewBitmap(path, currentPreviewBox(), signal)` で起動。成功: `setBitmap(path, bmp, data.tier)` → `setPreloadedImage(path, data)` → `perfEvent("preload:done", { path, tier: data.tier })`。失敗: 404（GIF/欠損）以外は `format: "error"` entry（既存と同じ）。供給順序の識別（controller identity）は既存のまま
- effect 依存: `currentImage.index`, `folder.images`, `cache.thumbnails`（サムネイルが増えるたびにポンプ）, `currentReady`。`window` の `resize` を 200ms デバウンスで購読してポンプ。フォルダ変更で `clearBitmaps()` + abort（既存）

- [ ] **Step 1: テスト（既存テストの窓サイズ前提を置換）** — thumbnails entry の無い path はロードしない / entry が追加されるとロードが始まる / 窓は ±radius（`innerWidth` をスタブ）/ full は current 以外 evict される（preview が残れば preloaded entry は残る）/ 予算超過で遠い順 evict / GIF と error はスキップ / `preload:done` に tier
- [ ] **Step 2: 実装 → `npx vitest --run src/hooks/__tests__/useImagePreloader.test.ts` green → biome → commit `feat(preview): preload decoded previews over the visible thumbnail range, full only for the current image`**

---

### Task 6: store — hit の tier と `preload` イベント

**Files:** `src/store/index.ts`, `src/store/__tests__/index.test.ts`

- `navigateToImage`: hit のとき `imageData = { ...cachedImage, tier: bitmapTier(image.path) ?? cachedImage.tier ?? "full" }`（bitmapCache から現在の tier を導出 — full を evict した後も正しい）。`perfEvent("preload", { path, hit, tier: hit ? imageData.tier : null, thumbnailFallback })`
- テスト: preview entry + preview bitmap → data.tier "preview"、イベント tier "preview"; entry が full でも bitmap が preview のみなら "preview"; miss は tier null

- [ ] **Step 1: テスト → Step 2: 実装 → green → biome → commit `feat(preview): derive the displayed tier from the bitmap cache on preload hits`**

---

### Task 7: ImageViewer — preview miss 経路・ズーム時 full・data 属性

**Files:** `src/components/ImageViewer.tsx`, `src/components/__tests__/ImageViewer.test.tsx`

**変更点:**
1. **preview miss 経路**: `loadImage` の「thumbnail upgrade」ブランチと「two-phase PHASE 2」ブランチで、`cachedThumbnail`（非 error）かつ非 GIF なら `loadImageViaProtocol(path)` の代わりに `loadPreviewBitmap(path, currentPreviewBox(), signal)` を使う。成功時: `setBitmap(path, bitmap, data.tier)` → `setImageData(data)` → fit/updateDims（原寸）→ `setPreloadedImage(path, data)` → `setThumbnailDisplayed(false)`。**失敗時（404 等）は既存のフルロードにフォールバック**（`loadImageViaProtocol` → `retainElementAsBitmap` full）。direct load（thumbnail なし）と GIF は無変更
2. **displayBitmap**: `getBitmap(path)` が `{bitmap, tier}` を返すようになるので `displayBitmap?.bitmap` を描画に使う（`drawBitmapToCanvas(canvas, retained.bitmap)`）。判定条件は不変
3. **ズーム → full アップグレード**（新 effect）: 依存 `view.zoom`, `currentImage.data`, `currentImage.path`。条件: `data && data.tier === "preview" && !ui.thumbnailDisplayed && retained?.tier === "preview" && view.zoom / 100 > retained.bitmap.width / data.width * 1.02`。`FULL_UPGRADE_DEBOUNCE_MS` 後に `loadBitmapViaProtocol(path)`（AbortController。path 変更・unmount で abort）→ 完了時 `activeLoadPathRef`/現在 path を確認 → `setBitmap(path, bitmap, "full")` → `setImageData({ ...data, tier: "full", src: imageSrc(path) })`（data 変化で draw effect が full で再描画し `paint:done`(tier full) が出る）→ `setPreloadedImage(path, {...data, tier: "full"})`。失敗は warn のみ（プレビュー表示のまま）
4. **data 属性**: `<canvas>` と `<img>` に `data-natural-width={currentImage.data.width}`、`data-natural-height={currentImage.data.height}`、`data-tier={displayTierOf(currentImage.data, ui.thumbnailDisplayed)}` を付与（E2E の原寸/tier 検証用。表示には影響しない）
5. 既存の `hasFullResolution` スキップは preview 表示でも成立（`data.width > 0 && !thumbnailDisplayed`）— 変更不要

- [ ] **Step 1: テスト** — thumbnail 表示中に preview をロードして canvas 描画（`loadPreviewBitmap` モック、`loadImageViaProtocol` は呼ばれない）/ preview ロード失敗で full にフォールバック / zoom が閾値を超えると `loadBitmapViaProtocol` が 1 回呼ばれ data.tier が full になる（fake timers でデバウンス）/ 閾値以下では呼ばれない / GIF は従来経路 / data 属性が出る / 既存の canvas/img テストは `getBitmap` の戻り形の変更に追従
- [ ] **Step 2: 実装 → `npx vitest --run src/components/__tests__/ImageViewer.test.tsx` green → biome → commit `feat(viewer): display previews on misses and upgrade to full resolution on zoom`**

---

### Task 8: E2E — 原寸/tier 検証への切替と新規 4 ケース

**Files:** `e2e/types.d.ts`（`getStatus` 変更なし）, `e2e/specs/centering.e2e.ts`, `e2e/specs/visual.e2e.ts`, Create: `e2e/specs/preview-display.e2e.ts`, `package.json`（`test:e2e` に `--spec e2e/specs/preview-display.e2e.ts` を preview の後に追加）

- `centering.e2e.ts` `measurePlacement`: `natural` を `el.dataset.naturalWidth/Height`（数値化）から取る（属性が無ければ従来の naturalWidth / canvas.width にフォールバック）。`showsFullRes` は「非プレースホルダー」の意味で `el.dataset.tier !== "thumbnail"` も要求する。名前は `showsDisplayedImage` に改名
- `visual.e2e.ts`: 「applies EXIF orientation from original bytes」「on the canvas hit path」は `dataset.naturalWidth/Height === "800"/"1200"` と `dataset.tier !== "thumbnail"` を待つ。canvas のバッキングは `width/height` の比が 2:3（±1px）であることを確認（preview なら 720×1080、full なら 800×1200）。「renders a large image without blank output」は `dataset.naturalWidth === "5472"` を待つ
- `preview-display.e2e.ts`（新規）:
  - (a) **hit = preview tier**: large フォルダの img-001 を開く → `bitmapPaths` に img-003 が入るまで待つ → `navigateToImage(3)` → canvas、`dataset.tier === "preview"`、`canvas.width === 1620 && canvas.height === 1080`、`dataset.naturalWidth === "5472"`、中央配置（`centering` のヘルパを複製せず `getBoundingClientRect` の中心 ±2px）
  - (b) **zoom → full**: (a) の続きで `zoomIn()` → `dataset.tier === "full"` かつ `canvas.width === 5472` を 10s 以内に待つ → `resetZoom()`
  - (c) **可視範囲内の後退ナビでプレースホルダーが出ない**: `navigateToImage(12)` → full paint 待ち → `clearPerf()` → `navigateToImage(3)` → `paint:done` が出るまで待ち、`__PERF__` に `thumbnail: true` の `paint:done` が **無い**こと、最初の `paint:done` の tier が preview であること
  - (d) **preview miss（thumbnail あり・未デコード）**: `evictDecoded()` → `navigateToImage(7)` → 最初の非プレースホルダー paint の tier が preview（`extract` は `__PERF__` を読む）、かつ `open:request` からの時間が 200ms 未満

- [ ] **Step 1: 変更・作成 → `npx tsc -p e2e/tsconfig.json --noEmit --pretty false`、biome → commit `test(e2e): verify natural size and tier via data attributes; preview display cases`**（実行は Task 10）

---

### Task 9: ドキュメント

- `docs/PERFORMANCE_AUTONOMY_PLAN.md` §2: NAV 系の「フル品質 paint」が preview tier で満たされることを明記（D1）、`preload` イベントの `tier`。`PROJECT_SPEC.md` の Image Loading Strategy（Display Priority）に preview tier を追記（1. preview/full キャッシュ済み → 即描画 / 2. thumbnail + preview ロード / 3. フルロード、ズーム時 full）。spec §9 Phase 3 の状態
- commit `docs(perf): preview tier in the display priority and metric notes`

---

### Task 10: ゲート（メインセッションで実行）

- [ ] `npm test` / `cargo test --lib --manifest-path src-tauri/Cargo.toml` / `npm run type-check` / e2e tsc
- [ ] `npm run bench:build` → `npm run test:e2e` ×2（smoke 3 + centering 6 + preview 3 + preview-display 4 + visual 4 = 20）
- [ ] **マシン状態確認**（`Get-Process find` が無い、`Get-Counter` でアイドル CPU 10–20%）→ `npm run bench`
- [ ] 判定（baseline 24977d1 = ab5b223 run）: NAV_visible 中央値 ≤ 411.8（≥10%）かつ hit_rate 1.0（予測: ~30ms、`tiers {preview: 84}`）/ PLACEHOLDER_dur_visible p95 < 80（予測 0）/ TTFI_cold ≤ 833.8・NAV_warm ≤ 32.9・NAV_rapid ≤ 269.1（p95 帯）/ NAV_cold（新定義、preview miss 経路）は参考（予測 ~50–80ms）/ ZOOM_full 中央値 ≤ 500（予測 ~350–450、20MP フルデコード）/ 全 n 完全
- [ ] 採用: `npm run bench:baseline` + §8 更新を同一コミット。不採用: 原因を報告（revert はユーザー判断）
- [ ] push → `gh pr create --base worktree-preview-tier-phase2-rust`（#273 マージ後は main）。PR 本文に NAV_visible / PLACEHOLDER_dur_visible / ZOOM_full の before/after、tiers、メモリピーク（任意: `Get-Process` の WorkingSet）、4:2:0 の目視所見

## Self-Review 済みの確認点

- spec §6.4（型・bitmapCache・loader・定数）→ Task 1–4、§6.5（4 経路・canvas 寸法・zoom アップグレード）→ Task 7、§6.6（窓・ゲート・evict・resize）→ Task 5、§6.8（store）→ Task 6、§7.2 の E2E 4 ケース → Task 8、§7.3 ゲート → Task 10。D4(a)（thumbnail 先出し）は Task 7 の経路 1 で維持
- TTFI_cold 経路（thumbnail なし → `<img>` フル）と GIF は Task 7 で明示的に無変更
- tier の一貫性: `BitmapTier` = `ImageData.tier` = `paint:done.tier ∖ {"thumbnail"}`。store は bitmapCache から tier を導出するため、full evict 後の hit でも preview と報告され、zoom アップグレードが正しく発火する
- E2E の前提変更（バッキング ≠ 原寸）は `data-natural-*` 属性で吸収し、中央配置・向き・非プレースホルダーの検証は維持（弱体化しない）
- Phase 2 の最終レビューからの繰り越し: プレビュー URL は `ImageInfo.path` 文字列から `previewSrc` で組み立てる（正規化なし = generator と同じキー）；`zoom:request` の eager 構築と 40px ピッチの二重管理は Task 4/7 で触る際に整理してよい（任意）
