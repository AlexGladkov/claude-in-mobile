//! Device interaction command handlers.
//!
//! Each public function here corresponds to a CLI subcommand that interacts
//! with a physical or emulated device (Android, iOS, Aurora, Desktop).

use anyhow::Result;

use crate::{android, aurora, desktop, ios, screenshot, scale};

// -- Screenshot / Annotate ----------------------------------------------------

pub fn screenshot(
    platform: &str,
    output: Option<&str>,
    compress: bool,
    max_width: u32,
    quality: u8,
    simulator: Option<&str>,
    device: Option<&str>,
    companion_path: Option<&str>,
) -> Result<()> {
    if platform == "desktop" {
        let data = desktop::screenshot(companion_path)?;
        return write_or_base64(output, &data);
    }
    if platform == "aurora" {
        let data = aurora::screenshot(device)?;
        return write_or_base64(output, &data);
    }
    screenshot::take_screenshot(platform, output, compress, max_width, quality, simulator, device)
}

pub fn annotate(
    platform: &str,
    output: Option<&str>,
    simulator: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    screenshot::take_annotated_screenshot(platform, output, device, simulator)
}

// -- Tap / Long press ---------------------------------------------------------

pub fn tap(
    platform: &str,
    x: i32,
    y: i32,
    text: Option<&str>,
    simulator: Option<&str>,
    device: Option<&str>,
    companion_path: Option<&str>,
    from_size: Option<&str>,
) -> Result<()> {
    if let Some(t) = text {
        if platform == "desktop" {
            return desktop::tap_by_text(t, companion_path);
        }
        return android::tap_element(t, device);
    }
    let (sx, sy) = scale::apply_scale(x, y, from_size, platform, device, simulator)?;
    match platform {
        "android" => android::tap(sx, sy, device),
        "ios" => ios::tap(sx, sy, simulator),
        "aurora" => aurora::tap(sx, sy, device),
        "desktop" => desktop::tap(sx, sy, companion_path),
        _ => unreachable!(),
    }
}

pub fn long_press(
    platform: &str,
    x: i32,
    y: i32,
    duration: u32,
    text: Option<&str>,
    simulator: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    if let Some(t) = text {
        if let Some((cx, cy)) = android::find_element(t, device)? {
            return android::long_press(cx, cy, duration, device);
        }
        anyhow::bail!("Element '{}' not found for long press", t);
    }
    match platform {
        "android" => android::long_press(x, y, duration, device),
        "ios" => ios::long_press(x, y, duration, simulator),
        "aurora" => aurora::long_press(x, y, duration, device),
        _ => unreachable!(),
    }
}

// -- URL / Shell --------------------------------------------------------------

pub fn open_url(
    platform: &str,
    url: &str,
    simulator: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    match platform {
        "android" => android::open_url(url, device),
        "ios" => ios::open_url(url, simulator),
        "aurora" => aurora::open_url(url, device),
        _ => unreachable!(),
    }
}

pub fn shell(
    platform: &str,
    command: &str,
    simulator: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    match platform {
        "android" => { android::shell(command, device)?; }
        "ios" => { ios::shell(command, simulator)?; }
        "aurora" => { aurora::shell(command, device)?; }
        _ => unreachable!(),
    }
    Ok(())
}

// -- Swipe --------------------------------------------------------------------

pub fn swipe(
    platform: &str,
    mut x1: i32,
    mut y1: i32,
    mut x2: i32,
    mut y2: i32,
    duration: u32,
    direction: Option<&str>,
    simulator: Option<&str>,
    device: Option<&str>,
    from_size: Option<&str>,
) -> Result<()> {
    if let Some(dir) = direction {
        let (cx, cy) = (540, 960);
        let dist = 400;
        match dir.to_lowercase().as_str() {
            "up"    => { x1 = cx; y1 = cy + dist; x2 = cx; y2 = cy - dist; }
            "down"  => { x1 = cx; y1 = cy - dist; x2 = cx; y2 = cy + dist; }
            "left"  => { x1 = cx + dist; y1 = cy; x2 = cx - dist; y2 = cy; }
            "right" => { x1 = cx - dist; y1 = cy; x2 = cx + dist; y2 = cy; }
            _ => {}
        }
    }
    let (sx1, sy1) = scale::apply_scale(x1, y1, from_size, platform, device, simulator)?;
    let (sx2, sy2) = scale::apply_scale(x2, y2, from_size, platform, device, simulator)?;
    match platform {
        "android" => android::swipe(sx1, sy1, sx2, sy2, duration, device),
        "ios"     => ios::swipe(sx1, sy1, sx2, sy2, duration, simulator),
        "aurora"  => aurora::swipe(sx1, sy1, sx2, sy2, duration, device),
        _ => unreachable!(),
    }
}

