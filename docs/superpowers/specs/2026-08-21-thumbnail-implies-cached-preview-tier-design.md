# 設計: 「サムネイルが見えている = キャッシュ済み」保証（Picasa 同等）— 表示解像度プレビュー層

- 日付: 2026-08-21 / 前提: PR #270（bitmap 窓 + canvas paint）マージ済み、baseline gitSha c4dc4d8（NAV_rapid 33.7ms / hit_rate 1.0 / PLACEHOLDER_dur p95 0）
- 種別: 実装可否調査 + 設計（brainstorming 成果物）。ユーザー決定事項（§3 D1–D5）は **2026-08-21 に推奨案で承認済み**。実装プランは Phase 単位で `docs/superpowers/plans/` に置く（Phase 1: `2026-08-21-preview-tier-phase1-measurement.md`）
- 前提 PR: `docs/HANDOFF_IMAGE_CENTERING_FIX.md`（canvas 表示の中央配置バグ）は **PR #271 で完了・マージ済み**（§9 Phase 0 完了。`centering.e2e.ts` が本件の回帰ゲートになる）

## 0. 結論（実装可否）

**実現可能。ただし「フル解像度ビットマップを可視範囲ぶん保持する」方式では物理的に不可能**で、Picasa と同じ「**表示解像度のプレビュー層**」を導入する必要がある。

| 事実 | 数値 |
|---|---|
| サムネイルバーの可視枚数（`.thumbnail-item` 30px + margin 5px×2 = 40px ピッチ） | 1920px 幅で **48 枚（現在 ±24）**、2560px で 64 枚 |
| 現行の bitmap 窓（PR #270） | current + **4**（前方 3・後方 1） |
| 20MP フル解像度ビットマップ 1 枚 | 5472×3648×4B ≈ **80MB** |
| 可視範囲をフル解像度で覆う場合 | 48 × 80MB ≈ **3.8GB** → 予算 500MB の 7.7 倍。不可能 |
| 1080p 画面ボックス（1920×1080）に収めたプレビュー 1 枚 | 3:2 横 1620×1080 ≈ **7MB** / 縦 720×1080 ≈ 3MB |
| 可視範囲をプレビューで覆う場合 | 48 × ≤7MB ≈ **≤336MB** → 予算内 |
| miss 時のコスト（現行、20MP ブラウザデコード） | median **~390ms**、p95 1.6s（profiling §C） |
| プレビュー（~1.7MP JPEG）の fetch+decode 見込み | **~30–50ms**（serve ~9ms + 2MP デコード ~20–30ms） |

つまり現状「サムネイルが見えていてもプレースホルダーが出る」のは、(a) 保持窓が可視範囲（±24）に対して極端に小さい（後方 2 枚以上・クリックジャンプで必ず miss）、(b) miss の実体が 20MP デコード ~390ms で知覚されるため。(a) はフル解像度では予算上解けず、(b) と合わせて「表示解像度プレビュー」が唯一の解。

**重要な副作用**: 表示解像度層を導入すると、現行ゲート「NAV_rapid = フル解像度 `paint:done`(thumbnail:false)」は定義の見直しが必要（§3 D1、§7）。前サイクルで「指標再定義は不採用」と決定した経緯があるが、当時のゴール（前進ナビ ±3 の hit 化）は 500MB で成立した一方、今回のゴール（可視範囲全体）は成立しないため、決定の再検討をお願いしたい。

## 1. 現状分析（コードの事実）

