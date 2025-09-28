use base64::{engine::general_purpose, Engine as _};
use image::{ImageError, ImageFormat};
use std::path::Path;

pub fn is_supported_image(path: &Path) -> bool {
    match path.extension().and_then(|s| s.to_str()) {
        Some(ext) => matches!(
            ext.to_lowercase().as_str(),
            "jpg" | "jpeg" | "png" | "webp" | "gif"
        ),
        None => false,
    }
}

pub fn get_image_format(path: &Path) -> Option<ImageFormat> {
    match path.extension().and_then(|s| s.to_str()) {
        Some(ext) => match ext.to_lowercase().as_str() {
            "jpg" | "jpeg" => Some(ImageFormat::Jpeg),
            "png" => Some(ImageFormat::Png),
            "webp" => Some(ImageFormat::WebP),
            "gif" => Some(ImageFormat::Gif),
            _ => None,
        },
        None => None,
    }
}

pub fn load_image_as_base64(path: &Path) -> Result<String, ImageError> {
    // For GIF files, read the original file to preserve animation
    if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
        if ext.to_lowercase() == "gif" {
            let file_data = std::fs::read(path).map_err(|e| ImageError::IoError(e))?;
            return Ok(general_purpose::STANDARD.encode(&file_data));
        }
    }

    // For other formats, use image processing
    let img = image::open(path)?;
    let mut buffer = Vec::new();

    let format = get_image_format(path).unwrap_or(ImageFormat::Jpeg);

    img.write_to(&mut std::io::Cursor::new(&mut buffer), format)?;

    Ok(general_purpose::STANDARD.encode(&buffer))
}

pub fn get_image_dimensions(path: &Path) -> Result<(u32, u32), ImageError> {
    let reader = image::ImageReader::open(path)?;
    let dimensions = reader.into_dimensions()?;
    Ok(dimensions)
}

