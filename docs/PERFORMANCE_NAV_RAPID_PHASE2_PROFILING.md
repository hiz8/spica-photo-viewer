# NAV_rapid Profiling 結果（進め方 2 / Step 1）

- **計測日**: 2026-08-16（capturedAt: raw JSON 参照）/ コード: origin/main 6e37bd9 相当（`src/`・`src-tauri/` 無変更。docs と e2e/scripts のみ追加のブランチ `worktree-nav-rapid-phase2-profiling`）
- **条件**: RUNS=7 × STEPS=12（n=84 完全）、large corpus（16 枚 5472×3648 ≈ 20MP）、release ビルド（`npm run bench:build`）、`SPICA_PERF=1`、baseline と同一マシン
- **計測方法**: `e2e/scripts/profile-nav-rapid.mjs` — release exe を piped spawn（serve ログを行到着時刻付きで捕捉）し、exe 組み込みの embedded W3C WebDriver サーバ（`TAURI_WEBDRIVER_PORT` + `WDIO_EMBEDDED_SERVER=true`）を素の HTTP で駆動して `bench.perf.ts` の NAV_rapid プロトコルを再現。ブラウザ側マークは `performance.timeOrigin` で wall clock に写像（skew 0.8ms）し、serve と ±20ms 許容窓で対応付け（`analyze-nav-rapid.mjs`）。bench との差分は wdio を介さない点のみ。
- **sanity**: pooled median 410.5ms vs baseline NAV_rapid 377.25ms（+8.8%、同一レジーム）✓ / hit_rate 68/84 = 0.810 vs baseline 0.714 ✓

## A. クラス別分布（full paint、ms）

| クラス | median | p95 | n |
|--------|--------|-----|---|
| pooled | 410.5 | 749.0 | 84 |
| miss | 420.5 | 1644.2 | 16 |
| hit-fast（<100ms） | 27.7 | 36.2 | 28 |
| **hit-slow（≥100ms）** | **495.6** | **728.9** | **40** |
| run 0 | 294.5 | 531.2 | 12 |
| runs 1+ | 444.2 | 762.6 | 72 |

per-run（hits / slow-hits / median）: run 0: 5/0/294.5、run 1: 9/0/28.0、**run 2: 12/12/545.7**、run 3: 9/2/28.6、**run 4: 12/12/554.9**、run 5: 9/2/31.1、**run 6: 12/12/455.0**

- **hit-slow が最大クラス（40/84 = 47.6%）で中央値を支配**。handoff 事実 1 の「遅い hit」レジームを再確認。
- run が「全 hit・全 slow」（2/4/6）と「ほぼ fast」（1/3/5、slow は step 5/7 の 2 件のみ）で**交互に振動**する。ブラウザ側デコード済みキャッシュの容量・LRU 挙動を示唆（下記 B）。

## B. 遅い hit の解剖（n=40）— 支配要因は「再デコード」

- **再フェッチ実証（窓内に自 path の serve あり）: 6/40 のみ**。34/40 は serve なし = WebView2 が HTTP キャッシュ（エンコード済みバイト）から供給。**「20MP 再フェッチ」仮説は主因としては棄却**。
- serve があった 6 件でも serve ms は median 8.5 / p95 10.2ms — フェッチコストは無視できる。
- **open→decode:done median 459.4ms**（p95 687.1）に対し decode→paint 残差は median 29.7ms。**遅い hit の所要はほぼ全て `img.decode()` の完了待ち = 20MP JPEG のブラウザ側再デコード**。
- 結論: `cache.preloaded` に entry はあるが**デコード済みビットマップが renderer 側で失われた**画像への hit は、`<img src>` 再設定後の**フル再デコード（~450ms）**を払う。handoff 事実 2 の retainedImages 非対称（ImageViewer 経由ロードは retain されない）と整合。振動パターン（A）は「slow run で 12 枚を再デコード → 次 run はそのビットマップが生きていて fast → その次でまた失われる」という renderer のデコード済みキャッシュの世代交代として説明できる。

