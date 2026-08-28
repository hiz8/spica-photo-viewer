# Explorer ソート Phase 1: 自然順ソートとソート層の分離 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 画像の並び順を序数(バイト)比較から Explorer の「名前」順(自然順・大小文字無視)に一致させ、Phase 2(Explorer 連動)が使う `SortSpec` / `sort_images` の土台を作る。COM は一切触らない。

**Architecture:** 比較器(`utils/natural_sort.rs`、Windows は `StrCmpLogicalW` / 非 Windows は純 Rust 代替)と純粋関数 `sort_images`(`commands/file.rs`)の 2 層。`ImageInfo` に `created`(秒)と比較専用の全精度フィールド `modified_ns` / `created_ns`(`#[serde(skip)]`)を追加。フロントは型の追従と死にフィールド `folder.sortOrder` の削除のみで、振る舞いは変えない。

**Tech Stack:** Rust (Tauri v2, windows crate 0.62, serde), TypeScript (React, Zustand, Vitest), Biome

**Spec:** `docs/superpowers/specs/2026-08-28-explorer-folder-sort-order-design.md`(D1–D5 承認済み。本プランは §10 Phase 1)

## Global Constraints

- 全テスト green でなければコミットしない(CLAUDE.md)
- TS を変更したコミットの前に必ず `npm run lint:fix` と `npm run format:fix` を実行する(サブエージェント編集では biome hook が発火しないため手動必須)
- `windows` crate はバージョン `0.62` のまま。Phase 1 で追加する feature は **`Win32_UI_Shell` のみ**(spec §6.4)
- `modified_ns` / `created_ns` は**絶対にシリアライズしない**(`#[serde(skip)]`)。ns 値は JS の安全整数 2^53 を超える(spec D5)
- 非 Windows でも `cargo test --lib` がコンパイル・全件 green(spec I4。CI は ubuntu-latest)
- 並び順は決定的: 一次キー同値時は常に `natural_cmp(filename)` **昇順**(降順指定でも反転しない。spec I1)
- UI・設定は追加しない(spec D4)
- パフォーマンス関連変更のため、最後に `npm run bench:build && npm run bench` の非悪化ゲートを通す(spec §8。改善狙いではないので baseline.json は**更新しない**)
- コミットメッセージは Conventional Commits(英語)。セッション標準のトレーラ(Co-Authored-By 等)を付与する

## 前提・作業環境

- 実装は worktree で行う(**superpowers:using-git-worktrees** を使用)。基点は HEAD / ローカル main / origin/main を個別に比較し、**GitHub の main と一致するもの**を選ぶ(ローカル main が古いことがある)
- 設計ドキュメントと本プランが main に未マージの場合は、それらを含むブランチ(`docs/explorer-folder-sort-order-spec`)から分岐し、PR は docs PR のマージ後に作る
- worktree 初期化: `npm install` → `npm run bench:corpus` → `npm run bench:build`(この初回 bench:build の所要時間を**記録**する — Task 6 で feature 追加後と比較する。spec §8)
- `npm install` で `package-lock.json` に EOL 差分が出たら元に戻す
- 長時間コマンド(bench:build / bench / e2e)はバックグラウンド実行する
- ブランチ名: `feat/explorer-sort-phase1-natural-order`

## ファイル構成

| ファイル | 役割 |
|---|---|
| `src-tauri/src/utils/natural_sort.rs`(新規) | 自然順比較器。Windows: `StrCmpLogicalW` / 非 Windows: 純 Rust 代替 |
| `src-tauri/src/utils/mod.rs` | `pub mod natural_sort;` を追加 |
| `src-tauri/src/commands/file.rs` | `ImageInfo` 拡張、`SortKey` / `SortSpec` / `sort_images`、`get_folder_images` の置き換え、テスト追加 |
| `src-tauri/Cargo.toml` | `Win32_UI_Shell` feature 追加 |
| `src/types/index.ts` | `ImageInfo.created` 追加、`sortOrder` 削除 ×2 |
| `src/store/index.ts` | `sortOrder` 書き込み削除 ×2 |
| TS テスト fixture 7 ファイル | `created` 追加、`modified` を秒に統一、`sortOrder` 削除 |

