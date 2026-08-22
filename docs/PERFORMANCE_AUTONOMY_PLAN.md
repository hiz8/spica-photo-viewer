# Performance Autonomy Plan — Spica Photo Viewer

コーディングエージェント（Claude Code）が、**人手を介さずにパフォーマンス改善を計測・実装・検証・採否判断**できるようにするためのハーネスと運用ルールの構築計画。

このファイルはリポジトリのルート（または `docs/`）に配置し、実装が進むごとにチェックボックスを更新すること。

---

## 0. ゴールと対象問題

Picasa Photo Viewer と比較して現状 Spica が遅い、以下の 2 点を数値で改善する。

| ID | 問題 | 主指標 | 目標（PROJECT_SPEC 準拠） |
|----|------|--------|--------------------------|
| P1 | 画像を開いた際の初期表示が遅い（ローディング表示が長い） | **TTFI (Time To First Image, cold)** | 起動〜初回描画 < 500ms |
| P2 | 次の画像へのナビゲーション表示が遅い | **Navigation latency (warm / preload-hit)** | 切り替え < 100ms |

**大原則**: パフォーマンスは連続値でノイズが乗るため、「再現性のある計測系」を先に作る。計測系が無いままの最適化はエージェントがノイズを改善と誤認する。したがって Phase 1（計測）を必ず最初に完了させ、baseline を確定してから最適化に入る。

---

## 1. 全体アーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│  bench harness (WebdriverIO + @wdio/tauri-service (embedded), Windows/WebView2)│
│   - release ビルドを起動                                       │
│   - 固定コーパス × 固定操作シーケンスを N 回実行                  │
│   - cold / warm を明示的に切替                                 │
└───────────────┬─────────────────────────────────────────────┘
                │ 収集
                ▼
┌─────────────────────────────────────────────────────────────┐
│  instrumentation（両側に計時を埋め込む）                        │
│   Frontend: performance.mark / measure（区間計時）             │
│   Rust:     tracing span / Instant（コマンド処理時間）          │
└───────────────┬─────────────────────────────────────────────┘
                │ JSON 出力
                ▼