1. **サムネイル生成は毎回 Rust でフルデコード**（`utils/image.rs` `generate_thumbnail` = `image::open` → `thumbnail(20,20)`）。20MP で ~300ms/枚。**同じデコード結果からプレビューも作れば、追加コストはリサイズ + エンコードのみ**（見積 +60〜100ms/枚、§8 R1）。これが Picasa 方式（1 回のデコードでサムネとキャッシュを両方作る）の鍵。
2. **Rust は EXIF 向きを一切扱っていない**（`grep orientation src-tauri` 0 件）。サムネイルと `original_width/height` は raw（回転前）。現状でも回転画像のプレースホルダーは横倒し寸法で出て、フル解像度で縦になる不整合がある。プレビューは「表示そのもの」なので**向き適用が必須**。`image` 0.25.10 には `ImageDecoder::orientation()` / `DynamicImage::apply_orientation()` があり追加依存なしで可能（確認済み）。
3. **ICC プロファイル**: ブラウザは原本の ICC を適用して表示する。Rust 再エンコードで ICC を落とすと、Display P3 / Adobe RGB の写真でプレビュー（fit）とフル（ズーム）の色が変わる。`JpegEncoder::set_icc_profile` と `ImageDecoder::icc_profile()` で引き継げる（確認済み）。
4. プリローダー（`useImagePreloader`）は fill を `thumbnailGeneration.allGenerated` でゲート。大フォルダ（900 枚）では全サムネ完了まで一切プリロードされない。「サムネイルが見えている ⇒ 準備済み」にはサムネイル単位の連動が必要。
5. `spica-img` プロトコルは「原本バイトをそのまま配信」のみ。プレビュー配信ルートの追加点は `lib.rs` のハンドラと `protocol.rs` の resolver。
6. ディスクキャッシュ（`commands/cache.rs`）は `{hash}.json` に base64 サムネを保存、24h 保持、**原本 mtime を見ていない**（編集後 24h 以内は古いサムネが出る）。プレビューは表示本体なので mtime 検証を入れる。
7. `ImageViewer` の img/canvas 分岐・`imageStyle`（CSS width/height = 原寸、`transform: scale(zoom)`）はそのまま流用できる。canvas のバッキングだけプレビュー寸法にし、CSS 寸法は原寸のままにすれば **ズーム/パン/中央配置の数学は一切変えずに済む**（§6.5）。
8. GIF は `<img>` 直接ロード（アニメ保持）。本設計でも GIF は対象外（現行通り）。

## 2. ゴール / 非ゴール

**ゴール（Picasa 同等の保証）**
- G1. サムネイルバーに**表示されている**（可視範囲 ±24 @1920px）どの画像へナビゲーションしても、プレースホルダー（20px サムネの引き伸ばし）を知覚させず、即時に fit-to-window 品質の画像を表示する。順方向・逆方向・クリックジャンプを問わない
- G2. 数値定義: 新指標 **NAV_visible**（§7）で hit_rate = 1.0、非プレースホルダー paint 中央値 < 100ms、PLACEHOLDER_dur_visible p95 < 80ms（目標 0）
- G3. ズーム時はフル解像度へ遅延アップグレードし、拡大表示の品質は現行と同一（新指標 **ZOOM_full** と E2E で保証）
- G4. 既存ゲート（TTFI_cold / NAV_warm / NAV_rapid）を p95 の揺れを超えて悪化させない。特に TTFI_cold の経路（初回オープンの `<img>` フルロード）は構造的に無変更

**非ゴール**
- アプリ再起動直後・キャッシュ削除直後の**初回**サムネイル生成前の画像の高速化（サムネイルが無い = 保証対象外。現行の thumbnail→full 経路のまま）
- GIF のプレビュー化
- サムネイル生成そのものの高速化（§9 Phase 4 の候補として分離。ただし回帰しきい値は設ける）
- サムネイルバーの仮想スクロール等 UI 変更

## 3. ユーザー決定事項（実装前に確認が必要）

| # | 決定 | 推奨 | 代替 |
|---|---|---|---|
| **D1** | **ゲート指標の再定義**: `paint:done` に `tier: "thumbnail" / "preview" / "full"` を追加し、NAV 系指標の終点を「最初の**非プレースホルダー** paint（preview または full）」とする。フル解像度の到達は新指標 ZOOM_full と E2E（ズーム後 canvas.width === 原寸）で別途保証 | **採用**。fit 表示ではプレビューとフルは画素等価（§6.5）であり、計測は「ユーザーが見るもの」に対して正直 | 現行定義維持 → 可視範囲保証は不可能（§0）。保証範囲を ±3 程度に縮め、準備済みサムネイルを視覚表示する縮退案（§4 案 C） |
| **D2** | **プレビュー解像度**: 起動時の画面物理解像度（`screen.width/height × devicePixelRatio`、複数ディスプレイではウィンドウが起動したディスプレイ）を {1920×1080, 2560×1440, 3840×2160} に切り上げたボックスに**収める**（長辺固定ではなく W×H ボックス。縦画像のメモリを半減）。ボックスはキャッシュキーに含めるため、別ディスプレイで開き直せば別セットが生成される。注: PR #271 の bench は 2560×1369 のウィンドウ（= 1440p ボックス）で実行されており、その環境ではプレビュー 3:2 ≈ 2160×1440 ≈ 12.4MB、可視 64 枚 ≈ 795MB → 予算 500MB で約 40 枚がデコード済み、残りはディスクから ~50–60ms（R9 と同じ縮退） | **採用**（画面に合わせて自動。1080p → 1920×1080 ボックス、1440p → 2560×1440 ボックス） | 固定 2560 長辺（4K で fit がやや甘くなる） |
| **D3** | **ディスク容量**: プレビュー JPEG q85 は 1080p ボックスで ~300–500KB/枚（900 枚 ≈ 400MB、4K ボックスでは ~1.5GB）。既存の 24h 保持に加え、起動時に**合計上限（例 2GB）を超えた分を古い順に削除** | **採用（上限 2GB）** | 上限なし（24h 保持のみ） |
| **D4** | **プレースホルダー方針（ディスクにプレビューはあるが未デコードの場合、~40ms）**: (a) 現行通り thumbnail を先に出す（40ms の一瞬の差し替え）/ (b) 前の画像を最大 100ms 保持し thumbnail を出さない | **(a) で実装し Phase 3 の実測（PLACEHOLDER_dur_visible p95）で判断**。定常状態では可視範囲はデコード済みなのでこの経路は稀 | (b) を最初から実装 |
| **D5** | **NAV_cold の再定義**: 可視範囲窓が medium コーパス 30 枚を覆うため「遠方ジャンプ = miss」の前提が崩れる（全件 HIT 除外で n=0）。テストフック `evictDecoded()` でメモリ側のみ破棄してからジャンプし「ディスク温・メモリ冷」の miss 経路を測る | **採用** | NAV_cold 廃止（miss 経路の回帰を見失うため非推奨） |

