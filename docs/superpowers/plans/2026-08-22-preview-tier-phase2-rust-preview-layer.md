# プレビュー層 Phase 2 — Rust プレビュー層（結合生成 / ディスクキャッシュ / 配信ルート）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** サムネイル生成の 1 回のデコードから、EXIF 向き適用・ICC 引き継ぎ済みの**表示解像度プレビュー JPEG** を生成してディスクにキャッシュし（不変条件 I1: サムネイルがある ⇒ 同じ画面ボックスのプレビューがディスクにある）、`spica-img://…/preview/<box>/<path>` で配信できるようにする。**表示経路（ImageViewer / store / プリローダー）は一切変更しない** — プレビューを表示に使うのは Phase 3。

**Architecture:** (1) `src-tauri/src/utils/preview.rs`（純関数: decode+orientation+ICC → 黒合成 RGB8 → `fast_image_resize` Lanczos3 で画面ボックスに収める → JPEG q85（ICC 付き）→ そのプレビューから 20px サムネ）、(2) `commands/cache.rs` をディレクトリ注入型の純関数群に再構成（サムネ JSON に `preview_box` / `source_mtime` / `source_size`、プレビュー `{hash}_p.jpg` + サイドカー `{hash}_p.json`、一時ファイル + rename の原子的書き込み、24h + 合計 2GB 上限の掃除）、(3) `commands/file.rs` の `generate_thumbnail_with_dimensions` を `spawn_blocking` + 結合生成に、(4) `protocol.rs`/`lib.rs` に `/preview/<W>x<H>/` ルート（キャッシュ命中なら配信、欠落なら生成して配信、`X-Spica-Natural-Width/Height` ヘッダ）、(5) フロントは `useThumbnailGenerator` が `previewBox` を渡し成功時の書き戻しを止めるだけ。SPICA_PERF op `thumbnail`（着手前の現状値 T0）→ `thumb_preview`（変更後 T1）で生成コストの回帰を判定（T1 ≤ 1.3 × T0）。

**Tech Stack:** Rust（`image` 0.25.10 既存: `ImageDecoder::orientation/icc_profile`, `DynamicImage::from_decoder/apply_orientation/thumbnail`, `JpegEncoder::new_with_quality/set_icc_profile`）+ 新規依存 `fast_image_resize = { version = "6.1", features = ["image"] }`（純 Rust・SIMD、`DynamicImage` を直接 `Resizer::resize` に渡せる）。Tauri v2 `register_asynchronous_uri_scheme_protocol` / `tauri::async_runtime::spawn_blocking`。フロント TypeScript + vitest。E2E: WebdriverIO。

**Spec:** `docs/superpowers/specs/2026-08-21-thumbnail-implies-cached-preview-tier-design.md` §5（I1）, §6.1–6.3, §6.7, §8 R1/R2/R5/R6/R7, §9 Phase 2。ユーザー決定 D2（画面ボックス {1920×1080, 2560×1440, 3840×2160}）/ D3（ディスク上限 2GB）。運用ゲートは `CLAUDE.md`「Performance changes」。baseline は `bench-results/baseline.json`（gitSha 52650ab、Phase 1）。

## Global Constraints

- **表示経路の変更禁止**: `src/components/ImageViewer.tsx`, `src/store/index.ts`, `src/hooks/useImagePreloader.ts`, `src/utils/bitmapCache.ts`, `bitmapLoader.ts`, `protocolLoader.ts` は 1 行も変更しない。フロントの変更は `src/hooks/useThumbnailGenerator.ts`（コマンド引数と書き戻し）、`src/utils/previewBox.ts`（新規・純関数）、`src/constants/memory.ts`（ボックス定数）、`src/types/index.ts`（`preview_available`）とそのテストに限る
- **サムネイルの契約を変えない**: 20px（`THUMBNAIL_SIZE`）、`data:image/jpeg;base64` で表示、`original_width/height` は**向き適用後**の原寸（EXIF 回転画像では Phase 1 までの raw 寸法と異なる — 既存不整合の修正であり spec §1-2 で承認済み）、エラーマーカー `"error"` の `set_cached_thumbnail` 経路は維持
- **Rust のテストは実 `%APPDATA%` キャッシュに書かない**: キャッシュ関数はすべて `cache_dir: &Path` を受け取り、テストは `tempfile::tempdir()` を使う（既存の `test_set_cached_thumbnail_returns_ok` 等の実ディレクトリ書き込みテストは、ディレクトリ注入版のテストに置き換える）
- `spica-img` の既存ルート（原本配信）は無変更。新ルートは `/preview/<W>x<H>/<encodeURIComponent(path)>` のみ。ボックスは allowlist {1920×1080, 2560×1440, 3840×2160}（縦横入替も可）以外は 404
- 原子的書き込み: 一時ファイル（同一ディレクトリ）に書いてから `fs::rename`（Windows では `std::fs::rename` が上書きする）。書きかけのファイルが読まれる経路を作らない
- 透過（PNG/WebP の alpha）は**黒で合成**してから JPEG 化。GIF はプレビュー対象外（サムネイルのみ、`preview_available: false`）
- 計測ゲート: `npm run profile:rust`（キャッシュ削除後）の op `thumb_preview` 中央値 T1 が着手前の op `thumbnail` 中央値 T0 の **1.3 倍以内**。`npm run bench` で TTFI_cold / NAV_warm / NAV_rapid / NAV_visible の中央値が baseline（52650ab）の p95 を超えて悪化しない（表示経路無変更なので NAV 系は不変のはず）。いずれも N 完全
- `cargo test --lib` / `npm test` / `npm run type-check` / `npx tsc -p e2e/tsconfig.json --noEmit` / `npm run test:e2e`（新規 preview spec 含む）green。`cargo clippy` は既存方針どおり必須ではないが、警告を増やさない
- **サブエージェント編集では biome hook が発火しない**: 変更した TS/JS ファイルに `npx biome format --write <paths>` と `npx biome lint <paths>`。Rust は `cargo fmt --manifest-path src-tauri/Cargo.toml`（`rustfmt` 既定）をコミット前に実行
- ブランチ: `worktree-preview-tier-phase2-rust`（Phase 1 ブランチ `worktree-preview-tier-phase1-measurement` に stack。PR の base は Phase 1 ブランチ）。コミットは Conventional Commits、末尾に `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- `cd` を使わない（worktree ガード）: `cargo <cmd> --manifest-path src-tauri/Cargo.toml` 形式で実行する

## ファイル構成

| ファイル | 責務 |
|---|---|
| Modify: `src-tauri/Cargo.toml` | `fast_image_resize` 追加 |
| Modify: `src-tauri/src/utils/mod.rs` / Create: `src-tauri/src/utils/preview.rs` | `PreviewBox`（parse/allowlist/key）、`fit_within`、`decode_oriented`、`flatten_to_rgb8`、`resize_rgb8`、`encode_jpeg`、`generate`（Generated）— 純関数と単体テスト |
| Modify: `src-tauri/src/test_utils.rs` | サイズ指定の JPEG/PNG(RGBA) フィクスチャ、EXIF orientation 付き JPEG、ICC 付き JPEG |
| Modify: `src-tauri/src/commands/cache.rs` | ディレクトリ注入型に再構成: `CacheEntry` 拡張、`preview_file`/`preview_sidecar`、`source_stamp`、`write_atomic`、`lookup_thumbnail`、`store_thumbnail_entry`、`store_preview`、`load_preview`、`sweep`、コマンドは薄いラッパ。`get_cache_dir` を `pub(crate)` に |
| Modify: `src-tauri/src/commands/file.rs` | `generate_thumbnail_with_dimensions(path, size, preview_box)` を `spawn_blocking` + 結合生成に。`generate_image_thumbnail` 削除 |
| Modify: `src-tauri/src/protocol.rs` / `src-tauri/src/lib.rs` | `resolve_preview_request`、`ensure_preview`、`/preview/` ルートとヘッダ、op `serve_preview` |
| Create: `src/utils/previewBox.ts` + test / Modify: `src/constants/memory.ts` | `PREVIEW_BOXES`、`previewBoxForScreen`、`currentPreviewBox` |
| Modify: `src/hooks/useThumbnailGenerator.ts` + test / `src/types/index.ts` | `previewBox` 引数、`preview_available`、成功時書き戻し廃止 |
| Create: `e2e/specs/preview.e2e.ts` / Modify: `package.json`（`test:e2e`） | プレビュー配信の E2E（寸法・ヘッダ・EXIF 向き） |
| Modify: `docs/PERFORMANCE_AUTONOMY_PLAN.md` §2、spec §9 | Rust op の定義、Phase 2 の進捗 |

---

### Task 1: 現状のサムネイル生成コストを計測できるようにする（op `thumbnail`）+ T0 記録

**Files:**
- Modify: `src-tauri/src/commands/file.rs`（`generate_thumbnail_with_dimensions`）

**Interfaces:**
- Produces: `SPICA_PERF=1` で `{"perf":"rust","op":"thumbnail","path":...,"ms":...}` が 1 画像につき 1 行（コマンド全体の所要）。Task 9 が T1 と比較する T0 の出所

- [ ] **Step 1: PerfTimer を追加**

```rust
#[tauri::command]
pub async fn generate_thumbnail_with_dimensions(
    path: String,
    size: u32,
) -> Result<ThumbnailWithDimensions, String> {
    let _t = crate::utils::perf::PerfTimer::start("thumbnail", &path);
    let image_path = Path::new(&path);
    // （以下既存のまま）
```

- [ ] **Step 2: ビルドとテスト**

Run: `cargo test --lib --manifest-path src-tauri/Cargo.toml` → 62 passed
Run: `cargo fmt --manifest-path src-tauri/Cargo.toml`

- [ ] **Step 3: コミット**

```bash
git add src-tauri/src/commands/file.rs
git commit -m "perf(rust): time thumbnail generation under SPICA_PERF (op thumbnail)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: T0 の記録（メインセッションで実行。CPU を使う作業と重ねない）**

```powershell
npm run bench:build
Remove-Item -Recurse -Force "$env:APPDATA\SpicaPhotoViewer\cache" -ErrorAction SilentlyContinue
npm run profile:rust
```

Expected: `thumbnail n=16 median=<T0>ms`（large コーパス 16 枚、20MP）。T0 を ledger と Task 9 の判定表に記録する。2 回実行して中央値が ±10% で一致することを確認（一致しなければ 3 回目を取り中央値を使う）。

---

### Task 2: `preview.rs` — 生成の純関数群（TDD）

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/utils/mod.rs`（`pub mod preview;`）
- Create: `src-tauri/src/utils/preview.rs`
- Modify: `src-tauri/src/test_utils.rs`

**Interfaces:**
- Produces（Task 4/5 が使用）:
  - `pub struct PreviewBox { pub width: u32, pub height: u32 }`、`PreviewBox::parse(&str) -> Option<PreviewBox>`（"WxH"、allowlist {1920×1080, 2560×1440, 3840×2160} とその縦横入替のみ）、`PreviewBox::key(&self) -> String`（"WxH"）
  - `pub const PREVIEW_JPEG_QUALITY: u8 = 85;`
  - `pub fn fit_within(w: u32, h: u32, bbox: PreviewBox) -> Option<(u32, u32)>`（収まっていれば None = リサイズ不要）
  - `pub struct Generated { pub preview_jpeg: Vec<u8>, pub preview_width: u32, pub preview_height: u32, pub natural_width: u32, pub natural_height: u32, pub resized: bool, pub thumbnail_base64: String }`
  - `pub fn generate(path: &Path, bbox: PreviewBox, thumb_size: u32) -> Result<Generated, String>`
  - `pub fn thumbnail_only(path: &Path, thumb_size: u32) -> Result<(String, u32, u32), String>`（GIF 用: base64 と向き適用後の寸法）

- [ ] **Step 1: 依存を追加**

Run: `cargo add fast_image_resize@6.1 --features image --manifest-path src-tauri/Cargo.toml`
Expected: `Cargo.toml` に `fast_image_resize = { version = "6.1", features = ["image"] }`（`Cargo.lock` 更新）。`cargo build --manifest-path src-tauri/Cargo.toml` が通る

- [ ] **Step 2: テストフィクスチャを追加（`src-tauri/src/test_utils.rs`）**

```rust
/// Gradient RGB JPEG of the given size (pixel values vary so resizing is observable).
pub fn create_gradient_jpeg(dir: &Path, filename: &str, width: u32, height: u32) -> PathBuf {
    use image::{ImageBuffer, Rgb};
    let file_path = dir.join(filename);
    let img = ImageBuffer::from_fn(width, height, |x, y| {
        Rgb([
            (x * 255 / width.max(1)) as u8,
            (y * 255 / height.max(1)) as u8,
            128u8,
        ])
    });
    img.save(&file_path).expect("Failed to create gradient JPEG");
    file_path
}

/// RGBA PNG whose left half is opaque white and right half fully transparent white.
pub fn create_half_transparent_png(dir: &Path, filename: &str, width: u32, height: u32) -> PathBuf {
    use image::{ImageBuffer, Rgba};
    let file_path = dir.join(filename);
    let img = ImageBuffer::from_fn(width, height, |x, _y| {
        if x < width / 2 {
            Rgba([255u8, 255u8, 255u8, 255u8])
        } else {
            Rgba([255u8, 255u8, 255u8, 0u8])
        }
    });
    img.save(&file_path).expect("Failed to create RGBA PNG");
    file_path
}

/// Minimal little-endian TIFF/Exif blob carrying only the Orientation tag.
/// The JPEG encoder prepends the "Exif\0\0" APP1 header itself.
pub fn exif_orientation_blob(orientation: u16) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(b"II\x2A\x00"); // byte order + magic 42
    v.extend_from_slice(&8u32.to_le_bytes()); // IFD0 offset
    v.extend_from_slice(&1u16.to_le_bytes()); // one entry
    v.extend_from_slice(&0x0112u16.to_le_bytes()); // Orientation
    v.extend_from_slice(&3u16.to_le_bytes()); // SHORT
    v.extend_from_slice(&1u32.to_le_bytes()); // count
    v.extend_from_slice(&orientation.to_le_bytes());
    v.extend_from_slice(&0u16.to_le_bytes()); // value padding to 4 bytes
    v.extend_from_slice(&0u32.to_le_bytes()); // next IFD: none
    v
}

