# 起動遅延改善 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ファイル関連付け起動で「最初のフレームから最大化・最初の paint がプレビュー層」になり、大きなキャッシュや多数ファイルのフォルダでもサムネイルバーが 1 秒以内に埋まり始める。

**Architecture:** 起動直後の Rust 側の空き時間（WebView2 初期化 ~500ms）に、起動画像のサムネイル+プレビュー生成とフォルダ走査を先行させ、フロントは `get_startup_file` の返す種でプレビュー経路を取る。ウィンドウは `setup` で最大化状態で生成する。キャッシュ掃除はディレクトリエントリだけで判定して遅延実行し、走査は列挙時のメタデータを使う。サムネイルバーは可視範囲だけ描画し、キャッシュ照会はまとめて行う。

**Tech Stack:** Tauri 2.11（`WebviewWindowBuilder::from_config`, `on_page_load`）、walkdir 2.5、React 19 / zustand 5、vitest、cargo test、embedded WebDriver（`e2e/scripts/profile-startup.mjs`）。

**Spec:** `docs/superpowers/specs/2026-09-05-startup-latency-design.md`

## Global Constraints

- 1 コミット 1 対策（設計 §7）。各コミットで `npm test` と `cd src-tauri && cargo test --lib` が green。lint/format は hook に任せる（`npm run lint:fix` / `format:fix` は必要時のみ）。
- 性能コミットは `npm run bench:build` 後に `e2e/scripts/profile-startup.mjs --exe <前フェーズの exe>` で同条件交互比較し、対象指標（設計 §4 の分離計測点）で効果を確認してから次へ進む。ビルド前に `cp src-tauri/target/release/spica-photo-viewer.exe src-tauri/target/release/spica-photo-viewer-phase<N-1>.exe` で前フェーズの exe を保存する。
- 新ビルド exe の初回 1〜2 起動は AV スキャンで WebView2 生成が遅い。計測前に捨て起動するか、run 数を 3 以上にして中央値で見る。`Get-Process MsMpEng,SearchIndexer` と Code/ブラウザの CPU が静かなことを確認する。
- `--cold` 計測は `%APPDATA%\SpicaPhotoViewer\cache` を消す。
- 最後に `npm run test:e2e`（2 回連続 green）と `npm run bench` を最終状態で流し、baseline 比で p95 の揺れを超える悪化が無いことを確認する。
- コメントは Why のみ（CLAUDE.md）。スペック参照はファイル先頭 1 回。
- 試作コードは `tmp/startup-prototype` ブランチに退避してあり、各タスクの完成形は `git show tmp/startup-prototype:<path>` で参照できる（フェーズ 0〜5 の内容。フェーズ 6 は未試作）。

---

### Task 0: 試作の退避とブランチの初期化

**Files:** なし（git 操作のみ）

- [ ] **Step 1: 試作を退避ブランチにコミット**

```bash
git checkout -b tmp/startup-prototype
git add -A
git commit -m "wip: startup latency prototype (reference only, not for merge)"
git checkout worktree-feat+improve-performance-startup
```

- [ ] **Step 2: フィーチャーブランチの作業ツリーを HEAD に戻す**

```bash
git status --short   # 何も出ないこと（tmp ブランチにすべて入った）
git rev-parse --short HEAD   # dcdcab1 (main と同じ)
```

- [ ] **Step 3: Phase 0 のベースライン exe を保存**

現在の `src-tauri/target/release/spica-photo-viewer-baseline.exe` が Phase 0 相当（計測コードのみ）。`cp` で `spica-photo-viewer-phase0.exe` にもコピーしておく。

---

### Task 1 (Phase 0): 計測系 — perf マーク・`startup` op・プロファイルスクリプト・設計書

**Files:**
- Modify: `src-tauri/src/utils/perf.rs`（`wall_ms`, `phase` を追加）
- Modify: `src-tauri/src/lib.rs`（`run_start` / `setup` / `page_load_*` の phase）
- Modify: `src-tauri/src/commands/file.rs`（`get_startup_file` の phase、`get_folder_images` の `folder_scan_start/end` と walk/meta/probe 内訳）
- Modify: `src-tauri/src/commands/window.rs`（`maximize_start/end`）
- Modify: `src-tauri/src/commands/cache.rs`（`thumb_lookup` / `cache_sweep` / `cache_stats` の PerfTimer）
- Modify: `src/main.tsx`（`app:script_start` with innerWidth/innerHeight）
- Modify: `src/App.tsx`（`app:startup_check` / `app:startup_file`）
- Modify: `src/store/index.ts`（`folder:scanned`）
- Modify: `src/components/ThumbnailBar.tsx`（`thumbbar:committed` / `thumbbar:painted`）
- Modify: `src/hooks/useThumbnailGenerator.ts`（`thumbgen:start` / `thumb:done`）
- Create: `e2e/scripts/profile-startup.mjs`, `e2e/scripts/summarize-startup.mjs`, `e2e/scripts/experiment-decode.mjs`
- Create: `docs/superpowers/specs/2026-09-05-startup-latency-design.md`, `docs/superpowers/plans/2026-09-05-startup-latency.md`

