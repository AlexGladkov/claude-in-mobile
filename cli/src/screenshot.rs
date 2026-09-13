//! Screenshot capture and compression

use ab_glyph::{FontArc, PxScale};
use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::{DynamicImage, GenericImageView, ImageReader, Limits, Rgba, RgbaImage};
use imageproc::drawing::{draw_hollow_rect_mut, draw_text_mut};
use imageproc::rect::Rect;
use std::fs::OpenOptions;
use std::io::{Cursor, Write as _};

use crate::utils::process::terminal_safe;
use crate::{android, harmony, ios};

const MAX_ENCODED_IMAGE_BYTES: usize = 50 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 32_768;
const MAX_IMAGE_PIXELS: u64 = 40_000_000;

fn write_screenshot_file(path: &str, data: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW).mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        options.custom_flags(0x0020_0000);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("Cannot safely open screenshot output {path}"))?;
    file.write_all(data)?;
    file.sync_all()?;
    Ok(())
}

fn decode_image(data: &[u8]) -> Result<DynamicImage> {
    if data.is_empty() || data.len() > MAX_ENCODED_IMAGE_BYTES {
        anyhow::bail!(
            "Image input must be between 1 and {} bytes",
            MAX_ENCODED_IMAGE_BYTES
        );
    }

    let reader = ImageReader::new(Cursor::new(data)).with_guessed_format()?;
    let (width, height) = reader.into_dimensions()?;
    if width == 0
        || height == 0
        || width > MAX_IMAGE_DIMENSION
        || height > MAX_IMAGE_DIMENSION
        || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS
    {
        anyhow::bail!(
            "Image dimensions exceed the {}-pixel decode limit",
            MAX_IMAGE_PIXELS
        );
    }

    let mut reader = ImageReader::new(Cursor::new(data)).with_guessed_format()?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(192 * 1024 * 1024);
    reader.limits(limits);
    Ok(reader.decode()?)
}

/// Take screenshot with optional compression
pub fn take_screenshot(
    platform: &str,
    output: Option<&str>,
    compress: bool,
    max_width: u32,
    max_height: u32,
    quality: u8,
    simulator: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    let png_data = if platform == "android" {
        android::screenshot(device)?
    } else {
        ios::screenshot(simulator)?
    };
    write_screenshot_output(png_data, output, compress, max_width, max_height, quality)
}

pub(crate) fn write_screenshot_output(
    png_data: Vec<u8>,
    output: Option<&str>,
    compress: bool,
    max_width: u32,
    max_height: u32,
    quality: u8,
) -> Result<()> {
    let final_data = if compress {
        compress_image(&png_data, max_width, max_height, quality)?
    } else {
        png_data
    };

    if let Some(path) = output {
        write_screenshot_file(path, &final_data)?;
        eprintln!(
            "Screenshot saved to: {} ({} bytes)",
            terminal_safe(path.as_bytes()),
            final_data.len(),
        );
    } else {
        let b64 = BASE64.encode(&final_data);
        println!("{}", b64);
        eprintln!(
            "Screenshot: {} bytes (base64: {} chars)",
            final_data.len(),
            b64.len()
        );
    }
    Ok(())
}

/// Compress image for LLM processing
fn compress_image(
    png_data: &[u8],
    max_width: u32,
    max_height: u32,
    quality: u8,
) -> Result<Vec<u8>> {
    if max_width == 0
        || max_height == 0
        || max_width > MAX_IMAGE_DIMENSION
        || max_height > MAX_IMAGE_DIMENSION
        || !(1..=100).contains(&quality)
    {
        anyhow::bail!("Invalid screenshot compression options");
    }
    let img = decode_image(png_data)?;
    let (width, height) = img.dimensions();

    eprintln!("Original: {}x{} ({} bytes)", width, height, png_data.len());

    let img = if width > max_width || height > max_height {
        eprintln!("Resizing within: {}x{}", max_width, max_height);
        img.resize(max_width, max_height, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };

    // Convert to JPEG for smaller size
    let mut jpeg_data = Vec::new();
    let mut cursor = Cursor::new(&mut jpeg_data);

    // Use JPEG encoder with quality setting
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, quality);
    img.write_with_encoder(encoder)?;

    eprintln!(
        "Compressed: {} bytes ({}% of original)",
        jpeg_data.len(),
        jpeg_data.len() * 100 / png_data.len()
    );

    Ok(jpeg_data)
}

struct AnnotationElement {
    bounds: (i32, i32, i32, i32),
    clickable: bool,
    label: String,
}