/// Gradient JPEG with an Exif Orientation tag (e.g. 6 = rotate 90 CW on display)
/// and, optionally, an ICC profile segment.
pub fn create_jpeg_with_metadata(
    dir: &Path,
    filename: &str,
    width: u32,
    height: u32,
    orientation: Option<u16>,
    icc: Option<&[u8]>,
) -> PathBuf {
    use image::codecs::jpeg::JpegEncoder;
    use image::{ExtendedColorType, ImageBuffer, ImageEncoder, Rgb};
    let file_path = dir.join(filename);
    let img = ImageBuffer::from_fn(width, height, |x, y| {
        Rgb([(x * 255 / width.max(1)) as u8, (y * 255 / height.max(1)) as u8, 64u8])
    });
    let file = fs::File::create(&file_path).expect("create jpeg");
    let mut encoder = JpegEncoder::new_with_quality(std::io::BufWriter::new(file), 90);
    if let Some(o) = orientation {
        encoder
            .set_exif_metadata(exif_orientation_blob(o))
            .expect("jpeg encoder supports exif");
    }
    if let Some(icc) = icc {
        encoder
            .set_icc_profile(icc.to_vec())
            .expect("jpeg encoder supports icc");
    }
    encoder
        .write_image(img.as_raw(), width, height, ExtendedColorType::Rgb8)
        .expect("write jpeg");
    file_path
}
```

- [ ] **Step 3: 失敗するテストを書く（`preview.rs` の末尾 `#[cfg(test)] mod tests`）**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::*;
    use image::{GenericImageView, ImageDecoder, ImageReader};

    fn box_1080p() -> PreviewBox {
        PreviewBox::parse("1920x1080").unwrap()
    }

    #[test]
    fn parse_accepts_allowlisted_boxes_in_both_orientations() {
        assert_eq!(PreviewBox::parse("1920x1080"), Some(PreviewBox { width: 1920, height: 1080 }));
        assert_eq!(PreviewBox::parse("1080x1920"), Some(PreviewBox { width: 1080, height: 1920 }));
        assert_eq!(PreviewBox::parse("3840x2160").map(|b| b.key()), Some("3840x2160".to_string()));
        assert_eq!(PreviewBox::parse("1920x1200"), None);
        assert_eq!(PreviewBox::parse("abc"), None);
        assert_eq!(PreviewBox::parse("1920x"), None);
    }

    #[test]
    fn fit_within_keeps_aspect_and_never_upscales() {
        assert_eq!(fit_within(5472, 3648, box_1080p()), Some((1620, 1080)));
        assert_eq!(fit_within(3648, 5472, box_1080p()), Some((720, 1080)));
        assert_eq!(fit_within(1024, 768, box_1080p()), None);
        assert_eq!(fit_within(1920, 1080, box_1080p()), None);
        assert_eq!(fit_within(4000, 1000, box_1080p()), Some((1920, 480)));
    }

    #[test]
    fn generate_resizes_large_image_into_box_and_reports_natural_size() {
        let dir = create_temp_dir();
        let src = create_gradient_jpeg(dir.path(), "big.jpg", 2400, 1600);
        let g = generate(&src, box_1080p(), 20).unwrap();
        assert!(g.resized);
        assert_eq!((g.natural_width, g.natural_height), (2400, 1600));
        assert_eq!((g.preview_width, g.preview_height), (1620, 1080));
        let decoded = image::load_from_memory(&g.preview_jpeg).unwrap();
        assert_eq!(decoded.dimensions(), (1620, 1080));
        let thumb = image::load_from_memory(
            &base64::engine::general_purpose::STANDARD.decode(&g.thumbnail_base64).unwrap(),
        )
        .unwrap();
        assert!(thumb.width() <= 20 && thumb.height() <= 20);
        assert!(thumb.width() == 20 || thumb.height() == 20);
    }

    #[test]
    fn generate_keeps_small_images_at_native_size() {
        let dir = create_temp_dir();
        let src = create_gradient_jpeg(dir.path(), "small.jpg", 640, 480);
        let g = generate(&src, box_1080p(), 20).unwrap();
        assert!(!g.resized);
        assert_eq!((g.preview_width, g.preview_height), (640, 480));
        assert_eq!((g.natural_width, g.natural_height), (640, 480));
    }

    #[test]
    fn generate_applies_exif_orientation_before_measuring_and_resizing() {
        let dir = create_temp_dir();
        // Encoded 1200x800 with Orientation=6: displayed (natural) size is 800x1200.
        let src = create_jpeg_with_metadata(dir.path(), "rot.jpg", 1200, 800, Some(6), None);
        let g = generate(&src, box_1080p(), 20).unwrap();
        assert_eq!((g.natural_width, g.natural_height), (800, 1200));
        assert_eq!((g.preview_width, g.preview_height), (720, 1080));
        // The preview must carry no Exif orientation of its own (it is already upright).
        let mut dec = ImageReader::new(std::io::Cursor::new(&g.preview_jpeg))
            .with_guessed_format()
            .unwrap()
            .into_decoder()
            .unwrap();
        assert_eq!(dec.orientation().unwrap(), image::metadata::Orientation::NoTransforms);
    }

    #[test]
    fn generate_carries_the_icc_profile_into_the_preview() {
        let dir = create_temp_dir();
        let icc: Vec<u8> = (0..600u32).map(|i| (i % 251) as u8).collect();
        let src = create_jpeg_with_metadata(dir.path(), "icc.jpg", 2400, 1600, None, Some(&icc));
        let g = generate(&src, box_1080p(), 20).unwrap();
        let mut dec = ImageReader::new(std::io::Cursor::new(&g.preview_jpeg))
            .with_guessed_format()
            .unwrap()
            .into_decoder()
            .unwrap();
        assert_eq!(dec.icc_profile().unwrap(), Some(icc));
    }

    #[test]
    fn generate_flattens_transparency_onto_black() {
        let dir = create_temp_dir();
        let src = create_half_transparent_png(dir.path(), "alpha.png", 200, 100);
        let g = generate(&src, box_1080p(), 20).unwrap();
        let decoded = image::load_from_memory(&g.preview_jpeg).unwrap().to_rgb8();
        let left = decoded.get_pixel(50, 50);
        let right = decoded.get_pixel(150, 50);
        assert!(left[0] > 240 && left[1] > 240 && left[2] > 240, "opaque white stays white: {:?}", left);
        assert!(right[0] < 16 && right[1] < 16 && right[2] < 16, "transparent becomes black: {:?}", right);
    }

    #[test]
    fn thumbnail_only_returns_base64_and_dimensions() {
        let dir = create_temp_dir();
        let src = create_test_gif(dir.path(), "anim.gif");
        let (b64, w, h) = thumbnail_only(&src, 20).unwrap();
        assert!(!b64.is_empty());
        assert_eq!((w, h), (1, 1));
    }

    #[test]
    fn generate_rejects_invalid_files() {
        let dir = create_temp_dir();
        let src = create_invalid_image(dir.path(), "bad.jpg");
        assert!(generate(&src, box_1080p(), 20).is_err());
    }
}
```

- [ ] **Step 4: 失敗を確認**

Run: `cargo test --lib --manifest-path src-tauri/Cargo.toml preview` → コンパイルエラー（モジュール未定義）

- [ ] **Step 5: 実装（`src-tauri/src/utils/preview.rs`）**

```rust
//! Display-resolution preview generation (design spec 2026-08-21 §6.1).
//! One decode produces both the preview JPEG (orientation applied, ICC kept,
//! alpha flattened onto the viewer's black background, fitted inside the
//! screen box without upscaling) and the 20px thumbnail derived from it.