**Interfaces:**
- Produces: `crate::utils::perf::phase(phase: &str, extra: &str)`（`{"perf":"rust","op":"startup","phase":..,"wall":<epoch ms>..}` を stderr に 1 行）。`crate::utils::perf::wall_ms() -> f64`。JS マーク名は上記の通り（`e2e/scripts/profile-startup.mjs` の `summarize()` が参照）。

- [ ] **Step 1: 退避ブランチから計測系のファイルを取り出す**

```bash
git checkout tmp/startup-prototype -- e2e/scripts/profile-startup.mjs e2e/scripts/summarize-startup.mjs e2e/scripts/experiment-decode.mjs docs/superpowers/specs/2026-09-05-startup-latency-design.md docs/superpowers/plans/2026-09-05-startup-latency.md src-tauri/src/utils/perf.rs src-tauri/src/commands/window.rs src/main.tsx src/store/index.ts src/components/ThumbnailBar.tsx
```

- [ ] **Step 2: 混在ファイルは計測行だけを手で入れる**

`src-tauri/src/lib.rs`: `run()` 先頭に `crate::utils::perf::phase("run_start", "");`、Builder に

```rust
.setup(|_app| {
    crate::utils::perf::phase("setup", "");
    Ok(())
})
.on_page_load(|_webview, payload| {
    let name = match payload.event() {
        tauri::webview::PageLoadEvent::Started => "page_load_started",
        tauri::webview::PageLoadEvent::Finished => "page_load_finished",
    };
    crate::utils::perf::phase(name, "");
});
```

`src-tauri/src/commands/file.rs`: `get_startup_file` 先頭に `crate::utils::perf::phase("get_startup_file", "");`。`get_folder_images` に `folder_scan_start` と、walk / par_iter / probe.join() それぞれの `Instant` 計測を入れ、`folder_scan_end` に `,"n":..,"walk_ms":..,"meta_ms":..,"probe_wait_ms":..` を付ける。

`src-tauri/src/commands/cache.rs`: `get_cached_thumbnail` に `PerfTimer::start("thumb_lookup", &path)`、`clear_old_cache` の spawn_blocking 内に `PerfTimer::start("cache_sweep", "")`、`get_cache_stats` に `"cache_stats"`。

`src/App.tsx`: `checkStartupFile` の invoke 前後に `perfMark("app:startup_check")` / `perfMark("app:startup_file", { path: startupFile })`（`perfMark` を `./utils/perf` から import）。

`src/hooks/useThumbnailGenerator.ts`: `processQueue` の queue 確定直後に `perfMark("thumbgen:start", { queue: queue.length })`、キャッシュ hit と生成完了の `setCachedThumbnail` 直後に `perfMark("thumb:done", { path, source: "cache" | "generate" })`。

- [ ] **Step 3: テスト**

Run: `npm run type-check && npm test` → 368 passed。`cd src-tauri && cargo test --lib` → 全件 ok（perf.rs のテスト含む）。

- [ ] **Step 4: コミット**

```bash
git add -A
git commit -m "perf(startup): add startup timeline instrumentation and profile-startup harness"
```

---

### Task 2 (Phase 1, T2): キャッシュ掃除をエントリ判定に変え、起動経路から外す

**Files:**
- Modify: `src-tauri/src/commands/cache.rs:281-355`（`sweep`）と同ファイルのテスト `sweep_removes_expired_entries_and_enforces_the_preview_cap`
- Modify: `src/hooks/useCacheManager.ts`

**Interfaces:**
- `sweep(cache_dir, now_secs, max_age_secs, cap_bytes) -> usize` のシグネチャ不変。判定は `entry.metadata()` の mtime/len のみ。
- `useCacheManager` は `clear_old_cache` を `DISK_SWEEP_DELAY_MS = 5000` 後に 1 回呼ぶ。`get_cache_stats` は呼ばない（コマンド自体は残す）。

- [ ] **Step 1: 失敗するテストを書く**

既存テストの `old` エントリは `created: now - 100_000` だが、ファイル mtime は「今」。mtime 判定に変えると落ちるので、フィクスチャに back-date を足す（新しい判定が「mtime で期限切れ」を消すことの検証になる）:

