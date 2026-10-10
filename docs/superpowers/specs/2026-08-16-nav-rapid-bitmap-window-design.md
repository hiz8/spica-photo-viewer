# 仮説 C 設計: デコード済みビットマップ窓による NAV_rapid 高速化

- 日付: 2026-08-16 / ブランチ系譜: PR #269（profiling）の後続。実装は origin/main ベースの worktree で行う
- 根拠: `docs/PERFORMANCE_NAV_RAPID_PHASE2_PROFILING.md` — 遅い hit（40/84、median 495.6ms）の実体は 20MP のブラウザ側**再デコード**（再フェッチは 6/40 のみ、serve は ~9ms）。renderer のデコード済みキャッシュは 20MP×13 枚を保持できず run 単位で振動する
- ユーザー決定（brainstorming で確定）:
  - デコード済みキャッシュのメモリ予算 **≤ 500MB**
  - 主要ディスプレイ **1080p**
  - **ゲート指標は現行定義を維持**（NAV_rapid = フル解像度 `paint:done`(thumbnail:false) 中央値 < 100ms。表示解像度ティアによる指標再定義は不採用）
  - Approach 1 採用、Approach 2（element 保持のみ）の先行サイクルは挟まない

## ゴール / 非ゴール

**ゴール**: サムネイルバー範囲の連続ナビゲーション（NAV_rapid プロトコル、250ms 下限）で、フル解像度 paint 中央値 < 100ms（サイクルゲートは ≥10% 改善）。TTFI_cold / NAV_warm / NAV_cold を p95 の揺れを超えて悪化させない。

**非ゴール**:
- miss（未デコード画像への遠方ジャンプ）の高速化 — デコード ~400ms は本設計では不変。仮説 A（Rust 側プレビュー）の領域として別サイクル
- GIF ナビゲーションの高速化（アニメ保持のため bitmap 窓から除外）
- メトリクス定義・bench プロトコルの変更（一切しない）

## 全体像

3 要素で「hit = デコード済み保証 = 即 paint」を成立させる:

1. **保証された保持**: `ImageBitmap` を自前 Map で保持（renderer キャッシュ非依存、evict は自前 `close()`）
2. **保証された高速 paint**: hit 時は `<canvas>` に `drawImage`（デコード不要、GPU 転送のみ、~1-2 フレーム）。フル解像度ピクセルの paint なので現行メトリクス定義に対して正直
3. **即時方向性スケジューラ**: 500ms タイマーを廃し、index 変更で直ちに進行方向の近傍 4 枚を `fetch → blob → createImageBitmap` でメインスレッド外デコード

cold 経路（bitmap 無し）と GIF は既存 `<img>` 二段階パスを**無変更**で使う — NAV_cold / TTFI_cold の悪化リスクを構造的に遮断する。

## §1 bitmapCache（新規 `src/utils/bitmapCache.ts`）

モジュールレベル状態（現行 `retainedImages` と同型。Zustand には入れない — 80MB オブジェクトは immutable 更新の対象外）。

```ts
setBitmap(path: string, bitmap: ImageBitmap): void  // 既存 entry は close() してから置換
getBitmap(path: string): ImageBitmap | undefined
hasBitmap(path: string): boolean
deleteBitmap(path: string): void                    // close() + Map から除去
clearBitmaps(): void                                // 全 close() + clear
bitmapBytes(): number                               // Σ width*height*4
bitmapPaths(): string[]                             // eviction 走査用
```

- eviction の**判断はしない**（距離・方向・予算を知るスケジューラの責務）。cache は会計と解放だけ
- 予算定数は新規 `src/constants/memory.ts`:
  - `BITMAP_CACHE_BUDGET_BYTES = 500 * 1024 * 1024`
  - `BITMAP_WINDOW_SIZE = 4`（current に加えて保持する近傍数）
- ユニットテスト: バイト会計 / set 置換時の close / delete・clear の close 呼び出し（jsdom に ImageBitmap は無いので `{width, height, close}` のモックで検証）

## §2 スケジューラ（`src/hooks/useImagePreloader.ts` 作り直し）

### 窓の定義（純関数 `computeWindow` — 新規 `src/utils/preloadWindow.ts`）

```ts
computeWindow(index: number, direction: 1 | -1, length: number, size?: number): number[]
```

