//! Custom `spica-img` URI scheme.
//! Serves validated local image files to the WebView as raw bytes,
//! replacing the decode→re-encode→base64→IPC pipeline. Windows WebView2
//! exposes the scheme as http://spica-img.localhost/<percent-encoded path>.

use crate::commands::cache::{self, PreviewSidecar};
use crate::utils::image::is_supported_image;
use crate::utils::preview::{self, PreviewBox};
use percent_encoding::percent_decode_str;
use std::path::{Path, PathBuf};

/// The webview page lives on a different origin than the custom scheme
/// (`http://tauri.localhost` vs `http://spica-img.localhost` on Windows), so
/// every response needs an explicit CORS header for `fetch`/`XMLHttpRequest`
/// to be able to read it. Tauri's own built-in protocols do the same thing.
pub const ALLOW_ORIGIN: &str = "*";

/// Decodes a `spica-img` URI path back into the absolute file path it points
/// at, applying the same validation as the IPC image commands: the extension
/// must be in the supported allowlist and the file must actually exist.
pub fn resolve_image_path(uri_path: &str) -> Result<PathBuf, String> {
    let trimmed = uri_path.trim_start_matches('/');
    let decoded = percent_decode_str(trimmed)
        .decode_utf8()
        .map_err(|e| format!("invalid encoding: {}", e))?;
    let path = PathBuf::from(decoded.as_ref());
    if !is_supported_image(&path) {
        return Err("unsupported file type".to_string());
    }
    if !path.is_file() {
        return Err("file not found".to_string());
    }
    Ok(path)
}

/// Content-Type for a path already accepted by [`resolve_image_path`].
pub fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "application/octet-stream",
    }
}

/// Plain-text error response. Never fails to build: the status codes and
/// headers used here are all static and valid.
pub fn error_response(status: u16, msg: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", "text/plain")
        .header("Access-Control-Allow-Origin", ALLOW_ORIGIN)
        .body(msg.as_bytes().to_vec())
        .expect("static error response must build")
}

pub const EXPOSE_HEADERS: &str = "X-Spica-Natural-Width, X-Spica-Natural-Height";

fn is_gif_path(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("gif"))
        .unwrap_or(false)
}

/// `rest` = everything after "/preview/": "<W>x<H>/<percent-encoded absolute path>".
pub fn resolve_preview_request(rest: &str) -> Result<(PreviewBox, PathBuf), String> {
    let (box_part, path_part) = rest
        .split_once('/')
        .ok_or_else(|| "missing path".to_string())?;
    let bbox = PreviewBox::parse(box_part).ok_or_else(|| "unsupported preview box".to_string())?;
    let path = resolve_image_path(path_part)?;
    // F2: GIF has no preview (design spec) — reject here rather than caching a
    // static JPEG of frame 1 under a box key.
    if is_gif_path(&path) {
        return Err("no preview for gif".to_string());
    }
    Ok((bbox, path))
}

pub struct ServedPreview {
    pub bytes: Vec<u8>,
    pub natural_width: u32,
    pub natural_height: u32,
    // Distinguishes a fresh generation from a cache hit; asserted on directly
    // by this module's own tests. Not read by the lib.rs handler today (the
    // response is identical either way) — kept for future perf/logging use.
    #[allow(dead_code)]
    pub generated: bool,
}