use crate::utils::perf::PerfTimer;
use base64::{engine::general_purpose, Engine as _};
use fast_image_resize::{images::Image as FirImage, FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer};
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ExtendedColorType, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, RgbImage};
use std::io::Cursor;
use std::path::Path;

pub const PREVIEW_JPEG_QUALITY: u8 = 85;

/// Screen-box buckets (D2). Either orientation of a bucket is accepted so a
/// portrait monitor gets a portrait box.
pub const ALLOWED_PREVIEW_BOXES: &[(u32, u32)] = &[(1920, 1080), (2560, 1440), (3840, 2160)];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreviewBox {
    pub width: u32,
    pub height: u32,
}

impl PreviewBox {
    /// Parses "WxH". Only allowlisted buckets are accepted — the box is part of
    /// a URL and a cache key, so arbitrary sizes must not reach the generator.
    pub fn parse(s: &str) -> Option<PreviewBox> {
        let (w, h) = s.split_once('x')?;
        let (w, h) = (w.parse::<u32>().ok()?, h.parse::<u32>().ok()?);
        let allowed = ALLOWED_PREVIEW_BOXES
            .iter()
            .any(|&(bw, bh)| (bw == w && bh == h) || (bw == h && bh == w));
        allowed.then_some(PreviewBox { width: w, height: h })
    }

    pub fn key(&self) -> String {
        format!("{}x{}", self.width, self.height)
    }
}

pub struct Generated {
    pub preview_jpeg: Vec<u8>,
    pub preview_width: u32,
    pub preview_height: u32,
    /// Orientation-applied size of the original.
    pub natural_width: u32,
    pub natural_height: u32,
    /// false when the original already fit inside the box (preview == original size).
    pub resized: bool,
    pub thumbnail_base64: String,
}

/// Size that fits (w, h) inside the box preserving aspect ratio, or None when
/// it already fits (never upscale).
pub fn fit_within(w: u32, h: u32, bbox: PreviewBox) -> Option<(u32, u32)> {
    if w <= bbox.width && h <= bbox.height {
        return None;
    }
    let scale = f64::min(
        f64::from(bbox.width) / f64::from(w),
        f64::from(bbox.height) / f64::from(h),
    );
    let tw = ((f64::from(w) * scale).round() as u32).clamp(1, bbox.width);
    let th = ((f64::from(h) * scale).round() as u32).clamp(1, bbox.height);
    Some((tw, th))
}

struct Decoded {
    image: DynamicImage,
    icc: Option<Vec<u8>>,
}

/// Decodes with the Exif orientation applied (what browsers display) and
/// returns the embedded ICC profile, if any.
fn decode_oriented(path: &Path) -> Result<Decoded, String> {
    let reader = ImageReader::open(path)
        .map_err(|e| format!("open: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("format: {e}"))?;
    let mut decoder = reader.into_decoder().map_err(|e| format!("decoder: {e}"))?;
    let orientation = decoder.orientation().map_err(|e| format!("orientation: {e}"))?;
    let icc = decoder.icc_profile().map_err(|e| format!("icc: {e}"))?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(|e| format!("decode: {e}"))?;
    image.apply_orientation(orientation);
    Ok(Decoded { image, icc })
}

/// RGB8 with any alpha composited onto black (the viewer background), so the
/// JPEG preview looks identical to the original over the black canvas.
fn flatten_to_rgb8(image: &DynamicImage) -> RgbImage {
    if !image.color().has_alpha() {
        return image.to_rgb8();
    }
    let rgba = image.to_rgba8();
    let mut out = RgbImage::new(rgba.width(), rgba.height());
    for (dst, src) in out.pixels_mut().zip(rgba.pixels()) {
        let a = u32::from(src[3]);
        dst.0 = [
            ((u32::from(src[0]) * a + 127) / 255) as u8,
            ((u32::from(src[1]) * a + 127) / 255) as u8,
            ((u32::from(src[2]) * a + 127) / 255) as u8,
        ];
    }
    out
}

fn resize_rgb8(src: RgbImage, tw: u32, th: u32) -> Result<RgbImage, String> {
    let src = DynamicImage::ImageRgb8(src);
    let mut dst = FirImage::new(tw, th, PixelType::U8x3);
    let mut resizer = Resizer::new();
    resizer
        .resize(
            &src,
            &mut dst,
            &ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3)),
        )
        .map_err(|e| format!("resize: {e}"))?;
    RgbImage::from_raw(tw, th, dst.into_vec()).ok_or_else(|| "resize: buffer size mismatch".to_string())
}

fn encode_jpeg(rgb: &RgbImage, quality: u8, icc: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut out, quality);
    if let Some(icc) = icc {
        // UnsupportedError cannot happen for JPEG; ignoring keeps the signature simple.
        let _ = encoder.set_icc_profile(icc.to_vec());
    }
    encoder
        .write_image(rgb.as_raw(), rgb.width(), rgb.height(), ExtendedColorType::Rgb8)
        .map_err(|e| format!("encode: {e}"))?;
    Ok(out)
}

fn thumbnail_base64(image: &DynamicImage, thumb_size: u32) -> Result<String, String> {
    let thumb = image.thumbnail(thumb_size, thumb_size);
    let mut buf = Vec::new();
    thumb
        .write_to(&mut Cursor::new(&mut buf), ImageFormat::Jpeg)
        .map_err(|e| format!("thumbnail: {e}"))?;
    Ok(general_purpose::STANDARD.encode(&buf))
}

/// Preview + thumbnail from ONE decode. `path` must already be validated.
pub fn generate(path: &Path, bbox: PreviewBox, thumb_size: u32) -> Result<Generated, String> {
    let path_str = path.to_string_lossy();
    let Decoded { image, icc } = {
        let _t = PerfTimer::start("preview_decode", &path_str);
        decode_oriented(path)?
    };
    let (natural_width, natural_height) = (image.width(), image.height());
    let rgb = flatten_to_rgb8(&image);
    drop(image);
    let (preview, resized) = match fit_within(natural_width, natural_height, bbox) {
        Some((tw, th)) => {
            let _t = PerfTimer::start("preview_resize", &path_str);
            (resize_rgb8(rgb, tw, th)?, true)
        }
        None => (rgb, false),
    };
    let (preview_width, preview_height) = (preview.width(), preview.height());
    let preview_jpeg = {
        let _t = PerfTimer::start("preview_encode", &path_str);
        encode_jpeg(&preview, PREVIEW_JPEG_QUALITY, icc.as_deref())?
    };
    let thumbnail_base64 = thumbnail_base64(&DynamicImage::ImageRgb8(preview), thumb_size)?;
    Ok(Generated {
        preview_jpeg,
        preview_width,
        preview_height,
        natural_width,
        natural_height,
        resized,
        thumbnail_base64,
    })
}

/// Thumbnail without a preview (GIF keeps its `<img>` path; the first frame
/// is enough for the bar). Returns (base64, natural width, natural height).
pub fn thumbnail_only(path: &Path, thumb_size: u32) -> Result<(String, u32, u32), String> {
    let Decoded { image, .. } = decode_oriented(path)?;
    let (w, h) = (image.width(), image.height());
    Ok((thumbnail_base64(&image, thumb_size)?, w, h))
}
```

`src-tauri/src/utils/mod.rs` に `pub mod preview;` を追加。

- [ ] **Step 6: 成功を確認**

Run: `cargo test --lib --manifest-path src-tauri/Cargo.toml preview` → 9 passed（`FilterType` の import パスがビルドエラーになる場合は `fast_image_resize::convolution::FilterType` に変える — 6.1 ではクレート直下から re-export されている）

- [ ] **Step 7: fmt + コミット**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/utils/mod.rs src-tauri/src/utils/preview.rs src-tauri/src/test_utils.rs
git commit -m "feat(rust): display-resolution preview generation (orientation, ICC, alpha flatten, Lanczos3)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `cache.rs` — ディレクトリ注入型のキャッシュ関数群（TDD）

**Files:**
- Modify: `src-tauri/src/commands/cache.rs`（全面的に再構成。コマンド 4 つのシグネチャは `get_cached_thumbnail` に `preview_box: Option<String>` が増える以外は不変）

**Interfaces:**
- Produces（Task 4/5 が使用。すべて `cache_dir: &Path` を受け取る純関数）:
  - `pub(crate) fn get_cache_dir() -> Result<PathBuf, String>`（既存、可視性のみ変更）
  - `pub struct CacheEntry { thumbnail: String, created: u64, width: Option<u32>, height: Option<u32>, preview_box: Option<String>, source_mtime: Option<u64>, source_size: Option<u64> }`（後ろ 3 つは `#[serde(default, skip_serializing_if = "Option::is_none")]`）
  - `pub fn source_stamp(path: &Path) -> Option<(u64, u64)>`（mtime 秒, サイズ）
  - `pub fn write_atomic(target: &Path, bytes: &[u8]) -> std::io::Result<()>`
  - `pub fn store_thumbnail_entry(cache_dir, path: &str, size: u32, entry: &CacheEntry) -> Result<(), String>`
  - `pub fn lookup_thumbnail(cache_dir, path: &str, size: u32, preview_box: Option<&str>) -> Option<(String, Option<u32>, Option<u32>)>`（24h・stamp 一致・`preview_box` 要求時はプレビューファイル + サイドカー存在、GIF は `preview_box: None` の entry を有効扱い）
  - `pub struct PreviewSidecar { natural_width: u32, natural_height: u32, source_mtime: u64, source_size: u64, created: u64 }`
  - `pub fn store_preview(cache_dir, path: &str, box_key: &str, jpeg: &[u8], sidecar: &PreviewSidecar) -> Result<(), String>`（jpeg を `{hash}_p.jpg`、サイドカーを `{hash}_p.json` に、各々原子的に）
  - `pub fn load_preview(cache_dir, path: &str, box_key: &str) -> Option<(Vec<u8>, PreviewSidecar)>`（存在 + stamp 一致のときのみ）
  - `pub const PREVIEW_CACHE_CAP_BYTES: u64 = 2 * 1024 * 1024 * 1024;`
  - `pub fn sweep(cache_dir, now_secs: u64, max_age_secs: u64, cap_bytes: u64) -> usize`（24h 超の `.json`/`_p.jpg`/`_p.json` を削除し、残る `_p.jpg` の合計が cap を超える間は mtime の古い順に `_p.jpg` + 対応 `_p.json` を削除。削除数を返す）
  - `pub fn stats(cache_dir, now_secs: u64, max_age_secs: u64) -> HashMap<String, u64>`（`total_files`, `valid_files`, `preview_files`, `preview_bytes`）