- 優先順 = デコード順。前進（direction=1）の候補列は `[i+1, i+2, i+3, i−1, i+4, i+5, …]`（基本 4 件の後は進行方向の続き、それも尽きたら逆方向の続き `i−2, i−3, …`）から、範囲内の index を先頭 `size`(=4) 件。後退は鏡像。例: index 0 前進 → `[1, 2, 3, 4]`、index 1 前進・全 2 枚 → `[0]`
- 保持集合 = `{index} ∪ computeWindow(...)` — 20MP で 5 × 80MB = 400MB ≤ 予算
- 3 手先行 = 250ms 間隔で 750ms のリード。デコード ~400ms・並列 3（`MAX_CONCURRENT_LOADS` 流用）で持続可能
- ユニットテスト: 前進/後退/両端/フォルダが窓より小さい場合

### ロード経路（新規 `src/utils/bitmapLoader.ts`）

`fetch(imageSrc(path))` → `blob` → `createImageBitmap(blob)`。`<img>` 非経由・メインスレッド外デコード・renderer キャッシュ非依存。EXIF は `createImageBitmap` 既定 `imageOrientation: "from-image"` で `<img>` と同じ向き（寸法は bitmap.width/height = 回転適用後）。**`src:set` は発行しない** — `fetch_decode_rapid_miss` への preloader 汚染（旧 handoff 事実 4）が副次的に解消される。fetch は AbortController 対応。

### スケジューラ本体（effect）

- 依存: `currentImage.index`, `folder.images`, `thumbnailGeneration.allGenerated`, および**現在画像がフル解像度表示済みか**（`currentImage.data` が有効寸法かつ `!ui.thumbnailDisplayed`）
- **起動ゲート**: `allGenerated`（現行踏襲、フォルダ初回オープンのサムネイル生成と競合しない）かつ**現在画像のフル解像度データが表示済み**であること。後者が新規で、miss 進行中に窓デコードが現在画像のデコードとスレッドを取り合うのを防ぐ（NAV_cold / TTFI_cold 保護）。miss 中は data がフル解像度に昇格した時点で effect が再発火して充填が始まる。hit 中（rapid の主ケース）は即時
- 方向: 直前 index との差の符号を ref で検出（初回は +1）
- 手順:
  1. 保持集合を計算し、**evict**: bitmapCache にあって保持集合外 → `deleteBitmap` + `removePreloadedImage`（不変条件の維持）。その後 `bitmapBytes() > BUDGET` の間、現在画像以外を遠い順に追加 evict（巨大画像対応）
  2. 窓外になった in-flight fetch を abort。in-flight 完了時に保持集合外なら `close()` して破棄
  3. 優先順に、未キャッシュ・未 pending・非 GIF・非 error の path を並列上限まで起動。成功時: `setBitmap` → `setPreloadedImage(path, { path, src, width: bmp.width, height: bmp.height, format })` → `perfEvent("preload:done", { path })`。失敗時: 現行同様 `format: "error"` を `setPreloadedImage`（リトライループ防止）
- **不変条件**: 非 GIF について `cache.preloaded ⊆ bitmapCache ∪ {current}`。evict は必ず両方から除去。「preloaded に entry はあるが bitmap が無い」という今回のバグの構造自体を排除する。例外は (a) GIF（bitmap 化しない）、(b) viewer cold ロード完了直後の bitmap 化 in-flight の過渡（この間の hit は現行の `<img>` 再デコードと同等 = 現状比で悪化なし、spec 上明記）
- 廃止: `PRELOAD_DELAY_MS` の使用、`retainedImages`、チャンク逐次 walk、queue 空での cleanup スキップ（eviction は毎 index 変更で走る）
- folder.path 変更 effect: `clearBitmaps()`（現行の `retainedImages.clear()` を置換）
- bench 互換: `preload:done` イベントと `cache.preloaded`（= `getStatus().preloadedCount`）は維持。settle(5) は current + 窓 4 = 5 で成立。`preload` イベント（hit 判定）のスキーマ不変

## §3 ImageViewer 描画（canvas hit パス追加）