## 4. 検討した方式

- **案 A（採用）: Rust 生成の表示解像度プレビュー層 + ディスクキャッシュ + サムネイルとの結合生成**。サムネイル生成のデコードに相乗りし、「サムネイルがある ⇒ プレビューがディスクにある」を生成側で保証。フロントは可視範囲ぶんをデコード済み `ImageBitmap` で保持（≤336MB）。miss コストは ~390ms → ~40ms。Picasa と同じ構造。
- 案 B: フロントのみ（`createImageBitmap(blob, {resizeWidth})` で縮小保持、Rust 無変更）。メモリは解決するが、**miss 時は 20MP のフルデコード（~390ms）が不変**、可視範囲 48 枚の充填に 48×390/3 ≈ 6s、再起動毎にやり直し、サムネイルとの結合も不可。ゴール G1 を満たせないため不採用。
- 案 C: 保証範囲の縮小（フル解像度のまま ±3 程度）+ サムネイルバーに「準備済み」インジケータ。Picasa 同等にならない。D1 が否決された場合のフォールバック。

## 5. 全体像と不変条件

3 層: **thumbnail**（20px、バー用・最終フォールバック）/ **preview**（画面ボックス以下、fit 表示の主経路）/ **full**（原寸、ズーム時のみ）。

```
[Rust] サムネイル生成コマンド: decode 1 回 → orientation 適用 → preview(JPEG+ICC) をディスクへ → preview から 20px thumb → 返却 {thumb_base64, oriented w/h}
[Rust] spica-img://…/preview/<box>/<path>: キャッシュ命中なら配信 / 欠落なら同じ関数で生成して配信（自己修復）
[FE]   thumbnails に entry が入る ──(I1)──> ディスクに preview がある
[FE]   preview 窓(可視範囲)に入った path ──(I2)──> fetch(preview) → createImageBitmap → bitmapCache[tier=preview]
[FE]   navigateToImage: preloaded(preview|full) hit → canvas 即描画(非プレースホルダー) / miss かつ thumbnail あり → thumbnail 先出し + preview ロード(~40ms) / どちらも無し → 現行 <img> フルロード
[FE]   zoom > previewScale → full を遅延ロード → canvas をフルで再描画（current のみ保持）
```

不変条件:
- **I1（生成結合）**: 非 GIF について `cache.thumbnails` に有効 entry ⇒ 同じ画面ボックスのプレビューがディスクにある（同一コマンド内で書いてから返す。`get_cached_thumbnail` はプレビューファイルの存在と原本 mtime も検証し、欠けていれば再生成）
- **I2（窓 = 可視範囲）**: fill 完了後、`{current} ∪ window(可視枚数)` の非 GIF は `bitmapCache` に preview tier を持つ。窓外は evict
- **I3（hit の正直さ）**: `cache.preloaded` の entry ⇒ `bitmapCache` に当該 tier のビットマップがある（PR #270 の不変条件を tier 付きで維持）
- **I4（ズーム品質）**: 表示スケール `zoom/100 > previewWidth/naturalWidth` のとき full をロードし、完了後は full で描画する。未完了の間はプレビューを拡大表示（Picasa と同じ一時的な甘さ）