参照のみ(変更しない): `src/store/index.ts:631` / `src/hooks/useFileDrop.ts:46`(`get_folder_images` 呼び出し側)、`src/components/ThumbnailBar.tsx` / `src/hooks/useImagePreloader.ts`(配列順の消費者)。E2E corpus はゼロ埋めファイル名(`img-000.jpg`)なので自然順導入で並びは変わらない(確認済み)。

---

### Task 1: 純 Rust の自然順比較器(非 Windows 代替)

**Files:**
- Create: `src-tauri/src/utils/natural_sort.rs`
- Modify: `src-tauri/src/utils/mod.rs`(現在は `image` / `perf` / `preview` の 3 行のみ)

**Interfaces:**
- Produces: `pub(crate) fn natural_cmp_fallback(a: &str, b: &str) -> std::cmp::Ordering` — Task 2 が `natural_cmp` の非 Windows 分岐として使う

契約(spec §6.1・§7.1): 数字列は数値として比較(ゼロ埋めは値で比較: `01` = `1` < `2`)、それ以外は大小文字無視、全体が同値なら大小区別の全文字列比較で決定的にする。

- [ ] **Step 1: モジュールを登録し、失敗するテストを書く**

`src-tauri/src/utils/mod.rs` に追加:

```rust
pub mod natural_sort;
```

`src-tauri/src/utils/natural_sort.rs` を作成(まずテストと関数シグネチャのみ。本体は `todo!()`):

```rust
use std::cmp::Ordering;

/// Non-Windows natural-order comparator. Exists so CI (ubuntu-latest) can
/// compile and run tests; it does NOT guarantee Explorer-identical order
/// (spec §6.1). Digit runs compare numerically, everything else
/// case-insensitively; equal strings fall back to a case-sensitive compare
/// so the result is deterministic.
#[cfg_attr(windows, allow(dead_code))]
pub(crate) fn natural_cmp_fallback(a: &str, b: &str) -> Ordering {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shared contract: must hold for BOTH the fallback and (from Task 2)
    // the platform comparator. Spec §7.1.
    fn assert_natural_contract(cmp: fn(&str, &str) -> Ordering) {
        // digit runs compare as numbers
        assert_eq!(cmp("img2.jpg", "img10.jpg"), Ordering::Less);
        assert_eq!(cmp("img10.jpg", "img2.jpg"), Ordering::Greater);
        // zero padding compares by numeric value
        assert_eq!(cmp("01.jpg", "2.jpg"), Ordering::Less);
        // case-insensitive: the digits decide, not the case
        assert_eq!(cmp("IMG_1.jpg", "img_2.jpg"), Ordering::Less);
        // digits after non-ASCII text still compare numerically
        assert_eq!(cmp("写真2.jpg", "写真10.jpg"), Ordering::Less);
        // identical strings
        assert_eq!(cmp("image.jpg", "image.jpg"), Ordering::Equal);
        // prefix orders before longer string
        assert_eq!(cmp("img.jpg", "img1.jpg"), Ordering::Less);
    }

    #[test]
    fn fallback_meets_natural_contract() {
        assert_natural_contract(natural_cmp_fallback);
    }

    #[test]
    fn fallback_is_deterministic_for_japanese_names() {
        let mut v = vec!["写真10.jpg", "スクショ.png", "写真2.jpg", "img1.jpg"];
        v.sort_by(|a, b| natural_cmp_fallback(a, b));
        let first = v.clone();
        v.sort_by(|a, b| natural_cmp_fallback(a, b));
        assert_eq!(v, first);
    }

    #[test]
    fn fallback_breaks_case_tie_deterministically() {
        // Case-insensitively equal names must still order deterministically
        // (I1: stable navigation / preload window).
        let ab = natural_cmp_fallback("IMG_1.jpg", "img_1.jpg");
        let ba = natural_cmp_fallback("img_1.jpg", "IMG_1.jpg");
        assert_ne!(ab, Ordering::Equal);
        assert_eq!(ab, ba.reverse());
    }
}
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd src-tauri && cargo test --lib natural_sort`
Expected: FAIL(`todo!()` による panic)