// -- Text input / key press ---------------------------------------------------

pub fn input(
    platform: &str,
    text: &str,
    simulator: Option<&str>,
    device: Option<&str>,
    companion_path: Option<&str>,
) -> Result<()> {
    match platform {
        "android" => android::input_text(text, device),
        "ios" => ios::input_text(text, simulator),
        "aurora" => aurora::input_text(text, device),
        "desktop" => desktop::input_text(text, companion_path),
        _ => unreachable!(),
    }
}

pub fn key(
    platform: &str,
    key_name: &str,
    simulator: Option<&str>,
    device: Option<&str>,
    companion_path: Option<&str>,
) -> Result<()> {
    match platform {
        "android" => android::press_key(key_name, device),
        "ios" => ios::press_key(key_name, simulator),
        "aurora" => aurora::press_key(key_name, device),
        "desktop" => desktop::press_key(key_name, companion_path),
        _ => unreachable!(),
    }
}

// -- UI dump ------------------------------------------------------------------

pub fn ui_dump(
    platform: &str,
    format: &str,
    simulator: Option<&str>,
    device: Option<&str>,
    companion_path: Option<&str>,
) -> Result<()> {
    match platform {
        "android" => android::ui_dump(format, device),
        "ios" => ios::ui_dump(format, simulator),
        "desktop" => desktop::get_ui(companion_path),
        _ => unreachable!(),
    }
}

// -- Device management --------------------------------------------------------

pub fn devices(platform: &str) -> Result<()> {
    match platform {
        "android" => android::print_devices(),
        "ios" => ios::print_devices(),
        "aurora" => aurora::print_devices(),
        _ => {
            android::print_devices()?;
            ios::print_devices()?;
            aurora::print_devices()
        }
    }
}

pub fn apps(
    platform: &str,
    filter: Option<&str>,
    simulator: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    match platform {
        "android" => android::list_apps(filter, device),
        "ios" => ios::list_apps(filter, simulator),
        "aurora" => aurora::list_apps(filter, device),
        _ => unreachable!(),
    }
}

pub fn launch(
    platform: &str,
    package: &str,
    simulator: Option<&str>,
    device: Option<&str>,
    companion_path: Option<&str>,
) -> Result<()> {
    match platform {
        "android" => android::launch_app(package, device),
        "ios" => ios::launch_app(package, simulator),
        "aurora" => aurora::launch_app(package, device),
        "desktop" => desktop::launch_app(package, companion_path),
        _ => unreachable!(),
    }
}

pub fn stop(
    platform: &str,
    package: &str,
    simulator: Option<&str>,
    device: Option<&str>,
    companion_path: Option<&str>,
) -> Result<()> {
    match platform {
        "android" => android::stop_app(package, device),
        "ios" => ios::stop_app(package, simulator),
        "aurora" => aurora::stop_app(package, device),
        "desktop" => desktop::stop_app(package, companion_path),
        _ => unreachable!(),
    }
}

pub fn install(
    platform: &str,
    path: &str,
    simulator: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    match platform {
        "android" => android::install_app(path, device),
        "ios" => ios::install_app(path, simulator),
        "aurora" => aurora::install_app(path, device),
        _ => unreachable!(),
    }
}

pub fn uninstall(
    platform: &str,
    package: &str,
    simulator: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    match platform {
        "android" => android::uninstall_app(package, device),
        "ios" => ios::uninstall_app(package, simulator),
        "aurora" => aurora::uninstall_app(package, device),
        _ => unreachable!(),
    }
}

// -- Element search -----------------------------------------------------------

pub fn find(
    platform: &str,
    query: &str,
    simulator: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    if platform == "android" {
        android::find_element(query, device)?;
    } else {
        ios::find_element(query, simulator)?;
    }
    Ok(())
}

pub fn tap_text(
    platform: &str,
    query: &str,
    simulator: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    if platform == "android" {
        android::tap_element(query, device)
    } else {
        ios::tap_element(query, simulator)
    }
}

// -- Logs ---------------------------------------------------------------------

pub fn logs(
    platform: &str,
    filter: Option<&str>,
    lines: usize,
    simulator: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    match platform {
        "android" => android::get_logs(filter, lines, device),
        "ios" => ios::get_logs(filter, lines, simulator),
        "aurora" => aurora::get_logs(filter, lines, device),
        _ => unreachable!(),
    }
}

pub fn clear_logs(
    platform: &str,
    simulator: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    match platform {
        "android" => android::clear_logs(device),
        "ios" => ios::clear_logs(simulator),
        "aurora" => aurora::clear_logs(device),
        _ => unreachable!(),
    }
}