- [ ] **Step 1: 失敗するテストを書く（既存テストは置き換える）**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::*;

    fn entry(stamp: Option<(u64, u64)>, preview_box: Option<&str>) -> CacheEntry {
        CacheEntry {
            thumbnail: "AAAA".to_string(),
            created: current_unix_time(),
            width: Some(800),
            height: Some(600),
            preview_box: preview_box.map(str::to_string),
            source_mtime: stamp.map(|s| s.0),
            source_size: stamp.map(|s| s.1),
        }
    }

    fn sidecar(stamp: (u64, u64)) -> PreviewSidecar {
        PreviewSidecar {
            natural_width: 800,
            natural_height: 600,
            source_mtime: stamp.0,
            source_size: stamp.1,
            created: current_unix_time(),
        }
    }

    #[test]
    fn cache_key_is_stable_and_distinct_per_path_and_size() {
        assert_eq!(get_cache_key("/a.jpg", 20), get_cache_key("/a.jpg", 20));
        assert_ne!(get_cache_key("/a.jpg", 20), get_cache_key("/a.jpg", 30));
        assert_ne!(get_cache_key("/a.jpg", 20), get_cache_key("/b.jpg", 20));
    }

    #[test]
    fn write_atomic_leaves_no_temp_file_and_replaces_existing() {
        let dir = create_temp_dir();
        let target = dir.path().join("x.bin");
        write_atomic(&target, b"one").unwrap();
        write_atomic(&target, b"two").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"two");
        let names: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names.len(), 1, "temp files must be gone: {:?}", names);
    }

    #[test]
    fn lookup_requires_matching_source_stamp() {
        let dir = create_temp_dir();
        let img = create_test_jpeg(dir.path(), "a.jpg");
        let p = img.to_string_lossy().to_string();
        let stamp = source_stamp(&img).unwrap();
        store_thumbnail_entry(dir.path(), &p, 20, &entry(Some(stamp), None)).unwrap();
        assert!(lookup_thumbnail(dir.path(), &p, 20, None).is_some());
        // Source changed (different size) → stale.
        fs::write(&img, b"replaced with different bytes").unwrap();
        assert!(lookup_thumbnail(dir.path(), &p, 20, None).is_none());
    }

    #[test]
    fn lookup_without_stamp_is_treated_as_stale() {
        let dir = create_temp_dir();
        let img = create_test_jpeg(dir.path(), "a.jpg");
        let p = img.to_string_lossy().to_string();
        store_thumbnail_entry(dir.path(), &p, 20, &entry(None, None)).unwrap();
        assert!(lookup_thumbnail(dir.path(), &p, 20, None).is_none());
    }

    #[test]
    fn lookup_with_box_requires_the_preview_files() {
        let dir = create_temp_dir();
        let img = create_test_jpeg(dir.path(), "a.jpg");
        let p = img.to_string_lossy().to_string();
        let stamp = source_stamp(&img).unwrap();
        store_thumbnail_entry(dir.path(), &p, 20, &entry(Some(stamp), Some("1920x1080"))).unwrap();
        // Entry claims a preview, but none is on disk → not usable (I1).
        assert!(lookup_thumbnail(dir.path(), &p, 20, Some("1920x1080")).is_none());
        store_preview(dir.path(), &p, "1920x1080", b"\xFF\xD8jpeg", &sidecar(stamp)).unwrap();
        assert_eq!(
            lookup_thumbnail(dir.path(), &p, 20, Some("1920x1080")),
            Some(("AAAA".to_string(), Some(800), Some(600)))
        );
        // A different box is a different preview.
        assert!(lookup_thumbnail(dir.path(), &p, 20, Some("2560x1440")).is_none());
        // Without a box request the thumbnail alone is enough.
        assert!(lookup_thumbnail(dir.path(), &p, 20, None).is_some());
    }

    #[test]
    fn lookup_exempts_gif_from_the_preview_requirement() {
        let dir = create_temp_dir();
        let gif = create_test_gif(dir.path(), "a.gif");
        let p = gif.to_string_lossy().to_string();
        let stamp = source_stamp(&gif).unwrap();
        store_thumbnail_entry(dir.path(), &p, 20, &entry(Some(stamp), None)).unwrap();
        assert!(lookup_thumbnail(dir.path(), &p, 20, Some("1920x1080")).is_some());
    }

    #[test]
    fn load_preview_roundtrips_and_checks_the_stamp() {
        let dir = create_temp_dir();
        let img = create_test_jpeg(dir.path(), "a.jpg");
        let p = img.to_string_lossy().to_string();
        let stamp = source_stamp(&img).unwrap();
        store_preview(dir.path(), &p, "1920x1080", b"\xFF\xD8jpeg", &sidecar(stamp)).unwrap();
        let (bytes, side) = load_preview(dir.path(), &p, "1920x1080").unwrap();
        assert_eq!(bytes, b"\xFF\xD8jpeg");
        assert_eq!((side.natural_width, side.natural_height), (800, 600));
        fs::write(&img, b"different").unwrap();
        assert!(load_preview(dir.path(), &p, "1920x1080").is_none());
    }

    #[test]
    fn sweep_removes_expired_entries_and_enforces_the_preview_cap() {
        let dir = create_temp_dir();
        let now = 1_000_000u64;
        // Expired thumbnail entry.
        let old = CacheEntry { created: now - 100_000, ..entry(Some((1, 1)), None) };
        store_thumbnail_entry(dir.path(), "/old.jpg", 20, &old).unwrap();
        // Three fresh previews of 1000 bytes each, cap 2500 → oldest one must go.
        for (i, name) in ["/p1.jpg", "/p2.jpg", "/p3.jpg"].iter().enumerate() {
            store_preview(dir.path(), name, "1920x1080", &vec![0u8; 1000], &sidecar((1, 1))).unwrap();
            let f = preview_file(dir.path(), name, "1920x1080");
            let t = filetime_for_test(now - 1000 + i as u64 * 10);
            filetime::set_file_mtime(&f, t).unwrap();
        }
        let removed = sweep(dir.path(), now, 24 * 60 * 60, 2500);
        assert_eq!(removed, 2, "expired json + one preview (jpg+sidecar count as one)");
        assert!(load_preview(dir.path(), "/p1.jpg", "1920x1080").is_none());
        assert!(load_preview(dir.path(), "/p3.jpg", "1920x1080").is_some());
        assert!(!json_file(dir.path(), "/old.jpg", 20).exists());
    }

    #[test]
    fn stats_counts_previews_and_bytes() {
        let dir = create_temp_dir();
        store_preview(dir.path(), "/p1.jpg", "1920x1080", &vec![0u8; 1000], &sidecar((1, 1))).unwrap();
        let s = stats(dir.path(), current_unix_time(), 24 * 60 * 60);
        assert_eq!(s["preview_files"], 1);
        assert_eq!(s["preview_bytes"], 1000);
    }
}
```

`sweep` テストのファイル mtime 操作には `filetime` クレート（dev-dependency）を使う: `cargo add filetime --dev --manifest-path src-tauri/Cargo.toml`。`filetime_for_test(secs)` は `filetime::FileTime::from_unix_time(secs as i64, 0)` を返すテスト内ヘルパ。

- [ ] **Step 2: 失敗を確認**

Run: `cargo test --lib --manifest-path src-tauri/Cargo.toml cache` → コンパイルエラー

- [ ] **Step 3: 実装**

```rust
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize, Deserialize)]
pub struct CacheEntry {
    pub thumbnail: String,
    pub created: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// Screen box of the preview generated together with this thumbnail (I1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_box: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_mtime: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_size: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct PreviewSidecar {
    pub natural_width: u32,
    pub natural_height: u32,
    pub source_mtime: u64,
    pub source_size: u64,
    pub created: u64,
}

pub const CACHE_DURATION: u64 = 24 * 60 * 60;
/// D3: previews are ~0.3–1.5 MB each; cap the total so a 900-image folder on a
/// 4K box cannot grow unbounded.
pub const PREVIEW_CACHE_CAP_BYTES: u64 = 2 * 1024 * 1024 * 1024;

pub(crate) fn get_cache_dir() -> Result<PathBuf, String> { /* 既存のまま */ }

fn hash_key(parts: &[&str]) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    for p in parts { p.hash(&mut hasher); }
    format!("{:x}", hasher.finish())
}

fn get_cache_key(path: &str, size: u32) -> String {
    // Keep the legacy (path, size) hashing so existing entries stay addressable.
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    size.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

fn json_file(cache_dir: &Path, path: &str, size: u32) -> PathBuf {
    cache_dir.join(format!("{}.json", get_cache_key(path, size)))
}

pub fn preview_file(cache_dir: &Path, path: &str, box_key: &str) -> PathBuf {
    cache_dir.join(format!("{}_p.jpg", hash_key(&[path, box_key])))
}

fn preview_sidecar_file(cache_dir: &Path, path: &str, box_key: &str) -> PathBuf {
    cache_dir.join(format!("{}_p.json", hash_key(&[path, box_key])))
}

pub fn current_unix_time() -> u64 { /* 既存のまま */ }

pub fn source_stamp(path: &Path) -> Option<(u64, u64)> {
    let meta = fs::metadata(path).ok()?;
    let mtime = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
    Some((mtime, meta.len()))
}

/// Write to a sibling temp file, then rename over the target (atomic on NTFS;
/// `std::fs::rename` replaces an existing destination on Windows).
pub fn write_atomic(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let mut tmp = target.as_os_str().to_owned();
    tmp.push(format!(".tmp-{}-{}", std::process::id(), nanos));
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, bytes)?;
    match fs::rename(&tmp, target) {
        Ok(()) => Ok(()),
        Err(e) => { let _ = fs::remove_file(&tmp); Err(e) }
    }
}

fn is_gif(path: &str) -> bool {
    Path::new(path).extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("gif")).unwrap_or(false)
}

fn stamp_matches(path: &str, mtime: Option<u64>, size: Option<u64>) -> bool {
    match (source_stamp(Path::new(path)), mtime, size) {
        (Some((m, s)), Some(em), Some(es)) => m == em && s == es,
        _ => false,
    }
}

