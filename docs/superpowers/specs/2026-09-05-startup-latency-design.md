# 起動時の初回表示とサムネイルバー開始遅延の調査と改善設計

- 日付: 2026-09-05
- 状態: 調査完了・試作で効果を実測済み。採用判断待ち（bench ゲート未実施）
- 関連: `docs/superpowers/specs/2026-08-21-thumbnail-implies-cached-preview-tier-design.md`（プレビュー層、I1 / D1 / D2）、`docs/superpowers/specs/2026-08-28-explorer-folder-sort-order-design.md`（ソート検出 §6.3）

## 0. 苦情

Picasa と比べて次の 2 点が遅い。

1. ファイル関連付けで画像を開くと、800×600 のウィンドウが先に出て、その中で数百 ms のローディングが走ってから最大化され画像が出る。
2. 画像枚数の多いフォルダでは、画像表示後サムネイルバーの描画開始まで最大 5 秒程度待つことがある。

既存 bench の TTFI_cold（`open:request → paint:done`）はテストフック経由のオープンを測っており、**プロセス起動〜WebView 初期化〜起動ファイル取得**を含まない。今回はプロセス spawn を 0 とするタイムラインを別途計測した。

## 1. 計測方法（Phase 0 として追加）

- `e2e/scripts/profile-startup.mjs`: bench バイナリを `argv[1] = 画像パス` で spawn し、`SPICA_PERF=1` の stderr 行（各行が `wall` = epoch ms を持つ）と、embedded WebDriver 経由で読んだ `window.__PERF__`（`performance.timeOrigin` で wall clock に写像）を spawn 基準に並べる。`--cold` で `%APPDATA%\SpicaPhotoViewer\cache` を run 毎に消す。`--exe` で保存したベースライン exe と同条件で交互比較できる。
- `e2e/scripts/summarize-startup.mjs`: 複数ラベルの結果を表にする。
- 追加した計測点: Rust `startup` op（`run_start` / `setup` / `window_created` / `page_load_*` / `get_startup_file` / `maximize_*` / `folder_scan_*` / `prefetch_*`）、`PerfTimer` op `cache_sweep` / `cache_stats` / `thumb_lookup` / `prefetch_thumb`、JS マーク `app:script_start`（innerWidth 付き）/ `app:startup_check` / `app:startup_file` / `folder:scanned` / `thumbbar:committed` / `thumbbar:painted` / `thumbgen:start` / `thumb:done`。すべて `SPICA_PERF=1` / perf ビルド時のみ出力。
- コーパス: bench corpus の large（5472×3648, 20MP, 16 枚）と、medium（3264×2448）を 2000 枚に複製したフォルダ。計測機は 2560×1440、NVMe、OS ページキャッシュ温。
- 注意: 新しくビルドした exe の初回数起動は AV スキャンで WebView2 初期化が 0.9〜2.5s まで伸びる。比較は同じ exe を数回起動してから、または baseline/試作を交互に行う。

## 2. 現状のタイムライン（ベースライン = 計測コードのみ追加）

中央値、spawn からの ms。

| 区間 | A: 16枚/20MP cold | B: 16枚 warm | C: 2000枚 cold | D2: 2000枚 warm・キャッシュ 4000 ファイル |
|---|---|---|---|---|
| プロセス起動 → `run()` | 41 | 43 | 27 | 58 |
| `run()` → ウィンドウ+WebView2 生成完了（`setup`） | 547 | 545 | 483 | 2617 |
| → React マウント・`get_startup_file`・`open:request` | 622 | 618 | 571 | 2919 |
| → `maximize_window` 完了（ここでウィンドウが飛ぶ） | 624 | 620 | 573 | 2936 |
| → `src:set`（50ms デバウンス後） | 684 | 682 | 628 | 2989 |
| → フル解像度 `decode:done` | 1081 | 1044 | 800 | 3740 |
| **→ 最初の画像 paint（tier）** | **1102 (full)** | **1058 (full)** | **810 (full)** | **3800 (full)** |
| フォルダ走査 walk / meta / probe 待ち (ms) | 1 / 2 / 73 | 2 / 1 / 82 | 92 / 21 / 4 | 655 / 85 / 0 |
| サムネイルバー paint（空スロット） | 785 | 782 | 800 | 4050 |
| `clear_old_cache` / `get_cache_stats` (ms) | 0.2 / 0.2 | 3.9 / 3.0 | 0.2 / 0.2 | **2075 / 1895** |
| サムネイル生成開始（500ms デバウンス後） | 1266 | 1272 | 1215 | 4429 |
| サムネイル 1 枚目 / 5 枚目 / 21 枚目 | 1506 / 1798 / – | 1277 / 1297 / – | 1431 / 1697 / 4947 | 4454 / 5470 / 6561 |

