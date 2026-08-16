# 引き継ぎ: 進め方 2 — NAV_rapid の profiling と支配要因に基づく最適化（Picasa 同等の瞬時表示）

> このファイルは次セッションへの引き継ぎプロンプト。新セッション開始時にこの全文を読み、origin/main から worktree を作成した上で、まず本ファイルを `docs/PERFORMANCE_NAV_RAPID_PHASE2_HANDOFF.md` として最初のコミットで永続化すること（未追跡のまま作業すると消失事故の前例あり）。

## ゴール（不変）

サムネイルバーに表示されている範囲の画像へのナビゲーションで、ぼやけたプレースホルダーを知覚させず体感即時にフル品質を表示する。数値ゲート（CLAUDE.md「Performance changes」に記載済み）:
- **NAV_rapid フル品質 paint 中央値 < 100ms** かつ **PLACEHOLDER_dur 中央値 < 80ms または 0**
- サイクル毎の改善判定は **NAV_rapid 中央値**で行う。PLACEHOLDER_dur は hit 優勢時に中央値が 0 に飽和するため**進捗は p95 で追う**

## 前提（完了済み）

- リポジトリ: `C:\Users\hirof\Project\hiz\spica-photo-viewer`（Tauri v2 + React 19 + Zustand、Windows/WebView2 専用）
- **PR #266**: 計測ハーネス / **PR #267**: spica-img プロトコル / **PR #268（マージ済み・直近）**: NAV_rapid / PLACEHOLDER_dur 計測系 — 「進め方 1」完了。苦情は数値再現済み。
- **現 baseline**（`bench-results/baseline.json`、gitSha adfe42b、詳細は `docs/PERFORMANCE_AUTONOMY_PLAN.md` §8）:
  TTFI_cold 334.9 / NAV_warm 38.7 / NAV_cold 161.8 / **NAV_rapid 377.25（p95 973.6、n=84、hit_rate 0.714、単一ステップ最大 ~1.5s）** / PLACEHOLDER_dur 中央値 0（p95 352.9）/ fetch_decode_cold 243.0 / fetch_decode_rapid_miss 294.55（n=24）
- baseline は**マシン条件ドリフトにより全指標を現条件で再アンカー済み**（§8 に経緯記録）。コード無変更で NAV_warm がタイトな分布のままジャンプしたら環境ドリフトの兆候 — 再 baseline すること。同一マシン・同一条件でのみ比較有効。

## 進め方 1 で判明した重要事実（profiling の設計前提。着手前に必ず読む）

1. **NAV_rapid は固定プロトコルの混合分布**（§2 に文書化済み）: run 0 は fresh-preload レジーム（真の hit は数十 ms）、run 1 以降は「**遅い hit**」レジーム（preload Map に entry はあるが paint まで 374〜1499ms、PLACEHOLDER_dur=0）。hit_rate 0.714 で中央値 377ms ⇒ **中央値を支配しているのは遅い hit**。比較は bench 実行 1 回分同士のみ有効。per-run 内訳は bench ログ（`NAV_rapid run k: [...] (hits x/12)`）に出る。
2. **遅い hit の推定メカニズム（profiling で必ず数値検証すること）**: ImageViewer 経由でロードされた画像は `cache.preloaded` に入るが `retainedImages`（HTMLImageElement 保持）には入らない既知の非対称（PR #267 の park 済み follow-up）。ブラウザ側のリソースが失われた entry への「hit」は `<img src>` 再設定 → **spica-img の 20MP 再フェッチ + 再デコード**になる。また `useImagePreloader` の cleanupCache は queue が空だと呼ばれない（early return）ため、stale entry が ±5 外にも残存し得る。
3. **マークの経路別構成**（オフライン対応付けの鍵）: MISS ステップ = `open:request` → thumbnail paint → `src:set` → `decode:done`(thumbnail:false) → `paint:done`。**hit ステップは `src:set` を発行しない**（store が同期的に data を設定、ImageViewer はロードをスキップ）が、paint effect の `img.decode()` により `decode:done`/`paint:done` は出る。⇒ hit の `open:request`→`decode:done` 間隔がブラウザ側 再フェッチ+デコードの近似になる。
4. **裏取りは Rust 側で**: `SPICA_PERF=1` の serve ログ（op: `serve`）に protocol フェッチが 1 件ずつ出る。遅い hit の時刻に serve が発火していれば「再フェッチ」が実証される。`fetch_decode_rapid_miss` は稀に preloader 由来の `src:set` を拾う競合があり得るため、viewer/preloader の区別は serve ログで行う（`src/utils/protocolLoader.ts` の `src:set` は両者共用）。
5. **250ms 未満の間隔では preload は一切走らない**（500ms タイマーが index 変更毎にリセット）。ステップが 500ms を超えた時だけ preload が発火し以降と競合する。遅い hit が fetch_decode_cold（243ms）より大幅に遅い（〜1.5s）のは競合/直列化の疑い — serve ログの並び・所要で確認。
6. 固定間隔 fire-and-forget は ImageViewer の abort により MISS サンプルが検閲されるため使わない（NAV_rapid は full paint 待ち + 下限 250ms。§2 参照）。

## 仮説マップ（1 ブランチ 1 仮説。profiling の数値で 1 つ選ぶ）

