use crate::commands::cache::{self, CacheEntry, PreviewSidecar};
use crate::utils::image::is_supported_image;
use crate::utils::natural_sort::natural_cmp;
use crate::utils::preview::{self, PreviewBox};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

// Windows API constants
#[cfg(target_os = "windows")]
const MAX_PATH_EXTENDED: usize = 32768;

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

#[derive(Debug, Serialize, Deserialize)]
pub struct ThumbnailWithDimensions {
    pub thumbnail_base64: String,
    pub original_width: u32,
    pub original_height: u32,
    /// true when a display-resolution preview for the requested box is now on disk (I1).
    pub preview_available: bool,
}

#[tauri::command]
pub async fn get_folder_images(path: String) -> Result<Vec<ImageInfo>, String> {
    let folder_path = Path::new(&path);

    if !folder_path.exists() || !folder_path.is_dir() {
        return Err("Invalid folder path".to_string());
    }

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

    sort_images(&mut images, SortSpec::default());
    Ok(images)
}

fn validate_image_path(path: &Path) -> Result<(), String> {
    if !path.exists() || !path.is_file() {
        return Err("File not found".to_string());
    }
    if !is_supported_image(path) {
        return Err("Unsupported file format".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn handle_dropped_file(path: String) -> Result<ImageInfo, String> {
    let file_path = Path::new(&path);
    validate_image_path(file_path)?;
    get_image_info(file_path)
}

#[tauri::command]
pub fn validate_image_file(path: String) -> Result<bool, String> {
    let file_path = Path::new(&path);
    Ok(file_path.exists() && file_path.is_file() && is_supported_image(file_path))
}

#[tauri::command]
pub fn get_startup_file() -> Result<Option<String>, String> {
    let args: Vec<String> = std::env::args().collect();

    // Look for image file in command line arguments (usually args[1])
    for arg in &args[1..] {
        let path = Path::new(arg);
        if path.exists() && path.is_file() && is_supported_image(path) {
            return Ok(Some(arg.clone()));
        }
    }

    Ok(None)
}

fn is_gif_path(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("gif"))
        .unwrap_or(false)
}

/// Thumbnail + (non-GIF, box given) preview from one decode, both written to
/// `cache_dir` before returning, so "thumbnail exists" implies "preview exists".
pub fn generate_and_cache(
    path: &Path,
    size: u32,
    preview_box: Option<&str>,
    cache_dir: &Path,
) -> Result<ThumbnailWithDimensions, String> {
    validate_image_path(path)?;
    let path_str = path.to_string_lossy().to_string();
    let bbox = match preview_box {
        Some(s) => {
            Some(PreviewBox::parse(s).ok_or_else(|| format!("unsupported preview box: {s}"))?)
        }
        None => None,
    };
    let stamp =
        cache::source_stamp(path).ok_or_else(|| "Failed to stat source file".to_string())?;
    let now = cache::current_unix_time();

    let (thumbnail_base64, natural_width, natural_height, stored_box) =
        match (bbox, is_gif_path(path)) {
            (Some(bbox), false) => {
                let g = preview::generate(path, bbox, size)?;
                cache::store_preview(
                    cache_dir,
                    &path_str,
                    &bbox.key(),
                    &g.preview_jpeg,
                    &PreviewSidecar {
                        natural_width: g.natural_width,
                        natural_height: g.natural_height,
                        source_mtime: stamp.0,
                        source_size: stamp.1,
                        created: now,
                    },
                )?;
                (
                    g.thumbnail_base64,
                    g.natural_width,
                    g.natural_height,
                    Some(bbox.key()),
                )
            }
            _ => {
                let (b64, w, h) = preview::thumbnail_only(path, size)?;
                (b64, w, h, None)
            }
        };
    cache::store_thumbnail_entry(
        cache_dir,
        &path_str,
        size,
        &CacheEntry {
            thumbnail: thumbnail_base64.clone(),
            created: now,
            width: Some(natural_width),
            height: Some(natural_height),
            preview_box: stored_box.clone(),
            source_mtime: Some(stamp.0),
            source_size: Some(stamp.1),
        },
    )?;
    Ok(ThumbnailWithDimensions {
        thumbnail_base64,
        original_width: natural_width,
        original_height: natural_height,
        preview_available: stored_box.is_some(),
    })
}

#[tauri::command]
pub async fn generate_thumbnail_with_dimensions(
    path: String,
    size: u32,
    preview_box: Option<String>,
) -> Result<ThumbnailWithDimensions, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _t = crate::utils::perf::PerfTimer::start("thumb_preview", &path);
        // M5: validate before touching the cache dir, so a bad path fails
        // without creating the real cache directory as a side effect.
        validate_image_path(Path::new(&path))?;
        let cache_dir = cache::get_cache_dir()?;
        generate_and_cache(Path::new(&path), size, preview_box.as_deref(), &cache_dir)
    })
    .await
    .map_err(|e| format!("thumbnail task failed: {e}"))?
}

