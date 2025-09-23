use crate::utils::image::{is_supported_image, get_image_dimensions, load_image_as_base64, generate_thumbnail};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ImageInfo {
    pub path: String,
    pub filename: String,
    pub width: u32,
    pub height: u32,
    pub size: u64,
    pub modified: u64,
    pub format: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImageData {
    pub path: String,
    pub base64: String,
    pub width: u32,
    pub height: u32,
    pub format: String,
}

#[tauri::command]
pub async fn get_folder_images(path: String) -> Result<Vec<ImageInfo>, String> {
    let folder_path = Path::new(&path);

    if !folder_path.exists() || !folder_path.is_dir() {
        return Err("Invalid folder path".to_string());
    }

    let mut images = Vec::new();

    for entry in WalkDir::new(folder_path)
        .max_depth(1)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();

        if path.is_file() && is_supported_image(path) {
            match get_image_info(path) {
                Ok(info) => images.push(info),
                Err(_) => continue,
            }
        }
    }

    images.sort_by(|a, b| a.filename.cmp(&b.filename));
    Ok(images)
}

#[tauri::command]
pub async fn load_image(path: String) -> Result<ImageData, String> {
    let image_path = Path::new(&path);

    if !image_path.exists() || !image_path.is_file() {
        return Err("File not found".to_string());
    }

    if !is_supported_image(image_path) {
        return Err("Unsupported file format".to_string());
    }

    let base64_data = load_image_as_base64(image_path)
        .map_err(|e| format!("Failed to load image: {}", e))?;

    let (width, height) = get_image_dimensions(image_path)
        .map_err(|e| format!("Failed to get image dimensions: {}", e))?;

    let format = image_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_lowercase();

    Ok(ImageData {
        path: path.clone(),
        base64: base64_data,
        width,
        height,
        format,
    })
}

#[tauri::command]
pub async fn handle_dropped_file(path: String) -> Result<ImageInfo, String> {
    let file_path = Path::new(&path);

    if !file_path.exists() || !file_path.is_file() {
        return Err("File not found".to_string());
    }

    if !is_supported_image(file_path) {
        return Err("Unsupported file format".to_string());
    }

    get_image_info(file_path)
}

#[tauri::command]
pub fn validate_image_file(path: String) -> Result<bool, String> {
    let file_path = Path::new(&path);
    Ok(file_path.exists() && file_path.is_file() && is_supported_image(file_path))
}

#[tauri::command]
pub async fn generate_image_thumbnail(path: String, size: Option<u32>) -> Result<String, String> {
    let image_path = Path::new(&path);

    if !image_path.exists() || !image_path.is_file() {
        return Err("File not found".to_string());
    }

    if !is_supported_image(image_path) {
        return Err("Unsupported file format".to_string());
    }

    let thumbnail_size = size.unwrap_or(30);

    generate_thumbnail(image_path, thumbnail_size)
        .map_err(|e| format!("Failed to generate thumbnail: {}", e))
}

fn get_image_info(path: &Path) -> Result<ImageInfo, String> {
    let metadata = fs::metadata(path)
        .map_err(|e| format!("Failed to read file metadata: {}", e))?;

    let (width, height) = get_image_dimensions(path)
        .map_err(|e| format!("Failed to get image dimensions: {}", e))?;

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

    let modified = metadata
        .modified()
        .map_err(|e| format!("Failed to get modification time: {}", e))?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("Failed to convert time: {}", e))?
        .as_secs();

    Ok(ImageInfo {
        path: path.to_string_lossy().to_string(),
        filename,
        width,
        height,
        size: metadata.len(),
        modified,
        format,
    })
}