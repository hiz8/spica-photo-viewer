//! Display-resolution preview generation (design spec 2026-08-21 §6.1).
//! One decode produces both the preview JPEG (orientation applied, ICC kept,
//! alpha flattened onto the viewer's black background, fitted inside the
//! screen box without upscaling) and the 20px thumbnail derived from it.

use crate::utils::perf::PerfTimer;
use base64::{engine::general_purpose, Engine as _};
use fast_image_resize::{
    images::Image as FirImage, FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer,
};
use image::{DynamicImage, ExtendedColorType, ImageDecoder, ImageFormat, ImageReader, RgbImage};
use jpeg_encoder::{ColorType as JpegColorType, Encoder as JpegEncoderFast, SamplingFactor};
use std::io::Cursor;
use std::path::Path;

pub const PREVIEW_JPEG_QUALITY: u8 = 85;

/// Mirror of `THUMBNAIL_SIZE` in `src/constants/timing.ts` — the bar thumbnail size
/// used when serving a `/preview/` request generates one as a side effect.
pub const DEFAULT_THUMB_SIZE: u32 = 20;

/// Screen-box buckets (D2). Either orientation of a bucket is accepted so a
/// portrait monitor gets a portrait box.
pub const ALLOWED_PREVIEW_BOXES: &[(u32, u32)] = &[(1920, 1080), (2560, 1440), (3840, 2160)];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreviewBox {
    pub width: u32,
    pub height: u32,
}

impl PreviewBox {
    /// Parses "WxH". Only allowlisted buckets are accepted — the box is part of
    /// a URL and a cache key, so arbitrary sizes must not reach the generator.
    pub fn parse(s: &str) -> Option<PreviewBox> {
        let (w, h) = s.split_once('x')?;
        let (w, h) = (w.parse::<u32>().ok()?, h.parse::<u32>().ok()?);
        let allowed = ALLOWED_PREVIEW_BOXES
            .iter()
            .any(|&(bw, bh)| (bw == w && bh == h) || (bw == h && bh == w));
        allowed.then_some(PreviewBox {
            width: w,
            height: h,
        })
    }

    pub fn key(&self) -> String {
        format!("{}x{}", self.width, self.height)
    }
}

pub struct Generated {
    pub preview_jpeg: Vec<u8>,
    // preview_width/preview_height/resized are part of the documented Generated
    // contract (asserted on directly by preview.rs's own tests) but no current
    // caller reads them off the struct — decode the JPEG's dimensions or check
    // `natural_*` vs the requested box instead when that's needed in production.
    #[allow(dead_code)]
    pub preview_width: u32,
    #[allow(dead_code)]
    pub preview_height: u32,
    /// Orientation-applied size of the original.
    pub natural_width: u32,
    pub natural_height: u32,
    /// false when the original already fit inside the box (preview == original size).
    #[allow(dead_code)]
    pub resized: bool,
    pub thumbnail_base64: String,
}

/// Size that fits (w, h) inside the box preserving aspect ratio, or None when
/// it already fits (never upscale).
pub fn fit_within(w: u32, h: u32, bbox: PreviewBox) -> Option<(u32, u32)> {
    if w <= bbox.width && h <= bbox.height {
        return None;
    }
    let scale = f64::min(
        f64::from(bbox.width) / f64::from(w),
        f64::from(bbox.height) / f64::from(h),
    );
    let tw = ((f64::from(w) * scale).round() as u32).clamp(1, bbox.width);
    let th = ((f64::from(h) * scale).round() as u32).clamp(1, bbox.height);
    Some((tw, th))
}

struct Decoded {
    image: DynamicImage,
    icc: Option<Vec<u8>>,
    /// The source file's color type *before* decoding converted it (X1) — a
    /// CMYK/YCCK JPEG is already RGB pixels in `image` by the time it's a
    /// `DynamicImage`, but `original_color` still says `Cmyk8`.
    original_color: ExtendedColorType,
}