- [ ] **Step 3: 本体を実装**

`todo!()` を置き換え:

```rust
    let av: Vec<char> = a.chars().collect();
    let bv: Vec<char> = b.chars().collect();
    let (mut i, mut j) = (0usize, 0usize);
    while i < av.len() && j < bv.len() {
        if av[i].is_ascii_digit() && bv[j].is_ascii_digit() {
            let si = i;
            while i < av.len() && av[i].is_ascii_digit() {
                i += 1;
            }
            let sj = j;
            while j < bv.len() && bv[j].is_ascii_digit() {
                j += 1;
            }
            let da: String = av[si..i].iter().collect();
            let db: String = bv[sj..j].iter().collect();
            // Compare numerically without parsing (digit runs can exceed u64):
            // strip leading zeros, then longer run is larger, then lexicographic.
            let ta = da.trim_start_matches('0');
            let tb = db.trim_start_matches('0');
            let ord = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
            if ord != Ordering::Equal {
                return ord;
            }
        } else {
            let ord = av[i].to_lowercase().cmp(bv[j].to_lowercase());
            if ord != Ordering::Equal {
                return ord;
            }
            i += 1;
            j += 1;
        }
    }
    (av.len() - i)
        .cmp(&(bv.len() - j))
        .then_with(|| a.cmp(b))
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd src-tauri && cargo test --lib natural_sort`
Expected: PASS(3 テスト)。既存テストも巻き添えで壊れていないこと: `cargo test --lib` 全件 green

- [ ] **Step 5: コミット**

```bash
git add src-tauri/src/utils/natural_sort.rs src-tauri/src/utils/mod.rs
git commit -m "feat(sort): add pure-Rust natural filename comparator"
```

---

### Task 2: Windows `StrCmpLogicalW` 経路と feature 追加

**Files:**
- Modify: `src-tauri/src/utils/natural_sort.rs`
- Modify: `src-tauri/Cargo.toml`(46 行目: `windows = { version = "0.62", features = ["Win32_Storage_FileSystem", "Win32_Foundation"] }`)

**Interfaces:**
- Consumes: Task 1 の `natural_cmp_fallback`
- Produces: `pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering` — Task 4 の `sort_images` が使う公開 API(spec §6.1)

- [ ] **Step 1: 失敗するテストを書く**

`natural_sort.rs` の `tests` モジュールに追加:

```rust
    #[test]
    fn platform_natural_cmp_meets_natural_contract() {
        assert_natural_contract(natural_cmp);
    }
```

- [ ] **Step 2: テストが失敗する(コンパイルエラーになる)ことを確認**

Run: `cd src-tauri && cargo test --lib natural_sort`
Expected: FAIL — `natural_cmp` が未定義のコンパイルエラー

- [ ] **Step 3: Cargo feature と実装を追加**

`src-tauri/Cargo.toml` の windows 依存を変更(spec §6.4。`Win32_UI_Shell` のみ追加):

```toml
windows = { version = "0.62", features = ["Win32_Storage_FileSystem", "Win32_Foundation", "Win32_UI_Shell"] }
```

`natural_sort.rs` の先頭(`natural_cmp_fallback` の前)に追加:

```rust
/// Compares filenames in the same order as Explorer's "Name" column.
#[cfg(windows)]
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::StrCmpLogicalW;

    let aw: Vec<u16> = a.encode_utf16().chain(std::iter::once(0)).collect();
    let bw: Vec<u16> = b.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: both buffers are NUL-terminated and live across the call.
    let r = unsafe { StrCmpLogicalW(PCWSTR(aw.as_ptr()), PCWSTR(bw.as_ptr())) };
    r.cmp(&0)
}

/// Compares filenames in the same order as Explorer's "Name" column.
/// Non-Windows builds use the pure-Rust approximation (spec §6.1).
#[cfg(not(windows))]
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    natural_cmp_fallback(a, b)
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd src-tauri && cargo test --lib natural_sort`
Expected: PASS(4 テスト)。この開発機は Windows なので `StrCmpLogicalW` 経路が契約テストで実際に検証される(spec §7.1 の Windows 限定テストに相当)