/// Serve from the cache when the preview exists and its source stamp still
/// matches; otherwise generate it now (self-healing, e.g. after a cap sweep)
/// and store it for the next request.
pub fn ensure_preview(
    cache_dir: &Path,
    path: &Path,
    bbox: PreviewBox,
    thumb_size: u32,
) -> Result<ServedPreview, String> {
    let path_str = path.to_string_lossy().to_string();
    if let Some((bytes, side)) = cache::load_preview(cache_dir, &path_str, &bbox.key()) {
        return Ok(ServedPreview {
            bytes,
            natural_width: side.natural_width,
            natural_height: side.natural_height,
            generated: false,
        });
    }
    let stamp =
        cache::source_stamp(path).ok_or_else(|| "Failed to stat source file".to_string())?;
    let g = preview::generate(path, bbox, thumb_size)?;
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
            created: cache::current_unix_time(),
        },
    )?;
    Ok(ServedPreview {
        bytes: g.preview_jpeg,
        natural_width: g.natural_width,
        natural_height: g.natural_height,
        generated: true,
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::*;
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};

    fn encode(path: &std::path::Path) -> String {
        // encodeURIComponent 相当（英数字以外すべてエンコード）
        format!(
            "/{}",
            utf8_percent_encode(&path.to_string_lossy(), NON_ALPHANUMERIC)
        )
    }

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
        assert!(
            resolve_preview_request(&format!("1234x567{}", encode(&img)))
                .unwrap_err()
                .contains("box")
        );
        assert!(resolve_preview_request("1920x1080").is_err());
        assert!(
            resolve_preview_request("1920x1080/C%3A%5Cnope%5Cmissing.jpg")
                .unwrap_err()
                .contains("not found")
        );
    }

    #[test]
    fn test_resolve_preview_request_rejects_gif() {
        let temp_dir = create_temp_dir();
        let gif = create_test_gif(temp_dir.path(), "a.gif");
        let err = resolve_preview_request(&format!("1920x1080{}", encode(&gif))).unwrap_err();
        assert!(
            err.contains("gif"),
            "expected a gif-specific error, got: {err}"
        );
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

    #[test]
    fn test_resolve_roundtrips_windows_path_with_spaces_and_japanese() {
        let temp_dir = create_temp_dir();
        let img = create_test_jpeg(temp_dir.path(), "テスト 画像 (1).jpg");
        let resolved = resolve_image_path(&encode(&img)).unwrap();
        assert_eq!(resolved, img);
    }

    #[test]
    fn test_resolve_rejects_unsupported_extension() {
        let temp_dir = create_temp_dir();
        let txt = temp_dir.path().join("note.txt");
        std::fs::write(&txt, "x").unwrap();
        let err = resolve_image_path(&encode(&txt)).unwrap_err();
        assert!(err.contains("unsupported"));
    }

    #[test]
    fn test_resolve_rejects_missing_file() {
        let err = resolve_image_path("/C%3A%5Cnope%5Cmissing.jpg").unwrap_err();
        assert!(err.contains("not found"));
    }

    #[test]
    fn test_mime_for_known_formats() {
        use std::path::Path;
        assert_eq!(mime_for(Path::new("a.jpg")), "image/jpeg");
        assert_eq!(mime_for(Path::new("a.JPEG")), "image/jpeg");
        assert_eq!(mime_for(Path::new("a.png")), "image/png");
        assert_eq!(mime_for(Path::new("a.webp")), "image/webp");
        assert_eq!(mime_for(Path::new("a.gif")), "image/gif");
    }

    #[test]
    fn test_error_response_carries_status_and_message() {
        let response = error_response(404, "file not found");
        assert_eq!(response.status(), 404);
        assert_eq!(response.body(), b"file not found");
        assert_eq!(acao_header(&response), Some(ALLOW_ORIGIN));
    }

    #[test]
    fn test_error_response_500_carries_acao_header() {
        let response = error_response(500, "internal error");
        assert_eq!(response.status(), 500);
        assert_eq!(response.body(), b"internal error");
        assert_eq!(acao_header(&response), Some(ALLOW_ORIGIN));
    }

    /// `response.headers().get(...)` returns an `Option<&HeaderValue>`;
    /// convert to `&str` for a plain string comparison in assertions above.
    fn acao_header(response: &tauri::http::Response<Vec<u8>>) -> Option<&str> {
        response
            .headers()
            .get("Access-Control-Allow-Origin")
            .and_then(|v| v.to_str().ok())
    }
}