fn read_entry(cache_dir: &Path, path: &str, size: u32) -> Option<CacheEntry> {
    let file = json_file(cache_dir, path, size);
    let content = fs::read_to_string(&file).ok()?;
    let entry: CacheEntry = match serde_json::from_str(&content) {
        Ok(e) => e,
        Err(_) => { let _ = fs::remove_file(&file); return None; }
    };
    if current_unix_time().saturating_sub(entry.created) > CACHE_DURATION {
        let _ = fs::remove_file(&file);
        return None;
    }
    Some(entry)
}

pub fn store_thumbnail_entry(cache_dir: &Path, path: &str, size: u32, entry: &CacheEntry) -> Result<(), String> {
    let json = serde_json::to_string(entry).map_err(|e| format!("Failed to serialize cache entry: {e}"))?;
    write_atomic(&json_file(cache_dir, path, size), json.as_bytes()).map_err(|e| format!("Failed to write cache file: {e}"))
}

/// Thumbnail lookup honoring I1: with a box requested, the matching preview
/// (jpg + sidecar, fresh stamp) must be on disk — GIF excepted. Entries
/// without a source stamp (pre-2026-08 format) count as stale.
pub fn lookup_thumbnail(cache_dir: &Path, path: &str, size: u32, preview_box: Option<&str>) -> Option<(String, Option<u32>, Option<u32>)> {
    let entry = read_entry(cache_dir, path, size)?;
    if entry.thumbnail != "error" && !stamp_matches(path, entry.source_mtime, entry.source_size) {
        return None;
    }
    if let Some(bk) = preview_box {
        if !is_gif(path) && entry.thumbnail != "error" {
            if entry.preview_box.as_deref() != Some(bk) { return None; }
            load_preview(cache_dir, path, bk)?;
        }
    }
    Some((entry.thumbnail, entry.width, entry.height))
}

pub fn store_preview(cache_dir: &Path, path: &str, box_key: &str, jpeg: &[u8], sidecar: &PreviewSidecar) -> Result<(), String> {
    write_atomic(&preview_file(cache_dir, path, box_key), jpeg).map_err(|e| format!("Failed to write preview: {e}"))?;
    let json = serde_json::to_string(sidecar).map_err(|e| format!("Failed to serialize sidecar: {e}"))?;
    write_atomic(&preview_sidecar_file(cache_dir, path, box_key), json.as_bytes()).map_err(|e| format!("Failed to write sidecar: {e}"))
}

pub fn load_preview(cache_dir: &Path, path: &str, box_key: &str) -> Option<(Vec<u8>, PreviewSidecar)> {
    let side: PreviewSidecar = serde_json::from_str(&fs::read_to_string(preview_sidecar_file(cache_dir, path, box_key)).ok()?).ok()?;
    if !stamp_matches(path, Some(side.source_mtime), Some(side.source_size)) { return None; }
    let bytes = fs::read(preview_file(cache_dir, path, box_key)).ok()?;
    Some((bytes, side))
}

/// Startup housekeeping: age out everything older than `max_age_secs`, then
/// evict the oldest previews until the preview total is under `cap_bytes`.
/// Returns the number of removed entries (a preview jpg + its sidecar = 1).
pub fn sweep(cache_dir: &Path, now_secs: u64, max_age_secs: u64, cap_bytes: u64) -> usize {
    let Ok(entries) = fs::read_dir(cache_dir) else { return 0 };
    let mut removed = 0usize;
    let mut previews: Vec<(PathBuf, u64, u64)> = Vec::new(); // (jpg, mtime, len)
    for entry in entries.flatten() {
        let p = entry.path();
        let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
        if name.ends_with("_p.jpg") {
            let meta = match fs::metadata(&p) { Ok(m) => m, Err(_) => continue };
            let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
            if now_secs.saturating_sub(mtime) > max_age_secs {
                remove_preview_pair(&p); removed += 1;
            } else {
                previews.push((p, mtime, meta.len()));
            }
        } else if name.ends_with("_p.json") {
            // Orphan sidecar (jpg gone) → drop it.
            let jpg = p.with_file_name(name.replace("_p.json", "_p.jpg"));
            if !jpg.exists() { let _ = fs::remove_file(&p); }
        } else if name.ends_with(".json") {
            match fs::read_to_string(&p).ok().and_then(|c| serde_json::from_str::<CacheEntry>(&c).ok()) {
                Some(e) if now_secs.saturating_sub(e.created) <= max_age_secs => {}
                _ => { if fs::remove_file(&p).is_ok() { removed += 1; } }
            }
        }
    }
    let mut total: u64 = previews.iter().map(|p| p.2).sum();
    previews.sort_by_key(|p| p.1); // oldest first
    for (jpg, _, len) in previews {
        if total <= cap_bytes { break; }
        remove_preview_pair(&jpg); removed += 1;
        total = total.saturating_sub(len);
    }
    removed
}

fn remove_preview_pair(jpg: &Path) {
    let _ = fs::remove_file(jpg);
    if let Some(name) = jpg.file_name().and_then(|s| s.to_str()) {
        let _ = fs::remove_file(jpg.with_file_name(name.replace("_p.jpg", "_p.json")));
    }
}

pub fn stats(cache_dir: &Path, now_secs: u64, max_age_secs: u64) -> HashMap<String, u64> {
    let mut s = HashMap::from([
        ("total_files".to_string(), 0u64), ("valid_files".to_string(), 0u64),
        ("preview_files".to_string(), 0u64), ("preview_bytes".to_string(), 0u64),
    ]);
    let Ok(entries) = fs::read_dir(cache_dir) else { return s };
    for entry in entries.flatten() {
        let p = entry.path();
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        if name.ends_with("_p.jpg") {
            *s.get_mut("preview_files").unwrap() += 1;
            *s.get_mut("preview_bytes").unwrap() += fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        } else if name.ends_with(".json") && !name.ends_with("_p.json") {
            *s.get_mut("total_files").unwrap() += 1;
            if let Some(e) = fs::read_to_string(&p).ok().and_then(|c| serde_json::from_str::<CacheEntry>(&c).ok()) {
                if now_secs.saturating_sub(e.created) <= max_age_secs { *s.get_mut("valid_files").unwrap() += 1; }
            }
        }
    }
    s
}

// ---- commands: thin wrappers over the injected-directory functions ----

#[tauri::command]
pub async fn get_cached_thumbnail(path: String, size: Option<u32>, preview_box: Option<String>) -> Result<Option<(String, Option<u32>, Option<u32>)>, String> {
    let cache_dir = get_cache_dir()?;
    Ok(lookup_thumbnail(&cache_dir, &path, size.unwrap_or(30), preview_box.as_deref()))
}

#[tauri::command]
pub async fn set_cached_thumbnail(path: String, thumbnail: String, size: Option<u32>, width: Option<u32>, height: Option<u32>) -> Result<(), String> {
    let cache_dir = get_cache_dir()?;
    let stamp = source_stamp(Path::new(&path));
    let entry = CacheEntry {
        thumbnail, created: current_unix_time(), width, height,
        preview_box: None, source_mtime: stamp.map(|s| s.0), source_size: stamp.map(|s| s.1),
    };
    store_thumbnail_entry(&cache_dir, &path, size.unwrap_or(30), &entry)
}

#[tauri::command]
pub async fn clear_old_cache() -> Result<(), String> {
    let Ok(cache_dir) = get_cache_dir() else { return Ok(()) };
    let removed = tauri::async_runtime::spawn_blocking(move || sweep(&cache_dir, current_unix_time(), CACHE_DURATION, PREVIEW_CACHE_CAP_BYTES))
        .await.map_err(|e| e.to_string())?;
    println!("Cleaned {} old cache entries", removed);
    Ok(())
}

#[tauri::command]
pub async fn get_cache_stats() -> Result<HashMap<String, u64>, String> {
    let Ok(cache_dir) = get_cache_dir() else { return Ok(HashMap::new()) };
    Ok(stats(&cache_dir, current_unix_time(), CACHE_DURATION))
}
```

注意: `get_cache_stats` の戻り型が `HashMap<String, u32>` → `u64` に変わる（フロント `useCacheManager.ts` は値を表示するだけ。型注釈があれば `number` のままで互換）。`lookup_thumbnail` の `"error"` エントリは stamp を要求しない（`set_cached_thumbnail` が stamp を書くので通常は一致するが、書き込み時に原本が消えている場合もある）。

- [ ] **Step 4: 成功を確認**

Run: `cargo test --lib --manifest-path src-tauri/Cargo.toml cache` → 全 PASS（旧テスト 9 件は削除、新テスト 9 件）
Run: `cargo test --lib --manifest-path src-tauri/Cargo.toml` → 全 PASS（他モジュールの `get_cache_key` 参照があれば追従）

- [ ] **Step 5: fmt + コミット**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/commands/cache.rs
git commit -m "feat(rust): thumbnail cache with source stamps, atomic writes, preview files and a size cap

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `generate_thumbnail_with_dimensions` の結合生成化 + `spawn_blocking`（TDD）

**Files:**
- Modify: `src-tauri/src/commands/file.rs`
- Modify: `src-tauri/src/lib.rs`（`generate_image_thumbnail` をハンドラ一覧から削除）

**Interfaces:**
- Consumes: Task 2 `preview::{generate, thumbnail_only, PreviewBox}`、Task 3 `cache::{get_cache_dir, store_thumbnail_entry, store_preview, source_stamp, current_unix_time, CacheEntry, PreviewSidecar}`
- Produces: コマンド `generate_thumbnail_with_dimensions(path: String, size: u32, preview_box: Option<String>) -> Result<ThumbnailWithDimensions, String>`、`ThumbnailWithDimensions { thumbnail_base64, original_width, original_height, preview_available: bool }`（`original_*` は向き適用後）。純関数 `pub fn generate_and_cache(path: &Path, size: u32, preview_box: Option<&str>, cache_dir: &Path) -> Result<ThumbnailWithDimensions, String>`（テスト可能）。SPICA_PERF op `thumb_preview`（コマンド全体）

- [ ] **Step 1: 失敗するテストを書く（`file.rs` の tests に追加）**

```rust
    #[test]
    fn generate_and_cache_writes_thumbnail_entry_and_preview() {
        let dir = create_temp_dir();
        let cache = create_temp_dir();
        let img = create_gradient_jpeg(dir.path(), "big.jpg", 2400, 1600);
        let out = generate_and_cache(&img, 20, Some("1920x1080"), cache.path()).unwrap();
        assert!(out.preview_available);
        assert_eq!((out.original_width, out.original_height), (2400, 1600));
        assert!(!out.thumbnail_base64.is_empty());
        let p = img.to_string_lossy().to_string();
        assert!(crate::commands::cache::lookup_thumbnail(cache.path(), &p, 20, Some("1920x1080")).is_some());
        let (bytes, side) = crate::commands::cache::load_preview(cache.path(), &p, "1920x1080").unwrap();
        assert_eq!(image::load_from_memory(&bytes).unwrap().width(), 1620);
        assert_eq!((side.natural_width, side.natural_height), (2400, 1600));
    }

    #[test]
    fn generate_and_cache_gif_has_no_preview() {
        let dir = create_temp_dir();
        let cache = create_temp_dir();
        let gif = create_test_gif(dir.path(), "a.gif");
        let out = generate_and_cache(&gif, 20, Some("1920x1080"), cache.path()).unwrap();
        assert!(!out.preview_available);
        let p = gif.to_string_lossy().to_string();
        assert!(crate::commands::cache::lookup_thumbnail(cache.path(), &p, 20, Some("1920x1080")).is_some());
        assert!(crate::commands::cache::load_preview(cache.path(), &p, "1920x1080").is_none());
    }

    #[test]
    fn generate_and_cache_without_box_only_writes_the_thumbnail() {
        let dir = create_temp_dir();
        let cache = create_temp_dir();
        let img = create_gradient_jpeg(dir.path(), "a.jpg", 640, 480);
        let out = generate_and_cache(&img, 20, None, cache.path()).unwrap();
        assert!(!out.preview_available);
        let p = img.to_string_lossy().to_string();
        assert!(crate::commands::cache::lookup_thumbnail(cache.path(), &p, 20, None).is_some());
        assert!(crate::commands::cache::lookup_thumbnail(cache.path(), &p, 20, Some("1920x1080")).is_none());
    }

    #[test]
    fn generate_and_cache_rejects_invalid_box() {
        let dir = create_temp_dir();
        let cache = create_temp_dir();
        let img = create_gradient_jpeg(dir.path(), "a.jpg", 640, 480);
        assert!(generate_and_cache(&img, 20, Some("999x999"), cache.path()).is_err());
    }

    #[tokio::test]
    async fn generate_thumbnail_with_dimensions_command_rejects_missing_file() {
        let r = generate_thumbnail_with_dimensions("C:\\nope\\missing.jpg".to_string(), 20, Some("1920x1080".to_string())).await;
        assert!(r.is_err());
    }
