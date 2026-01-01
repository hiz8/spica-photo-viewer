mod commands;
mod utils;

#[cfg(test)]
mod test_utils;

use commands::cache::{
    clear_old_cache, get_cache_stats, get_cached_thumbnail, set_cached_thumbnail,
};
use commands::file::{
    generate_image_thumbnail, generate_thumbnail_with_dimensions, get_folder_images,
    get_startup_file, handle_dropped_file, load_image,
    open_with_dialog, validate_image_file,
};
use commands::window::{
    get_window_position, get_window_state, maximize_window, resize_window_to_image,
};

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