- [ ] **Step 5: コミット**

```bash
git add src-tauri/src/utils/natural_sort.rs src-tauri/Cargo.toml
git commit -m "feat(sort): route natural_cmp through StrCmpLogicalW on Windows"
```

---

### Task 3: `ImageInfo` の `created` と全精度タイムスタンプ

**Files:**
- Modify: `src-tauri/src/commands/file.rs` — `ImageInfo`(14–20 行)、`get_image_info`(290 行〜)、`mod tests` にテスト追加

**Interfaces:**
- Produces: `ImageInfo` の新フィールド `created: u64`(UNIX 秒・シリアライズされる)、`modified_ns: u64` / `created_ns: u64`(UNIX ns・`#[serde(skip)]`)— Task 4 の `sort_images` と Task 5 の TS 型が依存

- [ ] **Step 1: 失敗するテストを書く**

`file.rs` の `mod tests` に追加(`create_test_jpeg` 等の既存ヘルパーを使う):

```rust
    #[tokio::test]
    async fn test_image_info_timestamps_full_precision() {
        let temp_dir = create_temp_dir();
        create_test_jpeg(temp_dir.path(), "ts.jpg");

        let images = get_folder_images(temp_dir.path().to_string_lossy().to_string())
            .await
            .unwrap();
        let info = &images[0];

        // seconds fields are the ns fields truncated (D5)
        assert_eq!(info.modified, info.modified_ns / 1_000_000_000);
        assert_eq!(info.created, info.created_ns / 1_000_000_000);
        // a freshly created file has non-zero timestamps
        assert!(info.modified_ns > 0);
        assert!(info.created_ns > 0);
    }
```

- [ ] **Step 2: テストが失敗する(コンパイルエラーになる)ことを確認**

Run: `cd src-tauri && cargo test --lib test_image_info_timestamps`
Expected: FAIL — `modified_ns` 等が未定義のコンパイルエラー

- [ ] **Step 3: `ImageInfo` と `get_image_info` を実装**

`ImageInfo`(14–20 行)を置き換え:

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ImageInfo {
    pub path: String,
    pub filename: String,
    pub size: u64,
    pub modified: u64,
    /// UNIX seconds; falls back to `modified` where the platform/filesystem
    /// has no creation time (e.g. Linux). Spec §6.5.
    pub created: u64,
    pub format: String,
    /// Sort-only full-precision timestamps (spec D5). Never serialized:
    /// ns since epoch exceeds JavaScript's safe-integer range (2^53).
    #[serde(skip)]
    pub modified_ns: u64,
    #[serde(skip)]
    pub created_ns: u64,
}
```

`get_image_info` の `modified` 算出部(306–311 行)を置き換え、`Ok(ImageInfo { ... })` にフィールドを追加:

```rust
    let modified_dur = metadata
        .modified()
        .map_err(|e| format!("Failed to get modification time: {}", e))?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("Failed to convert time: {}", e))?;
    let modified = modified_dur.as_secs();

    let created_dur = metadata
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .unwrap_or(modified_dur);
```

```rust
    Ok(ImageInfo {
        path: path.to_string_lossy().to_string(),
        filename,
        size: metadata.len(),
        modified,
        created: created_dur.as_secs(),
        format,
        modified_ns: modified_dur.as_nanos() as u64,
        created_ns: created_dur.as_nanos() as u64,
    })