```rust
store_thumbnail_entry(dir.path(), &old_path, 20, &old).unwrap();
// The sweep ages entries by file mtime (== `created` for a real
// write); the fixture has to back-date the file the same way.
filetime::set_file_mtime(
    json_file(dir.path(), &old_path, 20),
    filetime_for_test(now - 100_000),
)
.unwrap();
```

さらに「JSON を読まない」ことの検証として、同テスト内で `created` が新しいのに mtime が古いエントリを 1 件追加し、それも消えることを assert する:

```rust
let mtime_old_path = touch("mtime-old.jpg");
store_thumbnail_entry(dir.path(), &mtime_old_path, 20, &entry(Some((1, 1)), None)).unwrap();
filetime::set_file_mtime(
    json_file(dir.path(), &mtime_old_path, 20),
    filetime_for_test(now - 100_000),
)
.unwrap();
// ... sweep 後
assert!(!json_file(dir.path(), &mtime_old_path, 20).exists());
```

`removed` の期待値は 3 になる（expired json ×2 + preview 1）。

- [ ] **Step 2: 失敗を確認**

Run: `cd src-tauri && cargo test --lib commands::cache::tests::sweep_removes_expired` → FAIL（`removed` が 2、`mtime-old` が残る）

- [ ] **Step 3: `sweep` を書き換える**

`git show tmp/startup-prototype:src-tauri/src/commands/cache.rs` の `sweep` 本体。要点: `read_dir` の各 `entry` から `entry.metadata()`（Windows では列挙時の値、syscall なし）で `mtime`/`len` を取り `(path, name, mtime, len)` を集める。`.tmp-` は mtime で古ければ削除、`_p.jpg` は mtime で期限判定し残りを `previews` に、`_p.json` は同じ列挙に jpg 名が無ければ削除（`names: HashSet<String>`）、`.json` は mtime で期限判定（`created` を読まない。壊れた JSON は `read_entry` が読んだ時点で消す）。cap 超過の古い順削除は不変。

- [ ] **Step 4: テスト通過を確認**

Run: `cd src-tauri && cargo test --lib commands::cache` → ok

- [ ] **Step 5: フロントの起動時呼び出しを遅延させ、stats を外す**

`src/hooks/useCacheManager.ts` の最初の `useEffect` を次に置き換える（`git show tmp/startup-prototype:src/hooks/useCacheManager.ts`）:

```ts
/**
 * The disk sweep walks every cache entry (thousands of files after a few
 * large folders); run at mount it competes with the startup image and the
 * folder scan for disk and blocking threads, so it waits until they are done.
 */
const DISK_SWEEP_DELAY_MS = 5000;
// useEffect: setTimeout(sweepDiskCache, DISK_SWEEP_DELAY_MS) + clearTimeout on cleanup
```

- [ ] **Step 6: テスト・コミット**

Run: `npm test` → green。

```bash
git add src-tauri/src/commands/cache.rs src/hooks/useCacheManager.ts
git commit -m "perf(cache): sweep from directory entries and defer it off the startup path"
```

- [ ] **Step 7: 効果計測（対象指標: `cache_sweep_ms`、D2 の初回 paint / サムネイル 21 枚目）**

```bash
cp src-tauri/target/release/spica-photo-viewer.exe src-tauri/target/release/spica-photo-viewer-phase0.exe
npm run bench:build
# 2000 枚コーパスを複製（medium 30 枚を p0000..p1999 に cp）し、キャッシュを満たす
node e2e/scripts/profile-startup.mjs --file <corpus>/p1000.jpg --runs 1 --wait-thumbs 2000 --thumb-timeout 420000 --label P1-fill
node e2e/scripts/profile-startup.mjs --exe src-tauri/target/release/spica-photo-viewer-phase0.exe --file <corpus>/p1000.jpg --runs 3 --wait-thumbs 60 --label P1-base
node e2e/scripts/profile-startup.mjs --file <corpus>/p1000.jpg --runs 3 --wait-thumbs 60 --label P1-new
node e2e/scripts/summarize-startup.mjs P1-base P1-new
```

Expected: `cache_sweep_ms` が 1000ms 超 → 数十 ms 以下、`js_first_full_paint` と `thumb_21st` の中央値が短縮。

---

### Task 3 (Phase 2, W1): ウィンドウを `setup` で最大化状態で生成する

**Files:**
- Modify: `src-tauri/tauri.conf.json`（main に `"create": false`, `"backgroundColor": "#000000"`）
- Modify: `src-tauri/src/lib.rs`（`setup` でウィンドウ生成）
- Modify: `src-tauri/src/commands/file.rs`（`startup_file_from_args` / `startup_file_in` と単体テスト）

