//! Spec: docs/superpowers/specs/2026-08-21-thumbnail-implies-cached-preview-tier-design.md

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
/// D3: previews are ~0.3-1.5 MB each; cap the total so a 900-image folder on a
/// 4K box cannot grow unbounded.
pub const PREVIEW_CACHE_CAP_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// `write_atomic`'s temp files only ever live for milliseconds; anything
/// still around this long is orphaned (crash mid-write) and invisible to
/// `stats`, so `sweep` reclaims it.
const STALE_TMP_AGE_SECS: u64 = 60 * 60;

pub(crate) fn get_cache_dir() -> Result<PathBuf, String> {
    let cache_dir = if cfg!(target_os = "windows") {
        let app_data =
            std::env::var("APPDATA").map_err(|_| "Failed to get APPDATA directory".to_string())?;
        Path::new(&app_data).join("SpicaPhotoViewer").join("cache")
    } else if cfg!(target_os = "macos") {
        let home = std::env::var("HOME").map_err(|_| "Failed to get HOME directory".to_string())?;
        Path::new(&home)
            .join("Library")
            .join("Caches")
            .join("SpicaPhotoViewer")
    } else {
        let cache_base = std::env::var("XDG_CACHE_HOME").unwrap_or_else(|_| {
            match std::env::var("HOME") {
                Ok(home) => format!("{}/.cache", home),
                Err(_) => {
                    eprintln!("Warning: HOME environment variable not set. Using /tmp/.cache as cache base.");
                    "/tmp/.cache".to_string()
                }
            }
        });
        Path::new(&cache_base).join("SpicaPhotoViewer")
    };

    if !cache_dir.exists() {
        fs::create_dir_all(&cache_dir)
            .map_err(|e| format!("Failed to create cache directory: {}", e))?;
    }

    Ok(cache_dir)
}

fn hash_key(parts: &[&str]) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    for p in parts {
        p.hash(&mut hasher);
    }
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

pub fn current_unix_time() -> u64 {
    // Falls back to 0 for the impossible case of a pre-epoch system clock; combined with the
    // `saturating_sub` callers below, this just defers any cache eviction until time corrects.
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs()
}

pub fn source_stamp(path: &Path) -> Option<(u64, u64)> {
    let meta = fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some((mtime, meta.len()))
}

/// Write to a sibling temp file, then rename over the target (atomic on NTFS;
/// `std::fs::rename` replaces an existing destination on Windows).
pub fn write_atomic(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    // pid+nanos alone can collide when the command path and the protocol
    // path race to write the same preview within one tick; a process-wide
    // counter makes every temp name unique regardless of timer resolution.
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut tmp = target.as_os_str().to_owned();
    tmp.push(format!(".tmp-{}-{}-{}", std::process::id(), nanos, seq));
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, bytes)?;
    match fs::rename(&tmp, target) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

fn is_gif(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("gif"))
        .unwrap_or(false)
}

fn stamp_matches(path: &str, mtime: Option<u64>, size: Option<u64>) -> bool {
    // mtime is compared at whole-second granularity (FAT32: 2 s); a same-second, same-size in-place edit is invisible — acceptable for photo files.
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
        Err(_) => {
            let _ = fs::remove_file(&file);
            return None;
        }
    };
    if current_unix_time().saturating_sub(entry.created) > CACHE_DURATION {
        let _ = fs::remove_file(&file);
        return None;
    }
    Some(entry)
}

pub fn store_thumbnail_entry(
    cache_dir: &Path,
    path: &str,
    size: u32,
    entry: &CacheEntry,
) -> Result<(), String> {
    let json = serde_json::to_string(entry)
        .map_err(|e| format!("Failed to serialize cache entry: {e}"))?;
    write_atomic(&json_file(cache_dir, path, size), json.as_bytes())
        .map_err(|e| format!("Failed to write cache file: {e}"))
}