## 6. 設計詳細

### 6.1 Rust: プレビュー生成（新規 `src-tauri/src/utils/preview.rs`）

```rust
pub struct PreviewBox { pub width: u32, pub height: u32 }   // 画面ボックス（D2）
pub struct Generated {
    pub preview_jpeg: Vec<u8>,      // orientation 適用済み・ICC 引き継ぎ・q85
    pub preview_w: u32, pub preview_h: u32,
    pub natural_w: u32, pub natural_h: u32,   // orientation 適用後の原寸
    pub thumbnail_base64: String,   // preview から生成（20px）
}
pub fn generate(path: &Path, bbox: PreviewBox, thumb_size: u32) -> Result<Generated, ImageError>
```

- `ImageReader::open` → `into_decoder()` → `orientation()` / `icc_profile()` を取得 → `DynamicImage::from_decoder` → `apply_orientation`
- 原本が画面ボックス以下なら**リサイズしない**（preview = 原寸、tier は実質 full。フロントは `preview_w == natural_w` で判定）
- リサイズは `fast_image_resize`（純 Rust・SIMD、Lanczos3/Bilinear、20MP→2MP で ~20–40ms）を追加依存として採用。`image::thumbnail()` の整数サンプラは表示品質に不足、`resize(Lanczos3)` は遅すぎる（~300ms+）
- エンコードは `image` の `JpegEncoder`（q85、`set_icc_profile`）。PNG/WebP の透過は**黒で合成**（ビューア背景と同色、見た目同一）
- GIF は対象外（コマンドはサムネのみ返す。`preview_available: false`）
- `SPICA_PERF=1` で op `thumb_preview`（decode / resize / encode の内訳）を出す — Phase 2 の回帰判定に使う

### 6.2 Rust: コマンドとキャッシュ（`commands/file.rs` / `commands/cache.rs`）

- `generate_thumbnail_with_dimensions(path, size, preview_box)` を拡張: `spawn_blocking` 内で `preview::generate` → プレビューを `{hash(path, box)}_p.jpg` に**一時ファイル + rename で原子的に書く** → サムネ JSON に `preview_box`, `source_mtime`, `source_size`, `natural_w/h` を追加して保存 → 返却（`original_width/height` は orientation 適用後）。現在の `async fn` は blocking 処理を tokio ワーカー上で直接実行しているため、`spawn_blocking` 化は既存の改善にもなる
- `get_cached_thumbnail(path, size, preview_box)`: JSON あり・24h 以内・`source_mtime/size` 一致・プレビューファイル存在 のすべてを満たす場合のみ `Some`。1 つでも欠ければ `None`（→ フロントが再生成コマンドを呼ぶ。I1 の維持）
- `clear_old_cache`: `.json` と `_p.jpg` の両方を対象に 24h 掃除 + 合計サイズ上限（D3）で mtime 古い順に削除
- `generate_image_thumbnail` はフロントから未使用（確認済み）のため削除。`set_cached_thumbnail` は成功時の書き戻しには不要になる（コマンド側で書く）が、**エラーマーカー（`"error"`）の保存に引き続き使う**（`useThumbnailGenerator.ts:108` の既存経路を維持）

### 6.3 Rust: プロトコル（`protocol.rs` / `lib.rs`）

- ルート追加: `http://spica-img.localhost/preview/<W>x<H>/<encodeURIComponent(path)>`。既存ルート（原本配信）は無変更
- 解決: 原本の検証（既存 `resolve_image_path`）→ キャッシュファイル → 存在 & mtime 一致なら配信 / 欠落なら `preview::generate` で生成・保存して配信（自己修復。サムネ生成と競合しても原子的書き込みで安全、重複生成は許容）
- レスポンスヘッダ: `Content-Type: image/jpeg`、`X-Spica-Natural-Width/Height`（orientation 適用後の原寸。フロントがレイアウト寸法に使う）、`Access-Control-Expose-Headers`
- `SPICA_PERF` op `serve_preview`（cache hit/miss を detail に）

### 6.4 フロント: 型とキャッシュ