```

- [ ] **Step 2: 失敗を確認**

Run: `cargo test --lib --manifest-path src-tauri/Cargo.toml generate_and_cache` → コンパイルエラー

- [ ] **Step 3: 実装**

```rust
use crate::commands::cache::{self, CacheEntry, PreviewSidecar};
use crate::utils::preview::{self, PreviewBox};

#[derive(Debug, Serialize, Deserialize)]
pub struct ThumbnailWithDimensions {
    pub thumbnail_base64: String,
    pub original_width: u32,
    pub original_height: u32,
    /// true when a display-resolution preview for the requested box is now on disk (I1).
    pub preview_available: bool,
}

fn is_gif_path(path: &Path) -> bool {
    path.extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("gif")).unwrap_or(false)
}

/// Thumbnail + (non-GIF, box given) preview from one decode, both written to
/// `cache_dir` before returning, so "thumbnail exists" implies "preview exists".
pub fn generate_and_cache(path: &Path, size: u32, preview_box: Option<&str>, cache_dir: &Path) -> Result<ThumbnailWithDimensions, String> {
    validate_image_path(path)?;
    let path_str = path.to_string_lossy().to_string();
    let bbox = match preview_box {
        Some(s) => Some(PreviewBox::parse(s).ok_or_else(|| format!("unsupported preview box: {s}"))?),
        None => None,
    };
    let stamp = cache::source_stamp(path).ok_or_else(|| "Failed to stat source file".to_string())?;
    let now = cache::current_unix_time();

    let (thumbnail_base64, natural_width, natural_height, stored_box) = match (bbox, is_gif_path(path)) {
        (Some(bbox), false) => {
            let g = preview::generate(path, bbox, size)?;
            cache::store_preview(cache_dir, &path_str, &bbox.key(), &g.preview_jpeg, &PreviewSidecar {
                natural_width: g.natural_width, natural_height: g.natural_height,
                source_mtime: stamp.0, source_size: stamp.1, created: now,
            })?;
            (g.thumbnail_base64, g.natural_width, g.natural_height, Some(bbox.key()))
        }
        _ => {
            let (b64, w, h) = preview::thumbnail_only(path, size)?;
            (b64, w, h, None)
        }
    };
    cache::store_thumbnail_entry(cache_dir, &path_str, size, &CacheEntry {
        thumbnail: thumbnail_base64.clone(), created: now,
        width: Some(natural_width), height: Some(natural_height),
        preview_box: stored_box.clone(), source_mtime: Some(stamp.0), source_size: Some(stamp.1),
    })?;
    Ok(ThumbnailWithDimensions {
        thumbnail_base64, original_width: natural_width, original_height: natural_height,
        preview_available: stored_box.is_some(),
    })
}

#[tauri::command]
pub async fn generate_thumbnail_with_dimensions(path: String, size: u32, preview_box: Option<String>) -> Result<ThumbnailWithDimensions, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _t = crate::utils::perf::PerfTimer::start("thumb_preview", &path);
        let cache_dir = cache::get_cache_dir()?;
        generate_and_cache(Path::new(&path), size, preview_box.as_deref(), &cache_dir)
    })
    .await
    .map_err(|e| format!("thumbnail task failed: {e}"))?
}
```

`generate_image_thumbnail` と `utils/image.rs` の `generate_thumbnail` / `get_image_dimensions` は他に利用箇所が無ければ削除（`utils/image.rs` のテストも併せて削除。`is_supported_image` / `get_image_format` は残す）。`lib.rs` の `generate_handler!` から `generate_image_thumbnail` を外す。Task 1 で入れた op `thumbnail` は本タスクで `thumb_preview` に置き換わる。

- [ ] **Step 4: 成功を確認**

Run: `cargo test --lib --manifest-path src-tauri/Cargo.toml` → 全 PASS
Run: `cargo build --manifest-path src-tauri/Cargo.toml` → warning なし（未使用 import を掃除）

- [ ] **Step 5: fmt + コミット**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/commands/file.rs src-tauri/src/lib.rs src-tauri/src/utils/image.rs
git commit -m "feat(rust): generate thumbnail and preview from one decode off the async runtime

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `/preview/<W>x<H>/` 配信ルート（TDD）

**Files:**
- Modify: `src-tauri/src/protocol.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Task 2 `preview::{generate, PreviewBox}`、Task 3 `cache::{load_preview, store_preview, source_stamp, current_unix_time, PreviewSidecar, get_cache_dir}`
- Produces:
  - `pub fn resolve_preview_request(rest: &str) -> Result<(PreviewBox, PathBuf), String>`（`rest` は `/preview/` を除いた `"1920x1080/<percent-encoded path>"`。ボックス不正 → `"unsupported preview box"`、以降は `resolve_image_path` と同じ検証）
  - `pub struct ServedPreview { pub bytes: Vec<u8>, pub natural_width: u32, pub natural_height: u32, pub generated: bool }`
  - `pub fn ensure_preview(cache_dir: &Path, path: &Path, bbox: PreviewBox, thumb_size: u32) -> Result<ServedPreview, String>`（キャッシュ命中なら `generated: false`、欠落/stale なら生成・保存して `true`）
  - レスポンス: `200`, `Content-Type: image/jpeg`, `X-Spica-Natural-Width`, `X-Spica-Natural-Height`, `Access-Control-Allow-Origin: *`, `Access-Control-Expose-Headers: X-Spica-Natural-Width, X-Spica-Natural-Height`。SPICA_PERF op `serve_preview`

- [ ] **Step 1: 失敗するテストを書く（`protocol.rs` tests）**

```rust
    #[test]
    fn test_resolve_preview_request_parses_box_and_path() {
        let temp_dir = create_temp_dir();
        let img = create_test_jpeg(temp_dir.path(), "p.jpg");
        let rest = format!("1920x1080{}", encode(&img));
        let (bbox, path) = resolve_preview_request(&rest).unwrap();
        assert_eq!(bbox.key(), "1920x1080");
        assert_eq!(path, img);
    }

    #[test]
    fn test_resolve_preview_request_rejects_bad_box_and_bad_path() {
        let temp_dir = create_temp_dir();
        let img = create_test_jpeg(temp_dir.path(), "p.jpg");
        assert!(resolve_preview_request(&format!("1234x567{}", encode(&img))).unwrap_err().contains("box"));
        assert!(resolve_preview_request("1920x1080").is_err());
        assert!(resolve_preview_request("1920x1080/C%3A%5Cnope%5Cmissing.jpg").unwrap_err().contains("not found"));
    }

    #[test]
    fn test_ensure_preview_generates_then_hits_cache() {
        let temp_dir = create_temp_dir();
        let cache = create_temp_dir();
        let img = create_gradient_jpeg(temp_dir.path(), "big.jpg", 2400, 1600);
        let bbox = PreviewBox::parse("1920x1080").unwrap();
        let first = ensure_preview(cache.path(), &img, bbox, 20).unwrap();
        assert!(first.generated);
        assert_eq!((first.natural_width, first.natural_height), (2400, 1600));
        assert_eq!(image::load_from_memory(&first.bytes).unwrap().width(), 1620);
        let second = ensure_preview(cache.path(), &img, bbox, 20).unwrap();
        assert!(!second.generated);
        assert_eq!(second.bytes, first.bytes);
    }
```

- [ ] **Step 2: 失敗を確認** — `cargo test --lib --manifest-path src-tauri/Cargo.toml protocol` → コンパイルエラー

- [ ] **Step 3: 実装（`protocol.rs`）**

