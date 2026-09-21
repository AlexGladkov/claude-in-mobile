//! Device interaction command handlers.
//!
//! Each public function here corresponds to a CLI subcommand that interacts
//! with a connected device or simulator.

use anyhow::{bail, Result};

use crate::utils::{process::terminal_safe, shell_gate};
use crate::{android, aurora, desktop, harmony, ios, scale, screenshot};

// -- Screenshot / Annotate ----------------------------------------------------

pub fn screenshot(
    platform: &str,
    output: Option<&str>,
    compress: bool,
    max_width: u32,
    max_height: u32,
    quality: u8,
    simulator: Option<&str>,
    device: Option<&str>,
    companion_path: Option<&str>,
) -> Result<()> {
    let captured = match platform {
        "desktop" => Some(desktop::screenshot(companion_path)?),
        "aurora" => Some(aurora::screenshot(device)?),
        "harmony" => Some(harmony::screenshot(device)?),
        _ => None,
    };
    if let Some(data) = captured {
        return screenshot::write_screenshot_output(
            data, output, compress, max_width, max_height, quality,
        );
    }
    screenshot::take_screenshot(
        platform, output, compress, max_width, max_height, quality, simulator, device,
    )
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
    if let Some(text) = text {
        return match platform {
            "desktop" => desktop::tap_by_text(text, companion_path),
            "harmony" => harmony::tap_element(text, device),
            "android" => android::tap_element(text, device),
            _ => bail!("Tap by text is not supported for {platform}"),
        };
    }
    let (x, y) = scale::apply_scale(x, y, from_size, platform, device, simulator)?;
    match platform {
        "android" => android::tap(x, y, device),
        "ios" => ios::tap(x, y, simulator),
        "harmony" => harmony::tap(x, y, device),
        "aurora" => aurora::tap(x, y, device),
        "desktop" => desktop::tap(x, y, companion_path),
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
    if let Some(text) = text {
        if platform == "harmony" {
            if let Some((x, y)) = harmony::find_element(text, device)? {
                return harmony::long_press(x, y, duration.into(), device);
            }
            bail!("Element '{text}' not found for long press");
        }
        if let Some((x, y)) = android::find_element(text, device)? {
            return android::long_press(x, y, duration, device);
        }
        bail!("Element '{text}' not found for long press");
    }
    match platform {
        "android" => android::long_press(x, y, duration, device),
        "ios" => ios::long_press(x, y, duration, simulator),
        "harmony" => harmony::long_press(x, y, duration.into(), device),
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
        "harmony" => harmony::open_url(url, device),
        "aurora" => aurora::open_url(url, device),
        _ => unreachable!(),
    }
}

pub fn shell(
    platform: &str,
    command: &str,
    simulator: Option<&str>,
    device: Option<&str>,
    i_know_what_im_doing: bool,
) -> Result<()> {
    // SECURITY (issue #41): `shell` executes whatever the caller passes,
    // verbatim, on the device. Gate non-interactive use behind an explicit
    // opt-in to prevent supply-chain / CI misuse. Runs BEFORE any platform
    // code so the gate cannot be skipped by picking a different platform.
    shell_gate::check_shell_allowed(i_know_what_im_doing)?;
    shell_gate::emit_warning_if_needed();

    match platform {
        "android" => android::shell(command, device)?,
        "ios" => ios::shell(command, simulator)?,
        "harmony" => harmony::shell(command, device)?,
        "aurora" => aurora::shell(command, device)?,
        _ => unreachable!(),
    };
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
    if let Some(direction) = direction {
        let (center_x, center_y) = (540, 960);
        let distance = 400;
        match direction.to_lowercase().as_str() {
            "up" => {
                x1 = center_x;
                y1 = center_y + distance;
                x2 = center_x;
                y2 = center_y - distance;
            }
            "down" => {
                x1 = center_x;
                y1 = center_y - distance;
                x2 = center_x;
                y2 = center_y + distance;
            }
            "left" => {
                x1 = center_x + distance;
                y1 = center_y;
                x2 = center_x - distance;
                y2 = center_y;
            }
            "right" => {
                x1 = center_x - distance;
                y1 = center_y;
                x2 = center_x + distance;
                y2 = center_y;
            }
            _ => {}
        }
    }
    let (x1, y1) = scale::apply_scale(x1, y1, from_size, platform, device, simulator)?;
    let (x2, y2) = scale::apply_scale(x2, y2, from_size, platform, device, simulator)?;
    match platform {
        "android" => android::swipe(x1, y1, x2, y2, duration, device),
        "ios" => ios::swipe(x1, y1, x2, y2, duration, simulator),
        "harmony" => harmony::swipe(x1, y1, x2, y2, duration.into(), device),
        "aurora" => aurora::swipe(x1, y1, x2, y2, duration, device),
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
        "harmony" => harmony::input_text(text, device),
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
        "harmony" => harmony::press_key(key_name, device),
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
        "harmony" => {
            println!(
                "{}",
                terminal_safe(harmony::ui_dump(format, device)?.as_bytes())
            );
            Ok(())
        }
        "desktop" => desktop::get_ui(companion_path),
        _ => unreachable!(),
    }
}
// -- Device management --------------------------------------------------------

pub fn devices(platform: &str) -> Result<()> {
    match platform {
        "android" => android::print_devices(),
        "ios" => ios::print_devices(),
        "harmony" => harmony::print_devices(),
        "aurora" => aurora::print_devices(),
        _ => {
            android::print_devices()?;
            ios::print_devices()?;
            harmony::print_devices()?;
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
        "harmony" => harmony::list_apps(filter, device),
        "aurora" => aurora::list_apps(filter, device),
        _ => unreachable!(),
    }
}

pub fn launch(
    platform: &str,
    package: &str,
    ability: Option<&str>,
    module: Option<&str>,
    simulator: Option<&str>,
    device: Option<&str>,
    companion_path: Option<&str>,
) -> Result<()> {
    match platform {
        "android" => android::launch_app(package, device),
        "ios" => ios::launch_app(package, simulator),
        "harmony" => harmony::launch_app(package, ability, module, device),
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
        "harmony" => harmony::stop_app(package, device),
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
        "harmony" => harmony::install(path, device),
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
        "harmony" => harmony::uninstall(package, device),
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
    match platform {
        "android" => {
            android::find_element(query, device)?;
        }
        "ios" => {
            ios::find_element(query, simulator)?;
        }
        "harmony" => {
            harmony::find_element(query, device)?;
        }
        _ => bail!("Unsupported platform for find: {platform}"),
    }
    Ok(())
}

pub fn tap_text(
    platform: &str,
    query: &str,
    simulator: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    match platform {
        "android" => android::tap_element(query, device),
        "ios" => ios::tap_element(query, simulator),
        "harmony" => harmony::tap_element(query, device),
        _ => bail!("Unsupported platform for tap-text: {platform}"),
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
        "harmony" => harmony::logs(lines, filter, device),
        "aurora" => aurora::get_logs(filter, lines, device),
        _ => unreachable!(),
    }
}

pub fn clear_logs(platform: &str, simulator: Option<&str>, device: Option<&str>) -> Result<()> {
    match platform {
        "android" => android::clear_logs(device),
        "ios" => ios::clear_logs(simulator),
        "harmony" => harmony::clear_logs(device),
        "aurora" => aurora::clear_logs(device),
        _ => unreachable!(),
    }
}

// -- System -------------------------------------------------------------------

pub fn system_info(platform: &str, simulator: Option<&str>, device: Option<&str>) -> Result<()> {
    match platform {
        "android" => android::get_system_info(device),
        "ios" => ios::get_system_info(simulator),
        "harmony" => harmony::system_info(device),
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

pub fn reboot(platform: &str, simulator: Option<&str>, device: Option<&str>) -> Result<()> {
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

pub fn screen_size(platform: &str, simulator: Option<&str>, device: Option<&str>) -> Result<()> {
    let (width, height) = match platform {
        "android" => android::get_screen_size(device)?,
        "ios" => {
            let data = ios::screenshot(simulator)?;
            let image = image::load_from_memory(&data)?;
            (image.width(), image.height())
        }
        "harmony" => harmony::screen_size(device)?,
        _ => bail!("Unsupported platform for screen-size: {platform}"),
    };
    println!("Screen size: {width}x{height}");
    Ok(())
}

pub fn wait(ms: u64) -> Result<()> {
    std::thread::sleep(std::time::Duration::from_millis(ms));
    println!("Waited {}ms", ms);
    Ok(())
}

// -- UI inspection commands ---------------------------------------------------

/// Poll UI hierarchy until a matching element appears or timeout expires.
///
/// Returns `Ok(())` when the element is found.
/// Returns an error (which propagates as exit code 1 via main) if the timeout
/// expires before the element becomes visible.
pub fn ui_wait(
    platform: &str,
    text: Option<&str>,
    resource_id: Option<&str>,
    class_name: Option<&str>,
    timeout_ms: u64,
    interval_ms: u64,
    simulator: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    use std::time::Instant;

    let deadline = Instant::now() + std::time::Duration::from_millis(timeout_ms);
    loop {
        let found = match platform {
            "android" => android::find_ui_element(text, resource_id, class_name, device)?,
            "ios" => ios::find_ui_element(text, resource_id, simulator)?,
            "harmony" => harmony::find_ui_element(text, resource_id, class_name, device)?,
            _ => bail!("Unsupported platform for ui-wait: {platform}"),
        };

        if let Some(elem_desc) = found {
            println!("Found: {}", terminal_safe(elem_desc.as_bytes()));
            return Ok(());
        }

        if Instant::now() >= deadline {
            let query = build_query_description(text, resource_id, class_name);
            anyhow::bail!(
                "Timeout: element {} not found within {}ms",
                query,
                timeout_ms
            );
        }

        std::thread::sleep(std::time::Duration::from_millis(interval_ms));
    }
}

/// Assert that an element matching the given criteria is currently visible.
///
/// Prints `PASS: Element visible -- <details>` and exits 0 on success.
/// Prints `FAIL: Element not visible` and exits 1 on failure.
pub fn ui_assert_visible(
    platform: &str,
    text: Option<&str>,
    resource_id: Option<&str>,
    simulator: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    let found = match platform {
        "android" => android::find_ui_element(text, resource_id, None, device)?,
        "ios" => ios::find_ui_element(text, resource_id, simulator)?,
        "harmony" => harmony::find_ui_element(text, resource_id, None, device)?,
        _ => bail!("Unsupported platform for ui-assert-visible: {platform}"),
    };

    match found {
        Some(elem_desc) => {
            println!(
                "PASS: Element visible -- {}",
                terminal_safe(elem_desc.as_bytes())
            );
            Ok(())
        }
        None => {
            println!("FAIL: Element not visible");
            std::process::exit(1);
        }
    }
}

/// Assert that an element matching the given criteria is NOT present.
///
/// Prints `PASS: Element not present` and exits 0 on success.
/// Prints `FAIL: Element exists -- <details>` and exits 1 on failure.
pub fn ui_assert_gone(
    platform: &str,
    text: Option<&str>,
    resource_id: Option<&str>,
    simulator: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    let found = match platform {
        "android" => android::find_ui_element(text, resource_id, None, device)?,
        "ios" => ios::find_ui_element(text, resource_id, simulator)?,
        "harmony" => harmony::find_ui_element(text, resource_id, None, device)?,
        _ => bail!("Unsupported platform for ui-assert-gone: {platform}"),
    };

    match found {
        None => {
            println!("PASS: Element not present");
            Ok(())
        }
        Some(elem_desc) => {
            println!(
                "FAIL: Element exists -- {}",
                terminal_safe(elem_desc.as_bytes())
            );
            std::process::exit(1);
        }
    }
}

/// Build a human-readable description of the query criteria for error messages.
fn build_query_description(
    text: Option<&str>,
    resource_id: Option<&str>,
    class_name: Option<&str>,
) -> String {
    let mut parts = Vec::new();
    if let Some(t) = text {
        parts.push(format!("text=\"{}\"", t));
    }
    if let Some(r) = resource_id {
        parts.push(format!("resource_id=\"{}\"", r));
    }
    if let Some(c) = class_name {
        parts.push(format!("class=\"{}\"", c));
    }
    if parts.is_empty() {
        "(no criteria)".to_string()
    } else {
        parts.join(", ")
    }
}

// -- Android-only advanced commands -------------------------------------------

pub fn analyze_screen(device: Option<&str>) -> Result<()> {
    android::analyze_screen(device)
}

pub fn find_and_tap(description: &str, min_confidence: u32, device: Option<&str>) -> Result<()> {
    android::find_and_tap(description, min_confidence, device)
}

// -- File transfer ------------------------------------------------------------

pub fn push_file(platform: &str, local: &str, remote: &str, device: Option<&str>) -> Result<()> {
    match platform {
        "android" => android::push_file(local, remote, device),
        "harmony" => harmony::push_file(local, remote, device),
        "aurora" => aurora::push_file(local, remote, device),
        _ => unreachable!(),
    }
}

pub fn pull_file(platform: &str, remote: &str, local: &str, device: Option<&str>) -> Result<()> {
    match platform {
        "android" => android::pull_file(remote, local, device),
        "harmony" => harmony::pull_file(remote, local, device),
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

// -- Sensor commands (Android-only) -------------------------------------------

pub fn sensor_location(
    latitude: f64,
    longitude: f64,
    altitude: f64,
    device: Option<&str>,
) -> Result<()> {
    android::sensor_location(latitude, longitude, altitude, device)
}

pub fn sensor_battery(
    level: Option<u8>,
    status: Option<&str>,
    plugged: Option<&str>,
    reset: bool,
    device: Option<&str>,
) -> Result<()> {
    android::sensor_battery(level, status, plugged, reset, device)
}

pub fn sensor_notifications(package: Option<&str>, device: Option<&str>) -> Result<()> {
    android::sensor_notifications(package, device)
}

pub fn sensor_thermal(status: Option<&str>, reset: bool, device: Option<&str>) -> Result<()> {
    android::sensor_thermal(status, reset, device)
}

// -- Network commands (Android-only) ------------------------------------------

pub fn network_traffic(package: Option<&str>, device: Option<&str>) -> Result<()> {
    android::network_traffic(package, device)
}

pub fn network_connectivity(device: Option<&str>) -> Result<()> {
    android::network_connectivity(device)
}

pub fn network_proxy(
    host: Option<&str>,
    port: Option<u16>,
    clear: bool,
    device: Option<&str>,
) -> Result<()> {
    android::network_proxy(host, port, clear, device)
}

pub fn network_airplane(enabled: bool, device: Option<&str>) -> Result<()> {
    android::network_airplane(enabled, device)
}

// -- Permission commands (Android + iOS + HarmonyOS) --------------------------

pub fn permission_grant(
    platform: &str,
    package: &str,
    permission: &str,
    simulator: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    match platform {
        "android" => android::permission_grant(package, permission, device),
        "harmony" => harmony::permission_grant(package, permission, device),
        "ios" => {
            crate::utils::validate::validate_bundle_identifier(package)?;
            crate::utils::validate::validate_simulator_service(permission)?;
            let output = ios::simctl_exec(&[
                "privacy",
                simulator.unwrap_or("booted"),
                "grant",
                permission,
                package,
            ])?;
            if !output.status.success() {
                bail!("Simulator permission grant failed");
            }
            println!("Permission granted");
            Ok(())
        }
        _ => anyhow::bail!("Unsupported platform for permission-grant: {}", platform),
    }
}

pub fn permission_revoke(
    platform: &str,
    package: &str,
    permission: &str,
    simulator: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    match platform {
        "android" => android::permission_revoke(package, permission, device),
        "harmony" => harmony::permission_revoke(package, permission, device),
        "ios" => {
            crate::utils::validate::validate_bundle_identifier(package)?;
            crate::utils::validate::validate_simulator_service(permission)?;
            let output = ios::simctl_exec(&[
                "privacy",
                simulator.unwrap_or("booted"),
                "revoke",
                permission,
                package,
            ])?;
            if !output.status.success() {
                bail!("Simulator permission revoke failed");
            }
            println!("Permission revoked");
            Ok(())
        }
        _ => anyhow::bail!("Unsupported platform for permission-revoke: {}", platform),
    }
}

pub fn permission_reset(
    platform: &str,
    package: &str,
    simulator: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    match platform {
        "android" => android::permission_reset(package, device),
        "harmony" => harmony::permission_reset(package, device),
        "ios" => {
            crate::utils::validate::validate_bundle_identifier(package)?;
            let output = ios::simctl_exec(&[
                "privacy",
                simulator.unwrap_or("booted"),
                "reset",
                "all",
                package,
            ])?;
            if !output.status.success() {
                bail!("Simulator permission reset failed");
            }
            println!("Permissions reset");
            Ok(())
        }
        _ => anyhow::bail!("Unsupported platform for permission-reset: {}", platform),
    }
}

// -- Intent commands (Android-only) -------------------------------------------

#[allow(clippy::too_many_arguments)]
pub fn intent_start(
    action: Option<&str>,
    component: Option<&str>,
    data: Option<&str>,
    category: Option<&str>,
    package: Option<&str>,
    extras: Option<&str>,
    flags: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    android::intent_start(
        action, component, data, category, package, extras, flags, device,
    )
}

pub fn intent_broadcast(
    action: &str,
    package: Option<&str>,
    component: Option<&str>,
    extras: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    android::intent_broadcast(action, package, component, extras, device)
}

pub fn intent_deeplink(
    platform: &str,
    uri: &str,
    package: Option<&str>,
    simulator: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    match platform {
        "android" => android::intent_deeplink(uri, package, device),
        "ios" => {
            crate::utils::validate::validate_deep_link(uri)?;
            let output = ios::simctl_exec(&["openurl", simulator.unwrap_or("booted"), uri])?;
            if !output.status.success() {
                bail!("Simulator deep-link failed");
            }
            println!("Deep-link opened");
            Ok(())
        }
        _ => anyhow::bail!("Unsupported platform for intent-deeplink: {}", platform),
    }
}

pub fn intent_services(package: Option<&str>, device: Option<&str>) -> Result<()> {
    android::intent_services(package, device)
}

// -- Sandbox commands (Android-only) ------------------------------------------

pub fn sandbox_prefs_read(package: &str, file: Option<&str>, device: Option<&str>) -> Result<()> {
    android::sandbox_prefs_read(package, file, device)
}

pub fn sandbox_prefs_write(
    package: &str,
    file: &str,
    key: &str,
    value: &str,
    pref_type: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    android::sandbox_prefs_write(package, file, key, value, pref_type, device)
}

pub fn sandbox_sqlite_query(
    package: &str,
    database: &str,
    query: &str,
    device: Option<&str>,
) -> Result<()> {
    android::sandbox_sqlite_query(package, database, query, device)
}

pub fn sandbox_file_list(
    platform: &str,
    package: &str,
    path: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    match platform {
        "android" => android::sandbox_file_list(package, path, device),
        "harmony" => harmony::sandbox_file_list(package, path, device),
        _ => bail!("Unsupported platform for sandbox-file-list: {}", platform),
    }
}

pub fn sandbox_file_read(
    platform: &str,
    package: &str,
    path: &str,
    max_bytes: Option<u64>,
    device: Option<&str>,
) -> Result<()> {
    match platform {
        "android" => android::sandbox_file_read(package, path, max_bytes, device),
        "harmony" => harmony::sandbox_file_read(package, path, max_bytes, device),
        _ => bail!("Unsupported platform for sandbox-file-read: {}", platform),
    }
}

pub fn harmony_sandbox_push(
    bundle: &str,
    local: &str,
    remote: &str,
    device: Option<&str>,
) -> Result<()> {
    harmony::sandbox_file_push(bundle, local, remote, device)
}

pub fn harmony_sandbox_pull(
    bundle: &str,
    remote: &str,
    local: &str,
    device: Option<&str>,
) -> Result<()> {
    harmony::sandbox_file_pull(bundle, remote, local, device)
}

pub fn harmony_arkweb(
    socket: Option<&str>,
    port: u16,
    close: bool,
    device: Option<&str>,
) -> Result<()> {
    if close {
        let Some(socket) = socket else {
            bail!("--socket is required with --close");
        };
        harmony::arkweb_close(socket, port, device)
    } else {
        harmony::arkweb_inspect(socket, port, device)
    }
}

#[allow(clippy::too_many_arguments)]
pub fn harmony_test(
    bundle: &str,
    module: &str,
    runner: &str,
    class: Option<&str>,
    not_class: Option<&str>,
    timeout_ms: Option<u64>,
    dry_run: bool,
    device: Option<&str>,
) -> Result<()> {
    harmony::run_tests(
        bundle, module, runner, class, not_class, timeout_ms, dry_run, device,
    )
}

// -- Performance commands (Android-only) --------------------------------------

/// Capture a memory/CPU/battery/framestats snapshot for a package.
pub fn perf_snapshot(package: &str, device: Option<&str>) -> Result<()> {
    android::perf_snapshot(package, device)
}

/// Save a perf-snapshot as a named baseline JSON file in /tmp.
pub fn perf_baseline(package: &str, name: &str, device: Option<&str>) -> Result<()> {
    android::perf_baseline(package, name, device)
}

/// Compare current perf metrics against a saved named baseline.
pub fn perf_compare(package: &str, name: &str, device: Option<&str>) -> Result<()> {
    android::perf_compare(package, name, device)
}

/// Collect N perf samples at the given interval and report min/max/avg trends.
pub fn perf_monitor(
    package: &str,
    count: u32,
    interval_ms: u64,
    device: Option<&str>,
) -> Result<()> {
    android::perf_monitor(package, count, interval_ms, device)
}

/// Extract recent crashes and ANRs from logcat.
pub fn perf_crashes(package: Option<&str>, lines: usize, device: Option<&str>) -> Result<()> {
    android::perf_crashes(package, lines, device)
}

/// Detailed frame rendering stats (gfxinfo framestats) for a package.
pub fn perf_framestats(package: &str, device: Option<&str>) -> Result<()> {
    android::perf_framestats(package, device)
}