- **レンダー分岐**: `getBitmap(currentImage.path)` が存在し、かつ `currentImage.data` がフル解像度（有効寸法・`!thumbnailDisplayed`）のとき `<canvas>`、それ以外は既存 `<img>`。モジュール Map は非リアクティブだが、分岐はナビゲーション起因の再レンダー時に評価されるので整合する（hit はナビ時点で bitmap があるから canvas になり、cold は `<img>` のまま完結する。cold 完了後の bitmap 化で再レンダーは起きないが、既にフル解像度が表示済みなので不要）
- **canvas 描画**: layout effect（`currentImage.data` 変化時）で `canvas.width/height = bitmap 寸法` を設定し `drawImage(bitmap, 0, 0)` 1 回。スタイルは既存 `imageStyle`（natural 寸法 + CSS transform）を共用 — ズーム/パンは `<img>` と同一挙動。drawImage 後は canvas が自前のバッキングを持つため、直後に元 bitmap が evict/close されても表示は安全
- **perf マーク**: canvas パスでは描画後に double rAF で `paint:done`({ path, thumbnail: false })。`decode:done` は発行しない（hit はもともと `src:set` を持たず fetchDecode=null — 現行挙動と同じ）。既存の `<img>` 用 paint effect は分岐でそのまま維持
- **cold ロードの bitmap 化（非対称の解消）**: `loadImageViaProtocol` の戻り値 `element` を捨てずに、非 GIF の 3 完了サイト（thumbnail upgrade / two-phase PHASE 2 / direct load）で fire-and-forget の `createImageBitmap(element)` → 完了時に path がまだ保持集合内なら `setBitmap`。off-main で走り表示をブロックしない
- **イベントハンドラ**: `e.target === imageRef.current` 判定（drag / dblclick）を表示中要素（img または canvas）への参照で統一
- **GIF**: 常に `<img>`（現行通り）
- コンポーネントテスト: jsdom は 2D context を持たないため、描画を `drawBitmapToCanvas(canvas, bitmap)`（`src/utils/canvasDraw.ts`）に切り出してモック。canvas/img 分岐・paint マーク発火をテスト。既存 ImageViewer テストは `<img>` パスのまま green を維持

## §4 store 統合

変更ほぼゼロ。`navigateToImage` の hit 判定は従来通り `cache.preloaded`（§2 の不変条件により非 GIF では bitmap 存在とほぼ同義）。`preload` イベント、`hasFullResolution` スキップ、`openImageFromPath` すべて不変。差分は「描画側が canvas を選ぶ」ことだけ。

## §5 計測・テスト・採否ゲート

- **メトリクス**: 定義・bench プロトコル・スキーマとも一切変更しない
- **ユニット**: `npm test` 全 green（既存 250 + 新規: bitmapCache / computeWindow / bitmapLoader(モック) / ImageViewer 分岐 / スケジューラ挙動）。store テストは無変更で green のはず
- **Rust**: 無変更（`cargo test --lib` は素通し確認のみ）
- **E2E 視覚**: 既存 exif ゲートは cold `<img>` 経路のみのため、**hit（canvas）経由の EXIF 向き検証を追加**。exif コーパスに 2 枚目（orientation なしの通常画像）を決定的に追加生成し、img-001 を開いて preload 完了後 img-000 へナビゲート → canvas パスで表示された向きを視覚比較
- **採否ゲート（CLAUDE.md 準拠）**: `bench:build` → `bench`。NAV_rapid 中央値 ≥10% 改善（予測: hit がデコード済み保証になり fast クラスタ ~30ms 台へ）/ TTFI_cold・NAV_warm・NAV_cold が p95 の揺れを超えて悪化しない / NAV_rapid・PLACEHOLDER_dur の n=84 完全 / `npm test` + `cargo test --lib` + `npm run test:e2e` green / 採用時は `npm run bench:baseline` を同一コミット（メインセッションで実行）。不成立なら revert

## リスクと予測される挙動

1. **並列 createImageBitmap の実効 throughput が計算（3 並列 × ~400ms → 7.5 枚/s）を下回る場合**: 窓充填が遅れて hit 率が下がるが、失敗モードは「現状の miss と同等（`<img>` パス）」であり現状比の劣化はない。bench で実測判定
2. **メモリピーク**: キャッシュ 400MB（20MP×5）+ canvas バッキング ~80MB + in-flight デコード transient。キャッシュ会計は 500MB 予算内だがプロセスピークは ~600MB 台に達しうる（ユーザー了承済みの予算はキャッシュ分。spec として明記）
3. **`createImageBitmap(element)` が再デコードになる環境**: off-main・fire-and-forget なので表示への影響なし。コストは cold ロード 1 回につき最大 1 デコード分のバックグラウンド CPU
4. **過渡的な非不変条件**（cold 完了〜bitmap 化完了の間の hit）: 現行の遅い hit と同等で、悪化ではない
5. **bench の NAV_warm への影響**: preloadedCount の定常値が ~10 から ~5 に下がるが、bench は settle(5) と per-path `preload:done` 待ちのため互換。NAV_warm 自体は canvas paint 化でやや改善見込み

## 実装フェーズ分割（writing-plans への入力）

1. bitmapCache + memory 定数（unit 付き）
2. computeWindow + bitmapLoader（unit 付き）
3. スケジューラ作り直し（useImagePreloader、unit 付き）
4. ImageViewer canvas パス + cold ロード bitmap 化 + canvasDraw 切り出し（unit 付き）
5. E2E: exif hit-canvas 視覚ケース + corpus 生成拡張
6. bench 実行 → ゲート判定 → 採用時 baseline canonize（メインセッション）