**Interfaces:**
- Produces: `pub fn startup_file_from_args() -> Option<String>`（`std::env::args().skip(1)` を `startup_file_in` に渡す）、`pub fn startup_file_in(args: impl Iterator<Item = String>) -> Option<String>`（存在する対応画像の最初の引数）。`get_startup_file` はこれを使う。

- [ ] **Step 1: 失敗するテストを書く（file.rs tests）**

```rust
#[test]
fn startup_file_in_picks_the_first_existing_supported_image() {
    let dir = create_temp_dir();
    let img = create_test_image(dir.path(), "a.jpg", 4, 4); // test_utils の既存ヘルパー名に合わせる
    let args = vec![
        "--flag".to_string(),
        dir.path().join("missing.jpg").to_string_lossy().to_string(),
        dir.path().join("notes.txt").to_string_lossy().to_string(),
        img.to_string_lossy().to_string(),
    ];
    assert_eq!(startup_file_in(args.into_iter()), Some(img.to_string_lossy().to_string()));
    assert_eq!(startup_file_in(std::iter::empty()), None);
}
```

- [ ] **Step 2: 失敗を確認** — Run: `cargo test --lib commands::file::tests::startup_file_in` → コンパイルエラー（関数未定義）

- [ ] **Step 3: 実装**

```rust
pub fn get_startup_file() -> Result<Option<String>, String> {
    crate::utils::perf::phase("get_startup_file", "");
    Ok(startup_file_from_args())
}

/// The image passed on the command line (file association), if any.
pub fn startup_file_from_args() -> Option<String> {
    startup_file_in(std::env::args().skip(1))
}

pub fn startup_file_in(args: impl Iterator<Item = String>) -> Option<String> {
    args.into_iter().find(|arg| {
        let path = Path::new(arg);
        path.exists() && path.is_file() && is_supported_image(path)
    })
}
```

`tauri.conf.json` の main ウィンドウに `"create": false`, `"backgroundColor": "#000000"` を追加。`lib.rs` の `.setup` を:

```rust
.setup(|app| {
    crate::utils::perf::phase("setup", "");
    // The main window is created here (config `create: false`) so it can
    // be born maximized when launched with a file. A config window would
    // first show at 800x600 and jump only when the frontend calls
    // maximize_window ~500ms later (after WebView2 init + page load +
    // React mount).
    let maximized = commands::file::startup_file_from_args().is_some();
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
        .ok_or("missing main window config")?;
    tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
        .maximized(maximized)
        .build()?;
    crate::utils::perf::phase("window_created", "");
    Ok(())
})
```

- [ ] **Step 4: テスト通過・コミット**

Run: `cargo test --lib` → ok、`npm test` → green。

```bash
git add src-tauri/tauri.conf.json src-tauri/src/lib.rs src-tauri/src/commands/file.rs
git commit -m "perf(window): create the main window maximized when launched with a file"
```

- [ ] **Step 5: 効果計測（対象指標: `js_script_innerWidth` = 2560、`rust_maximize_*` が no-op、初回 paint に悪化なし）**

```bash
cp src-tauri/target/release/spica-photo-viewer.exe src-tauri/target/release/spica-photo-viewer-phase1.exe
npm run bench:build
node e2e/scripts/profile-startup.mjs --exe .../spica-photo-viewer-phase1.exe --file e2e/fixtures/corpus/large/img-000.jpg --runs 3 --cold --label P2-base
node e2e/scripts/profile-startup.mjs --file e2e/fixtures/corpus/large/img-000.jpg --runs 3 --cold --label P2-new
node e2e/scripts/summarize-startup.mjs P2-base P2-new
```

---

### Task 4 (Phase 3, W2): 起動プリフェッチ

**Files:**
- Create: `src-tauri/src/commands/startup.rs`（`git show tmp/startup-prototype:src-tauri/src/commands/startup.rs`）
- Modify: `src-tauri/src/commands/mod.rs`（`pub mod startup;`）
- Modify: `src-tauri/src/lib.rs`（`setup` でウィンドウ生成前に `commands::startup::start(path, screen)`）
- Modify: `src-tauri/src/commands/file.rs`（`get_startup_file -> Option<StartupFile>`、`get_folder_images` の先頭で `take_folder`、走査本体を `pub fn scan_folder(folder_path: &Path, path: &str)` に切り出し）
- Modify: `src/types/index.ts`（`StartupFile`）
- Modify: `src/App.tsx`（種入れ）
- Test: `src-tauri/src/commands/startup.rs` の `tests`、`src-tauri/src/commands/file.rs` tests

