//! Spec: docs/superpowers/specs/2026-08-28-explorer-folder-sort-order-design.md

mod commands;
mod protocol;
mod utils;

#[cfg(test)]
mod test_utils;

use commands::cache::{
    clear_old_cache, get_cache_stats, get_cached_thumbnail, set_cached_thumbnail,
};
use commands::file::{
    generate_thumbnail_with_dimensions, get_folder_images, get_startup_file, handle_dropped_file,
    open_with_dialog, validate_image_file,
};
use commands::window::{
    get_window_position, get_window_state, maximize_window, resize_window_to_image,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Stash the launcher's foreground window before Tauri creates ours and
    // takes focus (spec §6.3: picks among multiple Explorer windows).
    commands::explorer_sort::stash_foreground_window();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());

    // Custom `spica-img` scheme: serves image files straight to the WebView as
    // raw bytes instead of base64 over IPC. On Windows WebView2 reaches it at
    // http://spica-img.localhost/<encodeURIComponent(absolute path)>.
    let builder = builder.register_asynchronous_uri_scheme_protocol(
        "spica-img",
        |_ctx, request, responder| {
            let uri_path = request.uri().path().to_string();
            // File reads are blocking; keep them off the async runtime's core threads.
            tauri::async_runtime::spawn_blocking(move || {
                let response = if let Some(rest) = uri_path.strip_prefix("/preview/") {
                    let _t = crate::utils::perf::PerfTimer::start("serve_preview", &uri_path);
                    match crate::protocol::resolve_preview_request(rest) {
                        Ok((bbox, path)) => {
                            match crate::commands::cache::get_cache_dir().and_then(|dir| {
                                crate::protocol::ensure_preview(
                                    &dir,
                                    &path,
                                    bbox,
                                    crate::utils::preview::DEFAULT_THUMB_SIZE,
                                )
                            }) {
                                Ok(served) => crate::protocol::preview_response(&served),
                                Err(e) => crate::protocol::error_response(500, &e),
                            }
                        }
                        Err(msg) => crate::protocol::error_response(404, &msg),
                    }
                } else {
                    let _t = crate::utils::perf::PerfTimer::start("serve", &uri_path);
                    match crate::protocol::resolve_image_path(&uri_path) {
                        Ok(path) => match std::fs::read(&path) {
                            Ok(bytes) => tauri::http::Response::builder()
                                .status(200)
                                .header("Content-Type", crate::protocol::mime_for(&path))
                                .header(
                                    "Access-Control-Allow-Origin",
                                    crate::protocol::ALLOW_ORIGIN,
                                )
                                .body(bytes)
                                .unwrap_or_else(|_| {
                                    crate::protocol::error_response(500, "response build failed")
                                }),
                            Err(e) => crate::protocol::error_response(500, &e.to_string()),
                        },
                        Err(msg) => crate::protocol::error_response(404, &msg),
                    }
                };
                responder.respond(response);
            });
        },
    );

    // E2E-only: embedded WebDriver server for @wdio/tauri-service. Gated behind
    // the `e2e` cargo feature so shipping builds never carry it.
    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .invoke_handler(tauri::generate_handler![
            get_folder_images,
            handle_dropped_file,
            validate_image_file,
            generate_thumbnail_with_dimensions,
            get_startup_file,
            open_with_dialog,
            get_cached_thumbnail,
            set_cached_thumbnail,
            clear_old_cache,
            get_cache_stats,
            get_window_state,
            get_window_position,
            resize_window_to_image,
            maximize_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Probe-only surface for scripts/explorer-sort-probe. Not a public API.
#[doc(hidden)]
pub mod probe_api {
    pub use crate::commands::explorer_sort::normalize_path;
    #[cfg(windows)]
    pub use crate::commands::explorer_sort::detect_sort_spec;
    pub use crate::commands::file::get_folder_images;
}