- **C. デコード済みビットマップの確実な保持**（retainedImages 非対称の解消 + 保持戦略）: **遅い hit に直結** — 中央値の支配要因なら本命。ImageViewer ロードの retain 化、または ImageBitmap/canvas キャッシュで ±N を確実に保持。
- **A. 表示解像度プレビューのディスクキャッシュ**（Picasa 方式）: MISS コストと再フェッチコストを抜本的に下げる（20MP→~2MP）。JPEG は IDCT スケーリング対応クレート（turbojpeg/zune-jpeg 等、要調査）。**ズーム経路を変えるため「ズーム時にフル解像度」の E2E 検証追加が必須**。
- **B. preload スケジューリング再設計**: 事実 5 により高速ナビ中は preload 自体が走らない — 単独では効果薄。優先度低。
- C と A は直交で併用可能だが同時にやらない。profiling で「遅い hit の内訳（再フェッチか、デコードか、競合か）」と「hit/miss の中央値寄与」を確定してから選ぶ。

## 進め方（必須の順序）

1. **profiling（最適化コード変更なし）**: `npm run bench:build` 後、`SPICA_PERF=1` で NAV_rapid 相当のシーケンスを実行し（`npm run profile:rust` の仕組みを流用。wdio サービスは Rust stderr を拾えないため piped spawn — `e2e/scripts/profile-rust.mjs` を読むこと）、次を数値で確定:
   - 遅い hit の件数・分布と、その時刻に対応する serve 発火の有無/所要（再フェッチ実証）
   - hit の `open:request`→`decode:done` と MISS の fetch_decode_rapid_miss の対比、serve の並行度・直列待ち
   - NAV_rapid 中央値への hit/miss 寄与の分解
2. 支配要因に対応する仮説 1 つを選び、brainstorming → writing-plans → subagent-driven-development で実装（worktree は origin/main から）。
3. 採否ゲート（CLAUDE.md 準拠）: NAV_rapid 中央値 ≥10% 改善（最終目標 <100ms）/ 既存指標（TTFI_cold / NAV_warm / NAV_cold）が p95 の揺れを超えて悪化しない / `npm test` + `cargo test --lib` + `npm run test:e2e` green（仮説 A ならズーム E2E 追加）/ NAV_rapid・PLACEHOLDER_dur の n=84 完全性 / 採用時は `npm run bench:baseline`（**bench 再実行なしで直近 run を直接 canonize**）を同一コミットで。

## プロセス上の注意（実績ベース）

- サブエージェント編集では biome hook が発火しない（CI 落ち実績）。**e2e/ は `npm run lint`/`format` の対象外**なので、変更ファイルに `npx biome format --write <paths>` と `npx biome lint <paths>` を dispatch に明記。
- `npm run type-check:test` には **main 由来の既存エラー 20 件**がある（15 件 e2e/lib/bench-helpers.ts ほか）。ゲートは「新規エラーゼロ・計 20 のまま」。修正しないこと。
- サブエージェントは `npm run bench:baseline` を権限拒否されることがある — canonize はメインセッションで実行。
- `bench:build`（~10 分）と `bench`（~25 分/回）はフォアグラウンドタイムアウトを超える — バックグラウンド実行で待つ。ベンチ中は他の重負荷処理禁止。
- push は SSH 不可の環境: `git -c credential.helper="!gh auth git-credential" push https://github.com/hiz8/spica-photo-viewer.git <branch>`、PR は `gh pr create`。
- park 済み follow-up（残）: 拡張子 allowlist の 3 箇所重複統合 / retainedImages 非対称（仮説 C を選ぶ場合は本体作業になる）。

## 主要ファイル

- `e2e/specs/bench.perf.ts`: NAV_rapid 本体（per-run ログ、混合プロトコルのコメント）
- `e2e/scripts/profile-rust.mjs`: SPICA_PERF=1 piped spawn（profiling の流用元）
- `src/hooks/useImagePreloader.ts`: retainedImages / cleanupCache の early return（事実 2）
- `src/components/ImageViewer.tsx`: loadImage 4 経路 + hasFullResolution スキップ（hit が src:set を出さない理由）+ paint/decode effect
- `src/store/index.ts` `navigateToImage`: hit/thumbnail-fallback 判定、`preload` イベント
- `src/utils/protocolLoader.ts`: `src:set` 発行（viewer/preloader 共用 — 事実 4 の注意）
- `src-tauri/src/protocol.rs`: spica-img（SPICA_PERF serve ログ / プレビュー配信の拡張点）
- `docs/PERFORMANCE_AUTONOMY_PLAN.md` §2/§4/§8: 指標定義・スキーマ・baseline と再アンカー経緯
- `docs/PERFORMANCE_NAV_RAPID_HANDOFF.md`: 前フェーズの引き継ぎ（冒頭に進捗ブロックあり）

## 最初にやること

1. origin/main から worktree を作成し、このファイルを `docs/PERFORMANCE_NAV_RAPID_PHASE2_HANDOFF.md` としてコミット
2. `docs/PERFORMANCE_AUTONOMY_PLAN.md`（特に §2/§8）と CLAUDE.md「Performance changes」、`e2e/scripts/profile-rust.mjs` を読む
3. 「進め方 1」（profiling）の実行プランを作成してレビューを受ける