観察:

- **(1) の正体**: 800×600 ウィンドウは WebView2 初期化（約 500ms）の前から可視で、最大化はフロントエンドが React マウント後に IPC で頼む（`openImageFromPath` 内 `maximize_window`）。その後さらに 50ms デバウンス + 20MP フルデコード 350〜450ms を経て画像が出る。ディスクにプレビューがあっても（B）、起動直後はメモリ内 `cache.thumbnails` が空なので **常にフル解像度経路**を通る（プレビュー層スペックはこの経路を「保証対象外」として現行維持していた）。
- **(2) の正体**: 使い込んだキャッシュ（このマシンの実キャッシュは 2963 ファイル / 165MB、試験では 4000 ファイル）があると、マウント直後の `clear_old_cache` と `get_cache_stats` が **キャッシュ全件を open/read**（`fs::metadata` は Windows ではハンドルを開く。JSON は read+parse ×2 回）するため 1.4〜5.0 秒かかり、blocking スレッドとディスクを占有して、フォルダ走査（92ms → 655ms）、初回 paint（810 → 3800ms）、サムネイル開始（1431 → 4454ms）まで巻き込む。これが「5 秒待つ」の再現。キャッシュが小さい間は表面化しない。
- フォルダ走査は 1 ファイルあたり `path.is_file()` + `fs::metadata()` の 2 回のハンドル open（AV フックの対象）で枚数に比例（2000 枚で 90〜650ms）。ディレクトリ列挙（FindNextFile）は同じ情報を既に持っている。
- Explorer ソート検出は未オープンのフォルダでも 70〜130ms かかり、走査完了を待たせる（予算 300ms）。
- サムネイル生成は走査完了からさらに 500ms のデバウンス後に始まる。デバウンスの目的は連続ナビゲーション中の抑止で、初回オープンには不要。
- サムネイルバーは全 N 件を DOM に出す。N=2000 で初回 commit→paint 86〜340ms、サムネイル 1 枚到着ごとの再レンダーが約 10ms（N=16 では約 5ms）。全件生成時は 2000 × 10ms がメインスレッドに乗る。
- ブラウザ側の縮小デコード（`createImageBitmap(blob, {resizeWidth})`）はフルデコードより速くならない（`e2e/scripts/experiment-decode.mjs`、2:high で 1.3× 遅い）。フロントだけで cold のデコードを縮める案は不採用。Rust 側 `preview::generate` は 20MP で 285〜345ms（decode+resize+encode）で、ブラウザのフルデコード（340〜450ms）と同程度。

## 3. 原因の整理と対策