/// Thumbnail lookup honoring I1: with a box requested, the matching preview
/// (jpg + sidecar, fresh stamp) must be on disk — GIF excepted. Non-error
/// entries without a source stamp (pre-2026-08 format) count as stale. An
/// "error" entry is exempt from the stamp check only when it carries no
/// stamp at all (couldn't stat the source when the error was recorded);
/// once a stamp is on record it is honored like any other entry, so
/// replacing a corrupt file with a valid one clears "error" immediately
/// instead of waiting out the 24h TTL (F3).
pub fn lookup_thumbnail(
    cache_dir: &Path,
    path: &str,
    size: u32,
    preview_box: Option<&str>,
) -> Option<(String, Option<u32>, Option<u32>)> {
    let entry = read_entry(cache_dir, path, size)?;
    let needs_stamp_check = entry.thumbnail != "error" || entry.source_mtime.is_some();
    if needs_stamp_check && !stamp_matches(path, entry.source_mtime, entry.source_size) {
        return None;
    }
    if let Some(bk) = preview_box {
        if !is_gif(path) && entry.thumbnail != "error" {
            if entry.preview_box.as_deref() != Some(bk) {
                return None;
            }
            // F1: metadata-only — do not read the (0.3-1.5 MB) preview jpg just
            // to confirm it exists on this hot thumbnail-bar path.
            preview_is_fresh(cache_dir, path, bk)?;
        }
    }
    Some((entry.thumbnail, entry.width, entry.height))
}

pub fn store_preview(
    cache_dir: &Path,
    path: &str,
    box_key: &str,
    jpeg: &[u8],
    sidecar: &PreviewSidecar,
) -> Result<(), String> {
    write_atomic(&preview_file(cache_dir, path, box_key), jpeg)
        .map_err(|e| format!("Failed to write preview: {e}"))?;
    let json =
        serde_json::to_string(sidecar).map_err(|e| format!("Failed to serialize sidecar: {e}"))?;
    write_atomic(
        &preview_sidecar_file(cache_dir, path, box_key),
        json.as_bytes(),
    )
    .map_err(|e| format!("Failed to write sidecar: {e}"))
}

/// Metadata-only freshness check for the preview named `box_key`: parses the
/// sidecar, confirms its stamp still matches the source file, and confirms
/// the jpg is on disk — without reading the jpg's bytes (F1). Use this on
/// hot paths that only need a yes/no answer; use `load_preview` when the
/// bytes are actually needed.
pub fn preview_is_fresh(cache_dir: &Path, path: &str, box_key: &str) -> Option<PreviewSidecar> {
    let side: PreviewSidecar = serde_json::from_str(
        &fs::read_to_string(preview_sidecar_file(cache_dir, path, box_key)).ok()?,
    )
    .ok()?;
    if !stamp_matches(path, Some(side.source_mtime), Some(side.source_size)) {
        return None;
    }
    if !preview_file(cache_dir, path, box_key).is_file() {
        return None;
    }
    Some(side)
}

pub fn load_preview(
    cache_dir: &Path,
    path: &str,
    box_key: &str,
) -> Option<(Vec<u8>, PreviewSidecar)> {
    let side = preview_is_fresh(cache_dir, path, box_key)?;
    let bytes = fs::read(preview_file(cache_dir, path, box_key)).ok()?;
    Some((bytes, side))
}

