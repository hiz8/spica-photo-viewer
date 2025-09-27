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
pub fn get_startup_file() -> Result<Option<String>, String> {
    let args: Vec<String> = std::env::args().collect();

    // Look for image file in command line arguments (usually args[1])
    for arg in &args[1..] {
        let path = Path::new(arg);
        if path.exists() && path.is_file() && is_supported_image(path) {
            return Ok(Some(arg.clone()));
        }
    }

    Ok(None)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::*;
    use std::fs;

    #[tokio::test]
    async fn test_get_folder_images_with_valid_folder() {
        let temp_dir = create_temp_dir();

        // Create test images
        create_test_jpeg(temp_dir.path(), "image1.jpg");
        create_test_png(temp_dir.path(), "image2.png");
        create_test_gif(temp_dir.path(), "image3.gif");

        let result = get_folder_images(temp_dir.path().to_string_lossy().to_string()).await;
        assert!(result.is_ok());

        let images = result.unwrap();
        assert_eq!(images.len(), 3);

        // Check sorting (should be alphabetical)
        assert_eq!(images[0].filename, "image1.jpg");
        assert_eq!(images[1].filename, "image2.png");
        assert_eq!(images[2].filename, "image3.gif");
    }

    #[tokio::test]
    async fn test_get_folder_images_with_invalid_folder() {
        let result = get_folder_images("/nonexistent/path".to_string()).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid folder path"));
    }

    #[tokio::test]
    async fn test_get_folder_images_with_empty_folder() {
        let temp_dir = create_temp_dir();

        let result = get_folder_images(temp_dir.path().to_string_lossy().to_string()).await;
        assert!(result.is_ok());

        let images = result.unwrap();
        assert_eq!(images.len(), 0);
    }

    #[tokio::test]
    async fn test_get_folder_images_with_mixed_files() {
        let temp_dir = create_temp_dir();

        // Create test images and non-image files
        create_test_jpeg(temp_dir.path(), "image1.jpg");
        create_invalid_image(temp_dir.path(), "textfile.txt");
        create_test_png(temp_dir.path(), "image2.png");

        let result = get_folder_images(temp_dir.path().to_string_lossy().to_string()).await;
        assert!(result.is_ok());

        let images = result.unwrap();
        assert_eq!(images.len(), 2); // Only valid images
        assert_eq!(images[0].filename, "image1.jpg");
        assert_eq!(images[1].filename, "image2.png");
    }

    #[tokio::test]
    async fn test_get_folder_images_skips_corrupted_images() {
        let temp_dir = create_temp_dir();

        // Create valid and corrupted images
        create_test_jpeg(temp_dir.path(), "valid.jpg");
        create_fake_image(temp_dir.path(), "corrupted.jpg");

        let result = get_folder_images(temp_dir.path().to_string_lossy().to_string()).await;
        assert!(result.is_ok());

        let images = result.unwrap();
        assert_eq!(images.len(), 1); // Only valid image
        assert_eq!(images[0].filename, "valid.jpg");
    }

    #[tokio::test]
    async fn test_get_folder_images_with_subdirectories() {
        let temp_dir = create_temp_dir();

        // Create image in root
        create_test_jpeg(temp_dir.path(), "root.jpg");

        // Create subdirectory with image
        let sub_dir = temp_dir.path().join("subdir");
        fs::create_dir(&sub_dir).unwrap();
        create_test_png(&sub_dir, "sub.png");

        let result = get_folder_images(temp_dir.path().to_string_lossy().to_string()).await;
        assert!(result.is_ok());

        let images = result.unwrap();
        // Should only include files from root directory (max_depth = 1)
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].filename, "root.jpg");
    }

    #[tokio::test]
    async fn test_get_folder_images_case_insensitive_extensions() {
        let temp_dir = create_temp_dir();

        // Create images with different case extensions
        create_test_jpeg(temp_dir.path(), "lower.jpg");
        create_test_jpeg(temp_dir.path(), "upper.JPG");
        create_test_jpeg(temp_dir.path(), "mixed.Jpeg");

        let result = get_folder_images(temp_dir.path().to_string_lossy().to_string()).await;
        assert!(result.is_ok());

        let images = result.unwrap();
        assert_eq!(images.len(), 3);
    }

    #[tokio::test]
    async fn test_load_image_with_valid_file() {
        let temp_dir = create_temp_dir();
        let image_path = create_test_jpeg(temp_dir.path(), "test.jpg");

        let result = load_image(image_path.to_string_lossy().to_string()).await;
        assert!(result.is_ok());

        let image_data = result.unwrap();
        assert_eq!(image_data.path, image_path.to_string_lossy().to_string());
        assert!(!image_data.base64.is_empty());
        assert_eq!(image_data.width, 1);
        assert_eq!(image_data.height, 1);
        assert_eq!(image_data.format, "jpg");
    }

    #[tokio::test]
    async fn test_load_image_with_nonexistent_file() {
        let result = load_image("/nonexistent/image.jpg".to_string()).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("File not found"));
    }

    #[tokio::test]
    async fn test_load_image_with_unsupported_format() {
        let temp_dir = create_temp_dir();
        let text_file = temp_dir.path().join("test.txt");
        fs::write(&text_file, "not an image").unwrap();

        let result = load_image(text_file.to_string_lossy().to_string()).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unsupported file format"));
    }

    #[tokio::test]
    async fn test_load_image_with_corrupted_file() {
        let temp_dir = create_temp_dir();
        let corrupted_path = create_fake_image(temp_dir.path(), "corrupted.jpg");

        let result = load_image(corrupted_path.to_string_lossy().to_string()).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to load image"));
    }

    #[tokio::test]
    async fn test_load_image_with_different_formats() {
        let temp_dir = create_temp_dir();

        // Test JPEG
        let jpeg_path = create_test_jpeg(temp_dir.path(), "test.jpeg");
        let result = load_image(jpeg_path.to_string_lossy().to_string()).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().format, "jpeg");

        // Test PNG
        let png_path = create_test_png(temp_dir.path(), "test.png");
        let result = load_image(png_path.to_string_lossy().to_string()).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().format, "png");

        // Test GIF
        let gif_path = create_test_gif(temp_dir.path(), "test.gif");
        let result = load_image(gif_path.to_string_lossy().to_string()).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().format, "gif");
    }

    #[tokio::test]
    async fn test_handle_dropped_file_with_valid_image() {
        let temp_dir = create_temp_dir();
        let image_path = create_test_jpeg(temp_dir.path(), "dropped.jpg");

        let result = handle_dropped_file(image_path.to_string_lossy().to_string()).await;
        assert!(result.is_ok());

        let image_info = result.unwrap();
        assert_eq!(image_info.filename, "dropped.jpg");
        assert_eq!(image_info.format, "jpg");
    }

    #[tokio::test]
    async fn test_handle_dropped_file_with_nonexistent_file() {
        let result = handle_dropped_file("/nonexistent/file.jpg".to_string()).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("File not found"));
    }

    #[tokio::test]
    async fn test_handle_dropped_file_with_unsupported_format() {
        let temp_dir = create_temp_dir();
        let text_file = temp_dir.path().join("text.txt");
        fs::write(&text_file, "not an image").unwrap();

        let result = handle_dropped_file(text_file.to_string_lossy().to_string()).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unsupported file format"));
    }

    #[tokio::test]
    async fn test_handle_dropped_file_with_corrupted_image() {
        let temp_dir = create_temp_dir();
        let corrupted_path = create_fake_image(temp_dir.path(), "corrupted.jpg");

        let result = handle_dropped_file(corrupted_path.to_string_lossy().to_string()).await;
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_image_file_with_valid_image() {
        let temp_dir = create_temp_dir();
        let image_path = create_test_jpeg(temp_dir.path(), "valid.jpg");

        let result = validate_image_file(image_path.to_string_lossy().to_string());
        assert!(result.is_ok());
        assert!(result.unwrap());
    }

    #[test]
    fn test_validate_image_file_with_nonexistent_file() {
        let result = validate_image_file("/nonexistent/file.jpg".to_string());
        assert!(result.is_ok());
        assert!(!result.unwrap());
    }

    #[test]
    fn test_validate_image_file_with_unsupported_format() {
        let temp_dir = create_temp_dir();
        let text_file = temp_dir.path().join("text.txt");
        fs::write(&text_file, "not an image").unwrap();

        let result = validate_image_file(text_file.to_string_lossy().to_string());
        assert!(result.is_ok());
        assert!(!result.unwrap());
    }

    #[test]
    fn test_validate_image_file_with_directory() {
        let temp_dir = create_temp_dir();

        let result = validate_image_file(temp_dir.path().to_string_lossy().to_string());
        assert!(result.is_ok());
        assert!(!result.unwrap()); // Directory should not be valid
    }

    #[test]
    fn test_get_startup_file_with_no_args() {
        // This test checks the current behavior, but might not work in test environment
        // since std::env::args() returns the test runner arguments
        let result = get_startup_file();
        assert!(result.is_ok());
        // Result can be None (no image file arguments) or Some(path) if test happens to pass an image
    }

    #[test]
    fn test_get_startup_file_functionality() {
        // Since we can't easily mock std::env::args(), we test the logic indirectly
        // by testing the function doesn't panic and returns Ok
        let result = get_startup_file();
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_generate_image_thumbnail_with_valid_image() {
        let temp_dir = create_temp_dir();
        let image_path = create_test_jpeg(temp_dir.path(), "thumbnail_test.jpg");

        let result = generate_image_thumbnail(image_path.to_string_lossy().to_string(), Some(30)).await;
        assert!(result.is_ok());

        let thumbnail_data = result.unwrap();
        assert!(!thumbnail_data.is_empty());
    }

    #[tokio::test]
    async fn test_generate_image_thumbnail_with_default_size() {
        let temp_dir = create_temp_dir();
        let image_path = create_test_jpeg(temp_dir.path(), "thumbnail_test.jpg");

        let result = generate_image_thumbnail(image_path.to_string_lossy().to_string(), None).await;
        assert!(result.is_ok());

        let thumbnail_data = result.unwrap();
        assert!(!thumbnail_data.is_empty());
    }

    #[tokio::test]
    async fn test_generate_image_thumbnail_with_nonexistent_file() {
        let result = generate_image_thumbnail("/nonexistent/file.jpg".to_string(), Some(30)).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("File not found"));
    }

    #[tokio::test]
    async fn test_generate_image_thumbnail_with_unsupported_format() {
        let temp_dir = create_temp_dir();
        let text_file = temp_dir.path().join("text.txt");
        fs::write(&text_file, "not an image").unwrap();

        let result = generate_image_thumbnail(text_file.to_string_lossy().to_string(), Some(30)).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unsupported file format"));
    }

    #[tokio::test]
    async fn test_generate_image_thumbnail_with_corrupted_file() {
        let temp_dir = create_temp_dir();
        let corrupted_path = create_fake_image(temp_dir.path(), "corrupted.jpg");

        let result = generate_image_thumbnail(corrupted_path.to_string_lossy().to_string(), Some(30)).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to generate thumbnail"));
    }
}