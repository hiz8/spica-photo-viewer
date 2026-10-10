# Explorer ソート Phase 2: COM による Explorer ソート設定の取得と連動 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 画像を開いた時点で、そのフォルダを表示している Explorer ウィンドウ/タブのソート設定（キー＋昇降）を COM で取得し、ナビゲーション順とサムネイルバーの並びを Explorer と一致させる。取得できない場合は Phase 1 の名前昇順（自然順）に必ずフォールバックする。

**Architecture:** 新規 `commands/explorer_sort.rs` が `IShellWindows` → `IUnknown_QueryService(SID_STopLevelBrowser)` → `IShellBrowser` → `QueryActiveShellView` → `IFolderView2::GetSortColumns` のチェーンで `Option<SortSpec>` を返す。`get_folder_images` はフォルダ走査と**並行**に専用スレッド（`CoInitializeEx(COINIT_APARTMENTTHREADED)`）で問い合わせ、スレッド起動時刻起点 300ms の残余だけ待って join する。COM 由来の失敗はすべて `None`（= 名前昇順）。非 Windows は常に `None` のスタブで、`cargo test --lib` が warning なしで通る。

**Tech Stack:** Rust (Tauri v2, windows crate 0.62.2), PowerShell（検証スクリプト）。フロントは無変更。

**Spec:** `docs/superpowers/specs/2026-08-28-explorer-folder-sort-order-design.md`（D1–D5 承認済み。本プランは §10 Phase 2。COM 手順 = §6.3、features = §6.4、リスク = §9、受け入れ = §7.3 + §8）

## Global Constraints

- 全テスト green でなければコミットしない（CLAUDE.md）
- **`IFolderView2::SetSortColumns` を呼ぶコードをどこにも書かない**（R10 — ユーザーの Explorer の並びを書き換える）。検証スクリプトも同様（ソート変更は UI 操作/UIA クリックのみ）
- COM 由来の失敗はエラーではなく `None`。`get_folder_images` は COM の失敗理由でエラーを返さない（I2）
- Explorer 問い合わせは Rust 内で完結。フロントに COM の概念・型・イベントを一切漏らさない（I3）。UI・設定も追加しない（D4）
- 非 Windows でもコンパイル・`cargo test --lib` が **warning なしで**通る（I4。CI は ubuntu-latest。unused import / dead_code に注意 — Phase 1 の教訓）
- クロスプラットフォームのテストデータに「記号 vs 数字」ペア（`IMG_1.jpg` vs `img2.jpg` 型）を使わない（fallback と `StrCmpLogicalW` で順序が異なる。`natural_sort.rs` の doc コメント参照）
- TS を変更したコミットの前に必ず `npm run lint:fix` と `npm run format:fix`（本プランでは TS 変更は無い想定だが、発生したら必須）
- パフォーマンス関連変更のため §8 の非悪化ゲートを通す。**判定は baseline.json 比ではなく同日・同一 worktree のベースコミット A/B**（baseline は stale — session-env-quirks 8/29 追記）。baseline.json は更新しない
- コミットメッセージは Conventional Commits（英語）+ セッション標準トレーラ

## プラン作成時に windows-0.62.2 ソースで検証済みの事実（再調査不要）

レジストリ実体 `~/.cargo/registry/src/*/windows-0.62.2/` で確認:

| 項目 | 場所 / 形 | 必要 feature |
|---|---|---|
| `IShellWindows` / CLSID `ShellWindows` | `Win32::UI::Shell`。`Item(&VARIANT) -> Result<IDispatch>`、`Count() -> Result<i32>` | 定義自体が `#[cfg(feature = "Win32_System_Com")]` |
| `IUnknown_QueryService<P0, T>(punk, guidservice)` | `Win32::UI::Shell`（cfg なし） | `Win32_UI_Shell`（既存） |
| `SID_STopLevelBrowser` | `Win32::UI::Shell` 定数 | 既存 |
| **`IShellBrowser`** | `Win32::UI::Shell`。`Deref` → `System::Ole::IOleWindow`。`QueryActiveShellView() -> Result<IShellView>` | **定義自体が `#[cfg(feature = "Win32_System_Ole")]`**（spec §6.4 に無い → 裁定 D-P2-1） |
| **`IShellView`** | `Win32::UI::Shell` | **`Win32_System_Ole`** |
| `IFolderView2` | cfg なし。`Deref` → `IFolderView`。`GetSortColumnCount() -> Result<i32>`、`GetSortColumns(&mut [SORTCOLUMN])`、`GetGroupBy(*mut PROPERTYKEY, Option<*mut BOOL>)`、`GetItem<T>(i32)` | 既存 |
| `IFolderView::GetFolder<T>() -> Result<T>`（generic）、`ItemCount(u32)` | `IFolderView2` から Deref で呼べる | 既存 |
| `IPersistFolder2::GetCurFolder() -> Result<*mut ITEMIDLIST>` | 定義が `Win32_System_Com`、メソッドが `Win32_UI_Shell_Common` | 両方 |
| `SHGetPathFromIDListW(pidl, &mut [u16; 260])` | `Win32::UI::Shell`。**バッファは固定長 260**（MAX_PATH 超のフォルダは失敗 → None。裁定 D-P2-7） | `Win32_UI_Shell_Common` |
| `SORTCOLUMN { propkey: PROPERTYKEY, direction: SORTDIRECTION(i32) }` | `Win32::UI::Shell`。`derive(Clone, Copy, Debug, Default, PartialEq)` | 既存 |
| `PROPERTYKEY { fmtid: GUID, pid: u32 }` | `Win32::Foundation`。`Default` 有り | 既存 |
| `VARIANT` | `Win32::System::Variant`。**手組み**（`From<i32>` 無し）: `Anonymous.Anonymous = ManuallyDrop::new(VARIANT_0_0 { vt: VT_I4, .., Anonymous: VARIANT_0_0_0 { lVal } })`。定義に `Win32_System_Com` + `Win32_System_Ole` の cfg | `Win32_System_Variant` + Com + Ole |
| `CoInitializeEx(None, COINIT_APARTMENTTHREADED) -> HRESULT`（`.is_err()`）、`CoUninitialize`、`CoCreateInstance<P1, T>`、`CoTaskMemFree(Option<*const c_void>)`、`CLSCTX_ALL` | `Win32::System::Com` | `Win32_System_Com` |
| **`GetForegroundWindow()`、`GetAncestor(hwnd, GA_ROOT)`** | `Win32::UI::WindowsAndMessaging` | **`Win32_UI_WindowsAndMessaging`**（spec §6.4 に無い → 裁定 D-P2-2） |
| `IOleWindow::GetWindow() -> Result<HWND>` | `Win32::System::Ole`。`IShellBrowser` の Deref 経由で呼ぶ | `Win32_System_Ole` |
| vtable 順序 | `GetSortColumnCount` → `SetSortColumns` → `GetSortColumns`（SDK と一致、spec §6.3 で確認済み） | — |

`ImageInfo` は Rust 側で `commands/file.rs` 以外に使用箇所なし、フロントからの deserialize 経路なし（`invoke` の戻り値のみ）→ `Deserialize` derive は形骸（裁定 D-P2-4）。

CI（`.github/workflows/ci.yml`）は ubuntu-latest で `npm run type-check` / `lint` / `format` / `test` と `cargo test --lib` のみ。`cargo test --lib` は examples をビルドしない（examples が Windows 専用 API を使っても CI は落ちない）。`scripts/**` は CI の paths-ignore 対象。

## 裁定（このプランで確定させる判断）