/// Validates the file path and converts it to a short path name (8.3 format) for Windows.
///
/// This function handles special characters (parentheses, spaces, Japanese characters, etc.)
/// by converting the path to Windows short path name format, which avoids command-line
/// escaping issues when passing to rundll32.exe.
///
/// Returns the prepared path as a String, or an error if validation fails.
#[cfg(target_os = "windows")]
fn prepare_path_for_open_with(path: &str) -> Result<String, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetShortPathNameW;

    let file_path = Path::new(path);

    // Validate file exists
    if !file_path.exists() {
        return Err("File not found".to_string());
    }

    if !file_path.is_file() {
        return Err("Path is not a file".to_string());
    }

    // Convert path to absolute path
    let absolute_path = file_path
        .canonicalize()
        .map_err(|e| format!("Failed to get absolute path: {}", e))?;

    // Convert to string and remove the UNC prefix (\\?\) if present
    let mut path_str = absolute_path.to_string_lossy().to_string();
    if path_str.starts_with(r"\\?\") {
        path_str = path_str[4..].to_string();
    }

    // Convert to short path name (8.3 format) to avoid issues with special characters
    // like parentheses, spaces, etc. in file names
    let path_wide: Vec<u16> = path_str.encode_utf16().chain(Some(0)).collect();
    let mut short_path_buf: Vec<u16> = vec![0; MAX_PATH_EXTENDED];

    unsafe {
        use windows::Win32::Foundation::GetLastError;

        let result = GetShortPathNameW(PCWSTR(path_wide.as_ptr()), Some(&mut short_path_buf));

        if result == 0 {
            // GetShortPathNameW failed - check the error code
            let error = GetLastError();
            // ERROR_PATH_NOT_FOUND (3), ERROR_ACCESS_DENIED (5), ERROR_INVALID_NAME (123)
            // Log the error but fall back to original path for compatibility
            // This allows the function to work even if short path conversion is not available
            eprintln!(
                "GetShortPathNameW failed with error code {:?}, falling back to original path",
                error
            );
            Ok(path_str)
        } else {
            // Use the short path name
            let short_path = String::from_utf16_lossy(&short_path_buf[..result as usize]);
            Ok(short_path)
        }
    }
}

#[tauri::command]
pub fn open_with_dialog(path: String) -> Result<(), String> {
    // Windows-specific implementation
    #[cfg(target_os = "windows")]
    {
        // Validate and prepare the path
        let _prepared_path = prepare_path_for_open_with(&path)?;

        // Skip actual dialog spawn during tests to avoid UI interaction
        #[cfg(not(test))]
        {
            use std::process::Command;

            Command::new("rundll32.exe")
                .arg("shell32.dll,OpenAs_RunDLL")
                .arg(&_prepared_path)
                .spawn()
                .map_err(|e| format!("Failed to spawn rundll32.exe: {}", e))?;
        }

        Ok(())
    }

    // Non-Windows platforms
    #[cfg(not(target_os = "windows"))]
    {
        Err("Open With dialog is only supported on Windows".to_string())
    }
}