| ID | 原因 | 対策 | 試作 |
|---|---|---|---|
| W1 | 設定ウィンドウが 800×600 で可視生成され、最大化は React マウント後の IPC | `tauri.conf.json` の main を `create: false` + `backgroundColor: #000` にし、`setup` で `WebviewWindowBuilder::from_config(..).maximized(起動ファイルあり)` で生成。Tauri 2.11 は設定ウィンドウ生成 → `setup` の順（`tauri/src/app.rs`）なので、`setup` で作れば最初のフレームから最大化・黒背景になる。単体起動（ファイルなし）は従来通り 800×600 | ✓ |
| W2 | WebView2 初期化の約 500ms の間、Rust 側は起動ファイルを知っているのに何もしない | **起動プリフェッチ** `commands/startup.rs`: `setup` でウィンドウ生成前にスレッドを 2 本起こす。(a) 起動画像のサムネイル+プレビューを `generate_and_cache`（ディスクにあれば `lookup_thumbnail`）— プレビューボックスは主モニタの物理解像度から `previewBoxForScreen` と同じ規則で決める（`box_for_screen`）。(b) 親フォルダを `scan_folder`（Explorer プローブ込み）。`get_startup_file` は `{path, thumbnail}` を返し（未完了なら最大 150ms 待って諦める）、フロントは `setCachedThumbnail` でメモリキャッシュに種を入れてから `openImageFromPath` する → ImageViewer は I1 により**プレビュー経路**（fetch 10ms + decode 20〜50ms）を取る。`get_folder_images` はプリフェッチ済みの一覧を `take_folder` で受け取る | ✓ |
| S2 | 起動時の画像ロードに連続ナビ用の 50ms デバウンス | `currentImage.index === -1`（走査前の新規オープン）ならデバウンス 0 | ✓ |
| T1 | サムネイル生成の 500ms デバウンスが初回オープンにも掛かる | 前回開始から 500ms 未満（連続ナビ）のときだけデバウンス | ✓ |
| T2 | `clear_old_cache` + `get_cache_stats` が起動直後にキャッシュ全件を open/read | `sweep` をディレクトリエントリの mtime/size だけで判定（JSON を読まない。`created` は書込み時刻と同一なので mtime で等価）。起動時の `get_cache_stats`（console 出力のみ）を廃止。sweep はマウント 5 秒後に遅延 | ✓ |
| T3 | 走査が 1 ファイル 2 回のハンドル open | walkdir の `file_type()` / `metadata()`（Windows では列挙時の値、syscall なし）を使う | ✓ |
| T4 | Explorer プローブ待ちが走査のクリティカルパス | W2 のプリフェッチで WebView 初期化中に完了 | ✓（副次） |
| T5 | サムネイルバーが全 N 件を描画、1 枚ごとの再レンダーが O(N) | 可視範囲 ± 余裕分だけ描画する仮想化（左右をスペーサー幅で埋め、`scrollToActiveItem` の offsetLeft 計算を保つ）。あわせて初期範囲のサムネイル取得を 1 IPC にまとめ（`get_cached_thumbnails(paths)`）、`setCachedThumbnails(map)` で 1 回の再レンダーにする | 未 |
| T6 | N=2000 では現在画像の paint がバーの commit（+可視範囲プレビューの取得開始）の後ろに並ぶ | T5 で commit を軽くする。さらに `folder.images` の反映を現在画像の最初の paint 後（`paint:done` 相当）まで 1 フレーム遅らせる案もある | 未 |
| — | 20MP の cold デコード自体（Rust 285〜345ms / ブラウザ 340〜450ms） | W2 により WebView 初期化と重なるので起動時は隠れる。ナビゲーション時の miss には libjpeg-turbo の DCT スケール縮小デコード（`turbojpeg`/`mozjpeg` crate、1/2 で ~1/4 のコスト）が唯一の本質的な短縮だが、ネイティブ依存追加とビルド時間の増加を伴うため本設計の範囲外 | 未 |
| — | カメラ JPEG の EXIF 埋め込みサムネイル（160×120）を使えばバーのサムネイル（20px）はデコード不要 | I1（サムネイル ⇒ プレビュー）と結合しているため、「サムネイルのみ（プレビュー未生成）」状態を別に持つ設計変更が必要。bench コーパス（sharp 生成）には EXIF サムネイルが無く効果を測れない。将来案 | 未 |

## 4. 試作の効果（baseline と試作を同条件で交互実行、中央値 ms）

