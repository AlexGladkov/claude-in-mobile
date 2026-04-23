//! Coordinate scaling utilities.
//!
//! Converts coordinates from compressed screenshot space to actual device
//! resolution so that taps and swipes land in the right spot.

use anyhow::{Context, Result};

/// Parse a `"WxH"` size string into `(width, height)` as `f64`.
pub fn parse_size(s: &str) -> Result<(f64, f64)> {
    let parts: Vec<&str> = s.splitn(2, 'x').collect();
    if parts.len() != 2 {
        anyhow::bail!("Invalid size format '{}'. Use WxH (e.g. 540x960)", s);
    }
    let w: f64 = parts[0].trim().parse().context("Invalid width in --from-size")?;
    let h: f64 = parts[1].trim().parse().context("Invalid height in --from-size")?;
    if w <= 0.0 || h <= 0.0 {
        anyhow::bail!("Size values must be positive");
    }
    Ok((w, h))
}

/// Scale screenshot coordinates to device coordinates.
///
/// `from_size`: compressed screenshot dimensions (WxH string, e.g. "540x960").
/// When not provided, coordinates are passed through unchanged.
pub fn apply_scale(
    x: i32,
    y: i32,
    from_size: Option<&str>,
    platform: &str,
    device: Option<&str>,
    simulator: Option<&str>,
) -> Result<(i32, i32)> {
    let from = match from_size {
        None => return Ok((x, y)),
        Some(s) => parse_size(s)?,
    };

    let (dev_w, dev_h): (f64, f64) = match platform {
        "android" | "aurora" => {
            let (w, h) = crate::android::get_screen_size(device)?;
            (w as f64, h as f64)
        }
        "ios" => {
            let data = crate::ios::screenshot(simulator)?;
            let img = image::load_from_memory(&data)?;
            (img.width() as f64, img.height() as f64)
        }
        _ => return Ok((x, y)), // desktop: pass through
    };

    let scale_x = dev_w / from.0;
    let scale_y = dev_h / from.1;
    if (scale_x - 1.0).abs() < 0.001 && (scale_y - 1.0).abs() < 0.001 {
        return Ok((x, y));
    }
    Ok((
        (x as f64 * scale_x).round() as i32,
        (y as f64 * scale_y).round() as i32,
    ))
}