```

注意: `metadata.created()` の失敗は `?` で伝播させず `modified` で代替する(Linux で取れないことがあり、CI が落ちる。spec §6.5)。

- [ ] **Step 4: テストが通ることを確認**

Run: `cd src-tauri && cargo test --lib`
Expected: 全件 PASS(新テスト含む。`ImageInfo` を構築するのは `get_image_info` のみ(確認済み)なので他は壊れない)

- [ ] **Step 5: コミット**

```bash
git add src-tauri/src/commands/file.rs
git commit -m "feat(sort): add created and sort-only full-precision timestamps to ImageInfo"
```

---

### Task 4: `SortKey` / `SortSpec` / `sort_images` と並び順の置き換え

**Files:**
- Modify: `src-tauri/src/commands/file.rs` — `ImageInfo` 定義の直後に型と関数を追加、`get_folder_images` 内の `images.sort_by(|a, b| a.filename.cmp(&b.filename));`(59 行)を置き換え、`mod tests` にテスト追加

**Interfaces:**
- Consumes: Task 2 の `natural_cmp(&str, &str) -> Ordering`、Task 3 の `modified_ns` / `created_ns`
- Produces: `pub enum SortKey { Name, Size, Modified, Created, Type }`、`pub struct SortSpec { pub key: SortKey, pub descending: bool }`(`Default` = Name 昇順)、`pub fn sort_images(images: &mut [ImageInfo], spec: SortSpec)` — Phase 2 の `detect_sort_spec` がこの型に写像する(spec §6.2)

- [ ] **Step 1: 失敗するテストを書く**

`file.rs` の `mod tests` に追加:

```rust
    /// Builds an ImageInfo for sort tests. Seconds fields derive from the ns
    /// fields the same way get_image_info does.
    fn sort_info(filename: &str, size: u64, modified_ns: u64, created_ns: u64, format: &str) -> ImageInfo {
        ImageInfo {
            path: format!("/t/{filename}"),
            filename: filename.to_string(),
            size,
            modified: modified_ns / 1_000_000_000,
            created: created_ns / 1_000_000_000,
            format: format.to_string(),
            modified_ns,
            created_ns,
        }
    }

    fn names(images: &[ImageInfo]) -> Vec<&str> {
        images.iter().map(|i| i.filename.as_str()).collect()
    }

    #[test]
    fn test_sort_images_name_natural_order() {
        let mut v = vec![
            sort_info("img10.jpg", 1, 1, 1, "jpeg"),
            sort_info("img2.jpg", 1, 1, 1, "jpeg"),
            sort_info("IMG_1.jpg", 1, 1, 1, "jpeg"),
        ];
        sort_images(&mut v, SortSpec::default());
        assert_eq!(names(&v), ["IMG_1.jpg", "img2.jpg", "img10.jpg"]);

        sort_images(&mut v, SortSpec { key: SortKey::Name, descending: true });
        assert_eq!(names(&v), ["img10.jpg", "img2.jpg", "IMG_1.jpg"]);
    }

    #[test]
    fn test_sort_images_size_with_name_tiebreak() {
        let mut v = vec![
            sort_info("b.jpg", 200, 1, 1, "jpeg"),
            sort_info("c.jpg", 100, 1, 1, "jpeg"),
            sort_info("a.jpg", 100, 1, 1, "jpeg"),
        ];
        sort_images(&mut v, SortSpec { key: SortKey::Size, descending: false });
        assert_eq!(names(&v), ["a.jpg", "c.jpg", "b.jpg"]);

        // Descending flips the primary key only; the tie between a/c stays
        // name-ASCENDING (I1).
        sort_images(&mut v, SortSpec { key: SortKey::Size, descending: true });
        assert_eq!(names(&v), ["b.jpg", "a.jpg", "c.jpg"]);
    }

    #[test]
    fn test_sort_images_modified_uses_ns_precision() {
        // Same second, different ns. Name order is the REVERSE of ns order,
        // so a seconds-truncated compare would fall to the name tiebreak and
        // produce the wrong result (D5 regression test).
        let base = 1_700_000_000_000_000_000u64;
        let mut v = vec![
            sort_info("a.jpg", 1, base + 500_000_000, 1, "jpeg"),
            sort_info("b.jpg", 1, base + 100_000_000, 1, "jpeg"),
        ];
        sort_images(&mut v, SortSpec { key: SortKey::Modified, descending: false });
        assert_eq!(names(&v), ["b.jpg", "a.jpg"]);
    }

    #[test]
    fn test_sort_images_created_uses_ns_precision() {
        let base = 1_700_000_000_000_000_000u64;
        let mut v = vec![
            sort_info("a.jpg", 1, 1, base + 500_000_000, "jpeg"),
            sort_info("b.jpg", 1, 1, base + 100_000_000, "jpeg"),
        ];
        sort_images(&mut v, SortSpec { key: SortKey::Created, descending: false });
        assert_eq!(names(&v), ["b.jpg", "a.jpg"]);
    }

    #[test]
    fn test_sort_images_type_then_name() {
        let mut v = vec![
            sort_info("b.png", 1, 1, 1, "png"),
            sort_info("a.jpg", 1, 1, 1, "jpeg"),
            sort_info("c.gif", 1, 1, 1, "gif"),
        ];
        sort_images(&mut v, SortSpec { key: SortKey::Type, descending: false });
        assert_eq!(names(&v), ["c.gif", "a.jpg", "b.png"]);
    }

    #[test]
    fn test_sort_images_empty_and_single() {
        let mut empty: Vec<ImageInfo> = vec![];
        sort_images(&mut empty, SortSpec::default());
        assert!(empty.is_empty());

        let mut one = vec![sort_info("a.jpg", 1, 1, 1, "jpeg")];
        sort_images(&mut one, SortSpec { key: SortKey::Modified, descending: true });
        assert_eq!(names(&one), ["a.jpg"]);
    }
