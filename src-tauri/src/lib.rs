mod commands;
mod utils;

use commands::file::{get_folder_images, load_image, handle_dropped_file, validate_image_file};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_folder_images,
            load_image,
            handle_dropped_file,
            validate_image_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