**Interfaces:**
- Produces（Rust）: `startup::start(image_path: &str, screen: (u32, u32))`、`startup::take_thumbnail(path: &str) -> Option<PrefetchedThumbnail>`（最大 150ms 待つ）、`startup::take_folder(folder: &Path) -> Option<Result<Vec<ImageInfo>, String>>`、`startup::box_for_screen(w, h) -> PreviewBox`、`PrefetchedThumbnail { base64, width, height }`（Serialize）、`file::StartupFile { path, thumbnail: Option<PrefetchedThumbnail> }`（Serialize）、`file::scan_folder`。
- Produces（TS）: `interface StartupFile { path: string; thumbnail: { base64: string; width: number; height: number } | null }`。

- [ ] **Step 1: 失敗するテスト（startup.rs）**

```rust
#[test]
fn box_for_screen_matches_frontend_buckets() {
    assert_eq!(box_for_screen(1920, 1080).key(), "1920x1080");
    assert_eq!(box_for_screen(2560, 1440).key(), "2560x1440");
    assert_eq!(box_for_screen(1440, 2560).key(), "1440x2560");
    assert_eq!(box_for_screen(2560, 1600).key(), "3840x2160");
    assert_eq!(box_for_screen(7680, 4320).key(), "3840x2160");
    assert_eq!(box_for_screen(0, 0).key(), "1920x1080");
}

#[test]
fn take_thumbnail_ignores_a_different_path() { /* THUMB に a.jpg を入れ、b.jpg で取ると None、その後 a.jpg でも None（消費済み） */ }

#[test]
fn take_folder_only_serves_the_prefetched_folder() { /* FOLDER に dir A を入れ、dir B で None、dir A（末尾区切り・大文字違い）で Some */ }
```

- [ ] **Step 2: 失敗を確認** — `cargo test --lib commands::startup` → コンパイルエラー

- [ ] **Step 3: 実装** — 退避ブランチの `startup.rs` をそのまま採用（`box_for_screen` / `start` / `prefetch_thumbnail` / `take_thumbnail` / `take_folder`）。`file.rs`:

```rust
#[tauri::command]
pub async fn get_folder_images(path: String) -> Result<Vec<ImageInfo>, String> {
    let folder_path = Path::new(&path);
    if !folder_path.exists() || !folder_path.is_dir() {
        return Err("Invalid folder path".to_string());
    }
    // The startup prefetch may have scanned (and sort-probed) this folder already.
    if let Some(prefetched) = crate::commands::startup::take_folder(folder_path) {
        crate::utils::perf::phase("folder_scan_prefetched", "");
        return prefetched;
    }
    scan_folder(folder_path, &path)
}

/// Enumerates `folder_path`'s images in Explorer's display order. `path` is
/// the same folder as a string, for the perf log only.
pub fn scan_folder(folder_path: &Path, path: &str) -> Result<Vec<ImageInfo>, String> { /* 旧本体 */ }

#[tauri::command]
pub fn get_startup_file() -> Result<Option<StartupFile>, String> {
    crate::utils::perf::phase("get_startup_file", "");
    Ok(startup_file_from_args().map(|path| {
        let thumbnail = crate::commands::startup::take_thumbnail(&path);
        crate::utils::perf::phase("get_startup_file_end", &format!(r#","thumb":{}"#, thumbnail.is_some()));
        StartupFile { path, thumbnail }
    }))
}
```

`lib.rs` の `setup` でウィンドウ生成の前に:

```rust
let startup_file = commands::file::startup_file_from_args();
if let Some(path) = &startup_file {
    // Overlaps the WebView2 init that window creation blocks on.
    let screen = app.primary_monitor().ok().flatten()
        .map(|m| (m.size().width, m.size().height)).unwrap_or((0, 0));
    commands::startup::start(path, screen);
}
let maximized = startup_file.is_some();
```

`App.tsx` の `checkStartupFile`:

```ts
const startup = await invoke<StartupFile | null>("get_startup_file");
perfMark("app:startup_file", { path: startup?.path ?? null, thumb: !!startup?.thumbnail });
if (startup) {
  // A prefetched thumbnail means its preview is on disk (I1): seeding the
  // cache lets the viewer paint the preview instead of decoding the
  // full-resolution original.
  if (startup.thumbnail) setCachedThumbnail(startup.path, startup.thumbnail);
  await openImageFromPath(startup.path);
}
```

- [ ] **Step 4: テスト通過・コミット**

Run: `cargo test --lib` → ok、`npm run type-check && npm test` → green。