- `ImageData` に `tier?: "preview" | "full"`（未指定 = full、後方互換）。`width/height` は**常に原寸**（orientation 適用後）。preview entry の `src` はプレビュー URL
- `bitmapCache`: `Map<path, { preview?: ImageBitmap; full?: ImageBitmap }>`。`setBitmap(path, bitmap, tier)` / `getBitmap(path)` は full 優先で `{bitmap, tier}` を返す / `deleteBitmap(path, tier?)` / `bitmapBytes()` は両 tier 合算。予算は `BITMAP_CACHE_BUDGET_BYTES = 500MB` を共有
- `bitmapLoader`: `loadPreviewBitmap(path, box, signal)`（ヘッダから原寸を読む）と既存 `loadBitmapViaProtocol`（full）。`src:set` は引き続き発行しない
- `constants/memory.ts`: `PREVIEW_BOXES = [[1920,1080],[2560,1440],[3840,2160]]`、`THUMBNAIL_ITEM_PITCH_PX = 40`、`FULL_BITMAP_RETAIN = 1`（current のみ）。`BITMAP_WINDOW_SIZE` は可視枚数から算出する関数 `visibleThumbnailCount(innerWidth)` に置換（`ceil(innerWidth / 40)`、下限 8・上限 96）

### 6.5 フロント: 表示（`ImageViewer.tsx` / `canvasDraw.ts`）

- 経路は 4 つに整理: (1) **hit**（preloaded preview|full）→ `navigateToImage` が同期的に data を設定、canvas 即描画、ロードなし（現行 hit と同じ）/ (2) **preview miss**（thumbnail あり = ディスクにプレビューあり）→ thumbnail 先出し（D4(a)）→ `loadPreviewBitmap` → `setBitmap(preview)` + `setImageData(tier: preview)` + `setPreloadedImage` → canvas / (3) **cold**（thumbnail なし）→ 現行の `<img>` フルロード経路を**無変更**で使用（TTFI_cold 保護）。完了後の `retainElementAsBitmap` は full tier として保持（current のみ）/ (4) GIF → 現行 `<img>`
- **canvas の寸法**: `drawBitmapToCanvas` はバッキング（`canvas.width/height`）= ビットマップ寸法、CSS（`imageStyle` の width/height）= 原寸のまま。合成器はテクスチャに合成変換（原寸/プレビュー × zoom）を直接掛けるため fit 表示では実質 1:1 サンプリングになり、**ズーム・パン・中央配置（`imageLeft/imageTop`、`fitToWindow`）の数学は無変更**。`HANDOFF_IMAGE_CENTERING_FIX` の CSS 修正（`.image-viewer canvas` に `position:absolute; transform-origin:center`）が前提
- **ズーム → full アップグレード**（I4）: `view.zoom` 変化を 150ms デバウンスで監視し、表示中 tier が preview かつ `zoom/100 > bitmap.width / data.width` なら `loadBitmapViaProtocol(path)`（full）を起動。完了時に path が current なら `setBitmap(full)` → `setImageData({...data, tier: "full"})` で canvas を再描画。ナビゲーションで中断（AbortController）。保存済み view state のズームが閾値超なら hit 直後に同じ処理を起動。`perfMark("zoom:request")` を store のズーム操作に追加
- `displayBitmap` メモ・`canvasMountRef`・イベントターゲット判定は現行のまま（tier 非依存）

### 6.6 フロント: スケジューラ（`useImagePreloader.ts` 改修）

- 保持集合 = `{current} ∪ computeWindow(index, direction, length, visibleThumbnailCount(innerWidth))`。優先順は現行の前方バイアス（[+1,+2,+3,−1,+4,…,−2,…]）を踏襲（`computeWindow` は size 引数で一般化済み）
- **fill ゲートの変更**: `allGenerated` を撤廃し、**path 単位**で「`cache.thumbnails` に有効 entry がある（= I1 によりディスクにプレビューがある）」ことを条件にする。`cache.thumbnails` を effect 依存に追加し、サムネイルが生成されるたびに窓内をポンプする（サムネイル生成順 = 現在地からの距離順なので可視範囲から順に埋まる）。「現在画像が非プレースホルダー表示済み」ゲートは維持（cold の `<img>` デコードと競合させない）
- 窓内で thumbnail entry がまだ無い path は**スキップ**（プロトコルの自己修復で生成させると Rust 側のサムネ生成と二重デコードになるため）。フォルダ全体のサムネが無い初回は、サムネ生成の進行に従って充填される
- evict: 窓外の preview を `close()`、full は current 以外を常に `close()`。予算超過時は遠い順。`cache.preloaded` も同時に除去（I3）
- ウィンドウリサイズ（`innerWidth` 変化）で窓サイズを再計算してポンプ
- 並列数 `MAX_CONCURRENT_LOADS = 3` 流用（2MP デコード ~25ms × 3 並列 → 可視 48 枚が ~0.5s で充填）
- `perfEvent("preload:done", { path, tier })`、`getStatus().preloadedCount` 互換維持（bench）

