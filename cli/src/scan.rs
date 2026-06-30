//! `scan` command — inject a scannable barcode/QR into the Android emulator camera.
//!
//! The emulator's hidden `videofile` camera source plays back a video file as a
//! full-frame, flat-on camera feed. Feeding it a barcode makes the app under
//! test decode the code through its own camera pipeline (CameraX / ML Kit /
//! ZXing) — no app changes, no mocking.
//!
//! Switching the camera source is a boot-time setting, so the first run on a
//! given emulator needs `--setup` (cold-boots the AVD into videofile mode).
//! Subsequent runs only rewrite the video; reopen the app's camera screen to
//! load the new code.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use image::{imageops, Rgb, RgbImage};

const FRAME_W: u32 = 640;
const FRAME_H: u32 = 480;

/// Entry point for the `scan` subcommand.
pub fn run(
    text: &str,
    kind: &str,
    device: Option<&str>,
    setup: bool,
    avd: Option<&str>,
    video_path: Option<&str>,
    tile: bool,
    hold: f32,
) -> Result<()> {
    let serial = resolve_emulator_serial(device)?;
    let video = resolve_video_path(video_path)?;
    if let Some(dir) = video.parent() {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("Failed to create directory {}", dir.display()))?;
    }

    let frame = render_frame(text, kind, tile)?;
    let png_path = video.with_extension("png");
    frame
        .save(&png_path)
        .with_context(|| format!("Failed to write frame image {}", png_path.display()))?;

    encode_video(&png_path, &video, hold)?;

    if setup {
        setup_emulator(&serial, avd, &video)?;
        println!(
            "Camera set to videofile mode and emulator booted.\n\
             Injected {} \"{}\" -> {}\n\
             Open the app's camera/scanner screen to scan it.",
            kind, text, video.display()
        );
    } else {
        let active = emulator_uses_videofile(&video);
        println!("Injected {} \"{}\" -> {}", kind, text, video.display());
        if active {
            println!("Reopen the app's camera/scanner screen to load the new code.");
        } else {
            println!(
                "WARNING: this emulator does not appear to be running in videofile \
                 camera mode for that path.\n\
                 Run once with `--setup` to cold-boot it into the right mode:\n  \
                 claude-in-mobile scan \"{}\" --type {} --setup",
                text, kind
            );
        }
    }

    Ok(())
}

// -- Path / device resolution -------------------------------------------------

fn resolve_video_path(explicit: Option<&str>) -> Result<PathBuf> {
    if let Some(p) = explicit {
        let mut path = PathBuf::from(p);
        if path.extension().is_none() {
            path.set_extension("mp4");
        }
        return Ok(path);
    }
    let base = dirs::home_dir().context("Could not determine home directory")?;
    Ok(base.join(".claude-mobile").join("scan").join("feed.mp4"))
}

/// Pick the target emulator serial: the explicit one, or the first `emulator-*`
/// device reported by adb.
fn resolve_emulator_serial(device: Option<&str>) -> Result<String> {
    if let Some(d) = device {
        return Ok(d.to_string());
    }
    let out = Command::new("adb")
        .arg("devices")
        .output()
        .context("Failed to run `adb devices` (is adb installed?)")?;
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines().skip(1) {
        let mut parts = line.split_whitespace();
        if let (Some(serial), Some(state)) = (parts.next(), parts.next()) {
            if state == "device" && serial.starts_with("emulator-") {
                return Ok(serial.to_string());
            }
        }
    }
    bail!("No running Android emulator found. Start one, or pass --device <serial>.")
}

// -- Barcode rendering --------------------------------------------------------

fn render_frame(text: &str, kind: &str, tile: bool) -> Result<RgbImage> {
    match kind {
        "qr" => Ok(render_qr_frame(text, tile)?),
        "code128" | "ean13" => Ok(render_linear_frame(text, kind)?),
        other => bail!("Unsupported barcode type: {}", other),
    }
}

/// Render a single QR tile (modules + quiet zone) at `module_px` per module.
fn render_qr_tile(text: &str, module_px: u32, quiet: u32) -> Result<RgbImage> {
    use qrcode::{Color, QrCode};
    let code = QrCode::new(text.as_bytes()).context("Failed to build QR code")?;
    let modules = code.width() as u32;
    let colors = code.to_colors();
    let side = (modules + 2 * quiet) * module_px;
    let mut img = RgbImage::from_pixel(side, side, Rgb([255, 255, 255]));
    for my in 0..modules {
        for mx in 0..modules {
            if colors[(my * modules + mx) as usize] == Color::Dark {
                let px0 = (mx + quiet) * module_px;
                let py0 = (my + quiet) * module_px;
                for dy in 0..module_px {
                    for dx in 0..module_px {
                        img.put_pixel(px0 + dx, py0 + dy, Rgb([0, 0, 0]));
                    }
                }
            }
        }
    }
    Ok(img)
}

