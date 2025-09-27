#![cfg(test)]

use std::path::{Path, PathBuf};
use tempfile::TempDir;
use std::fs;

/// Creates a temporary directory for testing
pub fn create_temp_dir() -> TempDir {
    tempfile::tempdir().expect("Failed to create temp directory")
}

/// Creates a test image using the image crate for reliability
pub fn create_test_jpeg(dir: &Path, filename: &str) -> PathBuf {
    use image::{ImageBuffer, Rgb};

    let file_path = dir.join(filename);

    // Create a simple 1x1 red pixel image
    let img = ImageBuffer::from_fn(1, 1, |_x, _y| Rgb([255u8, 0u8, 0u8]));
    img.save(&file_path).expect("Failed to create test JPEG");

    file_path
}

/// Creates a test PNG image using the image crate
pub fn create_test_png(dir: &Path, filename: &str) -> PathBuf {
    use image::{ImageBuffer, Rgb};

    let file_path = dir.join(filename);

    // Create a simple 1x1 green pixel image
    let img = ImageBuffer::from_fn(1, 1, |_x, _y| Rgb([0u8, 255u8, 0u8]));
    img.save(&file_path).expect("Failed to create test PNG");

    file_path
}

/// Creates a test WebP image by creating JPEG first then converting name
/// (WebP creation through image crate requires specific features)
pub fn create_test_webp(dir: &Path, filename: &str) -> PathBuf {
    // For simplicity, we'll create a JPEG and rename to .webp for extension testing
    // This tests the extension logic, not actual WebP processing
    let temp_jpeg = dir.join("temp.jpg");
    let webp_path = dir.join(filename);

    use image::{ImageBuffer, Rgb};
    let img = ImageBuffer::from_fn(1, 1, |_x, _y| Rgb([0u8, 0u8, 255u8]));
    img.save(&temp_jpeg).expect("Failed to create temp JPEG");

    // Copy the JPEG data but with WebP extension for testing
    let data = fs::read(&temp_jpeg).expect("Failed to read temp JPEG");
    fs::write(&webp_path, &data).expect("Failed to create test WebP");
    fs::remove_file(&temp_jpeg).ok();

    webp_path
}

/// Creates a minimal valid GIF file for testing
pub fn create_test_gif(dir: &Path, filename: &str) -> PathBuf {
    let file_path = dir.join(filename);

    // Minimal valid GIF file (1x1 pixel, black)
    let gif_data = vec![
        0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
        0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0x21, 0xF9, 0x04, 0x01, 0x00,
        0x00, 0x00, 0x00, 0x2C, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
        0x00, 0x02, 0x02, 0x04, 0x01, 0x00, 0x3B
    ];

    fs::write(&file_path, gif_data).expect("Failed to create test GIF");
    file_path
}

/// Creates an invalid image file for testing
pub fn create_invalid_image(dir: &Path, filename: &str) -> PathBuf {
    let file_path = dir.join(filename);
    fs::write(&file_path, b"invalid image data").expect("Failed to create invalid image");
    file_path
}

/// Creates a text file with image extension for testing
pub fn create_fake_image(dir: &Path, filename: &str) -> PathBuf {
    let file_path = dir.join(filename);
    fs::write(&file_path, b"This is not an image").expect("Failed to create fake image");
    file_path
}

/// Sets up a test environment variable
pub fn setup_test_env_var(key: &str, value: &str) -> String {
    let original = std::env::var(key).unwrap_or_default();
    std::env::set_var(key, value);
    original
}

/// Restores an environment variable
pub fn restore_env_var(key: &str, original: &str) {
    if original.is_empty() {
        std::env::remove_var(key);
    } else {
        std::env::set_var(key, original);
    }
}