┌─────────────────────────────────────────────────────────────┐
│  bench-results/*.json（中央値・p95）→ baseline と比較           │
│   → 改善閾値 & 回帰ゲート & 正しさゲートで採否判断                │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. 指標の定義（曖昧さを排除する）

エージェントが同じものを測り続けられるよう、区間を厳密に定義する。フロントの `performance.mark` 名は以下で固定する。

| mark / measure 名 | 意味 |
|-------------------|------|
| `open:request` | 画像オープン/ナビゲーションのトリガ時刻 |
| `src:set` | 画像 URL 設定・fetch 開始直前 |
| `decode:done` | `img.decode()` 完了 |
| `paint:done` | 実際に画面へ反映（`requestAnimationFrame` 直後） |
| `measure: ttfi` | `open:request` → `paint:done` |
| `measure: fetch_decode` | `src:set` → `decode:done`（`thumbnail: false` のフル解像度側と対応付け） |

> **実装注記**: `measure: ttfi` 等の区間はアプリ内では計算しない。アプリは `detail.path` 付きの mark を `window.__PERF__` に積むだけで、対応付け（同一 path の `open:request` → `paint:done` など）はベンチハーネスがオフラインで行う。ナビゲーション中断や abort が起きても計測が壊れないため。
> また `paint:done` は `detail.thumbnail` フラグを持つ。サムネイル先行表示→フル解像度差し替えの 2 段階描画では、**最初の paint:done（thumbnail 含む）までを TTFI**、`thumbnail: false` の paint までを `TTFI_full` として両方集計する。
> `paint:done` は `detail.tier`（`"thumbnail" | "preview" | "full"`）も持つ（2026-08-21、プレビュー層の設計 D1）。`thumbnail === false` ⇔ `tier !== "thumbnail"`。bench の「フル品質 paint」判定は従来通り `thumbnail === false` で行い、`tier` は「最初の非プレースホルダー paint が preview か full か」の診断と ZOOM_full の対応付けに使う。`zoom:request`（detail: `path`, `zoom`, `displayedTier`）はズーム操作の要求時刻。**Phase 3 実装後（2026-08-22）**: 表示解像度プレビュー層が有効なため、最初の非プレースホルダー paint は通常 **preview tier**（キャッシュ済みプレビュー、またはディスク上のプレビューをデコード）であり、`tier: "full"` はズームアップグレード時か、プレビューが不要なほど小さい画像（ダウンスケール不要）に限られる。`preload` イベント（`src/store/index.ts`）の detail にも `tier`（ヒット時に表示される ImageData の tier、`null` when not hit）が含まれる。
> **Rust 側 op（`SPICA_PERF=1`、2026-08-22 追加）**: `thumb_preview`（`generate_thumbnail_with_dimensions` 全体 = 1 回のデコードからサムネイル + プレビューを生成しディスクへ書くまで。内訳 `preview_decode` / `preview_resize` / `preview_encode`）、`serve_preview`（`/preview/<box>/` 配信。キャッシュ命中時は読み出しのみ）。生成コストの回帰判定は `npm run profile:rust`（キャッシュ削除後、large 16 枚）の `thumb_preview` 中央値で行い、Phase 2 着手前の `thumbnail` 中央値 T0 の 1.3 倍以内を要求する。 実装: デコード `image`（zune-jpeg）、リサイズ `fast_image_resize` Lanczos3 + rayon、エンコード `jpeg-encoder` q85 4:2:0 SIMD。Phase 2 の実測は §8 注記（T0 231.3 → T1 287.6ms）。
> 2026-08 のプロトコル化以降、IPC 区間はホットパスに存在しない。旧 baseline の `ipc_cold`/`decode_cold` と新 `fetch_decode_cold` は比較不能（パイプライン相違）。

集計する指標:

- **TTFI_cold**: キャッシュ・preload 無しでの `ttfi`（= P1）
- **NAV_warm**: preload ヒット時の `ttfi`（= P2 の理想ケース）
- **NAV_cold**: **メモリ冷・ディスク温**の miss 経路。プリローダー静穏後にテストフック `evictDecoded()`（デコード済みビットマップ + `cache.preloaded` を全消去。サムネイルとディスクキャッシュは保持）を呼んでから stride ジャンプしたときの `ttfi`。2026-08-21 に再定義（旧定義「±5 の外への遠方ジャンプ」は保持窓が可視範囲に広がると成立しないため）。旧 baseline とは比較不能
- **NAV_rapid**: preload の定常化を待たない連続ナビゲーション（large コーパス、12 ステップ × N run、ステップ間隔はフル品質 paint 待ち + 下限 250ms）での各ステップの `open:request` → `paint:done`(thumbnail: false)。**ヒット/ミスを除外せず全ステップを pool する**（n = runs × steps）。固定間隔の fire-and-forget を使わない理由: ImageViewer は後続ナビで進行中ロードを abort するため、固定間隔では MISS ステップのフル品質 paint が発生せず、生存サンプルが preload ヒットに偏って中央値が壊れる。`hit_rate` を診断用に併記。
- **PLACEHOLDER_dur**: NAV_rapid の同一サンプルにおける「最初の `paint:done`（サムネイル fallback）→ フル品質 `paint:done`」の間隔。プレースホルダー非表示（最初の paint が既にフル品質）のときは **0 が正しい値**。注意: 0 は「ぼやけが見えない」ことしか意味せず「即時」を意味しない（preload Map ヒットでもブラウザ側のデコード済みリソースが失われていると paint まで数百 ms〜1.5s かかる「遅い hit」が存在する）。体感即時の判定は必ず NAV_rapid とペアで行う。
- **NAV_visible**（2026-08-21 追加、プレビュー層ワークストリームの主指標）: large コーパス（16 枚、全てサムネイルバー可視範囲内であることを実行時に検証: バーは現在画像を中央に置くため片側の可視枚数 `floor((innerWidth − 40) / 80)` が `N − 1` 以上であること）を index 0 から決定的な**非単調** 12 ステップ列 `[5,2,9,1,12,7,3,14,6,11,0,8]`（後退・ジャンプ・前進を含む）でナビゲーションしたときの各ステップの `open:request` → `paint:done`(thumbnail: false)。ペーシングは NAV_rapid と同じ（フル品質 paint 待ち + 下限 250ms）。hit/miss を除外せず pool（n = runs × 12 = 84 固定）、`hit_rate` を併記。「サムネイルが見えている画像はプレースホルダー無しで即時表示」（Picasa 同等）の数値定義。**Phase 3 実装後**: 可視範囲窓スケジューラが可視範囲全体に対して preview tier のデコード済みビットマップを保持するため、可視範囲窓のフィルが定常状態に達していれば `hit_rate` は **1.0** が期待値（全ステップで `tier: "preview"` の cache hit）。フィル未完了（フォルダを開いた直後などサムネイル生成中）や大きいコーパスで窓が可視範囲全体をカバーしきれない場合は 1.0 を下回り得る
- **PLACEHOLDER_dur_visible**: NAV_visible の同一サンプルにおける「最初の paint → フル品質 paint」の間隔。0 が正しい値（PLACEHOLDER_dur と同じ読み方）
- **ZOOM_full**（2026-08-21 追加）: large コーパスで画像を表示後に `zoomIn()` したときの `zoom:request` → 最初の `paint:done`(tier: "full")。要求時の表示が既に full なら **0**（アップグレード不要）。現行は常に 0。表示解像度プレビュー層の導入後は 20MP フルデコード相当（~400ms 帯）に移る見込みで、これは D1 で承認されたトレードオフ — 回帰ゲートではなく悪化監視（目安: 中央値 ≤ 500ms）。n = runs
- 内訳（`fetch_decode`）: ボトルネック切り分け用

> NAV_rapid / PLACEHOLDER_dur の n は runs × steps（既定 7 × 12 = 84）で固定。除外ルールがないため n < runs × steps は計測失敗を意味する（save-baseline がガードする）。n=84 の nearest-rank p95 は n=7 と違い外れ値 1 個では汚染されないため、この 2 指標に限り p95 も参考値以上に使ってよい。
> **再現性の単位はプロトコル全体**: run 間リセットが保証するのは「index 0 に戻る + preloader 静穏」のみで、メモリキャッシュの中身はセッションを通じて意図的に進化する（run 0 は fresh-preload レジーム、run 1 以降は ImageViewer 経由ロードが retainedImages に入らない既知の非対称により「遅い hit」レジームを含む — これはユーザー苦情「体感 ~1s」の実物）。したがって NAV_rapid は混合分布であり、比較は必ず「同一の固定プロトコル一式（bench 実行 1 回分）」同士で行う。run 単体同士の比較は無効。per-run の内訳は bench ログ（`NAV_rapid run k: ...`）で確認できる。

各指標は **N 回実行の中央値と p95** を記録する（単発値は使わない）。

---

## 3. Phase 別実装計画

### Phase 1 — 計測ハーネス構築（最優先 / 最適化コード変更なし）

- [x] **フロント計時ユーティリティ** `src/utils/perf.ts` を新規作成
  - `perfMark(name)`, `perfMeasure(name, start, end)` を提供
  - 計測結果を `window.__PERF__`（配列）に push し、E2E から読めるようにする
  - `import.meta.env.DEV` や環境変数でオン/オフ可能に（release 計測用にビルドフラグで有効化）
- [x] **計時の埋め込み**（P1/P2 の経路に沿って最小限に）
  - `src/components/ImageViewer.tsx`: オープン/ナビゲーション時に `open:request` / `paint:done`
  - `src/components/ImageViewer.tsx の loadImage コールバック（invoke("load_image") 呼び出し 4 箇所）`: `ipc:sent` / `ipc:received` / `decode:done`
  - `src/store/index.ts`: preload ヒット/ミスのフラグを計測ログに含める
- [x] **Rust 側計時** `src-tauri/src/commands/file.rs`（load_image コマンド）と `src-tauri/src/utils/image.rs`（decode/encode 実処理）に `Instant` 計測を追加し、`tracing`（または `println!`）で構造化ログ出力（JSON 1 行）
- [x] **preload 可視化**: `src/store/index.ts` の preload 判定に、対象 path が `cache.preloaded` にヒットしたか否かをログに残す

**完了条件**: アプリを手動起動して画像を開閉すると、`window.__PERF__` と Rust ログに区間時間が出る。

---

### Phase 2 — ベンチ駆動（WebdriverIO + @wdio/tauri-service, Windows）

E2E ハーネスは存在しないためここで新規構築し、性能計測専用スペックを追加する。

- [x] `e2e/` 配下に WebdriverIO をセットアップ（`@wdio/tauri-service` の embedded プロバイダ（Rust 側に `tauri-plugin-wdio-webdriver` を cargo feature `e2e` 付きで追加。外部ドライバ不要、WebView2 とのバージョン整合問題を回避））
- [x] `wdio.conf.ts` の `onPrepare` で **release ビルド**を実行（`cargo build --release` または `tauri build --debug` は使わず、計測は release で行う）
- [x] **固定コーパス** `e2e/fixtures/corpus/` を用意：
  - `small/`（〜1MP）, `medium/`（〜8MP）, `large/`（2000px 超, 20MP 前後）を各数枚
  - コーパスは Git LFS もしくは生成スクリプトで再現可能にする
- [x] **ベンチスペック** `e2e/specs/bench.perf.ts`：
  - **TTFI_cold**: **新規アプリプロセス起動** + `%APPDATA%\SpicaPhotoViewer\cache\` クリア（ディスク上のサムネイルキャッシュ）の状態で画像を開く。フル画像の preload はプロセス内メモリのため、セッション再起動が cold の必要条件。`paint:done` を待つ → `ttfi` 収集
  - **NAV_warm**: 連番を順方向にナビゲーション（preload が効く想定）→ `ttfi` 収集
  - **NAV_cold**: 遠方インデックスへジャンプ（preload ミス想定）→ `ttfi` 収集（2026-08-21 に再定義: §2 参照）
  - 各ケースを **N=7〜10 回**繰り返し
  - `browser.execute(() => window.__PERF__)` で計測を回収
- [x] **結果出力** `bench-results/<git-sha>-<timestamp>.json` に中央値/p95 を書き出す（スキーマは §4）

**完了条件**: `npm run bench` 一発で、release アプリを起動し JSON 結果が生成される。

---

### Phase 3 — baseline 確定

- [x] 最適化前の状態で `npm run bench` を実行
- [x] 結果を `bench-results/baseline.json` として**コミット**（以降の比較基準）
- [x] baseline を README か本ファイルの §8 に転記（現状値の記録）

---

### Phase 4 — プロファイリング（原因特定 / 当て推量禁止）

エージェントは修正前に必ずボトルネックを数値で特定する。

- [x] **フロント**: WebView2 は Chromium 系のため Chrome DevTools Protocol / Performance トレースが利用可。まずは §2 の `ipc` / `decode` 内訳で「転送が支配的か、デコードが支配的か」を判定
- [x] **Rust**: `tracing` span、必要に応じ `cargo flamegraph` でディスク I/O・エンコード処理のホットスポットを可視化
- [x] 支配的な区間を **1 つだけ**選び、Phase 5 の仮説に対応付ける

**Phase 4 実測記録（2026-08-16, gitSha a9a3634）**:
- フロント内訳（baseline より）: TTFI_cold median 1771ms のうち ipc（ipc:sent→ipc:received）1266ms / decode（ブラウザ）266ms — IPC 経路が 71% を占め支配的
- Rust 内訳（`npm run profile:rust`, large 20MP JPEG, n=6/op: 起動時 1 枚 + preload 近傍分）: decode median=294.9ms(max 350.5ms) / encode median=1454.3ms(max 1538.6ms) / base64 median=6.8ms(max 22.3ms) / load_image 合計 median=1728.9ms(max 1831.4ms) — Rust 内では再エンコード（encode）が最大区間
- 結論: 支配区間は「Rust フルデコード→再エンコード→base64→JSON IPC→data URL パース」の転送パイプライン全体。Rust 側の load_image は 1729ms/枚（うち encode が 84%。preload による同時ロード下の実測であり、baseline の ipc 中央値 1266ms とは計測条件が異なるため直接比較はしない）。Phase 5 は候補 1（base64 over IPC の撤廃）に着手する

---

### Phase 5 — 最適化（仮説は profiling で確認済みのものだけ着手）

以下は候補。**全部やらない。** Phase 4 で支配的と確認できたものから 1 つずつ。

- [x] **[最有力] base64 over IPC の撤廃**
  - 現状の「Rust で読む → base64 化 → JSON IPC で巨大文字列 → フロントでデコード」を、`convertFileSrc` / `asset://` プロトコル（または独自 `register_uri_scheme_protocol`）に置換
  - PROJECT_SPEC の既知の制限「2000px+ images load slower due to base64 encoding」と一致する第一候補
  - `tauri.conf.json` の `security.assetProtocol.enable = true` と `scope` 設定、CSP の `img-src` に `asset: http://asset.localhost` を追加
  - 注意: `convertFileSrc` はローカルファイル前提。SMB 等リモートや巨大同時読み込みで Rust 側ブロックの報告あり（対象がローカルであることを確認）
- [ ] **デコードの主スレッド非ブロック化**: `createImageBitmap` / `img.decode()` を用い、表示解像度でデコード（原本はズーム用に保持）
- [ ] **preload の実効性改善**: `NAV_cold` と `NAV_warm` の差が大きい場合、±N の範囲・ナビゲーション方向優先・循環バッファの実装を検証/修正
- [ ] **サムネイル/キャッシュ**: 生成の WebP 化、キャッシュヒット率の改善

各修正は 1 コミット 1 仮説とし、Phase 6 のゲートを必ず通す。

---

### Phase 6 — 自律ループと採否ゲート

エージェントが 1 変更ごとに実行するループ:

1. `npm run bench` で候補ビルドを計測（N 回、中央値/p95）
2. `bench-results/baseline.json` と比較
3. 以下を**すべて満たす**場合のみ採用、いずれか欠けたら `git revert`:
   - **改善ゲート**: 対象指標の中央値が baseline を **≥ 10%** 改善
   - **回帰ゲート**: 他の指標が誤差（p95 の揺れ）を超えて悪化していない
   - **正しさゲート**: 既存の全単体テスト（フロント vitest + Rust cargo test）（`npm test`）が green
   - **視覚ゲート**: 視覚検証 E2E（スクリーンショット）で表示崩れ・非表示が無い
4. 採用時は新しい bench 結果で `baseline.json` を更新

---

## 4. bench-results JSON スキーマ

```json
{
  "gitSha": "abc1234",
  "timestamp": "2025-01-01T00:00:00Z",
  "buildProfile": "release",
  "runs": 7,
  "corpus": ["small", "medium", "large"],
  "metrics": {
    "TTFI_cold": {
      "median_ms": 0,
      "p95_ms": 0,
      "n": 7,
      "full": { "median_ms": 0, "p95_ms": 0, "n": 7 }
    },
    "NAV_warm": { "median_ms": 0, "p95_ms": 0, "n": 7 },
    "NAV_cold": { "median_ms": 0, "p95_ms": 0, "n": 7 },
    "NAV_rapid": {
      "median_ms": 0,
      "p95_ms": 0,
      "n": 84,
      "steps": 12,
      "hit_rate": 0.71
    },
    "PLACEHOLDER_dur": { "median_ms": 0, "p95_ms": 0, "n": 84 },
    "NAV_visible": {
      "median_ms": 0,
      "p95_ms": 0,
      "n": 84,
      "steps": 12,
      "sequence": [5, 2, 9, 1, 12, 7, 3, 14, 6, 11, 0, 8],
      "hit_rate": 1.0,
      "tiers": { "full": 84 }
    },
    "PLACEHOLDER_dur_visible": { "median_ms": 0, "p95_ms": 0, "n": 84 },
    "ZOOM_full": { "median_ms": 0, "p95_ms": 0, "n": 7 },
    "breakdown": {
      "fetch_decode_cold": { "median_ms": 0, "p95_ms": 0, "n": 7 },
      "fetch_decode_rapid_miss": { "median_ms": 0, "p95_ms": 0, "n": 0 },
      "fetch_decode_visible_miss": { "median_ms": 0, "p95_ms": 0, "n": 0 }
    }
  }
}
```

> `TTFI_cold` のトップレベルは最初の paint（サムネイル先行表示があればそれを含む）までの `ttfi`、`full` はフル解像度 paint（`thumbnail: false`）までの `ttfi`。2 段階描画が発生しない場合は両者が一致する。`n` はサンプル欠落（cold 実行失敗など）を考慮した実サンプル数で、7 未満になり得る。

---

## 5. package.json に追加するスクリプト（案）

```jsonc
{
  "scripts": {
    "bench:build":    "node e2e/scripts/build-bench.mjs",
    "bench:corpus":   "node e2e/scripts/generate-corpus.mjs",
    "test:e2e":       "wdio run e2e/wdio.conf.ts --spec e2e/specs/smoke.e2e.ts --spec e2e/specs/visual.e2e.ts",
    "bench":          "node e2e/scripts/run-bench.mjs",
    "bench:baseline": "node e2e/scripts/save-baseline.mjs"
  }
}
```

---

## 6. CLAUDE.md に追記する運用ルール（案）

> ### Performance changes
> - パフォーマンス関連の変更後は、必ず `npm run bench` を実行する（release ビルド、N 回）。
> - `bench-results/baseline.json` と比較し、**対象指標の中央値が 10% 以上改善**し、かつ他指標が悪化せず、`npm test`（フロント vitest + Rust cargo test）と視覚 E2E がすべて green の場合のみ採用する。
> - 上記を満たさない変更は `git revert` する。
> - 最適化前に必ず profiling で支配的なボトルネックを特定し、1 コミット 1 仮説とする。当て推量での複数同時変更は禁止。
> - 採用時は新しい bench 結果で `baseline.json` を更新する。

---

## 7. リスク・注意点（Windows / Tauri v2）

- **WebView2 と Edge WebDriver のバージョン整合**: 不一致だと E2E が不可解に失敗する。`msedgedriver` を WebView2 に合わせる（`@wdio/tauri-service` 埋め込みプロバイダなら外部ドライバ依存を回避できる）。
- **計測は必ず release ビルド**で。dev ビルドの数値は当てにしない。
- **ノイズ対策**: 単発値禁止、中央値/p95、最小改善閾値、同一マシン・同一コーパス・背景負荷一定。
- **cold/warm を混ぜない**: P1 は cold パス、P2 は warm/preload パス。
- **asset protocol の CSP/scope 設定漏れ**で 403/404 になりやすい。設定後にまず 1 枚表示できることを確認してから計測へ。
- **正しさの担保**: 「速いが壊れた」を防ぐため、性能ゲートと正しさ/視覚ゲートを常に併用。
- **EXIF orientation**: プロトコル化で原本バイトがブラウザに渡るため自動適用される（旧パイプラインは再エンコードで EXIF が落ち、回転付き JPEG は未回転表示だった）。視覚ゲートに exif コーパス検証あり。ただし Rust 側のサムネイル生成（`generate_thumbnail`、`image::open` → `img.thumbnail()`）は依然 EXIF 非対応のため、回転付き JPEG はサムネイル先行表示の間だけ未回転で見え、フル解像度のプロトコル画像に差し替わった時点で正しい向きに補正される（自己修復）。

---

## 8. 現状 baseline（2026-08-22 更新, プレビュー層 Phase 2 = Rust プレビュー層。表示経路は無変更）

計測元: `bench-results/baseline.json`（`gitSha: ab5b223`, `timestamp: 2026-08-21T17:17:15.478Z`, `runs: 7`, release ビルド）。全指標が想定 n を満たす（TTFI_cold/NAV_warm/NAV_cold/ZOOM_full は n=7、NAV_rapid/PLACEHOLDER_dur/NAV_visible/PLACEHOLDER_dur_visible は n=84、欠落サンプルなし。fetch_decode_rapid_miss は n=0 — NAV_rapid の hit_rate 1.0 で miss ステップが存在しないため母集団が空）。

| 指標 | corpus | median (ms) | p95 (ms) | n | 目標 |
|------|--------|-------------|----------|---|------|
| TTFI_cold（first paint = full） | large | 481.7 | 833.8 | 7 | < 500 |
| NAV_warm | medium | 19.1 | 32.9 | 7 | < 100 |
| NAV_cold（2026-08-21 再定義: evictDecoded 後のメモリ冷・ディスク温 miss） | medium | 178.0 | 354.6 | 7 | — |
| NAV_rapid（steps=12, hit_rate=1.0） | large | 28.6 | 269.1 | 84 | < 100 **達成** |
| PLACEHOLDER_dur | large | **0** | **0** | 84 | < 80 または 0 **達成** |
| **NAV_visible**（steps=12, 非単調列, **hit_rate=0.0**, tiers {full: 84}） | large | **457.5** | 802.6 | 84 | < 100 かつ hit_rate 1.0（**未達 — Phase 3 の対象**） |
| **PLACEHOLDER_dur_visible** | large | **405.1** | 766.9 | 84 | p95 < 80 または 0（**未達**） |
| ZOOM_full | large | 0 | 0 | 7 | 悪化監視のみ（目安 ≤ 500） |
| fetch_decode_cold（内訳） | large | 388.5 | 730.5 | 7 | — |
| fetch_decode_rapid_miss（内訳） | large | — | — | 0 | — |
| fetch_decode_visible_miss（内訳） | large | 426.7 | 470.7 | 84 | — |

> **Phase 2 baseline の読み方（2026-08-22、再アンカー）**: Phase 2（`docs/superpowers/plans/2026-08-22-preview-tier-phase2-rust-preview-layer.md`）は Rust 側にプレビュー生成・キャッシュ・配信を追加しただけで、**表示経路（ImageViewer / store / プリローダー）は 1 行も変えていない**。にもかかわらず全指標が Phase 1 baseline（52650ab）より速く、無変更経路の fetch_decode_cold も 530.7→388.5 と同方向に動いた — 2026-08-21 に観測したマシン条件ドリフト（§8 旧注記、同日の対照実行で変更前コードも TTFI_cold 606）が**戻った**もの。CLAUDE.md の規則（コード無変更で指標が旧帯へ戻ったら再 baseline）に従い、本 run を baseline とした。**Phase 3 の採否判定（NAV_visible 中央値 ≥10% 改善、最終目標 < 100ms かつ hit_rate 1.0）はこの 457.5ms を基準にすること** — 52650ab の 531.4 を基準にするとドリフトだけで 14% の見かけ改善になる。Phase 3 の判定 run 前にも同日の数値揺れを確認すること（NAV_visible は全ステップ miss のため 20MP デコード時間 = マシン状態に直結する）。
> **Phase 2 の生成コストゲート**: `npm run profile:rust`（キャッシュ削除後、large 16 枚、3 回の中央値）で `thumb_preview` 287.6ms（内訳 decode ~170–205 / resize ~30–35 / encode ~37–45）vs 変更前 `thumbnail` 231.3ms = 1.24 倍（ゲート ≤ 1.3 倍）。途中経過: `image` クレートの JPEG エンコーダでは 354.8（1.53 倍、encode 96–120ms）→ `jpeg-encoder`（4:2:0, SIMD）で 309.4（1.34 倍）→ `fast_image_resize` の rayon で 287.6。
> **Phase 1 baseline（52650ab, 2026-08-21T15:41:03.155Z）**: TTFI_cold 614.8 / 982.2、NAV_warm 26.6 / 35.5、NAV_cold 267.1 / 465.5、NAV_rapid 40.0 / 287.7、NAV_visible 531.4 / 870.8（hit 0）、PLACEHOLDER_dur_visible 479.2 / 828.8、ZOOM_full 0、fetch_decode_cold 530.7 / 882.8、fetch_decode_visible_miss 472.2 / 559.2。

> **Phase 1 baseline の読み方（2026-08-21）**: 本 baseline はプレビュー層ワークストリーム（設計: `docs/superpowers/specs/2026-08-21-thumbnail-implies-cached-preview-tier-design.md`）の **計測系のみ**を追加した状態で記録した。アプリ側の差分は `paint:done` の `tier` detail、`zoom:request` マーク、E2E テストフックだけで、表示・ロード・スケジューラの挙動は c4dc4d8 と同一。
> **NAV_visible hit_rate 0/84 の機序**: 非単調列 `[5,2,9,1,12,7,3,14,6,11,0,8]` の各ステップは、現行の保持窓 `computeWindow` = {i+1, i+2, i+3, i−1} の**外に構造的に落ちる**（最小ジャンプ距離 3・方向反転を含む）ため、全ステップが miss になる。プリローダーが「間に合わなかった」のではなく、窓の形状による決定論的な結果であり、run 間で振動しない。miss の実体は 20MP のブラウザデコード（fetch_decode_visible_miss median 472ms）で、これがユーザー苦情「サムネイルが見えているのにプレースホルダーが ~0.5s 見える」の数値再現（PLACEHOLDER_dur_visible median 479ms）。Phase 3 の採否判定はこの NAV_visible 中央値に対する ≥10% 改善（最終目標 < 100ms かつ hit_rate 1.0）で行う。
> **NAV_cold 再定義**: 旧 baseline（c4dc4d8）の NAV_cold 180.6ms は「±5 の外への遠方ジャンプ」、本 baseline の 267.1ms は「プリローダー静穏 → `evictDecoded()` → ジャンプ」（ディスク上のサムネイルは保持）。定義が異なるため**比較不能**。同日の対照実行（下記）では旧定義でも 249.7ms を示しており、差の大半は環境ドリフト。
> **ZOOM_full = 0**: 現行はナビゲーション時点で常にフル解像度が表示済みのため、`zoom:request` 時の表示 tier が full → 定義上 0。プレビュー層導入後（Phase 3）に ~400ms 帯（20MP フルデコード）へ移るのは D1 で承認済みのトレードオフであり、回帰ゲートではなく悪化監視（目安: 中央値 ≤ 500ms）。
> **TTFI_cold / fetch_decode_cold の再アンカー注記（2026-08-21）**: 本 baseline の TTFI_cold 614.8 / fetch_decode_cold 530.7 は旧 baseline（454.6 / 361.5）を大きく上回るが、**同日に基点コミット 2c9be70（本ブランチの変更前コード）を `git archive` からビルドして同一マシン・同一ハーネスで対照実行**した結果も TTFI_cold median 605.8（サンプル 516/610/606/818/832/587/556）/ fetch_decode_cold median 517.5 / NAV_cold（旧定義）249.7 / NAV_warm 28.9 であり、ブランチの 3 回の run（608.8 / 552.8 / 614.8）と同帯だった。したがって上昇はコード起因ではなく、マシン条件のドリフト（デコード支配経路が全体に +35〜40%）である。前回の再アンカー（下記 adfe42b の経緯）と同じ方針で全指標を現条件で再アンカーした。**コード無変更で TTFI_cold / fetch_decode_cold が旧帯（~450 / ~360）へ戻った場合は再 baseline を検討すること。**
> **旧 baseline（c4dc4d8, 2026-08-16T17:29:10.809Z, ビットマップ窓採用時）**: TTFI_cold 454.6 / 471.9、NAV_warm 25.8 / 36.6、NAV_cold（旧定義）180.6 / 518.4、NAV_rapid 33.7 / 260.4（hit_rate 1.0）、PLACEHOLDER_dur 0 / 0、fetch_decode_cold 361.5 / 376.0。

> **ビットマップ窓採用の経緯（2026-08-16, 仮説 C）**: profiling（`docs/PERFORMANCE_NAV_RAPID_PHASE2_PROFILING.md`）で「遅い hit の実体はブラウザ側再デコード（再フェッチではない）」を確定し、(1) `ImageBitmap` の明示保持（current+4 近傍、500MB 予算、自前 `close()`）、(2) hit 時の canvas paint（デコード不要）、(3) 即時方向性スケジューラ（500ms タイマー廃止、現在画像フル解像度表示後にのみ充填開始）を実装した（設計: `docs/superpowers/specs/2026-08-16-nav-rapid-bitmap-window-design.md`）。NAV_rapid 中央値 377.25→33.7ms（−91.1%）、p95 973.6→260.4ms、hit_rate 0.714→1.0、PLACEHOLDER_dur p95 352.9→0ms（プレースホルダー知覚ゼロ）。NAV_rapid の p95 260ms は各 run 端で窓充填が追いつかない 1〜2 ステップ（~250-300ms、旧 miss 相当）で、中央値は fast クラスタに完全移行した。
> **TTFI_cold / fetch_decode_cold の上方ドリフト注記**: 本計測で TTFI_cold median は 334.9→454.6ms（+36%）、fetch_decode_cold は 243.0→361.5ms（+49%）となったが、**fetch_decode_cold の計測経路（`src:set`→`decode:done`、protocolLoader / spica-img serve / ImageViewer direct load）は本変更で 1 行も変わっていない**。無変更経路が +49% 同方向に動いたことは、採用判定 2 回の独立 run（337.6/349.1 → 361.5/376.0）でも再現し、長時間のビルド・E2E 連続実行後のマシン条件（ページキャッシュ/熱/電源状態）ドリフトと判断した（上の「再アンカーの経緯」と同種）。ゲート上は TTFI_cold median 454.6 < 旧 baseline p95 499.1 で「p95 の揺れを超える悪化なし」を満たす。コード無変更で TTFI_cold/fetch_decode_cold が同方向に戻ったら再 baseline を検討すること。

> **再アンカーの経緯（2026-08-16, 旧 baseline adfe42b 採用時の記録）**: 当時の baseline は同日の前回 baseline（`gitSha: 11c01ca`, 2026-08-16T03:44:16.740Z 計測）から、アプリコードを一切変更せずに再計測した結果で置き換えたものである。`11c01ca..adfe42b` の `src/`/`src-tauri/` diff は機能的に無害な 4 件のみ（死コード除去 1 件・コメント追加 1 件・テスト追加 1 件・整形のみ 1 件）と確認済みで、コード起因の変化ではない。にもかかわらず両方向にズレが生じた: TTFI_cold は約 -31%（483.8→334.9ms、参考: run 1 は 321.8ms、fetch_decode_cold も 395.4→232.2/243.0ms）改善し、NAV_warm は +15〜16ms（23.1→38.2/38.7ms）悪化した。改善側は OS ページキャッシュ/電源状態のようなディスク I/O 起因の要因で説明でき、悪化側は NAV_warm が 2 回の独立フルベンチ実行で 38.2〜39.3ms という極めて狭い帯にクラスタしたことから、負荷ノイズというより表示リフレッシュ/vsync 状態の変化で double-rAF の paint マークの量子化点がシフトした可能性が高いと判断した。CLAUDE.md の「同一マシン・同一条件での比較のみ有効」の原則に従えば、旧 baseline は現在の計測条件下では両方向とも再現不能（irreproducible）であり、そのまま残すと将来の全比較が汚染される（存在しない NAV_warm 回帰・存在しない ~30% TTFI_cold 改善が幽霊のように出続ける）。そのため全指標をこの実測値で再アンカーした。**今後、コード変更なしに NAV_warm のような指標が「狭い帯にクラスタしたまま」ジャンプした場合は同種のマシン条件ドリフトを疑い、同じ手順で再度 re-baseline を検討すること。**
> **NAV_rapid / PLACEHOLDER_dur の読み方（旧 baseline adfe42b 時点の記録。当時の median 377.25ms はビットマップ窓採用で 33.7ms に解消済み）**: NAV_rapid median 377.25ms はユーザー苦情「体感 ~1s」を計測値として再現している（run 内には単一ステップの full paint が最大 1497.9ms に達したサンプルもあった）。PLACEHOLDER_dur の pooled median が 0ms なのは、hit_rate 0.714（84 サンプル中 60 ヒット、過半数）と「hit のとき PLACEHOLDER_dur=0」という定義から必然の結果であり、異常ではない（§2 参照）。体感遅延の判定は必ず NAV_rapid と PLACEHOLDER_dur のペアで行うこと（どちらか単独の median だけで判断しない）。サイクル毎の改善ゲート（中央値 ≥10% 改善）は NAV_rapid 中央値で判定する。PLACEHOLDER_dur は hit 優勢の混合分布では中央値が 0 に飽和するため、進捗の追跡は p95（n=84 の rank-80、頑健）で行う。
> **旧 baseline（spica-img プロトコル採用後, `gitSha: 11c01ca`, 2026-08-16T03:44:16.740Z, 全 n=7）**: TTFI_cold median 483.8ms / p95 629.2ms、NAV_warm median 23.1ms / p95 32.9ms、NAV_cold median 179.9ms / p95 252.9ms、fetch_decode_cold（内訳）median 395.4ms / p95 546.3ms。再アンカー理由は上記「再アンカーの経緯」を参照。
> **旧々 baseline（base64 IPC 時代, `gitSha: 08caaee`, 2026-08-15T16:02:45.827Z, 全 n=7）**: TTFI_cold median 1771.4ms / p95 2106.6ms、NAV_warm median 162.0ms / p95 293.5ms、NAV_cold median 515.6ms / p95 663.4ms、ipc（内訳）median 1266.5ms / p95 1523.8ms、decode（内訳）median 266.3ms / p95 470.7ms。`ipc`/`decode` はプロトコル化により IPC 経路自体がホットパスから消滅したため新 JSON には存在せず、新設の `fetch_decode_cold`（`src:set`→`decode:done`、fetch+ブラウザデコード区間）と直接比較はできない（計測区間が異なる設計変更。詳細は §2 実装注記）。
> **TTFI_cold の full paint**: 現 baseline（c4dc4d8）でも全 7 サンプルでサムネイル先行表示は発生せず、`full` は `first` と完全に一致（median 454.6ms / p95 471.9ms / n=7）。
> **p95 に関する注記**: n=7 の nearest-rank p95 は最大値と一致するため、外れ値 1 個の影響を強く受ける。回帰判定では中央値を主指標として扱うこと（詳細は CLAUDE.md 参照）。NAV_rapid/PLACEHOLDER_dur は n=84 のため、外れ値 1 個に汚染されにくく p95 も参考値以上に使ってよい（§2 参照）。

---

## 9. 進捗チェックリスト（サマリ）

- [x] Phase 1: 計測ハーネス（両側 instrumentation）
- [x] Phase 2: ベンチ駆動（WebdriverIO + release ビルド + 固定コーパス）
- [x] Phase 3: baseline 確定・コミット
- [x] Phase 4: profiling で支配的ボトルネック特定
- [ ] Phase 5: 最適化（base64→asset protocol を筆頭に、確認済み仮説のみ）
- [x] Phase 6: 自律ループ & ゲート運用開始

---

## 10. 参考

- Tauri v2 Tests / WebDriver: https://v2.tauri.app/develop/tests/
- Tauri WebDriver (WebdriverIO): https://v2.tauri.app/develop/tests/webdriver/
- Tauri CI で WebDriver: https://v2.tauri.app/develop/tests/webdriver/ci/
- 画像をディスクから直接表示（asset protocol / convertFileSrc）: https://github.com/tauri-apps/tauri/discussions/7145
- base64 IPC の非効率と asset protocol 推奨: https://github.com/tauri-apps/tauri/discussions/10116
- v2 で asset protocol 表示（CSP/scope 設定）: https://github.com/orgs/tauri-apps/discussions/11498
- convertFileSrc のリモート/大容量時ブロック注意: https://github.com/tauri-apps/tauri/issues/7434