```

- [ ] **Step 2: テストが失敗する(コンパイルエラーになる)ことを確認**

Run: `cd src-tauri && cargo test --lib test_sort_images`
Expected: FAIL — `SortKey` / `SortSpec` / `sort_images` が未定義のコンパイルエラー

- [ ] **Step 3: 型と関数を実装し、`get_folder_images` を置き換える**

`file.rs` の import に追加:

```rust
use crate::utils::natural_sort::natural_cmp;
```

`ImageInfo` 定義の直後に追加(spec §6.2):

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortKey {
    Name,
    Size,
    Modified,
    Created,
    Type,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SortSpec {
    pub key: SortKey,
    pub descending: bool,
}

impl Default for SortSpec {
    fn default() -> Self {
        Self {
            key: SortKey::Name,
            descending: false,
        }
    }
}

/// Sorts images the way Explorer displays them for the given sort setting.
/// Pure function: no COM, unit-testable (spec §5). Ties on the primary key
/// always break by natural name order ASCENDING regardless of `descending`,
/// so the order is deterministic (I1).
pub fn sort_images(images: &mut [ImageInfo], spec: SortSpec) {
    images.sort_by(|a, b| {
        let primary = match spec.key {
            SortKey::Name => natural_cmp(&a.filename, &b.filename),
            SortKey::Size => a.size.cmp(&b.size),
            SortKey::Modified => a.modified_ns.cmp(&b.modified_ns),
            SortKey::Created => a.created_ns.cmp(&b.created_ns),
            SortKey::Type => natural_cmp(&a.format, &b.format),
        };
        let primary = if spec.descending {
            primary.reverse()
        } else {
            primary
        };
        primary.then_with(|| natural_cmp(&a.filename, &b.filename))
    });
}
```

`get_folder_images` 内の `images.sort_by(|a, b| a.filename.cmp(&b.filename));` を置き換え:

```rust
    sort_images(&mut images, SortSpec::default());
```

- [ ] **Step 4: 全テストが通ることを確認**

Run: `cd src-tauri && cargo test --lib`
Expected: 全件 PASS。既存 `test_get_folder_images_with_valid_folder` は `image1/2/3` が自然順でも同順なのでそのまま green(spec §7.1)

- [ ] **Step 5: コミット**

```bash
git add src-tauri/src/commands/file.rs
git commit -m "feat(sort): sort folder images via SortSpec with natural name order default"
```

---

### Task 5: フロント型の追従と `folder.sortOrder` の削除

**Files:**
- Modify: `src/types/index.ts` — `ImageInfo`(1–7 行)に `created` 追加、`folder`(63 行)と `FolderState`(110 行)から `sortOrder` 削除
- Modify: `src/store/index.ts` — 123 行と 190 行の `sortOrder: "name",` を削除
- Modify(fixture 7 ファイル): `src/utils/testFactories.ts`、`src/utils/testUtils.tsx`、`src/components/__tests__/ImageViewer.test.tsx`、`src/store/__tests__/index.test.ts`、`src/components/__tests__/ThumbnailBar.test.tsx`、`src/hooks/__tests__/useImagePreloader.test.ts`、`src/hooks/__tests__/useThumbnailGenerator.test.ts`