### 6.7 フロント: サムネイル生成（`useThumbnailGenerator.ts`）

- コマンド呼び出しに `previewBox` を渡す。`set_cached_thumbnail` の書き戻しを廃止（コマンドが書く）。`original_width/height` が orientation 適用後になるため、プレースホルダー寸法の既存不整合（§1-2）が解消される
- 既存の優先度キュー・段階拡張（±10 → ±30 → 全体）・中断は無変更。生成コストが +60〜100ms/枚 増える見込み（§8 R1）

### 6.8 store（`store/index.ts`）

- `navigateToImage`: hit 判定は `cache.preloaded`（preview|full）。hit なら `thumbnailDisplayed=false`（プレビューはプレースホルダーではない）。`perfEvent("preload", { hit, tier, thumbnailFallback })`
- `thumbnailToImageData` は `tier` なし（thumbnail は `ui.thumbnailDisplayed` で識別、現行通り）
- ズーム系アクションに `perfMark("zoom:request", { path, zoom })`

## 7. 計測・テスト・採否ゲート

### 7.1 perf マークとメトリクス定義（`docs/PERFORMANCE_AUTONOMY_PLAN.md` §2 を更新）

- `paint:done` detail: `{ path, thumbnail: boolean, tier: "thumbnail"|"preview"|"full" }`。`thumbnail === false` ⇔ tier ∈ {preview, full}。**`bench-helpers.ts` の `fullPaint`（最初の thumbnail:false）はコード無変更で「最初の非プレースホルダー paint」になる**（D1）
- 新指標 **NAV_visible**（本サイクルの主指標）: large コーパス（16 枚、全部が可視範囲）で preview 窓の充填（`waitForPreloadSettled(15)`）後、決定的な非単調 12 ステップ列（例 `[5,2,9,1,12,7,3,14,6,11,0,8]`：後退・ジャンプ・前進を含む）を NAV_rapid と同じ 250ms 下限・full paint 待ちで N=7 run。n = 84 固定、pool 中央値/p95、`hit_rate`、同サンプルの **PLACEHOLDER_dur_visible**
- 新指標 **ZOOM_full**: large コーパスで preview hit 中に `zoomIn()` → `zoom:request` → `paint:done`(tier full)。N=7。回帰ガード（現行の 20MP デコード相当 ~400ms。目標は設けず、悪化監視のみ）。`zoom:request` 時点の表示 tier が既に full なら **0**（アップグレード不要 = 正しい値）。**Phase 1 では全サンプル 0（n=7）**。Phase 3 で ~400ms 帯（20MP フルデコード）へ移るのは D1 で承認済みのトレードオフであり回帰とは扱わない（目安: 中央値 ≤ 500ms、超えたら調査）
- **NAV_cold**（D5）: ジャンプ前に `__SPICA_TEST__.evictDecoded()`（bitmapCache + `cache.preloaded` を破棄、thumbnails/ディスクは保持）。意味は「ディスク温・メモリ冷の miss 経路」。旧 baseline とは比較不能（新 baseline を記録）
- NAV_rapid / NAV_warm / TTFI_cold: プロトコル無変更（回帰ゲート）。NAV_rapid は窓拡大で全 hit になり NAV_visible と収束する見込み
- `save-baseline.mjs` の n ガードに NAV_visible（84）/ ZOOM_full（7）を追加。スキーマ §4 更新

### 7.2 テスト

- Rust（`cargo test --lib`）: `preview::generate` の orientation（EXIF 6 → 縦寸法）/ ICC 引き継ぎ（APP2 が出力に含まれる）/ ボックス以下は無リサイズ / 透過 PNG の黒合成 / キャッシュの mtime 不一致で `None` / 原子的書き込み / 容量上限掃除 / プロトコル resolver の `preview/<box>/` パース・不正ボックス拒否
- vitest: bitmapCache の tier 会計 / `visibleThumbnailCount` / スケジューラ（thumbnails 連動 fill・窓外 evict・full は current のみ）/ store hit（tier）/ ImageViewer 経路分岐（preview miss → canvas、zoom 閾値で full ロード起動、GIF は img）
- E2E 視覚（`visual.e2e.ts` 追加）: (a) exif 画像を **preview 経路**（隣接 hit）で表示し canvas 寸法が 800×1200 相当の縦比・中央配置 / (b) preview hit 中に zoomIn → `canvas.width === 5472` になる（フル到達）/ (c) 可視範囲内の後退ナビ（index 12 → 3）で `paint:done` の thumbnail:true が**出ない** / (d) 既存の中央配置アサート（Phase 0 由来）が canvas preview でも green

