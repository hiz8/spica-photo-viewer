//! Custom `spica-img` URI scheme.
//! Serves validated local image files to the WebView as raw bytes,
//! replacing the decode→re-encode→base64→IPC pipeline. Windows WebView2
//! exposes the scheme as http://spica-img.localhost/<percent-encoded path>.

use crate::utils::image::is_supported_image;
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