**Interfaces:**
- Consumes: Task 3 が Rust 側で追加した `created`(UNIX 秒)
- Produces: TS `ImageInfo` に `created: number`。`sortOrder` は型・store・fixture から全て消える

方針(spec §6.5): `created` は必須フィールドとして追加(Rust 側は必ず値を返す)。fixture の `modified` は `Date.now()`(ms)から**秒**に統一し(Rust の実値と単位を揃える)、`created` は `modified` と同値を入れる。`modified_ns` / `created_ns` は TS に**追加しない**。

- [ ] **Step 1: 型を変更し、型エラーで壊れる箇所を確認する**

`src/types/index.ts` の `ImageInfo` に `modified` の次の行として追加:

```typescript
  created: number;
```

同ファイルの `folder:` ブロック(63 行)と `FolderState`(110 行)から `sortOrder: "name" | "date";` の行を削除。

Run: `npm run type-check`
Expected: FAIL — store と fixture の `sortOrder` 参照、および `ImageInfo` リテラルの `created` 欠落がエラーになる(壊れる箇所の全数把握)

- [ ] **Step 2: store と fixture を追従させる**

`src/store/index.ts`: 123 行(初期値)と 190 行(`setFolderImages`)の `sortOrder: "name",` を削除。

`src/utils/testFactories.ts`:

```typescript
export const createImageInfo = (
  overrides: Partial<ImageInfo> = {},
): ImageInfo => {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    path: "/test/image.jpg",
    filename: "image.jpg",
    size: 1024,
    modified: nowSec,
    created: nowSec,
    format: "jpeg",
    ...overrides,
  };
};
```

`createImageList` の override を秒に変更:

```typescript
      modified: Math.floor(Date.now() / 1000) - (count - index),
```

`createMockAppState`(75 行)と `createEmptyViewerState`(108 行)の `sortOrder: "name" as const,` を削除。

`src/utils/testUtils.tsx`: `mockImageInfo` と `mockImageList` の各リテラルで `modified` を秒に変更し(`Math.floor(Date.now() / 1000)`、`- 3000` などのオフセットは `- 3` 等の秒に)、各リテラルに `created:`(`modified` と同値)を追加。`createMockStore`(86 行)の `sortOrder: "name" as const,` を削除。例(`mockImageList` の 1 件目):

```typescript
  {
    path: "/test/image1.jpg",
    filename: "image1.jpg",
    size: 1024,
    modified: Math.floor(Date.now() / 1000) - 3,
    created: Math.floor(Date.now() / 1000) - 3,
    format: "jpeg",
  },
```

`src/components/__tests__/ImageViewer.test.tsx`(85 行): `sortOrder: "name" as const,` を削除。

`src/store/__tests__/index.test.ts`: 41 行の `sortOrder: "name",` を削除し、81 行の `expect(state.folder.sortOrder).toBe("name");` を削除。

`src/components/__tests__/ThumbnailBar.test.tsx`(25 行)と `src/hooks/__tests__/useThumbnailGenerator.test.ts`(19 行)の inline factory:

```typescript
  modified: Math.floor(Date.now() / 1000) - index,
  created: Math.floor(Date.now() / 1000) - index,
```

`src/hooks/__tests__/useImagePreloader.test.ts`(24 行):

```typescript
  modified: 1700000000 - i,
  created: 1700000000 - i,
```

- [ ] **Step 3: 検証**

Run: `npm run type-check && npm test`
Expected: 両方 green

Run: `grep -rn "sortOrder" src/`
Expected: 0 件

- [ ] **Step 4: lint / format(hook 非発火のため手動)**

Run: `npm run lint:fix && npm run format:fix`
Expected: エラーなし。差分が出たら内容を確認して含める

- [ ] **Step 5: コミット**

