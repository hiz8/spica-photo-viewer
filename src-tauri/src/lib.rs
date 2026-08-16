mod commands;
mod protocol;
mod utils;

#[cfg(test)]
mod test_utils;

use commands::cache::{
    clear_old_cache, get_cache_stats, get_cached_thumbnail, set_cached_thumbnail,
};
use commands::file::{
    generate_image_thumbnail, generate_thumbnail_with_dimensions, get_folder_images,
    get_startup_file, handle_dropped_file, open_with_dialog, validate_image_file,
};
use commands::window::{
    get_window_position, get_window_state, maximize_window, resize_window_to_image,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
                let _t = crate::utils::perf::PerfTimer::start("serve", &uri_path);
                let response = match crate::protocol::resolve_image_path(&uri_path) {
                    Ok(path) => match std::fs::read(&path) {
                        Ok(bytes) => tauri::http::Response::builder()
                            .status(200)
                            .header("Content-Type", crate::protocol::mime_for(&path))
                            .header("Access-Control-Allow-Origin", crate::protocol::ALLOW_ORIGIN)
                            .body(bytes)
                            .unwrap_or_else(|_| {
                                crate::protocol::error_response(500, "response build failed")
                            }),
                        Err(e) => crate::protocol::error_response(500, &e.to_string()),
                    },
                    Err(msg) => crate::protocol::error_response(404, &msg),
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
            generate_image_thumbnail,
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
