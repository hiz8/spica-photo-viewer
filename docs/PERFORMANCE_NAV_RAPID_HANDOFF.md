# 引き継ぎ: 画像ナビゲーションの体感性能改善（Picasa 同等の瞬時表示）

> このファイルは次セッションへの引き継ぎプロンプト。新セッション開始時にこの全文を読み、まず本ファイルを最初のコミットで永続化すること（未追跡のまま作業すると消失事故の前例あり）。

## ゴール

サムネイルバーに表示されている範囲の画像へのナビゲーションで、**ぼやけたプレースホルダーを知覚させず、体感即時にフル品質の画像を表示する**。Picasa Photo Viewer と同等の体感を数値で定義し、計測で裏付けて達成する。

## 前提（完了済みの仕事）

- リポジトリ: `C:\Users\hirof\Project\hiz\spica-photo-viewer`（Tauri v2 + React 19 + Zustand、Windows/WebView2 専用）
- **PR #266**（マージ済み）: 計測ハーネス一式 — WebdriverIO E2E（`@wdio/tauri-service` embedded）、`npm run bench`（TTFI_cold / NAV_warm / NAV_cold、N=7、中央値/p95）、決定論コーパス、視覚ゲート、`bench-results/baseline.json`、CLAUDE.md「Performance changes」採否ゲート
- **PR #267**（マージ済み）: base64 IPC 撤廃 → 独自 `spica-img` プロトコル（Rust が原本バイト配信、ブラウザ側 `Image.decode()`）。採否ゲート通過:
  - TTFI_cold 1771.4 → **483.8ms** / NAV_warm 162.0 → **23.1ms** / NAV_cold 515.6 → **179.9ms** / fetch_decode_cold 395.4ms
- スペック: `docs/PERFORMANCE_AUTONOMY_PLAN.md`（計測大原則・採否ゲート運用）。**計測系なしの最適化は禁止**が大原則。

## ユーザー実機で確認された問題（この引き継ぎの理由）

ビルドしたアプリを実機インストールし、大型画像（bench コーパス相当）で Picasa と比較した結果:

> **Picasa**: ナビゲーション時、下部サムネイルバーに表示されている画像であれば瞬時に（プレースホルダーでない）画像が表示される。プレースホルダーの表示は認識できない。
>
> **Spica**: サムネイルバーの生成速度はほぼ遜色ない。しかしメイン画像をナビゲーションすると、**ぼやけたプレースホルダーがまず表示され、オリジナル画像への切り替わりに体感 ~1s** 要する。高速切り替え時に大きなストレス。

## ベンチ（NAV_warm 23ms）と体感（~1s）の乖離 — 調査済みの分析（着手前に必ず計測で検証）

1. **NAV_warm はアイドル後の preload ヒットの理想ケースを測っている**。実使用の高速ナビは preload が追いつかず **MISS 経路**（キャッシュ済みサムネイル表示 → フル解像度アップグレード）に入る。ユーザーの見た「ぼやけたプレースホルダー」はこの経路の実物（`src/store/index.ts` `navigateToImage` の thumbnail fallback → `src/components/ImageViewer.tsx` の upgrade path）。
2. **MISS 経路のコスト**: 20MP のフル解像度 fetch+decode は実測で中央値 ~395ms（fetch_decode_cold）。高速連打時は preload の同時ロード（3 並列）と CPU/IO を奪い合い、体感 ~1s に伸びる。
3. **preload の構造問題**（`src/constants/timing.ts` / `src/hooks/useImagePreloader.ts`）: `thumbnailGeneration.allGenerated` まで開始しない / `PRELOAD_DELAY_MS=500` / 範囲 ±5 固定でナビ方向を無視 / `MAX_CONCURRENT_LOADS=3` / 高速ナビ中はキュー再構築が繰り返され定常化しない。
4. **根本**: ナビゲーション hot path が常に「**20MP フル解像度のデコード**」を要求する設計。Picasa は画面解像度で即時表示し、フル解像度はズーム時にしか要らない。fit-to-window 表示なら画面解像度（~2MP）のデコードで視覚的に等価であり、コストは 1/5〜1/10。
5. 補足: プレースホルダーに使われるサムネイルは極小（`THUMBNAIL_SIZE=20` ベース）のため引き伸ばしが激しくぼやけて見える。これは症状の一部であって根本ではない。

