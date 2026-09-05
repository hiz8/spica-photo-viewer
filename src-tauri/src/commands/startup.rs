//! Startup prefetch for the file-association launch path.
//!
//! WebView2 initialization keeps the process waiting for ~500ms before the
//! frontend can ask for anything, while the startup file is already known
//! from argv. The two things the frontend asks for first — the current
//! image's thumbnail + display-resolution preview, and the folder listing —
//! are started here so they overlap that wait instead of following it.

use crate::commands::cache;
use crate::commands::file::{self, ImageInfo};
use crate::utils::perf;
use crate::utils::preview::{PreviewBox, ALLOWED_PREVIEW_BOXES, DEFAULT_THUMB_SIZE};
use serde::Serialize;
use std::path::Path;
use std::sync::mpsc::{self, Receiver};
use std::sync::Mutex;
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
pub struct PrefetchedThumbnail {
    pub base64: String,
    pub width: u32,
    pub height: u32,
}

/// Bounded wait in `take_thumbnail` for an almost-finished prefetch: a hit
/// paints the preview in ~50ms, a miss costs the frontend a full-resolution
/// decode (~350ms for 20MP), so a short wait is worth it on average.
const THUMB_WAIT: Duration = Duration::from_millis(150);

type ThumbSlot = Option<(String, Receiver<Option<PrefetchedThumbnail>>)>;
type FolderSlot = Option<(String, Receiver<Result<Vec<ImageInfo>, String>>)>;

// One-shot slots, consumed by the first take. A dev-build React StrictMode
// double invocation of the startup effect therefore sees None on its second
// `get_startup_file` and takes the ordinary (non-prefetched) path — not a
// bug, just the second run paying the normal cost.
static THUMB: Mutex<ThumbSlot> = Mutex::new(None);
static FOLDER: Mutex<FolderSlot> = Mutex::new(None);

/// Mirror of `previewBoxForScreen` (src/utils/previewBox.ts) for a screen of
/// `(width, height)` physical pixels: the smallest allowlisted box that
/// contains the screen, oriented like it. A mismatch (window on another
/// monitor, DPR rounding) only costs a cache miss on the frontend's box.
pub fn box_for_screen(width: u32, height: u32) -> PreviewBox {
    let long = width.max(height);
    let short = width.min(height);
    let &(bl, bs) = ALLOWED_PREVIEW_BOXES
        .iter()
        .find(|&&(l, s)| l >= long && s >= short)
        .unwrap_or(&ALLOWED_PREVIEW_BOXES[ALLOWED_PREVIEW_BOXES.len() - 1]);
    if height > width {
        PreviewBox {
            width: bs,
            height: bl,
        }
    } else {
        PreviewBox {
            width: bl,
            height: bs,
        }
    }
}

/// Starts both prefetches for `image_path`. `screen` is the primary
/// monitor's physical size, used to pick the box the frontend will ask for.
pub fn start(image_path: &str, screen: (u32, u32)) {
    perf::phase("prefetch_start", "");
    let path = image_path.to_string();
    let bbox = box_for_screen(screen.0, screen.1);

    let (thumb_tx, thumb_rx) = mpsc::channel();
    *THUMB.lock().unwrap() = Some((path.clone(), thumb_rx));
    std::thread::spawn(move || {
        let result = {
            let _t = perf::PerfTimer::start("prefetch_thumb", &path);
            prefetch_thumbnail(&path, bbox)
        };
        perf::phase(
            "prefetch_thumb_done",
            &format!(r#","hit":{}"#, result.is_some()),
        );
        let _ = thumb_tx.send(result);
    });

    if let Some(folder) = Path::new(image_path).parent().map(Path::to_path_buf) {
        let (folder_tx, folder_rx) = mpsc::channel();
        let key = crate::commands::explorer_sort::normalize_path(&folder.to_string_lossy());
        *FOLDER.lock().unwrap() = Some((key, folder_rx));
        std::thread::spawn(move || {
            let folder_str = folder.to_string_lossy().to_string();
            let result = if folder.is_dir() {
                file::scan_folder(&folder, &folder_str)
            } else {
                Err("Invalid folder path".to_string())
            };
            perf::phase("prefetch_folder_done", "");
            let _ = folder_tx.send(result);
        });
    }
}

fn prefetch_thumbnail(path: &str, bbox: PreviewBox) -> Option<PrefetchedThumbnail> {
    let cache_dir = cache::get_cache_dir().ok()?;
    let key = bbox.key();
    if let Some((base64, width, height)) =
        cache::lookup_thumbnail(&cache_dir, path, DEFAULT_THUMB_SIZE, Some(&key))
    {
        return match (width, height) {
            (Some(width), Some(height)) if base64 != "error" => Some(PrefetchedThumbnail {
                base64,
                width,
                height,
            }),
            // Recorded failure, or a pre-dimension entry: leave it to the
            // frontend's generator (it re-generates or shows the error).
            _ => None,
        };
    }
    let t = file::generate_and_cache(Path::new(path), DEFAULT_THUMB_SIZE, Some(&key), &cache_dir)
        .ok()?;
    Some(PrefetchedThumbnail {
        base64: t.thumbnail_base64,
        width: t.original_width,
        height: t.original_height,
    })
}

/// The prefetched thumbnail for `path`, waiting at most THUMB_WAIT for it.
/// Consumes the slot either way.
pub fn take_thumbnail(path: &str) -> Option<PrefetchedThumbnail> {
    let (prefetched_path, rx) = THUMB.lock().unwrap().take()?;
    if prefetched_path != path {
        return None;
    }
    rx.recv_timeout(THUMB_WAIT).ok().flatten()
}

/// The prefetched listing for `folder`, if the prefetch targeted that folder
/// (blocks until the scan finishes). Consumed on first use.
pub fn take_folder(folder: &Path) -> Option<Result<Vec<ImageInfo>, String>> {
    let key = crate::commands::explorer_sort::normalize_path(&folder.to_string_lossy());
    let mut guard = FOLDER.lock().unwrap();
    if guard.as_ref().map(|(k, _)| k == &key) != Some(true) {
        return None;
    }
    let (_, rx) = guard.take()?;
    drop(guard);
    rx.recv().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn take_thumbnail_ignores_a_different_path() {
        let (tx, rx) = mpsc::channel();
        *THUMB.lock().unwrap() = Some(("a.jpg".to_string(), rx));
        tx.send(Some(PrefetchedThumbnail {
            base64: "x".into(),
            width: 1,
            height: 1,
        }))
        .unwrap();
        assert!(take_thumbnail("b.jpg").is_none());
        // The slot is consumed even on a mismatch.
        assert!(take_thumbnail("a.jpg").is_none());
    }

    #[test]
    fn take_folder_only_serves_the_prefetched_folder() {
        let (tx, rx) = mpsc::channel();
        *FOLDER.lock().unwrap() = Some((
            crate::commands::explorer_sort::normalize_path(r"C:\Photos\Trip"),
            rx,
        ));
        tx.send(Ok(Vec::new())).unwrap();
        // Another folder leaves the slot alone.
        assert!(take_folder(Path::new(r"C:\Photos\Other")).is_none());
        // Same folder under a different spelling is served, and consumed.
        assert!(take_folder(Path::new("c:/photos/trip/")).is_some());
        assert!(take_folder(Path::new(r"C:\Photos\Trip")).is_none());
    }
}