```bash
git add src-tauri/src/commands/startup.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/src/commands/file.rs src/types/index.ts src/App.tsx
git commit -m "perf(startup): prefetch the startup image preview and folder scan during WebView init"
```

- [ ] **Step 5: 効果計測（対象指標: A/B の `js_first_full_paint` と paint tier、`js_startup_thumb`）**

phase2 exe を保存 → `bench:build` → A（`--cold`）と B（warm）で `--exe phase2` と新 exe を 3 run ずつ → `summarize-startup.mjs`。Expected: A/B とも paint 中央値 −30% 以上、tier `preview`。

---

### Task 5 (Phase 4a, S2): 新規オープンの画像ロードデバウンス除去

**Files:**
- Modify: `src/components/ImageViewer.tsx:428-440`
- Test: `src/components/__tests__/ImageViewer.test.tsx`

- [ ] **Step 1: 失敗するテスト**

`ImageViewer.test.tsx` の load 系 describe に追加（既存テストのモック構成に合わせる）:

```ts
it("loads immediately (no debounce) when the image is a fresh open (index -1)", async () => {
  // store: currentImage.path = "/a.jpg", currentImage.index = -1, data null
  render(<ImageViewer />);
  await act(async () => {
    vi.advanceTimersByTime(0);
    await Promise.resolve();
  });
  expect(mockLoadImageViaProtocol).toHaveBeenCalled(); // 既存テストが使う protocolLoader モック
});
```

- [ ] **Step 2: 失敗を確認** — `npx vitest --run src/components/__tests__/ImageViewer.test.tsx -t "fresh open"` → FAIL（50ms 経過前は未呼出）

- [ ] **Step 3: 実装**

```ts
// Skip debounce if thumbnail is already displayed - upgrade immediately.
// A fresh open (index is -1 until the folder scan lands) is never a
// rapid navigation either, so it must not pay the debounce.
const { ui: currentUi, currentImage: current } = useAppStore.getState();
const debounceDelay =
  currentUi.thumbnailDisplayed || current.index === -1 ? 0 : IMAGE_LOAD_DEBOUNCE_MS;
```

- [ ] **Step 4: テスト通過・コミット**

```bash
git add src/components/ImageViewer.tsx src/components/__tests__/ImageViewer.test.tsx
git commit -m "perf(viewer): skip the navigation debounce on a fresh open"
```

- [ ] **Step 5: 効果計測** — `js_open_request → js_src_set`（または decode 開始）の差が −50ms。bench の TTFI_cold にも −50ms が出るはず（最終 bench で確認）。

---

### Task 6 (Phase 4b, T1): サムネイル生成デバウンスを連続ナビ時のみに

**Files:**
- Modify: `src/hooks/useThumbnailGenerator.ts`（`lastStartRef`、`isRapid`）
- Test: `src/hooks/__tests__/useThumbnailGenerator.test.ts`（"thumbnail generation with debounce" の 2 テストを置換。内容は `git show tmp/startup-prototype:src/hooks/__tests__/useThumbnailGenerator.test.ts`）

- [ ] **Step 1: テストを新仕様に書き換え、失敗を確認** — "starts generating immediately on a fresh open (no debounce)" が FAIL
- [ ] **Step 2: 実装**（`startGeneration` 内）

```ts
// The debounce only exists to sit out rapid navigation; a folder open or
// a navigation after a pause starts generating immediately.
const now = Date.now();
const isRapid = now - lastStartRef.current < THUMBNAIL_GENERATION_DEBOUNCE_MS;
lastStartRef.current = now;
// ... setTimeout(..., isRapid ? THUMBNAIL_GENERATION_DEBOUNCE_MS : 0)
```

- [ ] **Step 3: テスト通過・コミット**

```bash
git add src/hooks/useThumbnailGenerator.ts src/hooks/__tests__/useThumbnailGenerator.test.ts
git commit -m "perf(thumbnails): debounce generation only during rapid navigation"
```

- [ ] **Step 4: 効果計測** — `js_folder_scanned → js_thumbgen_start` が ~500ms → ~5ms（A/B シナリオ、phase4a exe と比較）。

---

### Task 7 (Phase 5, T3): フォルダ走査で列挙時メタデータを使う

**Files:**
- Modify: `src-tauri/src/commands/file.rs`（`scan_folder` の walk、`image_info_from(path, Option<&fs::Metadata>)`）
- Test: `src-tauri/src/commands/file.rs` tests（既存 `test_get_folder_images_*` が回帰ゲート。追加: `image_info_from` に列挙メタデータを渡した結果が `get_image_info` と一致）