## 仮説候補（スペック Phase 5 の残候補に対応。profiling で確認できたものから 1 ブランチ 1 仮説）

- **A.（最有力）表示解像度プレビューのディスクキャッシュ**: Picasa 方式。アイドル時（サムネイル生成と同時 or 直後）に画面解像度（例: 長辺 1920〜2560px）のプレビューを Rust で生成しディスクキャッシュ（既存 `%APPDATA%\SpicaPhotoViewer\cache\` の仕組みを拡張）。ナビゲーション時はプレビューを `spica-img` 経由で即表示（fit 表示ではフル品質と区別不能 = プレースホルダー知覚なし）、フル解像度はズーム時のみ遅延ロード。JPEG は `turbojpeg`/`zune-jpeg` 等の IDCT スケーリング対応クレートなら 20MP→1/4 スケールデコードが高速（`image` クレートのフルデコード+リサイズより大幅に速い。クレート選定は要調査）。
- **B. preload スケジューリング再設計**: allGenerated ゲート撤廃（プレビュー/フルを分離）、遅延 500ms 撤廃または短縮、ナビ方向優先（進行方向 +N を先読み、逆方向は少なく）、現在画像のロードを preload より常に優先（優先度キュー/中断）。
- **C. デコード済みビットマップの確実な保持**: 現状の `retainedImages`（HTMLImageElement 参照保持）はエンコード済みリソースの保持であり、デコード済みビットマップの保持は保証されない。`createImageBitmap` + canvas 描画（または ImageBitmap キャッシュ）で ±N のデコード済みを確実に持てば、ヒット時は同期描画になる。ImageViewer 経由ロードが retainedImages に入らない既知の非対称（PR #267 の park 済み follow-up）もここで解消。
- 注意: A が本命（MISS 経路自体を安価にする）。B/C は A と直交で併用可能だが、**全部同時にやらない**。profiling の数値で支配要因を確認してから 1 つずつ。

## 進め方（必須の順序 — スペックの大原則に従う）

1. **まず計測系の拡張**（最適化コード変更なし）: ユーザーの苦情を再現する新指標を bench に追加し baseline を記録する。これ無しで最適化に着手してはならない。
   - **NAV_rapid**: preload の定常化を待たず、約 250ms 間隔で連続ナビゲーション（10〜15 ステップ、large コーパス）。各ステップの `open:request` → **フル品質 paint**（`paint:done` thumbnail:false）の中央値/p95。
   - **PLACEHOLDER_dur**: 同じ run で「プレースホルダー表示時間」= 最初の paint（thumbnail:true）→ フル品質 paint の間隔。0（プレースホルダー無し）も正しい値として扱う。
   - 既存 3 指標（TTFI_cold / NAV_warm / NAV_cold）は回帰ゲートとして維持。
2. **profiling**: NAV_rapid 実行時の MISS 経路内訳（fetch vs decode vs paint、preload との競合）を数値で確定。`npm run profile:rust`（piped spawn。wdio サービスは Rust stderr を拾えない既知の制限）と `__PERF__` マークを使う。
3. 支配要因に対応する仮説 1 つを選び、brainstorming → writing-plans → subagent-driven-development で実装。
4. **採否ゲート**（CLAUDE.md 準拠 + 本件の目標）:
   - 目標（体感即時の数値定義）: **NAV_rapid フル品質 paint 中央値 < 100ms、かつ PLACEHOLDER_dur 中央値 < 80ms（知覚困難域）またはプレースホルダー非表示**（サムネイル可視範囲の画像に対して）
   - サイクル毎の改善ゲートは対象指標中央値 ≥10% 改善
   - 回帰ゲート: 既存 3 指標が p95 の揺れを超えて悪化しない
   - 正しさ: `npm test` + `cargo test --lib`、視覚ゲート: `npm run test:e2e`（ズーム時のフル解像度表示が壊れていないことの検証を追加すること — 仮説 A はズーム経路を変えるため）

## プロセス上の注意（過去セッションの実績から）

- superpowers スキルに従う（brainstorming → writing-plans → subagent-driven-development）。worktree は origin/main から作成。
- **サブエージェントの編集では biome の PostToolUse hook が発火しない**（既知、CI 落ちの実績 2 回）。各タスクのコミット前検証に `npm run lint` と `npm run format`（差分があれば `format:fix`）を必ず含めるよう dispatch に明記。
- 意図的な依存配列（リセットトリガ等）には理由付き `// biome-ignore lint/correctness/useExhaustiveDependencies:` を使う（前例: `src/hooks/useImagePreloader.ts`）。
- park 済み follow-up（PR #267 由来、関連するなら取り込んで良い）: 拡張子 allowlist の 3 箇所重複（`is_supported_image`/`get_image_format`/`mime_for`）統合 / ImageViewer ロードの retainedImages 非対称 / `bench:baseline` が bench を再実行する仕様（判定 run の JSON を直接 baseline 化する方式に変えると良い — 今回のように閾値がタイトな場合に重要）。
- 計測は必ず release ビルド（`npm run bench:build` → `npm run bench`）。ベンチ中は他の重負荷アプリを起動しない。
- Phase 3 で確定した baseline は同一マシンでのみ有効。