### 7.3 採否ゲート（CLAUDE.md 準拠）

- 改善ゲート: **NAV_visible 中央値 ≥10% 改善**（Phase 1 baseline 比。予測: ~400ms → ~30ms）かつ hit_rate = 1.0、PLACEHOLDER_dur_visible p95 < 80ms
- 回帰ゲート: TTFI_cold / NAV_warm / NAV_rapid が p95 の揺れを超えて悪化しない。ZOOM_full は回帰ゲートに含めず悪化監視のみ（目安: 中央値 ≤ 500ms、超えたら調査。§7.1）。サムネイル生成（`thumb_preview` op、large 1 枚あたり）が **+30% 以内**（超えたら Phase 4-b を先に実施）
- n 完全性: NAV_visible / NAV_rapid / PLACEHOLDER 系 = 84、それ以外 = 7
- 正しさ: `npm test` / `cargo test --lib` / `npm run test:e2e`（新規 4 ケース含む）green
- 採用時 `npm run bench:baseline` を同一コミット（メインセッション）。不成立なら revert

## 8. リスクと対策

| # | リスク | 対策 / 判定 |
|---|---|---|
| R1 | サムネイル生成が遅くなる（+60〜100ms/枚、+20〜30%）。初回フォルダオープンでバーの埋まりが遅く見える | `thumb_preview` op で before/after を計測し +30% をゲートに。超過時は Phase 4-b（`turbojpeg` の IDCT スケールデコード: 20MP を 1/2 で ~90ms → 生成全体が現行より速くなる見込み）を先行 |
| R2 | 色・向きの忠実性（ICC/EXIF） | Rust で orientation 適用 + ICC 引き継ぎ、unit + E2E(a)。既存の raw 寸法バグも同時解消 |
| R3 | canvas の「CSS 原寸 + 小さいバッキング」の画質 | 合成変換は 1:1。E2E(d) と目視で確認。問題があれば CSS 寸法をプレビュー寸法にし `imageStyle` の scale に `natural/preview` を掛ける代替（view の数学は不変のまま）へ切替 |
| R4 | メモリピーク: preview ≤336MB + full 80MB + canvas 80MB + デコード一時 | 予算 500MB は preview+full の会計。プロセスピーク ~600MB 台（PR #270 と同等）。予算超過は遠い順 evict |
| R5 | ディスク使用量（D3） | 上限 2GB + 24h。`get_cache_stats` にサイズを追加 |
| R6 | 原本の編集・差し替え | JSON の `source_mtime/size` 不一致で再生成（サムネも同時に正しくなる） |
| R7 | プロトコル自己修復とサムネ生成の二重デコード | 窓 fill は thumbnail entry を条件にするため通常は起きない。起きても原子的書き込みで安全 |
| R8 | NAV_cold の意味変更で旧 baseline と不連続 | Phase 1 で新定義の baseline を先に記録（最適化なし） |
| R9 | 4K ディスプレイではプレビュー 1 枚 ~25MB → 窓 20 枚程度で予算到達 | 予算ガードで自動縮退（窓外はディスクから ~60–80ms）。D2 のバケットで将来調整可能 |

## 9. 実装フェーズ（writing-plans への入力。各フェーズ = 1 ブランチ/PR = 1 つの実装プラン。次フェーズのプランは前フェーズのゲート結果を見てから書く）