// -- System -------------------------------------------------------------------

pub fn system_info(
    platform: &str,
    simulator: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    match platform {
        "android" => android::get_system_info(device),
        "ios" => ios::get_system_info(simulator),
        "aurora" => aurora::get_system_info(device),
        _ => unreachable!(),
    }
}

pub fn current_activity(
    platform: &str,
    simulator: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    if platform == "android" {
        android::get_current_activity(device)
    } else {
        ios::get_current_activity(simulator)
    }
}

pub fn reboot(
    platform: &str,
    simulator: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    if platform == "android" {
        android::reboot(device)
    } else {
        ios::reboot(simulator)
    }
}

pub fn screen(state: &str, device: Option<&str>) -> Result<()> {
    let on = state == "on";
    android::screen_power(on, device)
}

pub fn screen_size(
    platform: &str,
    simulator: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    if platform == "android" {
        let (w, h) = android::get_screen_size(device)?;
        println!("Screen size: {}x{}", w, h);
        Ok(())
    } else {
        let data = ios::screenshot(simulator)?;
        let img = image::load_from_memory(&data)?;
        println!("Screen size: {}x{}", img.width(), img.height());
        Ok(())
    }
}

pub fn wait(ms: u64) -> Result<()> {
    std::thread::sleep(std::time::Duration::from_millis(ms));
    println!("Waited {}ms", ms);
    Ok(())
}

// -- Android-only advanced commands -------------------------------------------

pub fn analyze_screen(device: Option<&str>) -> Result<()> {
    android::analyze_screen(device)
}

pub fn find_and_tap(description: &str, min_confidence: u32, device: Option<&str>) -> Result<()> {
    android::find_and_tap(description, min_confidence, device)
}

// -- File transfer ------------------------------------------------------------

pub fn push_file(
    platform: &str,
    local: &str,
    remote: &str,
    device: Option<&str>,
) -> Result<()> {
    match platform {
        "android" => android::push_file(local, remote, device),
        "aurora" => aurora::push_file(local, remote, device),
        _ => unreachable!(),
    }
}

pub fn pull_file(
    platform: &str,
    remote: &str,
    local: &str,
    device: Option<&str>,
) -> Result<()> {
    match platform {
        "android" => android::pull_file(remote, local, device),
        "aurora" => aurora::pull_file(remote, local, device),
        _ => unreachable!(),
    }
}

// -- Clipboard ----------------------------------------------------------------

pub fn get_clipboard(
    platform: &str,
    device: Option<&str>,
    companion_path: Option<&str>,
) -> Result<()> {
    match platform {
        "android" => android::get_clipboard(device),
        "ios" => ios::get_clipboard(None),
        "desktop" => desktop::get_clipboard(companion_path),
        _ => unreachable!(),
    }
}

pub fn set_clipboard(
    platform: &str,
    text: &str,
    device: Option<&str>,
    companion_path: Option<&str>,
) -> Result<()> {
    match platform {
        "android" => android::set_clipboard(text, device),
        "ios" => ios::set_clipboard(text, None),
        "desktop" => desktop::set_clipboard(text, companion_path),
        _ => unreachable!(),
    }
}

// -- Desktop-only commands ----------------------------------------------------

pub fn get_performance_metrics(companion_path: Option<&str>) -> Result<()> {
    desktop::get_performance_metrics(companion_path)
}

pub fn get_monitors(companion_path: Option<&str>) -> Result<()> {
    desktop::get_monitors(companion_path)
}

pub fn launch_desktop_app(app_path: &str, companion_path: Option<&str>) -> Result<()> {
    desktop::launch_app(app_path, companion_path)
}

pub fn stop_desktop_app(app_name: &str, companion_path: Option<&str>) -> Result<()> {
    desktop::stop_app(app_name, companion_path)
}

pub fn get_window_info(companion_path: Option<&str>) -> Result<()> {
    desktop::get_window_info(companion_path)
}

pub fn focus_window(window_id: &str, companion_path: Option<&str>) -> Result<()> {
    desktop::focus_window(window_id, companion_path)
}

pub fn resize_window(
    window_id: &str,
    width: u32,
    height: u32,
    companion_path: Option<&str>,
) -> Result<()> {
    desktop::resize_window(window_id, width, height, companion_path)
}

// -- Helpers ------------------------------------------------------------------

/// Write raw bytes to a file, or encode as base64 and print to stdout.
fn write_or_base64(output: Option<&str>, data: &[u8]) -> Result<()> {
    if let Some(path) = output {
        std::fs::write(path, data)?;
        eprintln!("Screenshot saved to: {}", path);
    } else {
        let b64 = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            data,
        );
        println!("{}", b64);
    }
    Ok(())
}