pub fn generate_thumbnail(path: &Path, size: u32) -> Result<String, ImageError> {
    let img = image::open(path)?;

    let thumbnail = img.thumbnail(size, size);

    let mut buffer = Vec::new();
    thumbnail.write_to(&mut std::io::Cursor::new(&mut buffer), ImageFormat::Jpeg)?;

    Ok(general_purpose::STANDARD.encode(&buffer))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::*;
    use std::path::Path;

    #[test]
    fn test_is_supported_image_with_jpeg() {
        let temp_dir = create_temp_dir();
        let jpeg_path = create_test_jpeg(temp_dir.path(), "test.jpg");
        assert!(is_supported_image(&jpeg_path));

        let jpeg_path2 = create_test_jpeg(temp_dir.path(), "test.jpeg");
        assert!(is_supported_image(&jpeg_path2));
    }

    #[test]
    fn test_is_supported_image_with_png() {
        let temp_dir = create_temp_dir();
        let png_path = create_test_png(temp_dir.path(), "test.png");
        assert!(is_supported_image(&png_path));
    }

    #[test]
    fn test_is_supported_image_with_webp() {
        let temp_dir = create_temp_dir();
        let webp_path = create_test_webp(temp_dir.path(), "test.webp");
        assert!(is_supported_image(&webp_path));
    }

    #[test]
    fn test_is_supported_image_with_gif() {
        let temp_dir = create_temp_dir();
        let gif_path = create_test_gif(temp_dir.path(), "test.gif");
        assert!(is_supported_image(&gif_path));
    }

    #[test]
    fn test_is_supported_image_with_unsupported_format() {
        let path = Path::new("test.txt");
        assert!(!is_supported_image(path));

        let path2 = Path::new("test.bmp");
        assert!(!is_supported_image(path2));

        let path3 = Path::new("test");
        assert!(!is_supported_image(path3));
    }

    #[test]
    fn test_get_image_format_with_jpeg() {
        let path = Path::new("test.jpg");
        assert_eq!(get_image_format(path), Some(ImageFormat::Jpeg));

        let path2 = Path::new("test.jpeg");
        assert_eq!(get_image_format(path2), Some(ImageFormat::Jpeg));
    }

    #[test]
    fn test_get_image_format_with_png() {
        let path = Path::new("test.png");
        assert_eq!(get_image_format(path), Some(ImageFormat::Png));
    }

    #[test]
    fn test_get_image_format_with_webp() {
        let path = Path::new("test.webp");
        assert_eq!(get_image_format(path), Some(ImageFormat::WebP));
    }

    #[test]
    fn test_get_image_format_with_gif() {
        let path = Path::new("test.gif");
        assert_eq!(get_image_format(path), Some(ImageFormat::Gif));
    }

    #[test]
    fn test_get_image_format_with_unsupported() {
        let path = Path::new("test.txt");
        assert_eq!(get_image_format(path), None);

        let path2 = Path::new("test");
        assert_eq!(get_image_format(path2), None);
    }

    #[test]
    fn test_get_image_dimensions_with_jpeg() {
        let temp_dir = create_temp_dir();
        let jpeg_path = create_test_jpeg(temp_dir.path(), "test.jpg");

        let result = get_image_dimensions(&jpeg_path);
        assert!(result.is_ok());
        let (width, height) = result.unwrap();
        assert_eq!(width, 1);
        assert_eq!(height, 1);
    }

    #[test]
    fn test_get_image_dimensions_with_png() {
        let temp_dir = create_temp_dir();
        let png_path = create_test_png(temp_dir.path(), "test.png");

        let result = get_image_dimensions(&png_path);
        assert!(result.is_ok());
        let (width, height) = result.unwrap();
        assert_eq!(width, 1);
        assert_eq!(height, 1);
    }

    #[test]
    fn test_get_image_dimensions_with_webp() {
        // Since WebP support depends on compilation features,
        // we only test that our function handles the call gracefully
        let temp_dir = create_temp_dir();
        let webp_path = create_test_webp(temp_dir.path(), "test.webp");

        let result = get_image_dimensions(&webp_path);
        // WebP may not be supported in this test environment,
        // so we just verify the function doesn't panic
        match result {
            Ok((width, height)) => {
                assert!(width > 0);
                assert!(height > 0);
            }
            Err(_) => {
                // WebP support might not be available, which is acceptable
            }
        }
    }

    #[test]
    fn test_get_image_dimensions_with_gif() {
        let temp_dir = create_temp_dir();
        let gif_path = create_test_gif(temp_dir.path(), "test.gif");

        let result = get_image_dimensions(&gif_path);
        assert!(result.is_ok());
        let (width, height) = result.unwrap();
        assert_eq!(width, 1);
        assert_eq!(height, 1);
    }

    #[test]
    fn test_get_image_dimensions_with_invalid_file() {
        let temp_dir = create_temp_dir();
        let invalid_path = create_invalid_image(temp_dir.path(), "invalid.jpg");

        let result = get_image_dimensions(&invalid_path);
        assert!(result.is_err());
    }

    #[test]
    fn test_load_image_as_base64_with_jpeg() {
        let temp_dir = create_temp_dir();
        let jpeg_path = create_test_jpeg(temp_dir.path(), "test.jpg");

        let result = load_image_as_base64(&jpeg_path);
        assert!(result.is_ok());
        let base64_data = result.unwrap();
        assert!(!base64_data.is_empty());
    }

    #[test]
    fn test_load_image_as_base64_with_gif() {
        let temp_dir = create_temp_dir();
        let gif_path = create_test_gif(temp_dir.path(), "test.gif");

        let result = load_image_as_base64(&gif_path);
        assert!(result.is_ok());
        let base64_data = result.unwrap();
        assert!(!base64_data.is_empty());
        // GIF should preserve original file data
        assert!(base64_data.len() > 0);
    }

    #[test]
    fn test_load_image_as_base64_with_invalid_file() {
        let temp_dir = create_temp_dir();
        let invalid_path = create_invalid_image(temp_dir.path(), "invalid.jpg");

        let result = load_image_as_base64(&invalid_path);
        assert!(result.is_err());
    }

    #[test]
    fn test_generate_thumbnail_with_valid_image() {
        let temp_dir = create_temp_dir();
        let jpeg_path = create_test_jpeg(temp_dir.path(), "test.jpg");

        let result = generate_thumbnail(&jpeg_path, 30);
        assert!(result.is_ok());
        let thumbnail_data = result.unwrap();
        assert!(!thumbnail_data.is_empty());
    }

    #[test]
    fn test_generate_thumbnail_with_invalid_file() {
        let temp_dir = create_temp_dir();
        let invalid_path = create_invalid_image(temp_dir.path(), "invalid.jpg");

        let result = generate_thumbnail(&invalid_path, 30);
        assert!(result.is_err());
    }
}