## C. miss の解剖（n=16）— miss も同じくデコード支配

- fetch_decode（src:set→decode:done）median 387.2ms / p95 1641.2
- 対応 serve は median 9.1ms（13/16 に serve あり。3 件は HTTP キャッシュから）
- **Rust 側 serve は miss コストの ~2%**。miss の実体も 20MP のブラウザ側デコード。

## D. serve 競合・直列化（handoff 事実 5 の疑い）→ 棄却

- 遅いステップの窓に重なる他 path serve: median 0 / p95 2（n=56）
- 全 serve 68 件、median 8.9ms / p95 18.7ms — 直列待ち・競合の痕跡なし。
- **「競合/直列化で fetch_decode_cold より大幅に遅い」仮説は棄却**（~1.5s 級の外れ値もデコード列に載っている: miss p95 1644ms は src:set→decode 区間そのもの）。

## E. 中央値分解と反実仮想

| | pooled median |
|---|---|
| 実測 | 410.5 |
| cf R1: hit-slow → hit-fast median（27.7）に置換 | **27.7**（−93.3%） |
| cf R2: miss → hit-fast median に置換 | 33.7 |

分布が fast クラスタ（~28ms）と slow クラスタ（~450–550ms）の二峰性のため、どちらの反実仮想も「崖」を越えて大きく動くが、**件数で hit-slow（40）が miss（16）の 2.5 倍**であり、hit-slow の解消だけで中央値は fast クラスタに落ちる。

## 結論: 仮説 C を採用（判定ルール R1 成立、機序を修正）

- **R1 成立**: cf 改善 93.3%（≥30%）かつ hit-slow 全 40 件で open→decode:done ≥ 100ms（全件 ≥ 284ms）。ただし機序は「再フェッチ」ではなく **「ブラウザ側再デコード」が 34/40**（再フェッチは 6/40 の従属要因）。
- **R3 不成立**: serve 競合・直列化なし。
- **設計への含意（brainstorming の入力)**:
  1. 対策は「エンコード済みバイトの保持」では不十分で、**デコード済みビットマップの保持を保証**する必要がある。現行 `retainedImages`（HTMLImageElement 保持）は renderer のデコード済みキャッシュに「通常は」残る期待に依存しており、A の振動はその期待が 20MP × 12 枚では破れることを示す。`createImageBitmap` / canvas 等、**GC/キャッシュ eviction に依存しない明示的なビットマップ保持**を検討すること（メモリ予算: 20MP×4B ≈ 80MB/枚 → 保持枚数の上限設計が本体）。
  2. ImageViewer 経由ロードの retain 化（既知の非対称解消）は必要条件だが、1. がないと十分条件にならない可能性が高い。
  3. miss（~390ms、p95 1.6s）はデコード支配のため C では改善しない。**PLACEHOLDER_dur p95 のゲート達成に miss 側の改善（仮説 A: 表示解像度プレビュー）が別途必要になる可能性**を次サイクルで再評価する。

## 限界と注意

- serve 対応付けは stderr 行到着時刻ベース（パイプ遅延 ±10ms 程度）。±20ms 許容窓で吸収。
- WebView2 HTTP キャッシュにより serve が出ない再フェッチ相当（エンコード済み供給）は Rust 側からは不可視 — 本分析では decode:done 区間で捕捉済み。
- 「振動」（run 2/4/6 全 slow）の機序説明は renderer キャッシュの挙動からの推定であり、対策設計はこの説明に依存しない（実測: hit-slow の所要 = decode 待ち、が根拠）。
- raw データ: `e2e/.tmp/profile-nav-rapid-raw.json` / レポート出力: `e2e/.tmp/profile-nav-rapid-report.txt`（git 管理外）。再現は `npm run profile:nav-rapid && npm run profile:nav-rapid:analyze`。