| 指標 | A cold: baseline → 試作 | B warm | C 2000枚 cold | D2 2000枚 warm・キャッシュ 4000 |
|---|---|---|---|---|
| ウィンドウ生成時の innerWidth | 800 → **2560**（最初のフレームから最大化） | – | – | – |
| `open:request`（フロントが起動ファイルを得る） | 622 → 598 | 615 → 591 | 582 → 714 | 2919 → 1594 |
| プリフェッチ: サムネイル+プレビュー完了 | – → 390（20MP、345ms。フロントが問い合わせる 594 より前） | – → 57（ディスクにあり） | – → 236（8MP、171ms） | – → 80（ディスクにあり） |
| プリフェッチ: フォルダ走査完了 | – → 133 | – → 155 | – → 192 | – → 412 |
| **最初の画像 paint** | **1102 (full) → 662 (preview)** | **1085 (full) → 663 (preview)** | 824 (full) → 853 (preview)\*\* | **3800 (full) → 1938 (preview)**\* |
| `open:request` → paint | 480 → 64 | 470 → 72 | 242 → 139 | 881 → 344 |
| フォルダ走査 walk / meta (ms) | 1 / 2 → 0 / 1 | 1 / 1 → 1 / 2 | 88 / 19 → 7 / 2 | 655 / 85 → 10 / 4 |
| サムネイルバー paint | 785 → 629 | 785 → 629 | 764 → 806 | 4050 → 1767 |
| サムネイル 1 枚目 / 5 枚目 / 21 枚目 | 1506 / 1798 → 900 / 1248 | 1273 / 1292 → 618 / 626 | 1451 / 1692 / 2762 → 1040 / 1375 / 3755 | 4454 / 5470 / 6561 → 1773 / 1831 / 2184 |
| `clear_old_cache` (ms) | 0.2 → 0.5 | 5.3 → 0.6 | 0.2 → 遅延 | 2075 → 遅延（起動経路から除外） |

\* D2 試作値は新ビルド直後の初回起動 3 回で、WebView2 生成が 860〜1970ms（通常 ~500ms）だった。ウィンドウ生成後〜paint は約 500ms で、そのうち約 300ms は 2000 件のバー commit と可視範囲プレビュー取得の開始にメインスレッドを取られている（T5/T6 が残課題）。

\*\* C（8MP × 2000 枚 cold）は paint の改善が出ていない（n=3、run 値 847/772/824 vs 727/913/853。`open:request → paint` は 242 → 139ms と縮むが、試作では WebView2 生成が run により ~100ms 遅く相殺）。8MP のフルデコードは ~170ms なので、プレビュー経路の利得がそもそも小さい。5 run ずつの再計測はマシン使用中（VS Code / Explorer / メディア再生）で全区間が 2 倍に乱れ無効だった。**未解決の疑問**: 2000 件フォルダのプリフェッチ（走査 + 8MP デコード + COM プローブ）が WebView2 のプロセス生成と CPU を奪い合っている可能性。候補: プリフェッチスレッドの優先度を下げる、`scan_folder` の `par_iter` を逐次にする（メタデータはエントリ由来で 2000 件 2〜4ms、並列化の必要がない）。静穏時に n≥5 で再計測してから判断する。

各対策の寄与は計測点で分離できる（W1: `innerWidth`・`maximize` 消滅、W2: `prefetch_*` と paint tier、S2: `open:request → src:set`、T1: `folder:scanned → thumbgen:start`、T2: `cache_sweep` ms と発生時刻、T3: `scan_walk_ms` / `scan_meta_ms`）。採用時は 1 コミット 1 対策に分けて個別に bench を通す（§6）。

## 5. 設計上の判断

- **D1 最初の paint は preview 層でよい**: fit 表示ではプレビューとフルは画素等価（プレビュー層スペック §6.5）。既存の D1 定義（最初の非プレースホルダー paint）と整合。ズーム時は既存の full アップグレード（I4）が働く。
- **D2 プレビューボックスは Rust 側で主モニタから決める**: `previewBoxForScreen` は `screen.width/height × devicePixelRatio`（= 物理解像度）から選ぶので、主モニタの `Monitor::size()` で同じ箱になる。副モニタ起動や DPR の丸めで外れた場合は、フロントが自分の箱で `/preview/` を要求して従来通り生成される（悪化なし、改善なし）。
- **D3 `get_startup_file` の待ち 150ms**: hit なら約 50ms で paint、miss はフルデコード 350ms+ なので、期待値で有利。20MP JPEG（345ms）は WebView 初期化中に終わるため実測では待ちは発生しない。
- **D4 単体起動（ファイルなし）は現状維持**: 800×600・ウェルカム表示。`maximized(false)`。
- **D5 sweep の TTL 判定を mtime に変更**: `write_atomic` の書込み時刻 = `created`。壊れた JSON は従来通り `read_entry` が読んだ時点で消す。`stats` は変更せず、起動時に呼ばない。
- **D6 プリフェッチの所有**: 結果は `Mutex<Option<(key, Receiver)>>` の static に 1 件だけ保持し、最初の取得で消費する。フロントが問い合わせない（起動ファイルが無い）場合は何も持たない。対象フォルダが違えば `take_folder` は None を返して通常走査に落ちる。