- [ ] **Step 1: 失敗するテスト**

```rust
#[test]
fn image_info_from_dir_entry_metadata_matches_a_fresh_stat() {
    let dir = create_temp_dir();
    let img = create_test_image(dir.path(), "a.jpg", 4, 4);
    let entry = WalkDir::new(dir.path()).max_depth(1).into_iter()
        .filter_map(|e| e.ok()).find(|e| e.path() == img).unwrap();
    let from_entry = image_info_from(&img, entry.metadata().ok().as_ref()).unwrap();
    let from_stat = get_image_info(&img).unwrap();
    assert_eq!(from_entry.size, from_stat.size);
    assert_eq!(from_entry.modified_ns, from_stat.modified_ns);
    assert_eq!(from_entry.created_ns, from_stat.created_ns);
}
```

- [ ] **Step 2: 失敗を確認** — `image_info_from` 未定義でコンパイルエラー
- [ ] **Step 3: 実装** — 退避ブランチの `scan_folder` の walk（`entry.file_type()` / `entry.metadata()` / `into_path()`、symlink は `path().is_file()` で従来通り拾う）と `image_info_from`。
- [ ] **Step 4: テスト通過・コミット**

```bash
git add src-tauri/src/commands/file.rs
git commit -m "perf(scan): use directory-entry metadata instead of two stats per file"
```

- [ ] **Step 5: 効果計測** — 2000 枚 cold（`--cold`）で `scan_walk_ms + scan_meta_ms` が ~110ms → ~10ms（phase4b exe と比較）。

---

### Task 8 (Phase 6a, T5): サムネイルバーの仮想化

**Files:**
- Modify: `src/components/ThumbnailBar.tsx`
- Modify: `src/constants/memory.ts`（`THUMBNAIL_ITEM_PITCH_PX` は既存 40。追加: `THUMBNAIL_RENDER_MARGIN = 16`）
- Test: `src/components/__tests__/ThumbnailBar.test.tsx`

**Interfaces:**
- Consumes: `visibleThumbnailRadius(innerWidth)`（`src/utils/preloadWindow.ts`）。
- 描画範囲: `[max(0, index - R), min(n - 1, index + R)]`、`R = visibleThumbnailRadius(window.innerWidth) + THUMBNAIL_RENDER_MARGIN`。範囲外は左右 1 個ずつの `div.thumbnail-spacer` で `width = count × THUMBNAIL_ITEM_PITCH_PX`（`flex: none`）。`currentImage.index === -1` のときは先頭から `2R + 1` 件。

- [ ] **Step 1: 失敗するテスト**

```ts
it("renders only the thumbnails around the current image for large folders", () => {
  mockStore.folder.images = Array.from({ length: 500 }, (_, i) => createMockImageInfo(i));
  mockStore.currentImage.index = 250;
  render(<ThumbnailBar />);
  const buttons = screen.getAllByRole("button");
  expect(buttons.length).toBeLessThan(200);
  expect(buttons.length).toBeGreaterThanOrEqual(2 * 4 + 1); // 最小半径 4 + 余裕
  expect(screen.getByTitle("image250.jpg")).toBeInTheDocument();
  const spacers = document.querySelectorAll(".thumbnail-spacer");
  expect(spacers).toHaveLength(2);
  // 左スペーサー幅 = 描画開始 index × 40px
  const first = Number(buttons[0].getAttribute("data-index"));
  expect((spacers[0] as HTMLElement).style.width).toBe(`${first * 40}px`);
});

it("renders every thumbnail when the folder fits in the window", () => {
  // 既存 "should render thumbnail items for all images"（5 件）が通ることで担保
});
```

- [ ] **Step 2: 失敗を確認** — 500 件全部描画されて FAIL
- [ ] **Step 3: 実装** — `ThumbnailBar` で `range = useMemo(...)`、`folder.images.slice(start, end + 1).map(...)`、`ThumbnailItem` に `data-index={index}` を付け、前後に `<div className="thumbnail-spacer" style={{ width: start * THUMBNAIL_ITEM_PITCH_PX }} aria-hidden />` / 末尾側 `(n - 1 - end) * pitch`。`App.css` に `.thumbnail-spacer { flex: none; height: 1px; }`。`scrollToActiveItem` は `offsetLeft` を使うので不変。
- [ ] **Step 4: テスト通過・コミット**

```bash
git add src/components/ThumbnailBar.tsx src/components/__tests__/ThumbnailBar.test.tsx src/constants/memory.ts src/App.css
git commit -m "perf(thumbnail-bar): render only the thumbnails around the current image"
```