/// Build the camera frame for a QR code. When tiling, a 3x2 grid of identical
/// codes is laid out so at least one copy always falls inside the app's scan
/// region-of-interest (some apps only analyze part of the frame).
fn render_qr_frame(text: &str, tile: bool) -> Result<RgbImage> {
    let mut canvas = RgbImage::from_pixel(FRAME_W, FRAME_H, Rgb([255, 255, 255]));
    let qr = render_qr_tile(text, 4, 4)?;

    if tile {
        let cols = 3u32;
        let rows = 2u32;
        let cell = 150u32;
        let gap = 12u32;
        let grid_w = cols * cell + (cols + 1) * gap;
        let grid_h = rows * cell + (rows + 1) * gap;
        let ox = (FRAME_W - grid_w) / 2;
        let oy = (FRAME_H - grid_h) / 2;
        let small = imageops::resize(&qr, cell, cell, imageops::FilterType::Nearest);
        for r in 0..rows {
            for c in 0..cols {
                let x = (ox + gap + c * (cell + gap)) as i64;
                let y = (oy + gap + r * (cell + gap)) as i64;
                imageops::overlay(&mut canvas, &small, x, y);
            }
        }
    } else {
        let side = 384u32;
        let big = imageops::resize(&qr, side, side, imageops::FilterType::Nearest);
        let x = ((FRAME_W - side) / 2) as i64;
        let y = ((FRAME_H - side) / 2) as i64;
        imageops::overlay(&mut canvas, &big, x, y);
    }
    Ok(canvas)
}

/// Build the camera frame for a 1D barcode (Code128 / EAN13). Two stacked
/// copies cover both halves of the frame so the code is found regardless of
/// which region the app analyzes.
fn render_linear_frame(text: &str, kind: &str) -> Result<RgbImage> {
    let bars = encode_linear(text, kind)?;
    let mut canvas = RgbImage::from_pixel(FRAME_W, FRAME_H, Rgb([255, 255, 255]));

    let quiet = 40u32;
    let usable = FRAME_W - 2 * quiet;
    let bar_px = (usable / bars.len() as u32).max(1);
    let bw = bar_px * bars.len() as u32;
    let x0 = (FRAME_W - bw) / 2;
    let bar_h = 150u32;

    for (i, copy_y) in [110u32, 330u32].into_iter().enumerate() {
        let _ = i;
        for (bi, b) in bars.iter().enumerate() {
            if *b == 1 {
                let bx = x0 + bi as u32 * bar_px;
                for dx in 0..bar_px {
                    for dy in 0..bar_h {
                        canvas.put_pixel(bx + dx, copy_y + dy, Rgb([0, 0, 0]));
                    }
                }
            }
        }
    }
    Ok(canvas)
}

fn encode_linear(text: &str, kind: &str) -> Result<Vec<u8>> {
    match kind {
        "code128" => {
            use barcoders::sym::code128::Code128;
            // Prefix selects Code Set B (full ASCII): U+0181.
            let data = format!("\u{0181}{}", text);
            let code = Code128::new(data)
                .map_err(|e| anyhow::anyhow!("Invalid Code128 payload: {:?}", e))?;
            Ok(code.encode())
        }
        "ean13" => {
            use barcoders::sym::ean13::EAN13;
            let code = EAN13::new(text)
                .map_err(|e| anyhow::anyhow!("Invalid EAN13 payload (need 12-13 digits): {:?}", e))?;
            Ok(code.encode())
        }
        other => bail!("Unsupported linear type: {}", other),
    }
}

// -- Video encoding -----------------------------------------------------------

/// Wrap the still barcode image into a short looping MP4 — the emulator's
/// videofile camera source needs a video stream, not a still image.
fn encode_video(png: &Path, mp4: &Path, hold: f32) -> Result<()> {
    which("ffmpeg").context(
        "ffmpeg is required to build the camera video but was not found in PATH.\n\
         Install it (e.g. `brew install ffmpeg`) and retry.",
    )?;

    const LOOP_SECS: f32 = 60.0;
    // The videofile camera source loops the file, so the barcode would reappear
    // every loop. With `hold`, pad a very long blank tail (~1h) so in practice
    // the code shows once and the camera stays quiet for the whole session.
    // Static white compresses to almost nothing, so the file stays small.
    const BLANK_TAIL_SECS: f32 = 3600.0;
    let scale = format!("scale={}:{}", FRAME_W, FRAME_H);

    // hold <= 0 keeps the barcode visible the whole loop: the app scans it
    // continuously while it sits in frame. Otherwise the barcode shows for
    // `hold` seconds then the feed goes blank, so the app decodes it once.
    let args: Vec<String> = if hold <= 0.0 {
        vec![
            "-y".into(),
            "-loop".into(), "1".into(),
            "-i".into(), png.to_string_lossy().into_owned(),
            "-t".into(), LOOP_SECS.to_string(),
            "-r".into(), "10".into(),
            "-g".into(), "10".into(),
            "-pix_fmt".into(), "yuv420p".into(),
            "-vf".into(), scale,
            mp4.to_string_lossy().into_owned(),
        ]
    } else {
        let blank = BLANK_TAIL_SECS.to_string();
        vec![
            "-y".into(),
            "-loop".into(), "1".into(), "-t".into(), hold.to_string(),
            "-i".into(), png.to_string_lossy().into_owned(),
            "-f".into(), "lavfi".into(), "-t".into(), blank,
            "-i".into(), format!("color=c=white:s={}x{}:r=10", FRAME_W, FRAME_H),
            "-filter_complex".into(),
            format!(
                "[0:v]{},setsar=1[a];[1:v]setsar=1[b];[a][b]concat=n=2:v=1:a=0[v]",
                scale
            ),
            "-map".into(), "[v]".into(),
            "-r".into(), "10".into(),
            "-g".into(), "10".into(),
            "-pix_fmt".into(), "yuv420p".into(),
            mp4.to_string_lossy().into_owned(),
        ]
    };

    let status = Command::new("ffmpeg")
        .args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .context("Failed to run ffmpeg")?;
    if !status.success() {
        bail!("ffmpeg failed to encode {}", mp4.display());
    }
    Ok(())
}

