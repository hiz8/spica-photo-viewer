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
| `ipc:sent` | Rust コマンド呼び出し直前 |
| `ipc:received` | 画像データ（またはURL）受領時 |
| `decode:done` | `img.decode()` 完了 |
| `paint:done` | 実際に画面へ反映（`requestAnimationFrame` 直後） |
| `measure: ttfi` | `open:request` → `paint:done` |
| `measure: ipc` | `ipc:sent` → `ipc:received` |
| `measure: decode` | `ipc:received` → `decode:done` |

> **実装注記**: `measure: ttfi` 等の区間はアプリ内では計算しない。アプリは `detail.path` 付きの mark を `window.__PERF__` に積むだけで、対応付け（同一 path の `open:request` → `paint:done` など）はベンチハーネスがオフラインで行う。ナビゲーション中断や abort が起きても計測が壊れないため。
> また `paint:done` は `detail.thumbnail` フラグを持つ。サムネイル先行表示→フル解像度差し替えの 2 段階描画では、**最初の paint:done（thumbnail 含む）までを TTFI**、`thumbnail: false` の paint までを `TTFI_full` として両方集計する。

集計する指標:

- **TTFI_cold**: キャッシュ・preload 無しでの `ttfi`（= P1）
- **NAV_warm**: preload ヒット時の `ttfi`（= P2 の理想ケース）
- **NAV_cold**: preload ミス（遠方ジャンプ）時の `ttfi`（preload の効き検証用）
- 内訳（`ipc` / `decode`）: ボトルネック切り分け用

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
  - **NAV_cold**: 遠方インデックスへジャンプ（preload ミス想定）→ `ttfi` 収集
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

- [ ] **[最有力] base64 over IPC の撤廃**
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
    "breakdown": {
      "ipc_cold":    { "median_ms": 0, "p95_ms": 0, "n": 7 },
      "decode_cold": { "median_ms": 0, "p95_ms": 0, "n": 7 }
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
    "bench:baseline": "npm run bench && node e2e/scripts/save-baseline.mjs"
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

---

## 8. 現状 baseline（Phase 3 完了時に記入）

計測元: `bench-results/baseline.json`（`gitSha: 08caaee`, `timestamp: 2026-08-15T16:02:45.827Z`, `runs: 7`, release ビルド）。全指標 n=7（欠落サンプルなし）。

| 指標 | corpus | median (ms) | p95 (ms) | n | 目標 |
|------|--------|-------------|----------|---|------|
| TTFI_cold（first paint） | large | 1771.4 | 2106.6 | 7 | < 500 |
| NAV_warm  | medium | 162.0 | 293.5 | 7 | < 100 |
| NAV_cold  | medium | 515.6 | 663.4 | 7 | — |
| ipc（内訳） | large | 1266.5 | 1523.8 | 7 | — |
| decode（内訳） | large | 266.3 | 470.7 | 7 | — |

> **TTFI_cold の full paint**: 全 7 サンプルでサムネイル先行表示は発生せず、`full`（`thumbnail: false` の paint まで）は `first` と完全に一致（median 1771.4ms / p95 2106.6ms / n=7）。したがって large コーパスでは 2 段階描画のオーバーヘッドは現状観測されていない。
> **p95 に関する注記**: n=7 の nearest-rank p95 は最大値と一致するため、外れ値 1 個の影響を強く受ける（例: NAV_warm は 7 サンプル中の最大値 293.5ms がそのまま p95 になっている）。回帰判定では中央値を主指標として扱うこと（詳細は CLAUDE.md 参照）。

---

## 9. 進捗チェックリスト（サマリ）

- [x] Phase 1: 計測ハーネス（両側 instrumentation）
- [x] Phase 2: ベンチ駆動（WebdriverIO + release ビルド + 固定コーパス）
- [x] Phase 3: baseline 確定・コミット
- [ ] Phase 4: profiling で支配的ボトルネック特定
- [ ] Phase 5: 最適化（base64→asset protocol を筆頭に、確認済み仮説のみ）
- [ ] Phase 6: 自律ループ & ゲート運用開始

---

## 10. 参考

- Tauri v2 Tests / WebDriver: https://v2.tauri.app/develop/tests/
- Tauri WebDriver (WebdriverIO): https://v2.tauri.app/develop/tests/webdriver/
- Tauri CI で WebDriver: https://v2.tauri.app/develop/tests/webdriver/ci/
- 画像をディスクから直接表示（asset protocol / convertFileSrc）: https://github.com/tauri-apps/tauri/discussions/7145
- base64 IPC の非効率と asset protocol 推奨: https://github.com/tauri-apps/tauri/discussions/10116
- v2 で asset protocol 表示（CSP/scope 設定）: https://github.com/orgs/tauri-apps/discussions/11498
- convertFileSrc のリモート/大容量時ブロック注意: https://github.com/tauri-apps/tauri/issues/7434