/// Take annotated screenshot with UI element bounds drawn
pub fn take_annotated_screenshot(
    platform: &str,
    output: Option<&str>,
    device: Option<&str>,
    simulator: Option<&str>,
) -> Result<()> {
    // Get screenshot and the platform accessibility bounds.
    let png_data = match platform {
        "android" => android::screenshot(device)?,
        "harmony" => harmony::screenshot(device)?,
        _ => ios::screenshot(simulator)?,
    };
    let elements = match platform {
        "android" => android::get_ui_elements(device)?
            .into_iter()
            .map(|element| AnnotationElement {
                bounds: element.bounds,
                clickable: element.clickable,
                label: element.label(),
            })
            .collect::<Vec<_>>(),
        "harmony" => harmony::get_ui_elements(device)?
            .into_iter()
            .map(|element| AnnotationElement {
                bounds: element.bounds,
                clickable: element.clickable,
                label: element.label().to_owned(),
            })
            .collect::<Vec<_>>(),
        _ => {
            eprintln!("Note: Annotated screenshot element bounds are unavailable on iOS");
            Vec::new()
        }
    };

    // Load image
    let img = decode_image(&png_data)?;
    let mut rgba_img: RgbaImage = img.to_rgba8();

    // Colors for drawing
    let red = Rgba([255u8, 0u8, 0u8, 255u8]);
    let green = Rgba([0u8, 255u8, 0u8, 255u8]);

    // Load a basic font (embedded for portability)
    let font_data = include_bytes!("../assets/DejaVuSans.ttf");
    let font = FontArc::try_from_slice(font_data).context("Failed to load font")?;
    let scale = PxScale::from(24.0);

    // Draw elements
    for (i, elem) in elements.iter().enumerate() {
        let (x1, y1, x2, y2) = elem.bounds;

        // Skip very small or full-screen elements
        let width = x2 - x1;
        let height = y2 - y1;
        if width < 10 || height < 10 || (width > 1000 && height > 2000) {
            continue;
        }

        let color = if elem.clickable { green } else { red };

        // Draw rectangle
        if x1 >= 0 && y1 >= 0 && x2 > x1 && y2 > y1 {
            let rect = Rect::at(x1, y1).of_size((x2 - x1) as u32, (y2 - y1) as u32);
            draw_hollow_rect_mut(&mut rgba_img, rect, color);
        }

        // Draw number label
        let label = format!("{}", i + 1);
        draw_text_mut(
            &mut rgba_img,
            color,
            x1,
            y1.saturating_sub(20),
            scale,
            &font,
            &label,
        );
    }

    // Convert back to bytes
    let mut output_data = Vec::new();
    let mut cursor = Cursor::new(&mut output_data);
    rgba_img.write_to(&mut cursor, image::ImageFormat::Png)?;

    // Output
    if let Some(path) = output {
        write_screenshot_file(path, &output_data)?;
        eprintln!(
            "Annotated screenshot saved to: {} ({} bytes)",
            terminal_safe(path.as_bytes()),
            output_data.len()
        );
    } else {
        let b64 = BASE64.encode(&output_data);
        println!("{}", b64);
        eprintln!("Annotated screenshot: {} bytes", output_data.len());
    }

    // Print element index
    eprintln!("\nElements:");
    for (i, element) in elements.iter().enumerate() {
        let (x1, y1, x2, y2) = element.bounds;
        let center = ((x1 + x2) / 2, (y1 + y2) / 2);
        eprintln!(
            "  {}: {} @ ({}, {})",
            i + 1,
            terminal_safe(element.label.as_bytes()),
            center.0,
            center.1
        );
    }

    Ok(())
}

/// Analyze screenshot and return structured info (for future use)
#[allow(dead_code)]
pub fn analyze_screenshot(data: &[u8]) -> Result<ScreenshotInfo> {
    let img = decode_image(data)?;
    let (width, height) = img.dimensions();

    // Calculate average brightness
    let brightness = calculate_brightness(&img);

    // Detect if mostly text (high contrast)
    let is_text_heavy = brightness > 200.0 || brightness < 50.0;

    Ok(ScreenshotInfo {
        width,
        height,
        size_bytes: data.len(),
        brightness,
        is_text_heavy,
    })
}

#[allow(dead_code)]
fn calculate_brightness(img: &DynamicImage) -> f32 {
    let rgb = img.to_rgb8();
    let pixels = rgb.pixels();
    let mut total: u64 = 0;
    let mut count: u64 = 0;

    for pixel in pixels {
        // Luminance formula
        let r = pixel[0] as u64;
        let g = pixel[1] as u64;
        let b = pixel[2] as u64;
        total += (r * 299 + g * 587 + b * 114) / 1000;
        count += 1;
    }

    if count > 0 {
        total as f32 / count as f32
    } else {
        0.0
    }
}

#[derive(Debug)]
#[allow(dead_code)]
pub struct ScreenshotInfo {
    pub width: u32,
    pub height: u32,
    pub size_bytes: usize,
    pub brightness: f32,
    pub is_text_heavy: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_png(width: u32, height: u32) -> Vec<u8> {
        let image = DynamicImage::new_rgba8(width, height);
        let mut data = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut data), image::ImageFormat::Png)
            .unwrap();
        data
    }

    #[test]
    fn compression_honors_both_dimension_limits() {
        let compressed = compress_image(&test_png(100, 200), 80, 80, 70).unwrap();
        let image = decode_image(&compressed).unwrap();
        assert_eq!(image.dimensions(), (40, 80));
    }

    #[test]
    fn compression_rejects_invalid_options_before_decoding() {
        assert!(compress_image(&test_png(1, 1), 0, 80, 70).is_err());
        assert!(compress_image(&test_png(1, 1), 80, 80, 0).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn screenshot_output_refuses_symlinks() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target.png");
        let output = directory.path().join("output.png");
        std::fs::write(&target, b"untouched").unwrap();
        symlink(&target, &output).unwrap();

        assert!(write_screenshot_file(output.to_str().unwrap(), b"replacement").is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"untouched");
    }
}