fn get_image_info(path: &Path) -> Result<ImageInfo, String> {
    let metadata =
        fs::metadata(path).map_err(|e| format!("Failed to read file metadata: {}", e))?;

    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("unknown")
        .to_string();

    let format = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_lowercase();

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

    // Note: Image validation is deferred to actual image loading time (spica-img protocol serve,
    // generate_thumbnail) to avoid opening 900+ files during folder scan, which causes significant
    // delays. Corrupted images will be detected when actually loaded via image::open() / browser decode.

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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::*;
    use std::fs;

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
        assert!(
            crate::commands::cache::lookup_thumbnail(cache.path(), &p, 20, Some("1920x1080"))
                .is_some()
        );
        let (bytes, side) =
            crate::commands::cache::load_preview(cache.path(), &p, "1920x1080").unwrap();
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
        assert!(
            crate::commands::cache::lookup_thumbnail(cache.path(), &p, 20, Some("1920x1080"))
                .is_some()
        );
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
        assert!(
            crate::commands::cache::lookup_thumbnail(cache.path(), &p, 20, Some("1920x1080"))
                .is_none()
        );
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
        let r = generate_thumbnail_with_dimensions(
            "C:\\nope\\missing.jpg".to_string(),
            20,
            Some("1920x1080".to_string()),
        )
        .await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn test_get_folder_images_with_valid_folder() {
        let temp_dir = create_temp_dir();

        // Create test images
        create_test_jpeg(temp_dir.path(), "image1.jpg");
        create_test_png(temp_dir.path(), "image2.png");
        create_test_gif(temp_dir.path(), "image3.gif");

        let result = get_folder_images(temp_dir.path().to_string_lossy().to_string()).await;
        assert!(result.is_ok());

        let images = result.unwrap();
        assert_eq!(images.len(), 3);

        // Check sorting (should be alphabetical)
        assert_eq!(images[0].filename, "image1.jpg");
        assert_eq!(images[1].filename, "image2.png");
        assert_eq!(images[2].filename, "image3.gif");
    }

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

    /// Builds an ImageInfo for sort tests. Seconds fields derive from the ns
    /// fields the same way get_image_info does.
    fn sort_info(
        filename: &str,
        size: u64,
        modified_ns: u64,
        created_ns: u64,
        format: &str,
    ) -> ImageInfo {
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

        sort_images(
            &mut v,
            SortSpec {
                key: SortKey::Name,
                descending: true,
            },
        );
        assert_eq!(names(&v), ["img10.jpg", "img2.jpg", "IMG_1.jpg"]);
    }

    #[test]
    fn test_sort_images_size_with_name_tiebreak() {
        let mut v = vec![
            sort_info("b.jpg", 200, 1, 1, "jpeg"),
            sort_info("c.jpg", 100, 1, 1, "jpeg"),
            sort_info("a.jpg", 100, 1, 1, "jpeg"),
        ];
        sort_images(
            &mut v,
            SortSpec {
                key: SortKey::Size,
                descending: false,
            },
        );
        assert_eq!(names(&v), ["a.jpg", "c.jpg", "b.jpg"]);

        // Descending flips the primary key only; the tie between a/c stays
        // name-ASCENDING (I1).
        sort_images(
            &mut v,
            SortSpec {
                key: SortKey::Size,
                descending: true,
            },
        );
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
        sort_images(
            &mut v,
            SortSpec {
                key: SortKey::Modified,
                descending: false,
            },
        );
        assert_eq!(names(&v), ["b.jpg", "a.jpg"]);
    }

    #[test]
    fn test_sort_images_created_uses_ns_precision() {
        let base = 1_700_000_000_000_000_000u64;
        let mut v = vec![
            sort_info("a.jpg", 1, 1, base + 500_000_000, "jpeg"),
            sort_info("b.jpg", 1, 1, base + 100_000_000, "jpeg"),
        ];
        sort_images(
            &mut v,
            SortSpec {
                key: SortKey::Created,
                descending: false,
            },
        );
        assert_eq!(names(&v), ["b.jpg", "a.jpg"]);
    }

    #[test]
    fn test_sort_images_type_then_name() {
        let mut v = vec![
            sort_info("b.png", 1, 1, 1, "png"),
            sort_info("a.jpg", 1, 1, 1, "jpeg"),
            sort_info("c.gif", 1, 1, 1, "gif"),
        ];
        sort_images(
            &mut v,
            SortSpec {
                key: SortKey::Type,
                descending: false,
            },
        );
        assert_eq!(names(&v), ["c.gif", "a.jpg", "b.png"]);
    }

    #[test]
    fn test_sort_images_empty_and_single() {
        let mut empty: Vec<ImageInfo> = vec![];
        sort_images(&mut empty, SortSpec::default());
        assert!(empty.is_empty());

        let mut one = vec![sort_info("a.jpg", 1, 1, 1, "jpeg")];
        sort_images(
            &mut one,
            SortSpec {
                key: SortKey::Modified,
                descending: true,
            },
        );
        assert_eq!(names(&one), ["a.jpg"]);
    }

    #[tokio::test]
    async fn test_get_folder_images_with_invalid_folder() {
        let result = get_folder_images("/nonexistent/path".to_string()).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid folder path"));
    }

    #[tokio::test]
    async fn test_get_folder_images_with_empty_folder() {
        let temp_dir = create_temp_dir();

        let result = get_folder_images(temp_dir.path().to_string_lossy().to_string()).await;
        assert!(result.is_ok());

        let images = result.unwrap();
        assert_eq!(images.len(), 0);
    }

    #[tokio::test]
    async fn test_get_folder_images_with_mixed_files() {
        let temp_dir = create_temp_dir();

        // Create test images and non-image files
        create_test_jpeg(temp_dir.path(), "image1.jpg");
        create_invalid_image(temp_dir.path(), "textfile.txt");
        create_test_png(temp_dir.path(), "image2.png");

        let result = get_folder_images(temp_dir.path().to_string_lossy().to_string()).await;
        assert!(result.is_ok());

        let images = result.unwrap();
        assert_eq!(images.len(), 2); // Only valid images
        assert_eq!(images[0].filename, "image1.jpg");
        assert_eq!(images[1].filename, "image2.png");
    }

    #[tokio::test]
    async fn test_get_folder_images_defers_validation_to_load_time() {
        let temp_dir = create_temp_dir();

        // Create valid and corrupted images with valid extensions
        create_test_jpeg(temp_dir.path(), "valid.jpg");
        create_fake_image(temp_dir.path(), "corrupted.jpg");

        let result = get_folder_images(temp_dir.path().to_string_lossy().to_string()).await;
        assert!(result.is_ok());

        let images = result.unwrap();
        // Both files are included (validation deferred to load time for performance)
        assert_eq!(images.len(), 2);
        assert_eq!(images[0].filename, "corrupted.jpg");
        assert_eq!(images[1].filename, "valid.jpg");
    }

    #[tokio::test]
    async fn test_get_folder_images_with_subdirectories() {
        let temp_dir = create_temp_dir();

        // Create image in root
        create_test_jpeg(temp_dir.path(), "root.jpg");

        // Create subdirectory with image
        let sub_dir = temp_dir.path().join("subdir");
        fs::create_dir(&sub_dir).unwrap();
        create_test_png(&sub_dir, "sub.png");

        let result = get_folder_images(temp_dir.path().to_string_lossy().to_string()).await;
        assert!(result.is_ok());

        let images = result.unwrap();
        // Should only include files from root directory (max_depth = 1)
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].filename, "root.jpg");
    }

    #[tokio::test]
    async fn test_get_folder_images_case_insensitive_extensions() {
        let temp_dir = create_temp_dir();

        // Create images with different case extensions
        create_test_jpeg(temp_dir.path(), "lower.jpg");
        create_test_jpeg(temp_dir.path(), "upper.JPG");
        create_test_jpeg(temp_dir.path(), "mixed.Jpeg");

        let result = get_folder_images(temp_dir.path().to_string_lossy().to_string()).await;
        assert!(result.is_ok());

        let images = result.unwrap();
        assert_eq!(images.len(), 3);
    }

    #[tokio::test]
    async fn test_handle_dropped_file_with_valid_image() {
        let temp_dir = create_temp_dir();
        let image_path = create_test_jpeg(temp_dir.path(), "dropped.jpg");

        let result = handle_dropped_file(image_path.to_string_lossy().to_string()).await;
        assert!(result.is_ok());

        let image_info = result.unwrap();
        assert_eq!(image_info.filename, "dropped.jpg");
        assert_eq!(image_info.format, "jpg");
    }

    #[tokio::test]
    async fn test_handle_dropped_file_with_nonexistent_file() {
        let result = handle_dropped_file("/nonexistent/file.jpg".to_string()).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("File not found"));
    }

    #[tokio::test]
    async fn test_handle_dropped_file_with_unsupported_format() {
        let temp_dir = create_temp_dir();
        let text_file = temp_dir.path().join("text.txt");
        fs::write(&text_file, "not an image").unwrap();

        let result = handle_dropped_file(text_file.to_string_lossy().to_string()).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unsupported file format"));
    }

    #[tokio::test]
    async fn test_handle_dropped_file_with_corrupted_image() {
        let temp_dir = create_temp_dir();
        let corrupted_path = create_fake_image(temp_dir.path(), "corrupted.jpg");

        let result = handle_dropped_file(corrupted_path.to_string_lossy().to_string()).await;
        // Corrupted images are accepted at file info level (validation deferred to load time)
        assert!(result.is_ok());
        let info = result.unwrap();
        assert_eq!(info.filename, "corrupted.jpg");
    }

    #[test]
    fn test_validate_image_file_with_valid_image() {
        let temp_dir = create_temp_dir();
        let image_path = create_test_jpeg(temp_dir.path(), "valid.jpg");

        let result = validate_image_file(image_path.to_string_lossy().to_string());
        assert!(result.is_ok());
        assert!(result.unwrap());
    }

    #[test]
    fn test_validate_image_file_with_nonexistent_file() {
        let result = validate_image_file("/nonexistent/file.jpg".to_string());
        assert!(result.is_ok());
        assert!(!result.unwrap());
    }

    #[test]
    fn test_validate_image_file_with_unsupported_format() {
        let temp_dir = create_temp_dir();
        let text_file = temp_dir.path().join("text.txt");
        fs::write(&text_file, "not an image").unwrap();

        let result = validate_image_file(text_file.to_string_lossy().to_string());
        assert!(result.is_ok());
        assert!(!result.unwrap());
    }

    #[test]
    fn test_validate_image_file_with_directory() {
        let temp_dir = create_temp_dir();

        let result = validate_image_file(temp_dir.path().to_string_lossy().to_string());
        assert!(result.is_ok());
        assert!(!result.unwrap()); // Directory should not be valid
    }

    #[test]
    fn test_get_startup_file_with_no_args() {
        // This test checks the current behavior, but might not work in test environment
        // since std::env::args() returns the test runner arguments
        let result = get_startup_file();
        assert!(result.is_ok());
        // Result can be None (no image file arguments) or Some(path) if test happens to pass an image
    }

    #[test]
    fn test_get_startup_file_functionality() {
        // Since we can't easily mock std::env::args(), we test the logic indirectly
        // by testing the function doesn't panic and returns Ok
        let result = get_startup_file();
        assert!(result.is_ok());
    }

    #[test]
    fn test_open_with_dialog_with_valid_file() {
        let temp_dir = create_temp_dir();
        let image_path = create_test_jpeg(temp_dir.path(), "test.jpg");

        let result = open_with_dialog(image_path.to_string_lossy().to_string());

        // In test environment, actual dialog spawn is skipped
        #[cfg(target_os = "windows")]
        {
            assert!(result.is_ok());
        }

        #[cfg(not(target_os = "windows"))]
        {
            assert!(result.is_err());
            assert!(result.unwrap_err().contains("only supported on Windows"));
        }
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn test_open_with_dialog_with_nonexistent_file() {
        let result = open_with_dialog("/nonexistent/file.jpg".to_string());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("File not found"));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn test_open_with_dialog_with_directory() {
        let temp_dir = create_temp_dir();

        let result = open_with_dialog(temp_dir.path().to_string_lossy().to_string());
        assert!(result.is_err());
        let error_msg = result.unwrap_err();
        assert!(
            error_msg.contains("File not found") || error_msg.contains("Path is not a file"),
            "Expected error about file not found, got: {}",
            error_msg
        );
    }

    #[test]
    fn test_open_with_dialog_with_parentheses_in_filename() {
        let temp_dir = create_temp_dir();
        let image_path = create_test_jpeg(temp_dir.path(), "test (Custom).jpg");

        let result = open_with_dialog(image_path.to_string_lossy().to_string());

        // Regression test for special characters (parentheses) in filename
        // In test environment, actual dialog spawn is skipped
        #[cfg(target_os = "windows")]
        {
            assert!(result.is_ok(), "Should handle parentheses in filename");
        }

        #[cfg(not(target_os = "windows"))]
        {
            assert!(result.is_err());
            assert!(result.unwrap_err().contains("only supported on Windows"));
        }
    }

    #[test]
    fn test_open_with_dialog_with_spaces_in_filename() {
        let temp_dir = create_temp_dir();
        let image_path = create_test_jpeg(temp_dir.path(), "test with spaces.jpg");

        let result = open_with_dialog(image_path.to_string_lossy().to_string());

        // Regression test for spaces in filename
        // In test environment, actual dialog spawn is skipped
        #[cfg(target_os = "windows")]
        {
            assert!(result.is_ok(), "Should handle spaces in filename");
        }

        #[cfg(not(target_os = "windows"))]
        {
            assert!(result.is_err());
            assert!(result.unwrap_err().contains("only supported on Windows"));
        }
    }

    #[test]
    fn test_open_with_dialog_with_japanese_filename() {
        let temp_dir = create_temp_dir();
        let image_path = create_test_jpeg(temp_dir.path(), "テスト画像.jpg");

        let result = open_with_dialog(image_path.to_string_lossy().to_string());

        // Regression test for non-ASCII characters (Japanese) in filename
        // In test environment, actual dialog spawn is skipped
        #[cfg(target_os = "windows")]
        {
            assert!(
                result.is_ok(),
                "Should handle Japanese characters in filename"
            );
        }

        #[cfg(not(target_os = "windows"))]
        {
            assert!(result.is_err());
            assert!(result.unwrap_err().contains("only supported on Windows"));
        }
    }
}