/// Startup housekeeping: age out everything older than `max_age_secs`, then
/// evict the oldest previews until the preview total is under `cap_bytes`.
/// Returns the number of removed entries (a preview jpg + its sidecar = 1).
pub fn sweep(cache_dir: &Path, now_secs: u64, max_age_secs: u64, cap_bytes: u64) -> usize {
    let Ok(entries) = fs::read_dir(cache_dir) else {
        return 0;
    };
    let mut removed = 0usize;
    let mut previews: Vec<(PathBuf, u64, u64)> = Vec::new(); // (jpg, mtime, len)
    for entry in entries.flatten() {
        let p = entry.path();
        let name = p
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if name.contains(".tmp-") {
            // Orphaned `write_atomic` temp file from a crash mid-write —
            // normally live for milliseconds, so anything this old is dead
            // and otherwise invisible to `stats`.
            let mtime = fs::metadata(&p)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            if now_secs.saturating_sub(mtime) > STALE_TMP_AGE_SECS && fs::remove_file(&p).is_ok() {
                removed += 1;
            }
        } else if name.ends_with("_p.jpg") {
            let meta = match fs::metadata(&p) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            if now_secs.saturating_sub(mtime) > max_age_secs {
                remove_preview_pair(&p);
                removed += 1;
            } else {
                previews.push((p, mtime, meta.len()));
            }
        } else if name.ends_with("_p.json") {
            // Orphan sidecar (jpg gone) → drop it.
            let jpg = p.with_file_name(name.replace("_p.json", "_p.jpg"));
            if !jpg.exists() {
                let _ = fs::remove_file(&p);
            }
        } else if name.ends_with(".json") {
            match fs::read_to_string(&p)
                .ok()
                .and_then(|c| serde_json::from_str::<CacheEntry>(&c).ok())
            {
                Some(e) if now_secs.saturating_sub(e.created) <= max_age_secs => {}
                _ => {
                    if fs::remove_file(&p).is_ok() {
                        removed += 1;
                    }
                }
            }
        }
    }
    let mut total: u64 = previews.iter().map(|p| p.2).sum();
    previews.sort_by_key(|p| p.1); // oldest first
    for (jpg, _, len) in previews {
        if total <= cap_bytes {
            break;
        }
        remove_preview_pair(&jpg);
        removed += 1;
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
        ("total_files".to_string(), 0u64),
        ("valid_files".to_string(), 0u64),
        ("preview_files".to_string(), 0u64),
        ("preview_bytes".to_string(), 0u64),
    ]);
    let Ok(entries) = fs::read_dir(cache_dir) else {
        return s;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        let name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if name.ends_with("_p.jpg") {
            *s.get_mut("preview_files").unwrap() += 1;
            *s.get_mut("preview_bytes").unwrap() += fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        } else if name.ends_with(".json") && !name.ends_with("_p.json") {
            *s.get_mut("total_files").unwrap() += 1;
            if let Some(e) = fs::read_to_string(&p)
                .ok()
                .and_then(|c| serde_json::from_str::<CacheEntry>(&c).ok())
            {
                if now_secs.saturating_sub(e.created) <= max_age_secs {
                    *s.get_mut("valid_files").unwrap() += 1;
                }
            }
        }
    }
    s
}

// ---- commands: thin wrappers over the injected-directory functions ----

#[tauri::command]
pub async fn get_cached_thumbnail(
    path: String,
    size: Option<u32>,
    preview_box: Option<String>,
) -> Result<Option<(String, Option<u32>, Option<u32>)>, String> {
    let cache_dir = get_cache_dir()?;
    Ok(lookup_thumbnail(
        &cache_dir,
        &path,
        size.unwrap_or(30),
        preview_box.as_deref(),
    ))
}

#[tauri::command]
pub async fn set_cached_thumbnail(
    path: String,
    thumbnail: String,
    size: Option<u32>,
    width: Option<u32>,
    height: Option<u32>,
) -> Result<(), String> {
    let cache_dir = get_cache_dir()?;
    let stamp = source_stamp(Path::new(&path));
    let entry = CacheEntry {
        thumbnail,
        created: current_unix_time(),
        width,
        height,
        preview_box: None,
        source_mtime: stamp.map(|s| s.0),
        source_size: stamp.map(|s| s.1),
    };
    store_thumbnail_entry(&cache_dir, &path, size.unwrap_or(30), &entry)
}