// -- Emulator setup (cold boot into videofile mode) ---------------------------

fn setup_emulator(serial: &str, avd: Option<&str>, video: &Path) -> Result<()> {
    let avd_name = match avd {
        Some(a) => a.to_string(),
        None => detect_avd_name(serial)?,
    };
    let emu_bin = find_emulator_binary()?;

    // Stop the running emulator so the new camera source takes effect.
    let _ = Command::new("adb")
        .args(["-s", serial, "emu", "kill"])
        .output();
    wait_until_gone(serial, Duration::from_secs(40));

    let camera_arg = format!("videofile:{}", video.display());
    Command::new(&emu_bin)
        .args([
            "-avd",
            &avd_name,
            "-feature",
            "VideoPlayback",
            "-camera-back",
            &camera_arg,
            "-no-snapshot-load",
            "-gpu",
            "host",
            "-no-boot-anim",
            "-netdelay",
            "none",
            "-netspeed",
            "full",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| format!("Failed to launch emulator binary {}", emu_bin.display()))?;

    wait_until_booted(serial, Duration::from_secs(180))?;
    Ok(())
}

fn detect_avd_name(serial: &str) -> Result<String> {
    let out = Command::new("adb")
        .args(["-s", serial, "emu", "avd", "name"])
        .output()
        .context("Failed to query AVD name")?;
    let text = String::from_utf8_lossy(&out.stdout);
    let name = text.lines().next().unwrap_or("").trim();
    if name.is_empty() || name == "KO" {
        bail!("Could not detect AVD name for {serial}; pass --avd <name>.");
    }
    Ok(name.to_string())
}

fn find_emulator_binary() -> Result<PathBuf> {
    for var in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
        if let Ok(root) = std::env::var(var) {
            let candidate = PathBuf::from(root).join("emulator").join("emulator");
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }
    if which("emulator").is_ok() {
        return Ok(PathBuf::from("emulator"));
    }
    bail!("Could not find the `emulator` binary. Set ANDROID_HOME or add it to PATH.")
}

fn wait_until_gone(serial: &str, timeout: Duration) {
    let start = Instant::now();
    while start.elapsed() < timeout {
        let out = Command::new("adb").args(["-s", serial, "get-state"]).output();
        match out {
            Ok(o) if o.status.success() => sleep(Duration::from_millis(500)),
            _ => return,
        }
    }
}

fn wait_until_booted(serial: &str, timeout: Duration) -> Result<()> {
    let start = Instant::now();
    let _ = Command::new("adb")
        .args(["-s", serial, "wait-for-device"])
        .output();
    while start.elapsed() < timeout {
        let out = Command::new("adb")
            .args(["-s", serial, "shell", "getprop", "sys.boot_completed"])
            .output();
        if let Ok(o) = out {
            if String::from_utf8_lossy(&o.stdout).trim() == "1" {
                return Ok(());
            }
        }
        sleep(Duration::from_secs(2));
    }
    bail!("Emulator did not finish booting within {:?}", timeout)
}

/// Best-effort check that some running emulator process uses our videofile path.
fn emulator_uses_videofile(video: &Path) -> bool {
    let needle = format!("videofile:{}", video.display());
    let out = Command::new("ps").args(["-ax", "-o", "command="]).output();
    if let Ok(o) = out {
        if String::from_utf8_lossy(&o.stdout).contains(&needle) {
            return true;
        }
    }
    // Linux-style fallback.
    if let Ok(o) = Command::new("ps").args(["-e", "-o", "args="]).output() {
        return String::from_utf8_lossy(&o.stdout).contains(&needle);
    }
    false
}

fn which(bin: &str) -> Result<()> {
    let status = Command::new("which")
        .arg(bin)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .context("Failed to run `which`")?;
    if status.success() {
        Ok(())
    } else {
        bail!("{} not found", bin)
    }
}