/// Decodes with the Exif orientation applied (what browsers display) and
/// returns the embedded ICC profile, if any.
fn decode_oriented(path: &Path) -> Result<Decoded, String> {
    let reader = ImageReader::open(path)
        .map_err(|e| format!("open: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("format: {e}"))?;
    let mut decoder = reader.into_decoder().map_err(|e| format!("decoder: {e}"))?;
    let orientation = decoder
        .orientation()
        .map_err(|e| format!("orientation: {e}"))?;
    let icc = decoder.icc_profile().map_err(|e| format!("icc: {e}"))?;
    // X1: must be read before `from_decoder` consumes the decoder.
    let original_color = decoder.original_color_type();
    let mut image = DynamicImage::from_decoder(decoder).map_err(|e| format!("decode: {e}"))?;
    image.apply_orientation(orientation);
    Ok(Decoded {
        image,
        icc,
        original_color,
    })
}

/// RGB8 with any alpha composited onto black (the viewer background), so the
/// JPEG preview looks identical to the original over the black canvas.
///
/// M1: takes `image` by value and uses `into_*` instead of `to_*` — for the
/// common no-alpha case `into_rgb8()` returns the decoder's own buffer with
/// no copy at all (vs. `to_rgb8()`'s always-copy), which matters at ~72 MB
/// for a 24 MP photo.
fn flatten_to_rgb8(image: DynamicImage) -> RgbImage {
    if !image.color().has_alpha() {
        return image.into_rgb8();
    }
    let rgba = image.into_rgba8();
    let mut out = RgbImage::new(rgba.width(), rgba.height());
    for (dst, src) in out.pixels_mut().zip(rgba.pixels()) {
        let a = u32::from(src[3]);
        dst.0 = [
            ((u32::from(src[0]) * a + 127) / 255) as u8,
            ((u32::from(src[1]) * a + 127) / 255) as u8,
            ((u32::from(src[2]) * a + 127) / 255) as u8,
        ];
    }
    out
}

/// X1: ICC is carried only when the SOURCE was encoded as RGB/RGBA; for
/// CMYK/YCCK sources the decoder already converted to RGB and the embedded
/// profile would describe the wrong color space, so it is dropped. Must be
/// checked against the *original* (pre-decode) color type, not the decoded
/// `DynamicImage`'s — `image`'s JPEG decoder always hands back RGB8 pixels
/// for a CMYK/YCCK source, so gating on the decoded type would let a CMYK
/// profile through and stamp it onto already-converted RGB pixels.
fn icc_applies(original: ExtendedColorType) -> bool {
    matches!(
        original,
        ExtendedColorType::Rgb8
            | ExtendedColorType::Rgba8
            | ExtendedColorType::Rgb16
            | ExtendedColorType::Rgba16
            | ExtendedColorType::Rgb32F
            | ExtendedColorType::Rgba32F
    )
}

fn resize_rgb8(src: RgbImage, tw: u32, th: u32) -> Result<RgbImage, String> {
    let src = DynamicImage::ImageRgb8(src);
    let mut dst = FirImage::new(tw, th, PixelType::U8x3);
    let mut resizer = Resizer::new();
    resizer
        .resize(
            &src,
            &mut dst,
            &ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3)),
        )
        .map_err(|e| format!("resize: {e}"))?;
    RgbImage::from_raw(tw, th, dst.into_vec())
        .ok_or_else(|| "resize: buffer size mismatch".to_string())
}