```rust
use crate::commands::cache::{self, PreviewSidecar};
use crate::utils::preview::{self, PreviewBox};

pub const EXPOSE_HEADERS: &str = "X-Spica-Natural-Width, X-Spica-Natural-Height";

/// `rest` = everything after "/preview/": "<W>x<H>/<percent-encoded absolute path>".
pub fn resolve_preview_request(rest: &str) -> Result<(PreviewBox, PathBuf), String> {
    let (box_part, path_part) = rest.split_once('/').ok_or_else(|| "missing path".to_string())?;
    let bbox = PreviewBox::parse(box_part).ok_or_else(|| "unsupported preview box".to_string())?;
    let path = resolve_image_path(path_part)?;
    Ok((bbox, path))
}

pub struct ServedPreview {
    pub bytes: Vec<u8>,
    pub natural_width: u32,
    pub natural_height: u32,
    pub generated: bool,
}

/// Serve from the cache when the preview exists and its source stamp still
/// matches; otherwise generate it now (self-healing, e.g. after a cap sweep)
/// and store it for the next request.
pub fn ensure_preview(cache_dir: &Path, path: &Path, bbox: PreviewBox, thumb_size: u32) -> Result<ServedPreview, String> {
    let path_str = path.to_string_lossy().to_string();
    if let Some((bytes, side)) = cache::load_preview(cache_dir, &path_str, &bbox.key()) {
        return Ok(ServedPreview { bytes, natural_width: side.natural_width, natural_height: side.natural_height, generated: false });
    }
    let stamp = cache::source_stamp(path).ok_or_else(|| "Failed to stat source file".to_string())?;
    let g = preview::generate(path, bbox, thumb_size)?;
    cache::store_preview(cache_dir, &path_str, &bbox.key(), &g.preview_jpeg, &PreviewSidecar {
        natural_width: g.natural_width, natural_height: g.natural_height,
        source_mtime: stamp.0, source_size: stamp.1, created: cache::current_unix_time(),
    })?;
    Ok(ServedPreview { bytes: g.preview_jpeg, natural_width: g.natural_width, natural_height: g.natural_height, generated: true })
}

pub fn preview_response(served: &ServedPreview) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", "image/jpeg")
        .header("Access-Control-Allow-Origin", ALLOW_ORIGIN)
        .header("Access-Control-Expose-Headers", EXPOSE_HEADERS)
        .header("X-Spica-Natural-Width", served.natural_width.to_string())
        .header("X-Spica-Natural-Height", served.natural_height.to_string())
        .body(served.bytes.clone())
        .unwrap_or_else(|_| error_response(500, "response build failed"))
}
```

`lib.rs` のハンドラ（`spawn_blocking` 内）:

```rust
                let response = if let Some(rest) = uri_path.strip_prefix("/preview/") {
                    let _t = crate::utils::perf::PerfTimer::start("serve_preview", &uri_path);
                    match crate::protocol::resolve_preview_request(rest) {
                        Ok((bbox, path)) => match crate::commands::cache::get_cache_dir()
                            .and_then(|dir| crate::protocol::ensure_preview(&dir, &path, bbox, 20))
                        {
                            Ok(served) => crate::protocol::preview_response(&served),
                            Err(e) => crate::protocol::error_response(500, &e),
                        },
                        Err(msg) => crate::protocol::error_response(404, &msg),
                    }
                } else {
                    // （既存の原本配信 match をそのまま）
                };
```

`thumb_size` 20 はここでは未使用のサムネイル生成に使われるだけなので定数 `crate::utils::preview::DEFAULT_THUMB_SIZE: u32 = 20` を `preview.rs` に追加して使う（値は `src/constants/timing.ts` の `THUMBNAIL_SIZE` のミラー。コメントで明記）。

- [ ] **Step 4: 成功を確認** — `cargo test --lib --manifest-path src-tauri/Cargo.toml` → 全 PASS

- [ ] **Step 5: fmt + コミット**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/protocol.rs src-tauri/src/lib.rs src-tauri/src/utils/preview.rs
git commit -m "feat(rust): serve display-resolution previews over spica-img /preview/<box>/

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: フロント — `previewBox` の決定とサムネイル生成コマンドの切替（TDD）

**Files:**
- Create: `src/utils/previewBox.ts`、Test: `src/utils/__tests__/previewBox.test.ts`
- Modify: `src/constants/memory.ts`（`PREVIEW_BOXES`）
- Modify: `src/types/index.ts`（`ThumbnailWithDimensions.preview_available`）
- Modify: `src/hooks/useThumbnailGenerator.ts`、Test: `src/hooks/__tests__/useThumbnailGenerator.test.ts`

**Interfaces:**
- Produces: `PREVIEW_BOXES: ReadonlyArray<readonly [number, number]> = [[1920, 1080], [2560, 1440], [3840, 2160]]`、`previewBoxForScreen(width: number, height: number, dpr: number): string`（物理解像度を切り上げた最小バケット。画面が縦長なら "1080x1920" のように縦向き）、`currentPreviewBox(): string`（`window.screen` + `devicePixelRatio`）。Rust 側 allowlist と一致（Phase 3 のフロントのプレビュー取得もこの文字列を使う）

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/utils/__tests__/previewBox.test.ts
import { describe, expect, it } from "vitest";
import { previewBoxForScreen } from "../previewBox";

describe("previewBoxForScreen", () => {
  it("picks the smallest bucket that contains the physical screen", () => {
    expect(previewBoxForScreen(1920, 1080, 1)).toBe("1920x1080");
    expect(previewBoxForScreen(1536, 864, 1.25)).toBe("1920x1080"); // 1080p at 125%
    expect(previewBoxForScreen(2560, 1440, 1)).toBe("2560x1440");
    expect(previewBoxForScreen(1920, 1200, 1)).toBe("2560x1440"); // 16:10 overflows 1080 in height
    expect(previewBoxForScreen(3840, 2160, 1)).toBe("3840x2160");
  });

  it("caps at the largest bucket", () => {
    expect(previewBoxForScreen(5120, 2880, 1)).toBe("3840x2160");
  });

  it("orients the box like a portrait screen", () => {
    expect(previewBoxForScreen(1080, 1920, 1)).toBe("1080x1920");
  });

  it("falls back to the smallest bucket for unknown screens", () => {
    expect(previewBoxForScreen(0, 0, 1)).toBe("1920x1080");
    expect(previewBoxForScreen(1920, 1080, 0)).toBe("1920x1080");
  });
});
```

`src/hooks/__tests__/useThumbnailGenerator.test.ts` の変更:
- `generate_thumbnail_with_dimensions` のモック戻り値に `preview_available: true` を追加（全箇所）
- 「backend cache handling」に追加: `get_cached_thumbnail` が `{ path, size: THUMBNAIL_SIZE, previewBox: expect.stringMatching(/^\d+x\d+$/) }` で呼ばれること
- 「thumbnail generation with debounce」の最初のテストに追加: 成功時に `set_cached_thumbnail` が**呼ばれない**こと（`expect(mockInvoke).not.toHaveBeenCalledWith("set_cached_thumbnail", expect.anything())`）、`generate_thumbnail_with_dimensions` が `{ path, size: THUMBNAIL_SIZE, previewBox: expect.any(String) }` で呼ばれること
- 「error handling」のテスト（`set_cached_thumbnail` に `"error"`）は維持

- [ ] **Step 2: 失敗を確認** — `npx vitest --run src/utils/__tests__/previewBox.test.ts src/hooks/__tests__/useThumbnailGenerator.test.ts` → FAIL

- [ ] **Step 3: 実装**

```ts
// src/constants/memory.ts に追加
/**
 * Screen-box buckets for display-resolution previews (design spec D2).
 * Mirrors ALLOWED_PREVIEW_BOXES in src-tauri/src/utils/preview.rs.
 */
export const PREVIEW_BOXES: ReadonlyArray<readonly [number, number]> = [
  [1920, 1080],
  [2560, 1440],
  [3840, 2160],
];
```

```ts
// src/utils/previewBox.ts
import { PREVIEW_BOXES } from "../constants/memory";

/**
 * "WxH" of the smallest preview bucket that contains the screen in physical
 * pixels (CSS size × devicePixelRatio), oriented like the screen. fit-to-window
 * never exceeds the screen, so a preview fitted into this box is never upscaled.
 */
export const previewBoxForScreen = (
  width: number,
  height: number,
  dpr: number,
): string => {
  const scale = dpr > 0 ? dpr : 1;
  const w = Math.ceil(Math.max(0, width) * scale);
  const h = Math.ceil(Math.max(0, height) * scale);
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  const [bl, bs] =
    PREVIEW_BOXES.find(([l, s]) => l >= long && s >= short) ??
    PREVIEW_BOXES[PREVIEW_BOXES.length - 1];
  return h > w ? `${bs}x${bl}` : `${bl}x${bs}`;
};

export const currentPreviewBox = (): string =>
  previewBoxForScreen(
    window.screen?.width ?? 0,
    window.screen?.height ?? 0,
    window.devicePixelRatio || 1,
  );
```

`src/types/index.ts`: `ThumbnailWithDimensions` に `preview_available: boolean;` を追加。

`src/hooks/useThumbnailGenerator.ts` の `generateThumbnail`:

```ts
        const previewBox = currentPreviewBox();

        // First, try to get from backend cache (thumbnail + matching preview)
        const cachedThumbnail = await invoke<
          [string, number | null, number | null] | null
        >("get_cached_thumbnail", {
          path: imagePath,
          size: THUMBNAIL_SIZE,
          previewBox,
        });
        // （width/height null チェックは既存のまま）

        // Generate thumbnail + preview from one decode; the command writes
        // both to the disk cache before returning (I1), so no write-back here.
        const result = await invoke<ThumbnailWithDimensions>(
          "generate_thumbnail_with_dimensions",
          { path: imagePath, size: THUMBNAIL_SIZE, previewBox },
        );

        if (signal.aborted) return false;

        setCachedThumbnail(imagePath, {
          base64: result.thumbnail_base64,
          width: result.original_width,
          height: result.original_height,
        });
```

成功時の `await invoke("set_cached_thumbnail", {...})` ブロックを削除。エラー時の `set_cached_thumbnail`（`"error"`）は残す。import に `currentPreviewBox` と `ThumbnailWithDimensions` を追加。

- [ ] **Step 4: 成功を確認** — `npx vitest --run src/utils/__tests__/previewBox.test.ts src/hooks/__tests__/useThumbnailGenerator.test.ts` → 全 PASS。`npm run type-check` → clean

- [ ] **Step 5: biome + コミット**

```bash
npx biome format --write src/utils/previewBox.ts src/utils/__tests__/previewBox.test.ts src/constants/memory.ts src/types/index.ts src/hooks/useThumbnailGenerator.ts src/hooks/__tests__/useThumbnailGenerator.test.ts
npx biome lint src/utils/previewBox.ts src/utils/__tests__/previewBox.test.ts src/constants/memory.ts src/types/index.ts src/hooks/useThumbnailGenerator.ts src/hooks/__tests__/useThumbnailGenerator.test.ts
git add src/utils/previewBox.ts src/utils/__tests__/previewBox.test.ts src/constants/memory.ts src/types/index.ts src/hooks/useThumbnailGenerator.ts src/hooks/__tests__/useThumbnailGenerator.test.ts
git commit -m "feat(thumbnails): request previews alongside thumbnails (screen box) and stop the write-back

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: E2E — プレビュー配信の検証

**Files:**
- Create: `e2e/specs/preview.e2e.ts`
- Modify: `package.json`（`test:e2e` に `--spec e2e/specs/preview.e2e.ts` を centering の後に追加）