- **Phase 0（前提、別ハンドオフ）**: `docs/HANDOFF_IMAGE_CENTERING_FIX.md` の修正 + 中央配置 E2E をマージ。canvas が主経路になる本件の回帰ゲートになる
- **Phase 1 — 計測系（最適化コード変更なし）**: `paint:done` に `tier`、`zoom:request`、テストフック `evictDecoded()` / `zoomIn()`、bench に NAV_visible / PLACEHOLDER_dur_visible / ZOOM_full、NAV_cold を D5 方式へ、`save-baseline` ガード、AUTONOMY_PLAN §2/§4 更新 → `bench:build && bench` → **新 baseline を記録**（苦情の数値再現: NAV_visible hit_rate 低・中央値 ~400ms の見込み）
- **Phase 2 — Rust プレビュー層**: `utils/preview.rs`（orientation/ICC/`fast_image_resize`/JPEG）、コマンド拡張 + `spawn_blocking`、キャッシュ（mtime・原子的書き込み・容量上限・`_p.jpg`）、プロトコル `preview/<box>/` ルート、`SPICA_PERF` op、cargo tests。フロントは `useThumbnailGenerator` を新コマンドに切替（寸法が oriented になる）。**ゲート**: cargo/vitest/e2e green、`thumb_preview` +30% 以内、TTFI_cold 無悪化（プレビューはまだ表示に使わない）
- **Phase 3 — フロント プレビュー層**: 型/bitmapCache tier、`loadPreviewBitmap`、スケジューラ（可視範囲窓・thumbnails 連動・allGenerated 撤廃・full は current のみ）、store hit、ImageViewer（preview miss 経路・zoom アップグレード・canvas 寸法）、vitest、E2E 視覚 4 ケース → **採否ゲート §7.3** → canonize
- **Phase 4 — 任意の後続（各 1 サイクル・1 仮説）**: (a) D4(b) 前画像保持によるプレースホルダー完全排除（PLACEHOLDER_dur_visible p95 が 0 でなければ）/ (b) `turbojpeg` IDCT スケールデコードでサムネ+プレビュー生成の高速化（R1 超過時は Phase 2 直後に前倒し）/ (c) プレビューの WebP 化（`image` は lossless のみのため別クレート要）

## 10. 関連ファイル

| ファイル | 変更 |
|---|---|
| `src-tauri/src/utils/preview.rs`（新規）/ `utils/image.rs` | 生成本体 / 既存 `generate_thumbnail` を preview 経由に |
| `src-tauri/src/commands/file.rs` / `commands/cache.rs` | コマンド拡張・`spawn_blocking`・mtime/容量/原子的書き込み |
| `src-tauri/src/protocol.rs` / `lib.rs` | `preview/<box>/` ルート・ヘッダ |
| `src-tauri/Cargo.toml` | `fast_image_resize` 追加 |
| `src/types/index.ts` / `src/constants/memory.ts` | `tier`、ボックス・ピッチ定数 |
| `src/utils/bitmapCache.ts` / `bitmapLoader.ts` / `imageSrc.ts` / `canvasDraw.ts` | tier 対応・preview URL/ローダ |
| `src/hooks/useImagePreloader.ts` / `useThumbnailGenerator.ts` | 可視範囲窓・thumbnails 連動 / 新コマンド |
| `src/store/index.ts` / `src/components/ImageViewer.tsx` | hit(tier)・zoom マーク / preview miss 経路・zoom アップグレード |
| `src/utils/testHooks.ts` / `e2e/lib/bench-helpers.ts` / `e2e/specs/bench.perf.ts` / `visual.e2e.ts` / `e2e/scripts/save-baseline.mjs` | フック・NAV_visible・ZOOM_full・NAV_cold 再定義・視覚ケース |
| `docs/PERFORMANCE_AUTONOMY_PLAN.md` §2/§4/§8、`PROJECT_SPEC.md`（Image Loading Strategy） | 定義更新 |

## 付録: 数値の根拠

- 可視枚数: `App.css` `.thumbnail-item { width: 30px; margin: 0 5px }` → ピッチ 40px。コンテナ padding `50vw` で current が中央 → 可視 = `innerWidth / 40`。現在画像が中央に来るため片側は `floor((innerWidth − 40) / 80)`（1920px で ±23、2560px で ±31）
- fit 表示の最大寸法: `calculateFitToWindowZoom` の有効領域 = `(innerWidth − 40) × (innerHeight − 80 − 40)` ≤ 画面ボックス。よって「画面ボックスに収めたプレビュー」は fit 表示で拡大されない
- メモリ: RGBA 4B/px。20MP = 80MB、1920×1080 ボックス 3:2 = 1620×1080 = 1.75MP = 7.0MB
- miss コスト・serve コスト: `docs/PERFORMANCE_NAV_RAPID_PHASE2_PROFILING.md` §B/§C（serve ~9ms、20MP ブラウザデコード ~390ms）
- `image` 0.25.10 API 確認: `ImageDecoder::orientation()/icc_profile()`（`src/io/decoder.rs`）、`DynamicImage::apply_orientation`（`src/images/dynimage.rs:1161`）、`JpegEncoder::set_icc_profile`（`src/codecs/jpeg/encoder.rs:752`）
