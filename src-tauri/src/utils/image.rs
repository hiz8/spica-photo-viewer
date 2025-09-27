use image::{ImageError, ImageFormat};
use std::path::Path;
use base64::{engine::general_purpose, Engine as _};

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
            let file_data = std::fs::read(path)
                .map_err(|e| ImageError::IoError(e))?;
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
    let reader = image::io::Reader::open(path)?;
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