#[tauri::command]
pub async fn clear_old_cache() -> Result<(), String> {
    let Ok(cache_dir) = get_cache_dir() else {
        return Ok(());
    };
    let removed = tauri::async_runtime::spawn_blocking(move || {
        sweep(
            &cache_dir,
            current_unix_time(),
            CACHE_DURATION,
            PREVIEW_CACHE_CAP_BYTES,
        )
    })
    .await
    .map_err(|e| e.to_string())?;
    println!("Cleaned {} old cache entries", removed);
    Ok(())
}

#[tauri::command]
pub async fn get_cache_stats() -> Result<HashMap<String, u64>, String> {
    let Ok(cache_dir) = get_cache_dir() else {
        return Ok(HashMap::new());
    };
    // Reads and parses every JSON file in the cache directory — off the
    // async runtime's core threads, like `clear_old_cache`.
    tauri::async_runtime::spawn_blocking(move || {
        stats(&cache_dir, current_unix_time(), CACHE_DURATION)
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::*;

    fn filetime_for_test(secs: u64) -> filetime::FileTime {
        filetime::FileTime::from_unix_time(secs as i64, 0)
    }

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
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
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
        store_preview(
            dir.path(),
            &p,
            "1920x1080",
            b"\xFF\xD8jpeg",
            &sidecar(stamp),
        )
        .unwrap();
        assert_eq!(
            lookup_thumbnail(dir.path(), &p, 20, Some("1920x1080")),
            Some(("AAAA".to_string(), Some(800), Some(600)))
        );
        // A different box is a different preview.
        assert!(lookup_thumbnail(dir.path(), &p, 20, Some("2560x1440")).is_none());
        // Without a box request the thumbnail alone is enough.
        assert!(lookup_thumbnail(dir.path(), &p, 20, None).is_some());
        // F1: the metadata-only check must catch a deleted jpg (sidecar still
        // present) without ever reading the jpg's bytes.
        fs::remove_file(preview_file(dir.path(), &p, "1920x1080")).unwrap();
        assert!(lookup_thumbnail(dir.path(), &p, 20, Some("1920x1080")).is_none());
    }

    #[test]
    fn lookup_treats_error_entry_stamp_like_any_other_once_recorded() {
        let dir = create_temp_dir();
        let img = create_test_jpeg(dir.path(), "a.jpg");
        let p = img.to_string_lossy().to_string();
        let stamp = source_stamp(&img).unwrap();
        let err_entry = CacheEntry {
            thumbnail: "error".to_string(),
            ..entry(Some(stamp), None)
        };
        store_thumbnail_entry(dir.path(), &p, 20, &err_entry).unwrap();
        assert!(lookup_thumbnail(dir.path(), &p, 20, None).is_some());
        // Corrupt source replaced with a fixed one → stamp no longer matches →
        // "error" clears immediately instead of sticking around for 24h (F3).
        fs::write(&img, b"replaced with a different, valid-looking payload").unwrap();
        assert!(lookup_thumbnail(dir.path(), &p, 20, None).is_none());
    }

    #[test]
    fn lookup_error_entry_without_a_stamp_is_still_fresh() {
        let dir = create_temp_dir();
        // No real file behind this path: mirrors an "error" entry written
        // when the source couldn't even be stat'd.
        let p = "/no/such/source.jpg".to_string();
        let err_entry = CacheEntry {
            thumbnail: "error".to_string(),
            created: current_unix_time(),
            width: None,
            height: None,
            preview_box: None,
            source_mtime: None,
            source_size: None,
        };
        store_thumbnail_entry(dir.path(), &p, 20, &err_entry).unwrap();
        assert_eq!(
            lookup_thumbnail(dir.path(), &p, 20, None),
            Some(("error".to_string(), None, None))
        );
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
        store_preview(
            dir.path(),
            &p,
            "1920x1080",
            b"\xFF\xD8jpeg",
            &sidecar(stamp),
        )
        .unwrap();
        let (bytes, side) = load_preview(dir.path(), &p, "1920x1080").unwrap();
        assert_eq!(bytes, b"\xFF\xD8jpeg");
        assert_eq!((side.natural_width, side.natural_height), (800, 600));
        fs::write(&img, b"different").unwrap();
        assert!(load_preview(dir.path(), &p, "1920x1080").is_none());
    }

    #[test]
    fn sweep_removes_expired_entries_and_enforces_the_preview_cap() {
        let dir = create_temp_dir();
        // `load_preview` (see below) confirms the survivor via `stamp_matches`,
        // which stats the real source file at `path` — so unlike the other
        // fixtures in this module, the fake "/p*.jpg" paths from the brief must
        // be backed by real 1-byte files with mtime=1 (matching `sidecar((1,1))`
        // and `entry(Some((1,1)), _)` below), not just used as bare hash keys.
        let sources = create_temp_dir();
        let touch = |name: &str| -> String {
            let p = sources.path().join(name);
            fs::write(&p, b"x").unwrap();
            filetime::set_file_mtime(&p, filetime_for_test(1)).unwrap();
            p.to_string_lossy().to_string()
        };
        let old_path = touch("old.jpg");
        let now = 1_000_000u64;
        // Expired thumbnail entry.
        let old = CacheEntry {
            created: now - 100_000,
            ..entry(Some((1, 1)), None)
        };
        store_thumbnail_entry(dir.path(), &old_path, 20, &old).unwrap();
        // Three fresh previews of 1000 bytes each, cap 2500 → oldest one must go.
        let preview_paths: Vec<String> = ["p1.jpg", "p2.jpg", "p3.jpg"]
            .iter()
            .map(|n| touch(n))
            .collect();
        for (i, name) in preview_paths.iter().enumerate() {
            store_preview(
                dir.path(),
                name,
                "1920x1080",
                &vec![0u8; 1000],
                &sidecar((1, 1)),
            )
            .unwrap();
            let f = preview_file(dir.path(), name, "1920x1080");
            let t = filetime_for_test(now - 1000 + i as u64 * 10);
            filetime::set_file_mtime(&f, t).unwrap();
        }
        let removed = sweep(dir.path(), now, 24 * 60 * 60, 2500);
        assert_eq!(
            removed, 2,
            "expired json + one preview (jpg+sidecar count as one)"
        );
        assert!(load_preview(dir.path(), &preview_paths[0], "1920x1080").is_none());
        assert!(load_preview(dir.path(), &preview_paths[2], "1920x1080").is_some());
        assert!(!json_file(dir.path(), &old_path, 20).exists());
    }

    #[test]
    fn sweep_removes_stale_tmp_files_but_leaves_in_flight_ones() {
        let dir = create_temp_dir();
        let now = 1_000_000u64;
        // Orphaned from a crash mid-write — over an hour old.
        let stale = dir.path().join("abc123.json.tmp-1-2-3");
        fs::write(&stale, b"partial").unwrap();
        filetime::set_file_mtime(&stale, filetime_for_test(now - 3700)).unwrap();
        // A write in progress right now must survive the sweep.
        let fresh = dir.path().join("def456_p.jpg.tmp-1-2-4");
        fs::write(&fresh, b"partial").unwrap();
        filetime::set_file_mtime(&fresh, filetime_for_test(now - 5)).unwrap();
        let removed = sweep(dir.path(), now, 24 * 60 * 60, PREVIEW_CACHE_CAP_BYTES);
        assert_eq!(removed, 1);
        assert!(!stale.exists());
        assert!(fresh.exists());
    }

    #[test]
    fn stats_counts_previews_and_bytes() {
        let dir = create_temp_dir();
        store_preview(
            dir.path(),
            "/p1.jpg",
            "1920x1080",
            &vec![0u8; 1000],
            &sidecar((1, 1)),
        )
        .unwrap();
        let s = stats(dir.path(), current_unix_time(), 24 * 60 * 60);
        assert_eq!(s["preview_files"], 1);
        assert_eq!(s["preview_bytes"], 1000);
    }
}