```bash
git add src/types/index.ts src/store/index.ts src/utils/testFactories.ts src/utils/testUtils.tsx src/components/__tests__/ImageViewer.test.tsx src/store/__tests__/index.test.ts src/components/__tests__/ThumbnailBar.test.tsx src/hooks/__tests__/useImagePreloader.test.ts src/hooks/__tests__/useThumbnailGenerator.test.ts
git commit -m "refactor(front): add ImageInfo.created, drop dead folder.sortOrder"
```

---

### Task 6: 受け入れゲート(spec §8)と PR

**Files:** 変更なし(計測と検証のみ。E2E 期待値の更新が必要になった場合のみ該当 fixture を修正)

**Interfaces:**
- Consumes: Task 1–5 の全成果

- [ ] **Step 1: 単体テスト全件**

Run: `cd src-tauri && cargo test --lib` および `npm test` / `npm run type-check`
Expected: 全件 green

- [ ] **Step 2: bench:build と build 時間の記録**

Run(バックグラウンド・時間計測付き): `npm run bench:build`
Expected: 成功。**所要時間を記録**し、worktree 初期化時(feature 追加前)の bench:build 時間と比較して `Win32_UI_Shell` 追加による増分を PR 本文に書く(spec §8。参考: 最終クレートの LLVM 最適化がビルド時間を支配しており、大幅増なら feature 絞り込みを検討 = spec R9)

- [ ] **Step 3: bench 非悪化ゲート**

Run(バックグラウンド): `npm run bench`
Expected: `bench-results/baseline.json` と比較して **TTFI_cold / NAV_warm / NAV_rapid / NAV_visible の中央値が p95 の揺れを超えて悪化していない**こと。各指標の `n` が `runs` を満たしていること(NAV_rapid / PLACEHOLDER_dur は n=84)。ベンチ中は他の重負荷アプリを起動しない。
**baseline.json は更新しない**(非悪化ゲートのみ。`bench:baseline` は実行しない)

- [ ] **Step 4: E2E(視覚ゲート含む)**

Run(バックグラウンド): `npm run test:e2e`
Expected: green。**bench:build 直後の初回 run は timing flake の実績がある**ため、失敗したらもう 1 回実行し、**2 回連続 green** で判定する。corpus はゼロ埋めファイル名なので並び順起因の失敗は原理的に出ないはずだが、もし期待値ズレが出たら fixture を更新して `test: update e2e fixtures for natural sort order` でコミット(spec §7.4 / R11)

- [ ] **Step 5: 計測結果の記録とプランのチェックボックス更新をコミット**

bench の対象指標(中央値 / p95)と build 時間の前後差を本プランの末尾か PR 本文に記録する。

- [ ] **Step 6: PR 作成**

**superpowers:finishing-a-development-branch** を使用。push は SSH 不可のため gh credential helper 経由、`gh pr create` は `--head <branch>` を必ず付ける。PR 本文に含める:
- 目的(spec §0 の既存ズレ解消、Phase 2 の土台)と spec へのリンク
- bench 非悪化の数値(4 指標の中央値、baseline 比)
- bench:build 時間の前後(feature 追加の増分)
- 既知の制限: 非 Windows 比較器は Explorer 一致を保証しない(CI green ≠ Explorer 一致。spec §7.2)

---

## Self-Review(実施済み)

- **Spec 網羅**: §10 Phase 1 の 6 項目(natural_sort / SortSpec・sort_images・置き換え / created + ns フィールド / fixture 単位統一 / sortOrder 削除 / Win32_UI_Shell)= Task 1–5。受け入れ(§7.1 ユニットテスト、§8 非悪化ゲート)= 各 Task の Step + Task 6。§7.1 の全テストケース(数値比較・ゼロ埋め・大小無視・日本語・同一文字列・5 キー×昇降・タイブレーク・ns 精度・空/1 件・既存テスト green)に対応するテストコードを配置済み
- **Placeholder**: なし(全ステップに実コード・実コマンド・期待結果を記載)
- **型整合**: `natural_cmp(&str, &str) -> Ordering`(T2→T4)、`ImageInfo` フィールド名 `modified_ns` / `created_ns`(T3→T4→T5 で TS に出さない判断まで一貫)、`SortSpec::default()` = Name 昇順(T4、spec §5)を確認