| # | 裁定 | 理由 |
|---|---|---|
| **D-P2-1** | Cargo features に spec §6.4 の 3 つに加えて **`Win32_System_Ole`** を追加する | `IShellBrowser` / `IShellView` / `VARIANT` の定義自体が `Win32_System_Ole` に cfg されており、無いとコンパイル不能。spec §6.4 の見落とし |
| **D-P2-2** | **`Win32_UI_WindowsAndMessaging`** も追加する | foreground HWND 退避（`GetForegroundWindow`）とタブ HWND → トップレベル解決（`GetAncestor(GA_ROOT)`）に必要。手書き extern より crate バインディング利用が R10 の精神（自前定義を避ける）と一貫。ビルド時間増は §8 で実測・記録 |
| **D-P2-3** | HWND 照合は `IShellBrowser.GetWindow()`（タブの HWND の可能性がある）に `GetAncestor(GA_ROOT)` をかけてトップレベル枠に正規化してから、退避した foreground HWND と比較する | Windows 11 のタブは 1 つのトップレベル窓を共有し（付録 A: 10 エントリ / HWND 4 種類）、`GetForegroundWindow` はトップレベルを返すため。トップレベル窓に対する `GA_ROOT` は自身を返すので両ケースで正しい |
| **D-P2-4** | `ImageInfo` から `Deserialize` derive を外す（final review 持ち越し(1)） | deserialize 経路が存在せず、deserialize すると serde-skip の ns フィールドが 0 になる罠だけが残るため |
| **D-P2-5** | foreground 窓がフォルダ一致かつソートキー未対応の場合、他の窓を探さずその結果（None = 名前昇順）を採用する | §7.3 項目 5「手前の窓の設定が採用される」と一貫。手前の窓が未対応キーなのに別窓の設定で並ぶ方が意外性が大きい |
| **D-P2-6** | 検証プローブは C# ではなく **Rust の example バイナリ**（`src-tauri/examples/explorer_sort_probe.rs`）+ PowerShell ラッパで作る。ソート変更スクリプトは UIA のヘッダクリックのみ（`SetSortColumns` 不使用） | crate の検証済みバインディングを再利用でき、付録 A.5 の SAFEARRAY マーシャリング罠を構造的に回避。app 経路（本番コード）と Explorer 実表示順（`GetItem`）の両方を同じバイナリで出力して diff できる |
| **D-P2-7** | `SHGetPathFromIDListW` の 260 (MAX_PATH) 制限は既知の制限とする（超えるフォルダは照合失敗 → None → 名前昇順） | crate の安全ラッパーが固定長。フォールバックが正しく効くため実害は限定的。PR の既知の制限に明記 |

## 前提・作業環境

- 実装は worktree で行う（EnterWorktree）。作成後に `git rev-parse HEAD` / `git rev-parse main` / `git rev-parse origin/main` を**個別に**取り、`git ls-remote https://github.com/hiz8/spica-photo-viewer.git refs/heads/main` と一致するものを基点にする（ずれていれば一致する方へ `git reset --hard`）
- worktree 初期化: `npm install`（`package-lock.json` の EOL 差分は `git checkout -- package-lock.json` で戻す）→ `npm run bench:corpus` → `npm run bench:build`（**所要時間を記録** — §8 の feature 追加前の基準）
- ブランチ名: `feat/explorer-sort-phase2-com-detection`。本プランのコミットもこのブランチに含める
- 長時間コマンド（bench:build ~10分 / bench ~4分 / e2e）は background 実行。worktree の Bash ガードは複合コマンドを拒否するので 1 コマンドずつ
- push: `git -c credential.helper="!gh auth git-credential" push https://github.com/hiz8/spica-photo-viewer.git <branch>`（SSH 不可）。PR: `gh pr create --head <branch> --base main`
- サブエージェントには「コマンドは worktree cwd から 1 つずつ」「`find /` 禁止」を明記する

## ファイル構成

| ファイル | 役割 |
|---|---|
| `src-tauri/Cargo.toml` | windows features 追加（+4: Shell_Common / Com / Ole / Variant / WindowsAndMessaging のうち未追加分） |
| `src-tauri/src/commands/explorer_sort.rs`（新規） | 退避 HWND、`spawn_detect`/`SortProbe`（並行実行 + 残余タイムアウト）、`detect_sort_spec`（Windows）、`normalize_path`、`map_sort_column`、非 Windows スタブ |
| `src-tauri/src/commands/mod.rs` | `pub mod explorer_sort;` 追加 |
| `src-tauri/src/commands/file.rs` | probe の spawn/join を `get_folder_images` に組み込み、SPICA_PERF ログ、`Deserialize` 削除、タイブレークコメント、`SortKey` の `#[allow(dead_code)]` 削除 |
| `src-tauri/src/utils/perf.rs` | `enabled()` を `pub` に |
| `src-tauri/src/lib.rs` | `run()` 冒頭で `stash_foreground_window()`、`#[doc(hidden)] pub mod probe_api` |
| `src-tauri/examples/explorer_sort_probe.rs`（新規） | 検証プローブ（list / order / app サブコマンド） |
| `scripts/explorer-sort-probe/README.md`（新規） | §7.3 の検証手順とプローブの使い方 |
| `scripts/explorer-sort-probe/probe.ps1`（新規） | example のビルド & 実行ラッパ |
| `scripts/explorer-sort-probe/set-sort-via-ui.ps1`（新規） | UIA で Explorer のソートを変更（ヘッダクリック。COM の SetSortColumns 不使用） |
| `scripts/explorer-sort-probe/compare-order.ps1`（新規） | Explorer 実表示順と app 順の diff |

変更しない: `src/`（フロント全体）、`src-tauri/src/utils/natural_sort.rs`、`get_folder_images` の呼び出し側。

---

### Task 1: Cargo features + `explorer_sort.rs` の純ロジック（写像・パス正規化）

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/commands/explorer_sort.rs`
- Modify: `src-tauri/src/commands/mod.rs`（現在 `cache` / `file` / `window` の 3 行）
- Modify: `src-tauri/src/commands/file.rs:33-35`（`SortKey` の `#[allow(dead_code)]` と説明コメントを削除）

**Interfaces:**
- Consumes: `crate::commands::file::{SortKey, SortSpec}`（Phase 1 提供。`SortKey` は Windows 分岐内でのみ import すること — 非 Windows で unused import になる）
- Produces: `pub(crate) fn normalize_path(&str) -> String`（Task 2 と example が使用 — Task 2 で `pub` に昇格）、`pub(crate) fn map_sort_column(&SORTCOLUMN) -> Option<SortSpec>`（Task 2 が使用）

- [ ] **Step 1: Cargo.toml に features を追加**

`[target.'cfg(windows)'.dependencies]` を次で置き換える:

```toml
[target.'cfg(windows)'.dependencies]
windows = { version = "0.62", features = [
  "Win32_Storage_FileSystem",       # existing
  "Win32_Foundation",               # existing (PROPERTYKEY)
  "Win32_UI_Shell",                 # Phase 1: StrCmpLogicalW / Phase 2: IShellWindows, IFolderView2, SORTCOLUMN, SID_STopLevelBrowser, IUnknown_QueryService
  "Win32_UI_Shell_Common",          # ITEMIDLIST (GetCurFolder / SHGetPathFromIDListW)
  "Win32_System_Com",               # CoCreateInstance / CoInitializeEx / IDispatch / IShellWindows gate
  "Win32_System_Ole",               # IShellBrowser / IShellView / VARIANT gate (D-P2-1; spec §6.4 lacked it)
  "Win32_System_Variant",           # VARIANT / VT_I4 (IShellWindows::Item)
  "Win32_UI_WindowsAndMessaging",   # GetForegroundWindow / GetAncestor (D-P2-2)
] }
```

- [ ] **Step 2: モジュール登録と失敗するテスト**

`src-tauri/src/commands/mod.rs` に `pub mod explorer_sort;` を追加（アルファベット順で `cache` の次）。

`src-tauri/src/commands/explorer_sort.rs` を作成（まずシグネチャ + `todo!()` + テスト）:

```rust
//! Detects the sort setting of the Explorer window/tab showing a folder
//! (spec §6.3). Every COM failure collapses to `None` so callers fall back
//! to natural name order (I2). Non-Windows builds are a stub that always
//! yields `None` (I4).

/// Normalizes a filesystem path for comparing an Explorer window's current
/// folder against the target folder (§6.3 step 6): strips the `\\?\` prefix,
/// unifies separators, drops trailing separators, lowercases. Compiled on all
/// platforms so the contract stays unit-tested on CI (ubuntu); only the
/// Windows COM path calls it at runtime.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn normalize_path(p: &str) -> String {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_path_ignores_case_and_trailing_separator() {
        assert_eq!(
            normalize_path(r"C:\Users\X\Pictures\"),
            normalize_path(r"c:\users\x\pictures")
        );
    }

    #[test]
    fn normalize_path_strips_extended_length_prefix() {
        assert_eq!(
            normalize_path(r"\\?\C:\photos"),
            normalize_path(r"C:\photos")
        );
    }

    #[test]
    fn normalize_path_unifies_forward_slashes() {
        assert_eq!(normalize_path("C:/photos/2024"), normalize_path(r"C:\photos\2024"));
    }

    #[test]
    fn normalize_path_keeps_non_ascii() {
        assert_eq!(normalize_path("C:\\写真\\"), "c:\\写真");
    }

    #[test]
    fn normalize_path_distinguishes_different_folders() {
        assert_ne!(normalize_path(r"C:\a\b"), normalize_path(r"C:\a\c"));
    }
}
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `cd src-tauri && cargo test --lib explorer_sort`
Expected: FAIL（`todo!()` panic）。※ features 追加により windows crate の再コンパイルが走る（数分かかる）

- [ ] **Step 4: `normalize_path` を実装**

```rust
pub(crate) fn normalize_path(p: &str) -> String {
    let p = p.strip_prefix(r"\\?\").unwrap_or(p);
    p.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}
```

- [ ] **Step 5: `map_sort_column`（Windows 限定）をテストと共に追加**

同ファイルに追加:

```rust
#[cfg(windows)]
pub(crate) use imp::map_sort_column;

#[cfg(windows)]
mod imp {
    use crate::commands::file::{SortKey, SortSpec};
    use windows::Win32::UI::Shell::SORTCOLUMN;

    /// PSGUID_STORAGE: the fmtid shared by the standard column PROPERTYKEYs
    /// (spec appendix B).
    const FMTID_STORAGE: windows::core::GUID =
        windows::core::GUID::from_u128(0xB725F130_47EF_101A_A5F1_02608C9EEBAC);

    /// Appendix B mapping. Unmapped keys => None => caller falls back to
    /// natural name order ascending.
    pub(crate) fn map_sort_column(col: &SORTCOLUMN) -> Option<SortSpec> {
        if col.propkey.fmtid != FMTID_STORAGE {
            return None;
        }
        let key = match col.propkey.pid {
            10 => SortKey::Name,     // PKEY_ItemNameDisplay
            12 => SortKey::Size,     // PKEY_Size
            14 => SortKey::Modified, // PKEY_DateModified
            15 => SortKey::Created,  // PKEY_DateCreated
            4 => SortKey::Type,      // PKEY_ItemTypeText (approximated by extension, R4)
            _ => return None,
        };
        Some(SortSpec {
            key,
            descending: col.direction.0 < 0,
        })
    }
}
```

テスト（`mod tests` 内に追加）:

```rust
    #[cfg(windows)]
    mod windows_tests {
        use super::super::map_sort_column;
        use crate::commands::file::SortKey;
        use windows::Win32::Foundation::PROPERTYKEY;
        use windows::Win32::UI::Shell::{SORTCOLUMN, SORTDIRECTION};

        const STORAGE: windows::core::GUID =
            windows::core::GUID::from_u128(0xB725F130_47EF_101A_A5F1_02608C9EEBAC);

        fn col(fmtid: windows::core::GUID, pid: u32, dir: i32) -> SORTCOLUMN {
            SORTCOLUMN {
                propkey: PROPERTYKEY { fmtid, pid },
                direction: SORTDIRECTION(dir),
            }
        }

        #[test]
        fn maps_all_supported_pids() {
            for (pid, key) in [
                (10, SortKey::Name),
                (12, SortKey::Size),
                (14, SortKey::Modified),
                (15, SortKey::Created),
                (4, SortKey::Type),
            ] {
                let spec = map_sort_column(&col(STORAGE, pid, 1)).unwrap();
                assert_eq!(spec.key, key);
                assert!(!spec.descending);
            }
        }

        #[test]
        fn negative_direction_is_descending() {
            let spec = map_sort_column(&col(STORAGE, 12, -1)).unwrap();
            assert_eq!(spec.key, SortKey::Size);
            assert!(spec.descending);
        }

        #[test]
        fn unmapped_pid_is_none() {
            // e.g. pid 21 = PKEY_Author on the storage fmtid
            assert!(map_sort_column(&col(STORAGE, 21, 1)).is_none());
        }

        #[test]
        fn foreign_fmtid_is_none() {
            // PKEY_Photo_DateTaken {14B81DA1-0135-4D31-96D9-6CBFC9671A99},36867
            let taken = windows::core::GUID::from_u128(0x14B81DA1_0135_4D31_96D9_6CBFC9671A99);
            assert!(map_sort_column(&col(taken, 36867, 1)).is_none());
        }
    }
```

- [ ] **Step 6: `SortKey` の `#[allow(dead_code)]` を削除**

`src-tauri/src/commands/file.rs` の `SortKey` 直前にある次の 3 行を削除する（`map_sort_column` が全 variant を構築するようになったため）:

```rust
// Variants other than Name are constructed by Phase 2's Explorer
// detection (detect_sort_spec); until then only tests construct them.
#[allow(dead_code)]
```

- [ ] **Step 7: テストが通ることを確認**

Run: `cd src-tauri && cargo test --lib`
Expected: 全件 PASS、warning なし

- [ ] **Step 8: コミット**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/commands/explorer_sort.rs src-tauri/src/commands/mod.rs src-tauri/src/commands/file.rs
git commit -m "feat(sort): add COM features and explorer sort mapping layer"
```

---

### Task 2: COM 検出チェーンと並行プローブ（`detect_sort_spec` / `SortProbe`）

**Files:**
- Modify: `src-tauri/src/commands/explorer_sort.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Task 1 の `normalize_path` / `imp::map_sort_column`、`crate::commands::file::SortSpec`、`crate::utils::perf::enabled()`（Task 3 で pub 化 — 本 Task では `enabled()` をまだ呼ばず、ログは Task 3 でまとめて配線してもよいが、下記コードは Task 3 適用後の最終形。**Task 2 の時点では `crate::utils::perf::enabled` が private なので、本 Task に `src-tauri/src/utils/perf.rs` の `fn enabled()` → `pub fn enabled()` の変更を含める**）
- Produces:
  - `pub fn stash_foreground_window()`（lib.rs `run()` が呼ぶ）
  - `pub fn spawn_detect(folder: PathBuf) -> SortProbe` / `SortProbe::join(self) -> (Option<SortSpec>, f64)`（Task 3 の `get_folder_images` が使用）
  - `#[cfg(windows)] pub fn detect_sort_spec(folder: &Path, foreground_hwnd: Option<isize>) -> Option<SortSpec>`（example が使用）
  - `normalize_path` を `pub(crate)` から `pub` に昇格（example が probe_api 経由で使用）
  - lib.rs に `#[doc(hidden)] pub mod probe_api`

- [ ] **Step 1: 失敗するテストを書く**

`explorer_sort.rs` の `mod tests` に追加:

```rust
    use std::time::Instant;

    #[test]
    fn probe_on_unopened_folder_yields_none_within_budget() {
        // A fresh temp dir is never shown in any Explorer window, so the
        // probe must resolve to None on every platform. On Windows this
        // exercises the real COM chain (no matching window / no Explorer).
        let dir = tempfile::tempdir().unwrap();
        let started = Instant::now();
        let probe = spawn_detect(dir.path().to_path_buf());
        let (spec, ms) = probe.join();
        assert!(spec.is_none());
        assert!(ms >= 0.0);
        // join() must never wait past the 300ms budget by more than scheduling
        // slack (generous bound to avoid flakes on loaded machines).
        assert!(started.elapsed().as_millis() < 2000);
    }
```

Run: `cd src-tauri && cargo test --lib explorer_sort`
Expected: FAIL（`spawn_detect` 未定義のコンパイルエラー）

- [ ] **Step 2: プローブ骨格・退避 HWND・検出チェーンを実装**

`explorer_sort.rs` の冒頭（doc コメントの後、`normalize_path` の前）に追加:

```rust
use crate::commands::file::SortSpec;
use std::path::PathBuf;
use std::time::Instant;

/// Whole-detection budget measured from thread spawn (§6.3). The folder scan
/// runs concurrently, so join() only waits for whatever remains of it.
#[cfg(windows)]
const DETECT_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(300);

/// Foreground window at process launch, kept as isize because HWND is not
/// Send. Used to pick among multiple Explorer windows showing the folder.
#[cfg(windows)]
static FOREGROUND_AT_LAUNCH: std::sync::OnceLock<isize> = std::sync::OnceLock::new();

/// Call as early as possible in `run()`: the Explorer window the user
/// launched the app from is still foreground until Tauri creates our window.
pub fn stash_foreground_window() {
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
        let hwnd = unsafe { GetForegroundWindow() };
        if !hwnd.is_invalid() {
            let _ = FOREGROUND_AT_LAUNCH.set(hwnd.0 as isize);
        }
    }
}

/// In-flight Explorer query started by `spawn_detect`.
pub struct SortProbe {
    #[cfg(windows)]
    rx: std::sync::mpsc::Receiver<Option<SortSpec>>,
    started: Instant,
}

/// Spawns the Explorer query on a dedicated COM thread, concurrent with the
/// caller's folder scan (spec §5).
#[cfg(windows)]
pub fn spawn_detect(folder: PathBuf) -> SortProbe {
    let started = Instant::now();
    let (tx, rx) = std::sync::mpsc::channel();
    let foreground = FOREGROUND_AT_LAUNCH.get().copied();
    std::thread::spawn(move || {
        let _ = tx.send(detect_sort_spec(&folder, foreground));
    });
    SortProbe { rx, started }
}

/// Non-Windows stub: no Explorer, always resolves to None (I4).
#[cfg(not(windows))]
pub fn spawn_detect(folder: PathBuf) -> SortProbe {
    let _ = folder;
    SortProbe {
        started: Instant::now(),
    }
}

impl SortProbe {
    /// Returns (detected spec, elapsed ms). Waits only for the remainder of
    /// the 300ms budget measured from spawn; timeout or any COM failure is
    /// None. The COM call cannot be cancelled, so on timeout the worker
    /// thread stays detached (§6.3).
    pub fn join(self) -> (Option<SortSpec>, f64) {
        #[cfg(windows)]
        let spec = {
            let remaining = DETECT_TIMEOUT.saturating_sub(self.started.elapsed());
            self.rx.recv_timeout(remaining).ok().flatten()
        };
        #[cfg(not(windows))]
        let spec = None;
        (spec, self.started.elapsed().as_secs_f64() * 1000.0)
    }
}

/// Walks the open Explorer windows/tabs and returns the sort setting of the
/// one showing `folder`. Runs on a dedicated thread (spawn_detect) or a
/// probe binary; initializes STA COM for the duration of the query (§6.3).
#[cfg(windows)]
pub fn detect_sort_spec(
    folder: &std::path::Path,
    foreground_hwnd: Option<isize>,
) -> Option<SortSpec> {
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if hr.is_err() {
        return None;
    }
    let result = imp::scan_shell_windows(folder, foreground_hwnd);
    unsafe { CoUninitialize() };
    result
}
```

`normalize_path` の可視性を `pub(crate)` から `pub` に変更する（doc コメントはそのまま）。

`mod imp` の中（`map_sort_column` と同居）に追加:

```rust
    use super::normalize_path;
    use std::path::Path;
    use windows::core::Interface;
    use windows::Win32::Foundation::PROPERTYKEY;
    use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, IDispatch, CLSCTX_ALL};
    use windows::Win32::System::Variant::{VARIANT, VARIANT_0_0, VARIANT_0_0_0, VT_I4};
    use windows::Win32::UI::Shell::{
        IFolderView2, IPersistFolder2, IShellBrowser, IShellView, IShellWindows,
        IUnknown_QueryService, SHGetPathFromIDListW, ShellWindows, SID_STopLevelBrowser,
        SORTCOLUMN,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GA_ROOT};

    pub(super) fn scan_shell_windows(
        folder: &Path,
        foreground: Option<isize>,
    ) -> Option<SortSpec> {
        let target = normalize_path(&folder.to_string_lossy());
        let shell_windows: IShellWindows =
            unsafe { CoCreateInstance(&ShellWindows, None::<&windows::core::IUnknown>, CLSCTX_ALL) }
                .ok()?;
        let count = unsafe { shell_windows.Count() }.ok()?;
        let mut first_match: Option<Option<SortSpec>> = None;
        for i in 0..count {
            let Some((view, top_hwnd)) = entry_at(&shell_windows, i) else {
                continue;
            };
            let Some(path) = current_folder_path(&view) else {
                continue;
            };
            if normalize_path(&path) != target {
                continue;
            }
            let spec = read_sort_spec(&view);
            // The window the user launched from wins outright (§6.3) — even
            // when its sort key is unmapped (=> Name fallback, D-P2-5).
            if foreground.is_some() && top_hwnd == foreground {
                return spec;
            }
            if first_match.is_none() {
                first_match = Some(spec);
            }
        }
        first_match.flatten()
    }

    /// Resolves one IShellWindows entry to its folder view and top-level
    /// frame HWND. Entries can be non-browser shell hosts or vanish
    /// mid-enumeration; any failure skips the entry.
    fn entry_at(shell_windows: &IShellWindows, index: i32) -> Option<(IFolderView2, Option<isize>)> {
        let mut idx = VARIANT::default();
        idx.Anonymous.Anonymous = std::mem::ManuallyDrop::new(VARIANT_0_0 {
            vt: VT_I4,
            wReserved1: 0,
            wReserved2: 0,
            wReserved3: 0,
            Anonymous: VARIANT_0_0_0 { lVal: index },
        });
        let disp: IDispatch = unsafe { shell_windows.Item(&idx) }.ok()?;
        let browser: IShellBrowser =
            unsafe { IUnknown_QueryService(&disp, &SID_STopLevelBrowser) }.ok()?;
        let view: IShellView = unsafe { browser.QueryActiveShellView() }.ok()?;
        let view2: IFolderView2 = view.cast().ok()?;
        // A Windows 11 tab's browser window is a child of the shared
        // top-level frame; GetForegroundWindow returns the frame, so
        // normalize via GA_ROOT before comparing (D-P2-3).
        let top = unsafe { browser.GetWindow() }
            .ok()
            .map(|h| unsafe { GetAncestor(h, GA_ROOT) }.0 as isize);
        Some((view2, top))
    }

    /// Real path of the folder the view is showing, via PIDL (§6.3 step 5).
    /// IWebBrowser2::LocationURL is NOT used (escaping/UNC format issues).
    fn current_folder_path(view: &IFolderView2) -> Option<String> {
        let persist: IPersistFolder2 = unsafe { view.GetFolder::<IPersistFolder2>() }.ok()?;
        let pidl = unsafe { persist.GetCurFolder() }.ok()?;
        if pidl.is_null() {
            return None;
        }
        let mut buf = [0u16; 260];
        let ok = unsafe { SHGetPathFromIDListW(pidl, &mut buf) }.as_bool();
        unsafe { CoTaskMemFree(Some(pidl as *const core::ffi::c_void)) };
        if !ok {
            // Virtual folders (This PC, ...) and > MAX_PATH folders (D-P2-7)
            // have no filesystem path here.
            return None;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..len]))
    }

    /// First sort column of the view, mapped to SortSpec (appendix B).
    /// Secondary columns are recorded to the perf log only (R12).
    fn read_sort_spec(view: &IFolderView2) -> Option<SortSpec> {
        let count = unsafe { view.GetSortColumnCount() }.ok()?;
        if count < 1 {
            return None;
        }
        let mut cols = vec![SORTCOLUMN::default(); count as usize];
        unsafe { view.GetSortColumns(&mut cols) }.ok()?;
        log_view_details(view, &cols);
        map_sort_column(&cols[0])
    }

    /// R12 (multi-column sorts) and R3 (grouping): recorded to the
    /// SPICA_PERF log as future decision material; never shown in UI (D4).
    fn log_view_details(view: &IFolderView2, cols: &[SORTCOLUMN]) {
        if !crate::utils::perf::enabled() {
            return;
        }
        if cols.len() > 1 {
            let all: Vec<String> = cols
                .iter()
                .map(|c| format!("{:?}/{}:{}", c.propkey.fmtid, c.propkey.pid, c.direction.0))
                .collect();
            eprintln!(
                r#"{{"perf":"rust","op":"explorer_sort_columns","detail":{}}}"#,
                serde_json::Value::String(all.join(";"))
            );
        }
        let mut key = PROPERTYKEY::default();
        let mut ascending = windows::core::BOOL(0);
        if unsafe { view.GetGroupBy(&mut key, Some(&mut ascending)) }.is_ok()
            && key.fmtid != windows::core::GUID::default()
        {
            eprintln!(
                r#"{{"perf":"rust","op":"explorer_group_by","detail":{}}}"#,
                serde_json::Value::String(format!(
                    "{:?}/{}:asc={}",
                    key.fmtid,
                    key.pid,
                    ascending.as_bool()
                ))
            );
        }
    }
```

`imp` の既存 import（`use crate::commands::file::{SortKey, SortSpec};`）はそのまま。`src-tauri/src/utils/perf.rs` の `fn enabled()` を `pub fn enabled()` に変更する。

- [ ] **Step 3: lib.rs の配線**

`run()` の先頭（`let builder = ...` の前）に:

```rust
    // Stash the launcher's foreground window before Tauri creates ours and
    // takes focus (spec §6.3: picks among multiple Explorer windows).
    commands::explorer_sort::stash_foreground_window();
```

ファイル末尾（`run()` の後）に:

```rust
/// Probe-only surface for scripts/explorer-sort-probe. Not a public API.
#[doc(hidden)]
pub mod probe_api {
    pub use crate::commands::explorer_sort::normalize_path;
    #[cfg(windows)]
    pub use crate::commands::explorer_sort::detect_sort_spec;
    pub use crate::commands::file::get_folder_images;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd src-tauri && cargo test --lib`
Expected: 全件 PASS（新テスト含む）、warning なし。
特に `probe_on_unopened_folder_yields_none_within_budget` が実 COM（この Windows マシン）で green になること。

- [ ] **Step 5: 非 Windows の目視チェック**

Linux ツールチェーンが無いためコンパイルでは確認できない。次を目視確認する:
- `#[cfg(not(windows))]` ビルドに現れるコードが参照するのは `SortSpec` / `PathBuf` / `Instant` のみで、それらはすべて使用されている（unused import なし）
- `DETECT_TIMEOUT` / `FOREGROUND_AT_LAUNCH` / `detect_sort_spec` / `mod imp` はすべて `#[cfg(windows)]` 配下
- `SortProbe` の `started` フィールドは非 Windows の `join()` でも読まれる（dead_code 警告なし）
- `probe_api` の `detect_sort_spec` 再エクスポートは `#[cfg(windows)]` 付き

- [ ] **Step 6: コミット**

```bash
git add src-tauri/src/commands/explorer_sort.rs src-tauri/src/lib.rs src-tauri/src/utils/perf.rs
git commit -m "feat(sort): detect Explorer sort setting via IFolderView2 with 300ms budget"
```

---

### Task 3: `get_folder_images` への統合と SPICA_PERF ログ + final review 持ち越し

**Files:**
- Modify: `src-tauri/src/commands/file.rs`

**Interfaces:**
- Consumes: `crate::commands::explorer_sort::{spawn_detect, SortProbe}`（Task 2）、`crate::utils::perf::enabled`
- Produces: `get_folder_images` の並びが Explorer 設定に追従（戻り値の型・シグネチャは不変。フロント無変更）

- [ ] **Step 1: 失敗するテストを書く**

`file.rs` の `mod tests` に追加（`test_get_folder_images_with_valid_folder` の近く）:

```rust
    #[tokio::test]
    async fn test_get_folder_images_unopened_folder_uses_name_order() {
        // No Explorer window shows a fresh temp dir, so detection resolves to
        // None and the order must be natural-name ascending (G2/I2). Also
        // guards the probe wiring: the command must not error or hang.
        let temp_dir = create_temp_dir();
        create_test_jpeg(temp_dir.path(), "img10.jpg");
        create_test_jpeg(temp_dir.path(), "img2.jpg");
        create_test_png(temp_dir.path(), "img3.png");

        let images = get_folder_images(temp_dir.path().to_string_lossy().to_string())
            .await
            .unwrap();
        let names: Vec<&str> = images.iter().map(|i| i.filename.as_str()).collect();
        assert_eq!(names, ["img2.jpg", "img3.png", "img10.jpg"]);
    }
```

Run: `cd src-tauri && cargo test --lib test_get_folder_images_unopened_folder`
Expected: PASS してしまう（現状も名前昇順のため）— このテストは統合後の回帰ガード。**Step 2 の変更後にも green を維持することが目的**（Red を経ない追加として記録する）

- [ ] **Step 2: `get_folder_images` に probe を組み込む**

`file.rs:92` の `get_folder_images` を次に変更（`folder_path` 検証と `image_paths` 収集の**間**に spawn、`sort_images` の**直前**に join）:

```rust
#[tauri::command]
pub async fn get_folder_images(path: String) -> Result<Vec<ImageInfo>, String> {
    let folder_path = Path::new(&path);

    if !folder_path.exists() || !folder_path.is_dir() {
        return Err("Invalid folder path".to_string());
    }

    // Ask Explorer for this folder's sort setting concurrently with the scan
    // (spec §5); the answer is picked up after the scan with whatever remains
    // of the 300ms budget.
    let probe = crate::commands::explorer_sort::spawn_detect(folder_path.to_path_buf());

    // First, collect all valid image paths (fast, no metadata reads)
    let image_paths: Vec<_> = WalkDir::new(folder_path)
        .max_depth(1)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|entry| {
            let path = entry.path();
            path.is_file() && is_supported_image(path)
        })
        .map(|entry| entry.path().to_path_buf())
        .collect();

    // Process metadata in parallel using rayon
    // This dramatically speeds up folder scanning for large folders (900+ images)
    let mut images: Vec<ImageInfo> = image_paths
        .par_iter()
        .filter_map(|path| get_image_info(path).ok())
        .collect();

    let (detected, probe_ms) = probe.join();
    if crate::utils::perf::enabled() {
        // Sort provenance (§6.5): explorer = a window's setting was adopted,
        // fallback = Name ascending. Log-only; never surfaced in UI (D4).
        let (source, key, descending) = match detected {
            Some(s) => ("explorer", format!("{:?}", s.key), s.descending),
            None => ("fallback", "Name".to_string(), false),
        };
        eprintln!(
            r#"{{"perf":"rust","op":"explorer_sort","path":{},"ms":{:.2},"source":"{}","key":"{}","descending":{}}}"#,
            serde_json::to_string(&path).unwrap_or_else(|_| "\"?\"".into()),
            probe_ms,
            source,
            key,
            descending
        );
    }
    sort_images(&mut images, detected.unwrap_or_default());
    Ok(images)
}
```

- [ ] **Step 3: final review 持ち越し 2 件を適用**

(1) `ImageInfo` の derive から `Deserialize` を削除（D-P2-4）:

```rust
#[derive(Debug, Serialize, Clone)]
pub struct ImageInfo {
```

`use serde::{Deserialize, Serialize};` は `ThumbnailWithDimensions` が `Deserialize` を使うためそのまま残す。

(2) `sort_images` のタイブレーク行にコメント追加:

```rust
        // natural_cmp can return Equal for case-insensitively equal names
        // ("IMG_1.jpg" vs "img_1.jpg" under StrCmpLogicalW). The tiebreak is
        // then a no-op and the stable sort keeps enumeration order.
        primary.then_with(|| natural_cmp(&a.filename, &b.filename))
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd src-tauri && cargo test --lib`
Expected: 全件 PASS、warning なし（`test_image_info_serde_skips_ns_fields` は Serialize のみ検証しているため green のまま）

- [ ] **Step 5: SPICA_PERF ログの実地確認**

Run（worktree cwd、PowerShell）:
`$env:SPICA_PERF="1"; cd src-tauri; cargo test --lib test_get_folder_images_unopened_folder -- --nocapture; Remove-Item Env:SPICA_PERF`
Expected: stderr に `"op":"explorer_sort"` の JSON 1 行（`"source":"fallback"`、ms は 300 以下）

- [ ] **Step 6: コミット**

```bash
git add src-tauri/src/commands/file.rs
git commit -m "feat(sort): adopt detected Explorer sort in get_folder_images with perf provenance log"
```

---

### Task 4: 検証プローブ（Rust example + PowerShell スクリプト）

**Files:**
- Create: `src-tauri/examples/explorer_sort_probe.rs`
- Create: `scripts/explorer-sort-probe/README.md`
- Create: `scripts/explorer-sort-probe/probe.ps1`
- Create: `scripts/explorer-sort-probe/set-sort-via-ui.ps1`
- Create: `scripts/explorer-sort-probe/compare-order.ps1`

**Interfaces:**
- Consumes: `spica_photo_viewer_lib::probe_api::{detect_sort_spec, get_folder_images, normalize_path}`（Task 2）
- Produces: §7.3 検証（Task 5）が使う CLI。`probe.ps1 list` / `probe.ps1 order <folder>` / `probe.ps1 app <folder> [-Hwnd N]` / `compare-order.ps1 <folder>` / `set-sort-via-ui.ps1 -Path <folder> -Column <label> [-Clicks n]`

- [ ] **Step 1: example バイナリを作成**

`src-tauri/examples/explorer_sort_probe.rs`（examples は `cargo test --lib` ではビルドされないため CI 影響なし。dev-dependencies の tokio が使える）:

```rust
//! Manual-verification probe for spec §7.3 (scripts/explorer-sort-probe).
//!
//! Subcommands:
//!   list                     enumerate Explorer windows/tabs: top-level HWND,
//!                            folder path, raw sort columns, group-by
//!   order <folder>           Explorer's own display order (IFolderView::GetItem)
//!                            of the tab showing <folder> — ground truth
//!   app <folder> [--hwnd N]  the app's real pipeline: detect_sort_spec (spec
//!                            printed to stderr) + get_folder_images order
//!
//! Never calls SetSortColumns (R10).

#[cfg(windows)]
fn main() {
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};

    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("list") => {
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap() };
            win::list_windows();
            unsafe { CoUninitialize() };
        }
        Some("order") => {
            let folder = args.get(1).expect("usage: explorer_sort_probe order <folder>");
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap() };
            win::dump_display_order(folder);
            unsafe { CoUninitialize() };
        }
        Some("app") => {
            let folder = args.get(1).expect("usage: explorer_sort_probe app <folder> [--hwnd N]");
            let hwnd = args
                .iter()
                .position(|a| a == "--hwnd")
                .and_then(|i| args.get(i + 1))
                .and_then(|v| v.parse::<isize>().ok());
            let spec =
                spica_photo_viewer_lib::probe_api::detect_sort_spec(std::path::Path::new(folder), hwnd);
            eprintln!("detect_sort_spec(hwnd={hwnd:?}) => {spec:?}");
            let images = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(spica_photo_viewer_lib::probe_api::get_folder_images(folder.clone()))
                .expect("get_folder_images failed");
            for img in &images {
                println!("{}", img.filename);
            }
        }
        _ => eprintln!("usage: explorer_sort_probe (list | order <folder> | app <folder> [--hwnd N])"),
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("windows-only probe");
}

#[cfg(windows)]
mod win {
    use spica_photo_viewer_lib::probe_api::normalize_path;
    use windows::core::Interface;
    use windows::Win32::Foundation::PROPERTYKEY;
    use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, IDispatch, CLSCTX_ALL};
    use windows::Win32::System::Variant::{VARIANT, VARIANT_0_0, VARIANT_0_0_0, VT_I4};
    use windows::Win32::UI::Shell::{
        IFolderView2, IPersistFolder2, IShellBrowser, IShellItem, IShellView, IShellWindows,
        IUnknown_QueryService, SHGetPathFromIDListW, ShellWindows, SID_STopLevelBrowser,
        SIGDN_PARENTRELATIVEPARSING, SORTCOLUMN, SVGIO_ALLVIEW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GA_ROOT};

    fn entries() -> Vec<(IFolderView2, Option<isize>, String)> {
        let mut out = Vec::new();
        let Ok(shell_windows) = (unsafe {
            CoCreateInstance::<_, IShellWindows>(
                &ShellWindows,
                None::<&windows::core::IUnknown>,
                CLSCTX_ALL,
            )
        }) else {
            return out;
        };
        let count = unsafe { shell_windows.Count() }.unwrap_or(0);
        for i in 0..count {
            let mut idx = VARIANT::default();
            idx.Anonymous.Anonymous = std::mem::ManuallyDrop::new(VARIANT_0_0 {
                vt: VT_I4,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: VARIANT_0_0_0 { lVal: i },
            });
            let Ok(disp) = (unsafe { shell_windows.Item(&idx) }) else { continue };
            let disp: IDispatch = disp;
            let Ok(browser) =
                (unsafe { IUnknown_QueryService::<_, IShellBrowser>(&disp, &SID_STopLevelBrowser) })
            else {
                continue;
            };
            let Ok(view) = (unsafe { browser.QueryActiveShellView() }) else { continue };
            let view: IShellView = view;
            let Ok(view2) = view.cast::<IFolderView2>() else { continue };
            let top = unsafe { browser.GetWindow() }
                .ok()
                .map(|h| unsafe { GetAncestor(h, GA_ROOT) }.0 as isize);
            let Some(path) = folder_path(&view2) else { continue };
            out.push((view2, top, path));
        }
        out
    }

    fn folder_path(view: &IFolderView2) -> Option<String> {
        let persist: IPersistFolder2 = unsafe { view.GetFolder::<IPersistFolder2>() }.ok()?;
        let pidl = unsafe { persist.GetCurFolder() }.ok()?;
        if pidl.is_null() {
            return None;
        }
        let mut buf = [0u16; 260];
        let ok = unsafe { SHGetPathFromIDListW(pidl, &mut buf) }.as_bool();
        unsafe { CoTaskMemFree(Some(pidl as *const core::ffi::c_void)) };
        if !ok {
            return None;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..len]))
    }

    pub fn list_windows() {
        for (view, top, path) in entries() {
            let count = unsafe { view.GetSortColumnCount() }.unwrap_or(-1);
            let mut cols_txt = String::new();
            if count > 0 {
                let mut cols = vec![SORTCOLUMN::default(); count as usize];
                if unsafe { view.GetSortColumns(&mut cols) }.is_ok() {
                    cols_txt = cols
                        .iter()
                        .map(|c| format!("{:?}/{} dir={}", c.propkey.fmtid, c.propkey.pid, c.direction.0))
                        .collect::<Vec<_>>()
                        .join("; ");
                }
            }
            let mut gkey = PROPERTYKEY::default();
            let mut gasc = windows::core::BOOL(0);
            let group = if unsafe { view.GetGroupBy(&mut gkey, Some(&mut gasc)) }.is_ok()
                && gkey.fmtid != windows::core::GUID::default()
            {
                format!("{:?}/{} asc={}", gkey.fmtid, gkey.pid, gasc.as_bool())
            } else {
                "none".to_string()
            };
            println!("hwnd={top:?}\tpath={path}\tsort=[{cols_txt}]\tgroup={group}");
        }
    }

    pub fn dump_display_order(folder: &str) {
        let target = normalize_path(folder);
        for (view, _top, path) in entries() {
            if normalize_path(&path) != target {
                continue;
            }
            let count = unsafe { view.ItemCount(SVGIO_ALLVIEW.0 as u32) }.unwrap_or(0);
            for i in 0..count {
                let Ok(item) = (unsafe { view.GetItem::<IShellItem>(i) }) else { continue };
                if let Ok(name) = unsafe { item.GetDisplayName(SIGDN_PARENTRELATIVEPARSING) } {
                    let s = unsafe { name.to_string() }.unwrap_or_default();
                    unsafe { CoTaskMemFree(Some(name.0 as *const core::ffi::c_void)) };
                    println!("{s}");
                }
            }
            return; // first matching tab only
        }
        eprintln!("no Explorer window shows {folder}");
        std::process::exit(2);
    }
}
```

> 注意: `ItemCount` / `SVGIO_ALLVIEW` / `IShellItem` / `SIGDN_PARENTRELATIVEPARSING` のシグネチャ（引数型が `u32` か enum 型か）は windows 0.62.2 の実物に合わせて微調整すること（コンパイラのエラーメッセージに従う）。COM チェーン自体は Task 2 と同一で検証済み。

- [ ] **Step 2: example がビルド・実行できることを確認**

Run: `cd src-tauri && cargo build --example explorer_sort_probe`
Expected: ビルド成功。
Run: `cargo run --example explorer_sort_probe -- list`
Expected: 現在開いている Explorer 窓の一覧（無ければ空出力）。エラーで落ちないこと。

- [ ] **Step 3: PowerShell ラッパを作成**

`scripts/explorer-sort-probe/probe.ps1`:

```powershell
<#
.SYNOPSIS
Explorer sort probe wrapper (spec §7.3). Builds and runs the Rust example.
.EXAMPLE
./probe.ps1 list
./probe.ps1 order C:\tmp\sort-test
./probe.ps1 app C:\tmp\sort-test -Hwnd 123456
#>
param(
    [Parameter(Mandatory, Position = 0)][ValidateSet("list", "order", "app")][string]$Cmd,
    [Parameter(Position = 1)][string]$Folder = "",
    [long]$Hwnd = 0
)
$ErrorActionPreference = "Stop"
$srcTauri = Join-Path $PSScriptRoot "..\..\src-tauri"
$probeArgs = @($Cmd)
if ($Folder) { $probeArgs += $Folder }
if ($Hwnd -ne 0) { $probeArgs += @("--hwnd", "$Hwnd") }
Push-Location $srcTauri
try {
    cargo run --quiet --example explorer_sort_probe -- @probeArgs
} finally {
    Pop-Location
}
```

`scripts/explorer-sort-probe/compare-order.ps1`:

```powershell
<#
.SYNOPSIS
Compares Explorer's display order (GetItem) with the app's order
(get_folder_images) for a folder. Exit 0 = identical (spec §7.3 items 1-3).
Folders/non-images in the Explorer dump are filtered to the app's extension set.
#>
param([Parameter(Mandatory)][string]$Folder)
$ErrorActionPreference = "Stop"
$explorer = & (Join-Path $PSScriptRoot "probe.ps1") order $Folder
$app = & (Join-Path $PSScriptRoot "probe.ps1") app $Folder
$exts = ".jpg", ".jpeg", ".png", ".webp", ".gif"
$explorerImages = @($explorer | Where-Object { $exts -contains [IO.Path]::GetExtension($_).ToLower() })
$app = @($app)
if ($explorerImages.Count -ne $app.Count) {
    Write-Host "COUNT MISMATCH explorer=$($explorerImages.Count) app=$($app.Count)"
}
$diff = Compare-Object -ReferenceObject $explorerImages -DifferenceObject $app -SyncWindow 0
if ($null -eq $diff) {
    Write-Host "MATCH ($($app.Count) files)"
    exit 0
}
Write-Host "DIFF:"
$diff | Format-Table | Out-String | Write-Host
exit 1
```

`scripts/explorer-sort-probe/set-sort-via-ui.ps1`:

```powershell
<#
.SYNOPSIS
Changes an Explorer window's sort by switching to Details view and clicking a
column header via UI Automation. Deliberately avoids IFolderView2::SetSortColumns
(spec R10). Requires the window to already show $Path.
.EXAMPLE
./set-sort-via-ui.ps1 -Path C:\tmp\sort-test -Column サイズ -Clicks 2   # size desc
#>
param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Column,
    [int]$Clicks = 1
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$shell = New-Object -ComObject Shell.Application
$win = @($shell.Windows()) | Where-Object {
    try { $_.Document.Folder.Self.Path -eq $Path } catch { $false }
} | Select-Object -First 1
if (-not $win) { throw "no Explorer window shows $Path" }
$hwnd = [IntPtr]$win.HWND

# Bring the window forward, switch to Details view (Ctrl+Shift+6) so headers exist
$wsh = New-Object -ComObject WScript.Shell
$null = $wsh.AppActivate((Split-Path $Path -Leaf))
Start-Sleep -Milliseconds 500
$wsh.SendKeys("^+6")
Start-Sleep -Milliseconds 800

$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
$cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::HeaderItem)
$headers = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
$target = @($headers) | Where-Object { $_.Current.Name -eq $Column } | Select-Object -First 1
if (-not $target) {
    $names = (@($headers) | ForEach-Object { $_.Current.Name }) -join ", "
    throw "header '$Column' not found (available: $names)"
}
for ($i = 0; $i -lt $Clicks; $i++) {
    ($target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
    Start-Sleep -Milliseconds 500
}
Write-Host "clicked '$Column' x$Clicks"
```

`scripts/explorer-sort-probe/README.md`:

```markdown
# explorer-sort-probe

spec §7.3（Explorer ソート連動の手動検証）用のプローブ群。
spec 付録 A の C# プローブを、アプリ本体と同じ windows crate バインディングを
使う Rust example（`src-tauri/examples/explorer_sort_probe.rs`）に置き換えた
もの（SAFEARRAY マーシャリング罠 = 付録 A.5 を構造的に回避）。

**どのスクリプトも `SetSortColumns` は呼ばない（spec R10）。**
ソート変更は `set-sort-via-ui.ps1`（UIA のヘッダクリック）か手動で行う。

| コマンド | 用途 |
|---|---|
| `./probe.ps1 list` | 全 Explorer 窓/タブの HWND・パス・生ソート列・グループ化を列挙 |
| `./probe.ps1 order <folder>` | そのフォルダを表示中のタブの実表示順（`GetItem`）を出力 |
| `./probe.ps1 app <folder> [-Hwnd N]` | アプリ本体の検出+ソート経路の結果順を出力（stderr に検出結果） |
| `./compare-order.ps1 <folder>` | 上 2 つを diff（一致で exit 0） |
| `./set-sort-via-ui.ps1 -Path <folder> -Column <ヘッダ名> [-Clicks n]` | 詳細表示に切替えて列ヘッダを UIA クリック（1=昇順, 2=降順） |

PROPERTYKEY の読み方（spec 付録 B）: fmtid B725F130-… の pid 10=名前 /
12=サイズ / 14=更新日時 / 15=作成日時 / 4=種類。dir 1=昇順, -1=降順。
```

- [ ] **Step 4: スクリプトの動作確認（スモーク）**

Run: `powershell -ExecutionPolicy Bypass -File scripts/explorer-sort-probe/probe.ps1 list`
Expected: 実行できる（窓が無ければ空）。

- [ ] **Step 5: コミット**

```bash
git add src-tauri/examples/explorer_sort_probe.rs scripts/explorer-sort-probe/
git commit -m "feat(sort): add explorer-sort probe example and verification scripts"
```

---

### Task 5: §7.3 手動検証チェックリストのこのマシン上での実施

**Files:**（コードは書かない — 検証と記録のみ。結果は PR 本文素材として `docs/superpowers/plans/` には残さず、タスクの報告にまとめる）

**手順**（メインセッション or 対話可能なサブエージェントで実施。bench 実行中は避ける）:

- [ ] **Step 1: スクラッチフォルダを作る**

`$env:TEMP\spica-sort-verify` に、各ソートキーで順序が異なるダミー画像を作る（メタデータのみ使うため中身は問わない）:

```powershell
$d = Join-Path $env:TEMP "spica-sort-verify"
New-Item -ItemType Directory -Force $d | Out-Null
# names: natural order b1 < b2 < b10; sizes reversed; mtimes mixed
[IO.File]::WriteAllBytes("$d\b1.jpg",  (,0xFF * 3000))
[IO.File]::WriteAllBytes("$d\b2.jpg",  (,0xFF * 2000))
[IO.File]::WriteAllBytes("$d\b10.jpg", (,0xFF * 1000))
(Get-Item "$d\b1.jpg").LastWriteTime  = "2026-08-01 10:00"
(Get-Item "$d\b2.jpg").LastWriteTime  = "2026-08-03 10:00"
(Get-Item "$d\b10.jpg").LastWriteTime = "2026-08-02 10:00"
```

- [ ] **Step 2: 項目 1（名前昇順で一致）**: `explorer.exe $d` で窓を開く → 数秒待つ → `compare-order.ps1 $d` → MATCH
- [ ] **Step 3: 項目 2（サイズ降順で一致）**: `set-sort-via-ui.ps1 -Path $d -Column サイズ -Clicks 2` → `probe.ps1 list` で pid=12 dir=-1 を確認 → `compare-order.ps1 $d` → MATCH（期待順 b1 > b2 > b10）
- [ ] **Step 4: 項目 3 前半（更新日時降順で一致）**: `set-sort-via-ui.ps1 -Path $d -Column 更新日時 -Clicks 2` → probe で pid=14 dir=-1 確認 → compare → MATCH（期待順 b2 > b10 > b1）
- [ ] **Step 5: 項目 5 の選択ロジック（2 窓・別ソート）**: 同じフォルダをもう 1 窓開き（`explorer.exe $d`）、片方だけ `set-sort-via-ui.ps1` でソート変更 → `probe.ps1 list` で 2 窓の HWND とソートを記録 → `probe.ps1 app $d -Hwnd <窓A>` / `-Hwnd <窓B>` の stderr 検出結果がそれぞれの窓の設定と一致
- [ ] **Step 6: 項目 4/7（窓なし → フォールバック）**: 全該当窓を閉じる（`(New-Object -ComObject Shell.Application).Windows()` から対象を `.Quit()`）→ `probe.ps1 app $d` → stderr が `None`、出力が名前昇順（b1, b2, b10）、エラーなし
- [ ] **Step 7: 実アプリのスモーク**: 窓を開き直しサイズ降順に設定 → `SPICA_PERF=1` で bench ビルド済み exe を起動（`Start-Process -FilePath src-tauri\target\release\spica-photo-viewer.exe -ArgumentList "$d\b1.jpg" -RedirectStandardError <log>` + 環境変数）→ ログに `"op":"explorer_sort"` / `"source":"explorer"` / `"key":"Size"` / `"descending":true` → アプリを終了
- [ ] **Step 8: 結果の記録**: 各項目の PASS/FAIL と、自動化できなかった項目（下記）を PR 本文の「手動確認チェックリスト」として整理:
  - 項目 3 後半（作成日時昇順 — ヘッダに列が無く UIA では追加が不安定な場合）
  - 項目 5 の実起動経路（関連付け起動時の foreground 退避タイミング）
  - 項目 6（バックグラウンドタブ — タブの生成が UI 操作のため）
  - 項目 7 の実 D&D 操作、項目 8（グループ化）、項目 9（管理者権限起動）
  - UIA スクリプトが環境で不安定だった場合は該当項目も手動へ回す（試行 2 回まで、粘らない）

---

### Task 6: §8 受け入れゲート（テスト・bench A/B・e2e・ビルド時間）

- [ ] **Step 1: 静的チェック**: worktree で `npm test`（TS 無変更でも実施）と `cd src-tauri && cargo test --lib` が全件 green。ビルドと並走させない（vitest の収集失敗が exit 0 で件数を減らす既知の罠）
- [ ] **Step 2: 環境静穏の確認**: `Get-Process find -ErrorAction SilentlyContinue` で孤立プロセスを確認・kill。`probe.ps1 list` で **e2e corpus フォルダ（`e2e/fixtures/corpus`）を表示する Explorer 窓が無い**ことを確認（開いていると bench の並びとソート検出が汚染される）。検証で開いた窓も全て閉じる
- [ ] **Step 3: ベース側計測**: `git checkout --detach <基点 commit>` → `npm run bench:build`（background、**所要時間を記録**）→ `npm run bench`（background、~4 分）
- [ ] **Step 4: ブランチ側計測**: `git checkout feat/explorer-sort-phase2-com-detection` → `npm run bench:build`（**所要時間を記録** — ベース側との差が features 追加の増分）→ `npm run bench`
- [ ] **Step 5: 判定**: TTFI_cold / NAV_warm / NAV_rapid / NAV_visible の**中央値**を A/B 比較。採用条件: 各指標で「ブランチ中央値 ≤ max(ベース中央値 × 1.10, ベース p95)」（非悪化。改善は不要）。NAV_rapid / NAV_visible / PLACEHOLDER 系の n が 84 に満たない run は無効として再実行。判定は中央値が主・p95 は参考（N=7 の p95 は最大値）。不成立なら原因を調査し、説明できるまで採用しない（必要なら該当コミットを revert）
- [ ] **Step 6: e2e**: `npm run test:e2e` を**2 回連続 green**（Step 4 の bench:build 後の exe で。1 回目のタイミング flake は既知 — その場合は 3 回目まで見て 2 連続 green を確認）
- [ ] **Step 7: `baseline.json` に触れていないことを確認**（`git status`）

---

### Task 7: push・PR 作成・CI green 確認

- [ ] **Step 1**: 最終 `git status` / `git log` 確認（package-lock.json の EOL 差分が混じっていないこと）
- [ ] **Step 2**: `git -c credential.helper="!gh auth git-credential" push https://github.com/hiz8/spica-photo-viewer.git feat/explorer-sort-phase2-com-detection`
- [ ] **Step 3**: `gh pr create --head feat/explorer-sort-phase2-com-detection --base main` — 本文に含める:
  - 目的と spec リンク（§10 Phase 2）
  - 実装サマリ（COM チェーン、300ms 残余タイムアウト、foreground HWND 優先、SPICA_PERF ログ）と裁定 D-P2-1〜7（特に spec §6.4 からの feature 逸脱 2 件）
  - §7.3 の検証結果（Task 5 の PASS 項目と証跡）と**残りの手動確認チェックリスト**
  - bench A/B 数値表（ベース/ブランチの中央値・p95、n）と判定
  - bench:build 所要時間の前後差（features 追加の増分）
  - 既知の制限: R2（複数窓の取り違え残余）/ R3（グループ化非対応）/ R4（種類=拡張子近似）/ R6（NoStrCmpLogical ポリシー）/ R7（隠しファイル）/ R12（第 2 ソート列無視）/ D-P2-7（MAX_PATH 超）
  - CI green ≠ Explorer 一致（§7.2）の注記
- [ ] **Step 4**: `gh pr checks <PR#> --watch` で CI 全 green を確認（落ちたら修正して push し直す）

## Self-Review 記録

- **Spec coverage**: §10 Phase 2 の 5 項目 → explorer_sort.rs 新規 = Task 1+2 / get_folder_images 並行問い合わせ = Task 3 / foreground HWND 退避 = Task 2 / 検証スクリプト = Task 4 / ログ = Task 2+3。§7.3 = Task 5、§8 = Task 6。持ち越し 2 件 = Task 3 Step 3
- **Placeholder scan**: Task 4 Step 1 の「シグネチャ微調整」注記は残余不確実性の明示（enum 引数型のみ。チェーン本体は検証済み）で、実装内容は全て具体コード
- **Type consistency**: `SortProbe::join -> (Option<SortSpec>, f64)` を Task 2 定義・Task 3 消費で一致。`normalize_path` は Task 1 で `pub(crate)`、Task 2 で `pub` に昇格（Task 4 が probe_api 経由で使用）
