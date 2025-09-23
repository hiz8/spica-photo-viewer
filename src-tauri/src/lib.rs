mod commands;
mod utils;

use commands::file::{get_folder_images, load_image, handle_dropped_file, validate_image_file, generate_image_thumbnail};
use commands::cache::{get_cached_thumbnail, set_cached_thumbnail, clear_old_cache, get_cache_stats};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_folder_images,
            load_image,
            handle_dropped_file,
            validate_image_file,
            generate_image_thumbnail,
            get_cached_thumbnail,
            set_cached_thumbnail,
            clear_old_cache,
            get_cache_stats
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
