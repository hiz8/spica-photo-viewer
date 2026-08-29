#![cfg(test)]

use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

pub fn create_temp_dir() -> TempDir {
    tempfile::tempdir().expect("Failed to create temp directory")
}

pub fn create_test_jpeg(dir: &Path, filename: &str) -> PathBuf {
    use image::{ImageBuffer, Rgb};

    let file_path = dir.join(filename);

    let img = ImageBuffer::from_fn(1, 1, |_x, _y| Rgb([255u8, 0u8, 0u8]));
    img.save(&file_path).expect("Failed to create test JPEG");

    file_path
}

pub fn create_test_png(dir: &Path, filename: &str) -> PathBuf {
    use image::{ImageBuffer, Rgb};

    let file_path = dir.join(filename);

    let img = ImageBuffer::from_fn(1, 1, |_x, _y| Rgb([0u8, 255u8, 0u8]));
    img.save(&file_path).expect("Failed to create test PNG");

    file_path
}

/// Real WebP encoding needs `image` crate features this build doesn't enable,
/// so this creates a JPEG and renames it — exercises extension-based
/// dispatch only, not WebP decoding itself.
pub fn create_test_webp(dir: &Path, filename: &str) -> PathBuf {
    let temp_jpeg = dir.join("temp.jpg");
    let webp_path = dir.join(filename);

    use image::{ImageBuffer, Rgb};
    let img = ImageBuffer::from_fn(1, 1, |_x, _y| Rgb([0u8, 0u8, 255u8]));
    img.save(&temp_jpeg).expect("Failed to create temp JPEG");

    let data = fs::read(&temp_jpeg).expect("Failed to read temp JPEG");
    fs::write(&webp_path, &data).expect("Failed to create test WebP");
    fs::remove_file(&temp_jpeg).ok();

    webp_path
}

pub fn create_test_gif(dir: &Path, filename: &str) -> PathBuf {
    let file_path = dir.join(filename);

    // Minimal valid GIF file (1x1 pixel, black)
    let gif_data = vec![
        0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00,
        0x00, 0xFF, 0xFF, 0xFF, 0x21, 0xF9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2C, 0x00, 0x00,
        0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x04, 0x01, 0x00, 0x3B,
    ];

    fs::write(&file_path, gif_data).expect("Failed to create test GIF");
    file_path
}

pub fn create_invalid_image(dir: &Path, filename: &str) -> PathBuf {
    let file_path = dir.join(filename);
    fs::write(&file_path, b"invalid image data").expect("Failed to create invalid image");
    file_path
}

pub fn create_fake_image(dir: &Path, filename: &str) -> PathBuf {
    let file_path = dir.join(filename);
    fs::write(&file_path, b"This is not an image").expect("Failed to create fake image");
    file_path
}

/// Gradient RGB JPEG of the given size (pixel values vary so resizing is observable).
pub fn create_gradient_jpeg(dir: &Path, filename: &str, width: u32, height: u32) -> PathBuf {
    use image::{ImageBuffer, Rgb};
    let file_path = dir.join(filename);
    let img = ImageBuffer::from_fn(width, height, |x, y| {
        Rgb([
            (x * 255 / width.max(1)) as u8,
            (y * 255 / height.max(1)) as u8,
            128u8,
        ])
    });
    img.save(&file_path)
        .expect("Failed to create gradient JPEG");
    file_path
}

/// RGBA PNG whose left half is opaque white and right half fully transparent white.
pub fn create_half_transparent_png(dir: &Path, filename: &str, width: u32, height: u32) -> PathBuf {
    use image::{ImageBuffer, Rgba};
    let file_path = dir.join(filename);
    let img = ImageBuffer::from_fn(width, height, |x, _y| {
        if x < width / 2 {
            Rgba([255u8, 255u8, 255u8, 255u8])
        } else {
            Rgba([255u8, 255u8, 255u8, 0u8])
        }
    });
    img.save(&file_path).expect("Failed to create RGBA PNG");
    file_path
}

/// Minimal little-endian TIFF/Exif blob carrying only the Orientation tag.
/// The JPEG encoder prepends the "Exif\0\0" APP1 header itself.
pub fn exif_orientation_blob(orientation: u16) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(b"II\x2A\x00"); // byte order + magic 42
    v.extend_from_slice(&8u32.to_le_bytes()); // IFD0 offset
    v.extend_from_slice(&1u16.to_le_bytes()); // one entry
    v.extend_from_slice(&0x0112u16.to_le_bytes()); // Orientation
    v.extend_from_slice(&3u16.to_le_bytes()); // SHORT
    v.extend_from_slice(&1u32.to_le_bytes()); // count
    v.extend_from_slice(&orientation.to_le_bytes());
    v.extend_from_slice(&0u16.to_le_bytes()); // value padding to 4 bytes
    v.extend_from_slice(&0u32.to_le_bytes()); // next IFD: none
    v
}

/// Gradient JPEG with an Exif Orientation tag (e.g. 6 = rotate 90 CW on display)
/// and, optionally, an ICC profile segment.
pub fn create_jpeg_with_metadata(
    dir: &Path,
    filename: &str,
    width: u32,
    height: u32,
    orientation: Option<u16>,
    icc: Option<&[u8]>,
) -> PathBuf {
    use image::codecs::jpeg::JpegEncoder;
    use image::{ExtendedColorType, ImageBuffer, ImageEncoder, Rgb};
    let file_path = dir.join(filename);
    let img = ImageBuffer::from_fn(width, height, |x, y| {
        Rgb([
            (x * 255 / width.max(1)) as u8,
            (y * 255 / height.max(1)) as u8,
            64u8,
        ])
    });
    let file = fs::File::create(&file_path).expect("create jpeg");
    let mut encoder = JpegEncoder::new_with_quality(std::io::BufWriter::new(file), 90);
    if let Some(o) = orientation {
        encoder
            .set_exif_metadata(exif_orientation_blob(o))
            .expect("jpeg encoder supports exif");
    }
    if let Some(icc) = icc {
        encoder
            .set_icc_profile(icc.to_vec())
            .expect("jpeg encoder supports icc");
    }
    encoder
        .write_image(img.as_raw(), width, height, ExtendedColorType::Rgb8)
        .expect("write jpeg");
    file_path
}