- [ ] **Step 5: 効果計測** — 2000 枚 warm（キャッシュ満杯）で `js_thumbbar_committed → painted` と `thumb_first → thumb_21st` の差（phase5 exe と比較）。`npm run test:e2e` の visual ケースが green であること。

---

### Task 9 (Phase 6b, T5): サムネイルのキャッシュ照会をまとめる

**Files:**
- Modify: `src-tauri/src/commands/cache.rs`（`get_cached_thumbnails` コマンド）
- Modify: `src-tauri/src/lib.rs`（`generate_handler!` に追加）
- Modify: `src/store/index.ts`（`setCachedThumbnails(entries)`）、`src/utils/testUtils.tsx`（モック）
- Modify: `src/hooks/useThumbnailGenerator.ts`（`processQueue` の先頭で一括照会 → hit を 1 回で反映 → miss だけ生成）
- Test: `src/store/__tests__/index.test.ts`、`src/hooks/__tests__/useThumbnailGenerator.test.ts`（`get_cached_thumbnails` モック）

**Interfaces:**
- Rust: `#[tauri::command] pub async fn get_cached_thumbnails(paths: Vec<String>, size: Option<u32>, preview_box: Option<String>) -> Result<Vec<Option<(String, Option<u32>, Option<u32>)>>, String>`（`spawn_blocking` 内で `lookup_thumbnail` を順に呼ぶ。順序は `paths` と同じ）。
- TS: `setCachedThumbnails(entries: ReadonlyArray<[string, { base64; width; height } | "error"]>): void`（1 回の `set` で Map をコピーして全件入れる）。

- [ ] **Step 1: 失敗するテスト（store）**

```ts
it("setCachedThumbnails stores every entry in one update", () => {
  const { setCachedThumbnails } = useAppStore.getState();
  setCachedThumbnails([["/a.jpg", { base64: "a", width: 1, height: 1 }], ["/b.jpg", "error"]]);
  const { cache } = useAppStore.getState();
  expect(cache.thumbnails.get("/a.jpg")).toEqual({ base64: "a", width: 1, height: 1 });
  expect(cache.thumbnails.get("/b.jpg")).toBe("error");
});
```

generator テスト: `get_cached_thumbnails` が `[hit, null, hit]` を返すと `generate_thumbnail_with_dimensions` は miss の 1 件だけ呼ばれ、`setCachedThumbnails` が 1 回呼ばれる。

- [ ] **Step 2: 失敗を確認**
- [ ] **Step 3: 実装** — `processQueue` の各 chunk ではなく queue 全体（最大 100 件ずつ）を `get_cached_thumbnails` に投げ、hit を `setCachedThumbnails` で反映、`perfMark("thumb:done", {source: "cache"})` を hit ごとに出す。miss は従来の `generateThumbnail` を `MAX_CONCURRENT_LOADS` 並列で回す（`generateThumbnail` 内の個別 `get_cached_thumbnail` 呼び出しは削除）。
- [ ] **Step 4: テスト通過・コミット**

```bash
git add src-tauri/src/commands/cache.rs src-tauri/src/lib.rs src/store/index.ts src/utils/testUtils.tsx src/hooks/useThumbnailGenerator.ts src/store/__tests__/index.test.ts src/hooks/__tests__/useThumbnailGenerator.test.ts
git commit -m "perf(thumbnails): look up cached thumbnails in batches"
```

- [ ] **Step 5: 効果計測** — 2000 枚 warm（キャッシュ満杯）で `thumb_21st - thumbgen_start`（phase6a exe と比較）。

---

### Task 10: 最終ゲートと記録

- [ ] **Step 1:** `npm run bench:build` 済みの最終 exe で `npm run test:e2e` を 2 回連続 green。
- [ ] **Step 2:** `npm run bench` を実行し `bench-results/baseline.json` と比較（TTFI_cold は −50ms 程度の改善、NAV 系は p95 の揺れ内）。悪化があればフェーズを二分して原因コミットを特定し revert。
- [ ] **Step 3:** Phase 0 exe vs 最終 exe で A（cold）/ B（warm）/ D2（2000 枚・キャッシュ満杯）を 3 run ずつ計測し、設計書 §4 に「フェーズ別」「累積」の表を追記。
- [ ] **Step 4:** 採用なら `npm run bench:baseline` で baseline.json を更新し同じコミットに含める（CLAUDE.md）。
- [ ] **Step 5:** `tmp/startup-prototype` ブランチを削除（`git branch -D tmp/startup-prototype`）。コーパス複製を削除。
- [ ] **Step 6:** メモリ `project_startup_latency_workstream.md` を「実装済み・PR 待ち」に更新。