## 主要ファイル

| ファイル | 役割 |
|---|---|
| `src-tauri/src/protocol.rs` + `src-tauri/src/lib.rs` | `spica-img` プロトコル（resolver/mime/登録）。プレビュー配信の拡張点 |
| `src/utils/protocolLoader.ts` | URL 設定→decode→ImageData+element。`src:set` mark 発行 |
| `src/utils/imageSrc.ts` | URL/format ビルダ |
| `src/components/ImageViewer.tsx` | `loadImage`（サムネイル upgrade / 二段階 / 直接 / GIF の 4 経路）、paint/decode 計測 effect |
| `src/store/index.ts` | `navigateToImage`（preload/サムネイル fallback 判定、`open:request`/`preload` mark） |
| `src/hooks/useImagePreloader.ts` | preload キュー/並列/±5/retainedImages |
| `src/hooks/useThumbnailGenerator.ts` | サムネイル生成（プレビュー生成の相乗り候補） |
| `src/constants/timing.ts` | 全タイミング定数 |
| `e2e/specs/bench.perf.ts` + `e2e/lib/bench-helpers.ts` + `e2e/scripts/run-bench.mjs` | bench 本体（NAV_rapid の追加点） |
| `src-tauri/src/commands/cache.rs` | 既存ディスクキャッシュ（プレビューキャッシュの拡張点） |

## コマンド

```bash
npm run bench:corpus   # 決定論コーパス生成（46 枚 + exif）
npm run bench:build    # perf 有効 release ビルド（--features e2e, VITE_PERF_LOG=1）
npm run bench          # フルベンチ（cold はサンプル毎に別プロセス）
npm run bench:baseline # bench + baseline.json 更新（縮退 run ガード付き）
npm run test:e2e       # smoke + visual（視覚ゲート）
npm run profile:rust   # SPICA_PERF=1 で Rust 側内訳（piped spawn）
```

## 最初にやること

1. このファイルをコミット
2. `docs/PERFORMANCE_AUTONOMY_PLAN.md` と CLAUDE.md「Performance changes」を読む
3. 上記「進め方 1」（NAV_rapid / PLACEHOLDER_dur の計測系拡張）の実装プランを作成してレビューを受ける