/// Preview JPEG via the `jpeg-encoder` crate: 4:2:0 chroma subsampling and
/// SIMD make it several times faster than the `image` crate's encoder, which
/// dominated thumb_preview (see the Phase 2 gate numbers in the plan ledger).
/// Thumbnails (20 px) keep using `image`'s encoder through `write_to`.
fn encode_jpeg(rgb: &RgbImage, quality: u8, icc: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let (w, h) = (rgb.width(), rgb.height());
    let width =
        u16::try_from(w).map_err(|_| format!("encode: width {w} exceeds the JPEG limit"))?;
    let height =
        u16::try_from(h).map_err(|_| format!("encode: height {h} exceeds the JPEG limit"))?;
    let mut out: Vec<u8> = Vec::with_capacity((w as usize * h as usize) / 4);
    let mut encoder = JpegEncoderFast::new(&mut out, quality);
    encoder.set_sampling_factor(SamplingFactor::F_2_2); // 4:2:0
    if let Some(icc) = icc {
        // X2: a profile the encoder refuses (e.g. > 254 APP2 chunks, so over
        // ~15.9 MB) must not fail the whole preview — degrade to no ICC
        // rather than lose the bar thumbnail generated alongside it.
        if let Err(e) = encoder.add_icc_profile(icc) {
            eprintln!("preview: dropping ICC profile ({e})");
        }
    }
    encoder
        .encode(rgb.as_raw(), width, height, JpegColorType::Rgb)
        .map_err(|e| format!("encode: {e}"))?;
    Ok(out)
}

fn thumbnail_base64(image: &DynamicImage, thumb_size: u32) -> Result<String, String> {
    let thumb = image.thumbnail(thumb_size, thumb_size);
    let mut buf = Vec::new();
    thumb
        .write_to(&mut Cursor::new(&mut buf), ImageFormat::Jpeg)
        .map_err(|e| format!("thumbnail: {e}"))?;
    Ok(general_purpose::STANDARD.encode(&buf))
}

/// Preview + thumbnail from ONE decode. `path` must already be validated.
pub fn generate(path: &Path, bbox: PreviewBox, thumb_size: u32) -> Result<Generated, String> {
    let path_str = path.to_string_lossy();
    let Decoded {
        image,
        icc,
        original_color,
    } = {
        let _t = PerfTimer::start("preview_decode", &path_str);
        decode_oriented(path)?
    };
    let (natural_width, natural_height) = (image.width(), image.height());
    let icc = if icc_applies(original_color) {
        icc
    } else {
        None
    };
    let rgb = flatten_to_rgb8(image);
    let (preview, resized) = match fit_within(natural_width, natural_height, bbox) {
        Some((tw, th)) => {
            let _t = PerfTimer::start("preview_resize", &path_str);
            (resize_rgb8(rgb, tw, th)?, true)
        }
        None => (rgb, false),
    };
    let (preview_width, preview_height) = (preview.width(), preview.height());
    let preview_jpeg = {
        let _t = PerfTimer::start("preview_encode", &path_str);
        encode_jpeg(&preview, PREVIEW_JPEG_QUALITY, icc.as_deref())?
    };
    let thumbnail_base64 = thumbnail_base64(&DynamicImage::ImageRgb8(preview), thumb_size)?;
    Ok(Generated {
        preview_jpeg,
        preview_width,
        preview_height,
        natural_width,
        natural_height,
        resized,
        thumbnail_base64,
    })
}

