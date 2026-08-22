use image::ImageFormat;
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

// Not called from production code (kept for its test coverage and as the
// canonical extension→ImageFormat mapping other modules can reach for);
// pre-existing dead_code warning, unrelated to the preview-tier work.
#[allow(dead_code)]
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
}