## 6. 検証計画（採用ゲート）

CLAUDE.md の性能変更ルールに従う。

1. `npm test` / `cd src-tauri && cargo test --lib` 全件 green（試作時点: 368 / 104 件 green。`useThumbnailGenerator` のデバウンス 2 テストは新仕様に書き換え、`sweep` のテストは JSON の mtime を `created` に合わせて back-date）。
2. `npm run test:e2e`（視覚ゲート含む）green。`create: false` でも wdio embedded provider が main ウィンドウを掴めることは profile-startup で確認済み。**試作時点では未実行**（マシン使用中のためタイミング assertion が信用できない）。
3. `npm run bench:build && npm run bench` を対策ごとに回し、`baseline.json` と比較。TTFI_cold（テストフック経由のオープン）は W2 の恩恵を受けない設計なので、S2 の −50ms 以外は不変を期待。NAV 系・ZOOM_full が p95 の揺れを超えて悪化しないこと。
4. 新指標 **STARTUP_paint**（spawn → 最初の非プレースホルダー paint）と **STARTUP_thumb1**（spawn → サムネイル 1 枚目）を `profile-startup.mjs` で A（16 枚 cold）と D2（2000 枚・キャッシュ 4000）について記録し、目標: A の STARTUP_paint 中央値 < 700ms、D2 < 1500ms、STARTUP_thumb1 が paint + 300ms 以内。bench への統合は Phase 0 の follow-up。

## 7. 実装フェーズ（1 コミット 1 仮説）

1. **Phase 0 計測**: `profile-startup.mjs` / `summarize-startup.mjs` / perf マーク・`startup` op。挙動変更なし。
2. **Phase 1 T2 キャッシュ掃除**: sweep のエントリ判定 + 起動時 stats 廃止 + 5 秒遅延。効果はキャッシュが大きいほど大きい（D2 で −2〜5s）。
3. **Phase 2 W1 ウィンドウ**: `create: false` + `setup` で最大化生成。視覚的な「800×600 → 最大化」の消滅。
4. **Phase 3 W2 起動プリフェッチ**: `commands/startup.rs`、`get_startup_file` の戻り値変更、`App.tsx` の種入れ、`get_folder_images` の消費。A で paint −40%。
5. **Phase 4 S2 / T1 デバウンス**: 各 −50ms / −500ms。
6. **Phase 5 T3 走査**: 2000 枚で walk+meta −100ms（cold ディスクや AV 有効環境ではもっと大きい）。
7. **Phase 6 T5 バー仮想化 + サムネイル一括取得**: N=2000 の commit と 1 枚ごとの再レンダーを定数化。D2 の残り ~300ms と全件生成時のメインスレッド占有を解消。
8. 将来: EXIF サムネイル、DCT スケール縮小デコード。

## 8. リスク

- `create: false` はウィンドウ設定の `capabilities.windows: ["main"]` とラベル一致が前提。ラベルは設定から取るので不変。
- プリフェッチはプロセス起動直後に 20MP デコードを走らせる（CPU 1 コア 300ms）。WebView2 初期化は主に待ちなので競合は小さい（A で `window_created` 521 vs baseline `setup` 547）。
- `take_folder` は走査完了までブロックする（async コマンド内）。現行の `get_folder_images` も走査をインラインで行っているため同等。製品化時は `spawn_blocking` に載せる。
- sweep の TTL を mtime に切り替えるため、外部ツールで mtime を触ったキャッシュは寿命がずれる（実害なし）。
- Explorer プローブがプリフェッチ側で 1 本走るので、`PROBES_IN_FLIGHT` の「同時 1 本」規則によりフロントの `get_folder_images` が別フォルダを同時に開いた場合はそちらが名前順に落ちる（起動直後のみ。プリフェッチの結果を消費する通常経路では発生しない）。