/// Thumbnail without a preview (GIF keeps its `<img>` path; the first frame
/// is enough for the bar). Returns (base64, natural width, natural height).
pub fn thumbnail_only(path: &Path, thumb_size: u32) -> Result<(String, u32, u32), String> {
    let Decoded { image, .. } = decode_oriented(path)?;
    let (w, h) = (image.width(), image.height());
    Ok((thumbnail_base64(&image, thumb_size)?, w, h))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::*;
    use image::{GenericImageView, ImageDecoder, ImageReader};

    fn box_1080p() -> PreviewBox {
        PreviewBox::parse("1920x1080").unwrap()
    }

    #[test]
    fn parse_accepts_allowlisted_boxes_in_both_orientations() {
        assert_eq!(
            PreviewBox::parse("1920x1080"),
            Some(PreviewBox {
                width: 1920,
                height: 1080
            })
        );
        assert_eq!(
            PreviewBox::parse("1080x1920"),
            Some(PreviewBox {
                width: 1080,
                height: 1920
            })
        );
        assert_eq!(
            PreviewBox::parse("3840x2160").map(|b| b.key()),
            Some("3840x2160".to_string())
        );
        assert_eq!(PreviewBox::parse("1920x1200"), None);
        assert_eq!(PreviewBox::parse("abc"), None);
        assert_eq!(PreviewBox::parse("1920x"), None);
    }

    #[test]
    fn fit_within_keeps_aspect_and_never_upscales() {
        assert_eq!(fit_within(5472, 3648, box_1080p()), Some((1620, 1080)));
        assert_eq!(fit_within(3648, 5472, box_1080p()), Some((720, 1080)));
        assert_eq!(fit_within(1024, 768, box_1080p()), None);
        assert_eq!(fit_within(1920, 1080, box_1080p()), None);
        assert_eq!(fit_within(4000, 1000, box_1080p()), Some((1920, 480)));
    }

    #[test]
    fn icc_applies_only_to_rgb_like_color_types() {
        assert!(icc_applies(ExtendedColorType::Rgb8));
        assert!(icc_applies(ExtendedColorType::Rgba8));
        assert!(icc_applies(ExtendedColorType::Rgb16));
        assert!(icc_applies(ExtendedColorType::Rgba16));
        assert!(icc_applies(ExtendedColorType::Rgb32F));
        assert!(icc_applies(ExtendedColorType::Rgba32F));
        assert!(!icc_applies(ExtendedColorType::L8));
        assert!(!icc_applies(ExtendedColorType::La8));
        assert!(!icc_applies(ExtendedColorType::L16));
        assert!(!icc_applies(ExtendedColorType::La16));
        // X1: this is the case that motivated switching from the decoded
        // `DynamicImage`'s color (always RGB8 post-decode) to the source's
        // original color type — a CMYK/YCCK JPEG must not carry its profile.
        assert!(!icc_applies(ExtendedColorType::Cmyk8));
    }

    #[test]
    fn generate_resizes_large_image_into_box_and_reports_natural_size() {
        let dir = create_temp_dir();
        let src = create_gradient_jpeg(dir.path(), "big.jpg", 2400, 1600);
        let g = generate(&src, box_1080p(), 20).unwrap();
        assert!(g.resized);
        assert_eq!((g.natural_width, g.natural_height), (2400, 1600));
        assert_eq!((g.preview_width, g.preview_height), (1620, 1080));
        let decoded = image::load_from_memory(&g.preview_jpeg).unwrap();
        assert_eq!(decoded.dimensions(), (1620, 1080));
        let thumb = image::load_from_memory(
            &base64::engine::general_purpose::STANDARD
                .decode(&g.thumbnail_base64)
                .unwrap(),
        )
        .unwrap();
        assert!(thumb.width() <= 20 && thumb.height() <= 20);
        assert!(thumb.width() == 20 || thumb.height() == 20);
    }

    #[test]
    fn generate_keeps_small_images_at_native_size() {
        let dir = create_temp_dir();
        let src = create_gradient_jpeg(dir.path(), "small.jpg", 640, 480);
        let g = generate(&src, box_1080p(), 20).unwrap();
        assert!(!g.resized);
        assert_eq!((g.preview_width, g.preview_height), (640, 480));
        assert_eq!((g.natural_width, g.natural_height), (640, 480));
    }

    #[test]
    fn generate_applies_exif_orientation_before_measuring_and_resizing() {
        let dir = create_temp_dir();
        // Encoded 1200x800 with Orientation=6: displayed (natural) size is 800x1200.
        let src = create_jpeg_with_metadata(dir.path(), "rot.jpg", 1200, 800, Some(6), None);
        let g = generate(&src, box_1080p(), 20).unwrap();
        assert_eq!((g.natural_width, g.natural_height), (800, 1200));
        assert_eq!((g.preview_width, g.preview_height), (720, 1080));
        // The preview must carry no Exif orientation of its own (it is already upright).
        let mut dec = ImageReader::new(std::io::Cursor::new(&g.preview_jpeg))
            .with_guessed_format()
            .unwrap()
            .into_decoder()
            .unwrap();
        assert_eq!(
            dec.orientation().unwrap(),
            image::metadata::Orientation::NoTransforms
        );
    }

    #[test]
    fn generate_carries_the_icc_profile_into_the_preview() {
        let dir = create_temp_dir();
        let icc: Vec<u8> = (0..600u32).map(|i| (i % 251) as u8).collect();
        let src = create_jpeg_with_metadata(dir.path(), "icc.jpg", 2400, 1600, None, Some(&icc));
        let g = generate(&src, box_1080p(), 20).unwrap();
        let mut dec = ImageReader::new(std::io::Cursor::new(&g.preview_jpeg))
            .with_guessed_format()
            .unwrap()
            .into_decoder()
            .unwrap();
        assert_eq!(dec.icc_profile().unwrap(), Some(icc));
    }

    #[test]
    fn generate_degrades_gracefully_when_the_icc_profile_is_too_large_to_attach() {
        let dir = create_temp_dir();
        // X2: the smallest profile length `jpeg_encoder::Encoder::add_icc_profile`
        // rejects — it splits into 65519-byte APP2 chunks and errors once the
        // count reaches 255 (254 * 65519 + 1 = 16,641,827 bytes). Deliberately
        // NOT the coordinator's suggested 17 MiB: that also exceeds `image`'s
        // own JpegEncoder ICC cap (~16.7 MB), so `create_jpeg_with_metadata`
        // itself would panic writing the *source* fixture before this test
        // ever reaches the code under test.
        let icc: Vec<u8> = vec![7u8; 254 * 65519 + 1];
        let src = create_jpeg_with_metadata(dir.path(), "huge_icc.jpg", 200, 100, None, Some(&icc));
        let g = generate(&src, box_1080p(), 20).unwrap();
        let decoded = image::load_from_memory(&g.preview_jpeg).unwrap();
        assert_eq!(decoded.dimensions(), (200, 100));
        let mut dec = ImageReader::new(std::io::Cursor::new(&g.preview_jpeg))
            .with_guessed_format()
            .unwrap()
            .into_decoder()
            .unwrap();
        assert_eq!(dec.icc_profile().unwrap(), None);
    }

    #[test]
    fn generate_flattens_transparency_onto_black() {
        let dir = create_temp_dir();
        let src = create_half_transparent_png(dir.path(), "alpha.png", 200, 100);
        let g = generate(&src, box_1080p(), 20).unwrap();
        let decoded = image::load_from_memory(&g.preview_jpeg).unwrap().to_rgb8();
        let left = decoded.get_pixel(50, 50);
        let right = decoded.get_pixel(150, 50);
        assert!(
            left[0] > 240 && left[1] > 240 && left[2] > 240,
            "opaque white stays white: {:?}",
            left
        );
        assert!(
            right[0] < 16 && right[1] < 16 && right[2] < 16,
            "transparent becomes black: {:?}",
            right
        );
    }

    #[test]
    fn thumbnail_only_returns_base64_and_dimensions() {
        let dir = create_temp_dir();
        let src = create_test_gif(dir.path(), "anim.gif");
        let (b64, w, h) = thumbnail_only(&src, 20).unwrap();
        assert!(!b64.is_empty());
        assert_eq!((w, h), (1, 1));
    }

    #[test]
    fn generate_rejects_invalid_files() {
        let dir = create_temp_dir();
        let src = create_invalid_image(dir.path(), "bad.jpg");
        assert!(generate(&src, box_1080p(), 20).is_err());
    }
}