**Interfaces:**
- Consumes: Task 5 のルートとヘッダ、コーパス `large/img-000.jpg`（5472×3648）と `exif/img-000.jpg`（1200×800, orientation 6）

- [ ] **Step 1: スペックを書く**

```ts
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browser, expect } from "@wdio/globals";

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(here, "../fixtures/corpus");

type PreviewProbe = {
  ok: boolean;
  status: number;
  type: string;
  width: number;
  height: number;
  naturalWidth: string | null;
  naturalHeight: string | null;
  error?: string;
};

/** Fetches a preview in the page and decodes it, so we see what the viewer would see. */
const probePreview = (file: string, box: string): Promise<PreviewProbe> =>
  browser.executeAsync(
    (url: string, done: (r: PreviewProbe) => void) => {
      fetch(url)
        .then(async (r) => {
          const blob = await r.blob();
          const bitmap = r.ok ? await createImageBitmap(blob) : null;
          done({
            ok: r.ok,
            status: r.status,
            type: blob.type,
            width: bitmap?.width ?? 0,
            height: bitmap?.height ?? 0,
            naturalWidth: r.headers.get("X-Spica-Natural-Width"),
            naturalHeight: r.headers.get("X-Spica-Natural-Height"),
          });
          bitmap?.close();
        })
        .catch((e) =>
          done({
            ok: false,
            status: -1,
            type: "",
            width: 0,
            height: 0,
            naturalWidth: null,
            naturalHeight: null,
            error: String(e),
          }),
        );
    },
    `http://spica-img.localhost/preview/${box}/${encodeURIComponent(file)}`,
  );

describe("preview protocol", () => {
  it("serves a 20MP image fitted into the 1080p box with natural-size headers", async () => {
    const files = readdirSync(join(CORPUS, "large")).filter((f) => f.endsWith(".jpg")).sort();
    const probe = await probePreview(join(CORPUS, "large", files[0]), "1920x1080");
    expect(probe.ok).toBe(true);
    expect(probe.type).toBe("image/jpeg");
    expect([probe.width, probe.height]).toEqual([1620, 1080]); // 5472x3648 → fit 1920x1080
    expect(probe.naturalWidth).toBe("5472");
    expect(probe.naturalHeight).toBe("3648");
  });

  it("applies EXIF orientation to the preview and reports oriented natural size", async () => {
    const probe = await probePreview(join(CORPUS, "exif", "img-000.jpg"), "1920x1080");
    expect(probe.ok).toBe(true);
    expect([probe.width, probe.height]).toEqual([720, 1080]); // 800x1200 oriented → fit
    expect(probe.naturalWidth).toBe("800");
    expect(probe.naturalHeight).toBe("1200");
  });

  it("rejects unknown boxes and missing files", async () => {
    const files = readdirSync(join(CORPUS, "large")).filter((f) => f.endsWith(".jpg")).sort();
    const badBox = await probePreview(join(CORPUS, "large", files[0]), "1000x1000");
    expect(badBox.status).toBe(404);
    const missing = await probePreview("C:\\nope\\missing.jpg", "1920x1080");
    expect(missing.status).toBe(404);
  });
});
```

- [ ] **Step 2: `package.json` の `test:e2e` を更新**

`"test:e2e": "wdio run e2e/wdio.conf.ts --spec e2e/specs/smoke.e2e.ts --spec e2e/specs/centering.e2e.ts --spec e2e/specs/preview.e2e.ts --spec e2e/specs/visual.e2e.ts"`（package.json は CRLF — エディタ/Edit ツールで編集し、改行コードを保つ）

- [ ] **Step 3: biome + 型**

```bash
npx biome format --write e2e/specs/preview.e2e.ts
npx biome lint e2e/specs/preview.e2e.ts
npx tsc -p e2e/tsconfig.json --noEmit --pretty false
```

実行は Task 9（release ビルド後）。

- [ ] **Step 4: コミット**

```bash
git add e2e/specs/preview.e2e.ts package.json
git commit -m "test(e2e): verify preview serving (fit, orientation, natural-size headers, 404s)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: ドキュメント

**Files:**
- Modify: `docs/PERFORMANCE_AUTONOMY_PLAN.md` §2（Rust op の一覧）
- Modify: `docs/superpowers/specs/2026-08-21-thumbnail-implies-cached-preview-tier-design.md` §9（Phase 2 の状態）

- [ ] **Step 1: §2 のマーク表の後に Rust op の注記を追加**

```
> **Rust 側 op（`SPICA_PERF=1`、2026-08-22 追加）**: `thumb_preview`（`generate_thumbnail_with_dimensions` 全体 = 1 回のデコードからサムネイル + プレビューを生成しディスクへ書くまで。内訳 `preview_decode` / `preview_resize` / `preview_encode`）、`serve_preview`（`/preview/<box>/` 配信。キャッシュ命中時は読み出しのみ）。生成コストの回帰判定は `npm run profile:rust`（キャッシュ削除後、large 16 枚）の `thumb_preview` 中央値で行い、Phase 2 着手前の `thumbnail` 中央値 T0 の 1.3 倍以内を要求する。
```

- [ ] **Step 2: spec §9 の Phase 2 行を更新**

`- **Phase 2 — Rust プレビュー層**: ...` の末尾に `（**実装済み 2026-08-22**: プラン `docs/superpowers/plans/2026-08-22-preview-tier-phase2-rust-preview-layer.md`。計測結果は PR 本文と AUTONOMY_PLAN §8 注記）` を追記。

- [ ] **Step 3: コミット**

```bash
git add docs/PERFORMANCE_AUTONOMY_PLAN.md docs/superpowers/specs/2026-08-21-thumbnail-implies-cached-preview-tier-design.md
git commit -m "docs(perf): document Rust preview ops and Phase 2 status

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: ゲート（メインセッションで実行）

- [ ] **Step 1: 単体**

```bash
cargo test --lib --manifest-path src-tauri/Cargo.toml
npm test
npm run type-check
npx tsc -p e2e/tsconfig.json --noEmit --pretty false
```

- [ ] **Step 2: release ビルドと E2E（2 回連続 green）**

```bash
npm run bench:build
npm run test:e2e
npm run test:e2e
```

Expected: smoke 3 + centering 6 + preview 3 + visual 4 = 16/16

- [ ] **Step 3: 生成コスト T1（T0 は Task 1）**

```powershell
Remove-Item -Recurse -Force "$env:APPDATA\SpicaPhotoViewer\cache" -ErrorAction SilentlyContinue
npm run profile:rust
```

Expected: `thumb_preview n=16 median=<T1>`、内訳 `preview_decode` / `preview_resize` / `preview_encode` の中央値も記録。**判定: T1 ≤ 1.3 × T0**。超えたら停止して報告（spec Phase 4-b `turbojpeg` スケールデコードを先行する判断はユーザーへ）。2 回実行して一致を確認。

- [ ] **Step 4: フルベンチ（回帰ゲート）**

Run（バックグラウンド、他の重負荷なし）: `npm run bench`
判定（baseline 52650ab 比）: TTFI_cold / NAV_warm / NAV_rapid / NAV_visible の中央値が p95 を超えて悪化しない、全 n 完全。プレビューは表示に使われないため NAV 系は不変のはず。TTFI_cold はサムネイル生成（500ms デバウンス後）が重くなる分の競合に注意 — 悪化したら `thumb_preview` の内訳と合わせて報告。**baseline は更新しない**（改善主張なし。Phase 3 で更新）

- [ ] **Step 5: push と PR（base = Phase 1 ブランチ）**

```bash
git -c credential.helper="!gh auth git-credential" push https://github.com/hiz8/spica-photo-viewer.git worktree-preview-tier-phase2-rust
gh pr create --base worktree-preview-tier-phase1-measurement --head worktree-preview-tier-phase2-rust --title "feat(rust): display-resolution preview layer — coupled thumbnail/preview generation, disk cache, /preview/ route (preview-tier phase 2)" --body-file <本文>
```

PR 本文: 目的（Phase 2 = Rust 層のみ、表示は Phase 3）、I1 と検証、EXIF/ICC/alpha の扱い、キャッシュ形式（stamp・原子的書き込み・2GB 上限）、T0/T1 と内訳、bench 比較表、ゲート結果、`🤖 Generated with [Claude Code](https://claude.com/claude-code)`。PR #272 がマージされたら base を main にリターゲットする旨を書く。

---

## Self-Review 済みの確認点

- **Spec 対応**: §6.1（preview.rs: orientation/ICC/fast_image_resize/q85/黒合成/GIF 除外/op）→ Task 2、§6.2（コマンド拡張・spawn_blocking・JSON 拡張・mtime・原子的・容量上限・`set_cached_thumbnail` のエラー経路維持・`generate_image_thumbnail` 削除）→ Task 3/4、§6.3（ルート・自己修復・ヘッダ・op）→ Task 5、§6.7（generator の previewBox・書き戻し廃止・oriented 寸法）→ Task 6、§7.2 Rust テスト項目（orientation / ICC / ボックス以下無リサイズ / 透過黒合成 / mtime 不一致 / 原子的書き込み / 容量上限 / resolver のパースと拒否）→ Task 2/3/5、§7.3 の Phase 2 ゲート（+30%、TTFI 無悪化）→ Task 1/9
- **表示経路無変更**: ImageViewer / store / preloader / bitmap 系は一切触らない（Global Constraints）。プレビューはディスクに生成・配信されるだけで、Phase 3 までフロントは取得しない
- **型の一貫性**: `PreviewBox::parse/key`、`Generated` のフィールド名、`CacheEntry`/`PreviewSidecar` のフィールド名、`generate_and_cache` / `ensure_preview` / `lookup_thumbnail` / `store_preview` / `load_preview` のシグネチャは Task 2→5 で同一。フロントの `previewBox` 文字列形式 "WxH" は Rust の `PreviewBox::parse` と一致、バケット値は `PREVIEW_BOXES` と `ALLOWED_PREVIEW_BOXES` で同一
- **I1 の保証点**: `generate_and_cache` はプレビュー（jpg + sidecar）を書いてからサムネ JSON を書く。`lookup_thumbnail` はボックス要求時にプレビューの存在と stamp を検証。容量上限でプレビューが消えても JSON が残るだけで、lookup が None → 再生成で自己修復。プロトコル側も欠落時に生成
- **競合**: サムネ生成（コマンド）とプロトコル配信が同じ path を同時に生成し得るが、どちらも原子的書き込みで、最後の rename が勝つだけ（内容は同一）
- **既存テストの移行**: cache.rs の実ディレクトリ書き込みテストは削除し、ディレクトリ注入版で置換（Global Constraints）。utils/image.rs の `generate_thumbnail`/`get_image_dimensions` テストは関数削除に伴い削除
