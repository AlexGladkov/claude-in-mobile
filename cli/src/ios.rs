//! iOS Simulator automation via simctl

use anyhow::{bail, Context, Result};
use serde::Serialize;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;
use tempfile::Builder;

use crate::utils::private_state::{
    atomic_write, cache_dir, private_temp_dir, read_bounded_file, validate_identifier,
};
use crate::utils::process::{
    ensure_success, run_with_input_limits, run_with_limits, terminal_safe, terminal_safe_json,
};
use crate::utils::validate::validate_osascript_key;

/// Resolve an explicitly requested simulator to its stable UDID and window title.
///
/// The CLI historically accepted simulator names. Flow execution also passes
/// UDIDs, so prefer an exact UDID match and retain name matching as a
/// compatibility path.
#[derive(Debug, Clone)]
struct SimulatorTarget {
    udid: String,
    name: String,
}

fn get_simulator_target(selector: &str) -> Result<SimulatorTarget> {
    let output = simctl_exec(&["list", "devices", "-j"])?;
    ensure_success(&output, "Simulator discovery")?;
    let json: serde_json::Value = serde_json::from_slice(&output.stdout)?;

    let mut name_match = None;
    if let Some(runtimes) = json["devices"].as_object() {
        for devices in runtimes.values().filter_map(serde_json::Value::as_array) {
            for device in devices {
                let Some(udid) = device["udid"].as_str() else {
                    continue;
                };
                let Some(name) = device["name"].as_str() else {
                    continue;
                };

                if udid == selector {
                    return Ok(SimulatorTarget {
                        udid: udid.to_string(),
                        name: name.to_string(),
                    });
                }
                if name == selector && name_match.is_none() {
                    name_match = Some(SimulatorTarget {
                        udid: udid.to_string(),
                        name: name.to_string(),
                    });
                }
            }
        }
    }

    name_match.ok_or_else(|| anyhow::anyhow!("Requested simulator was not found"))
}

/// Get simulator UDID (booted or by name/UDID).
fn get_simulator_udid(simulator: Option<&str>) -> Result<String> {
    let Some(selector) = simulator else {
        return Ok("booted".to_string());
    };
    Ok(get_simulator_target(selector)?.udid)
}

/// Execute simctl with bounded output and a hard deadline.
pub(crate) fn simctl_exec(args: &[&str]) -> Result<std::process::Output> {
    let mut command = Command::new("xcrun");
    command.arg("simctl").args(args);
    run_with_limits(
        &mut command,
        Duration::from_secs(120),
        64 * 1024 * 1024,
        "simctl command",
    )
}

fn run_osascript(script: &str, action: &str) -> Result<std::process::Output> {
    let mut command = Command::new("osascript");
    command.args(["-e", script]);
    run_with_limits(&mut command, Duration::from_secs(15), 64 * 1024, action)
}

fn run_cliclick(args: &[String], action: &str) -> Result<()> {
    let mut command = Command::new("cliclick");
    command.args(args);
    let output = run_with_limits(&mut command, Duration::from_secs(30), 64 * 1024, action)?;
    ensure_success(&output, action)
}

#[cfg(unix)]
fn set_owner_executable(path: &Path) -> Result<()> {
    let mut permissions = std::fs::metadata(path)?.permissions();
    permissions.set_mode(permissions.mode() | 0o100);
    std::fs::set_permissions(path, permissions)
        .context("Failed to make Swift helper executable")?;
    Ok(())
}
/// Embedded Swift source for CGWindowList-based geometry lookup.
/// Does NOT require TCC/Accessibility — works in ad-hoc signed terminals.

const SWIFT_HELPER_SOURCE: &str = include_str!("../assets/simwindow.swift");

/// Get path to compiled Swift helper, compiling on first use or when source changes.
/// Binary cached at ~/.cache/mcp-devices/simwindow
fn get_swift_helper_path() -> Result<PathBuf> {
    let cache_dir = cache_dir("swift-helpers")?;
    let bin_path = cache_dir.join("simwindow");
    let hash_path = cache_dir.join("simwindow.hash");

    let current_hash = format!("{:x}", {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        SWIFT_HELPER_SOURCE.hash(&mut hasher);
        hasher.finish()
    });

    let binary_is_regular = std::fs::symlink_metadata(&bin_path)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false);
    let needs_compile = if binary_is_regular {
        match read_bounded_file(&hash_path, 1024, "Swift helper hash")
            .ok()
            .and_then(|stored| String::from_utf8(stored).ok())
        {
            Some(stored) => stored.trim() != current_hash,
            None => true,
        }
    } else {
        true
    };

    if needs_compile {
        let src_path = cache_dir.join("simwindow.swift");
        atomic_write(&src_path, SWIFT_HELPER_SOURCE.as_bytes())?;

        let staged_binary = Builder::new()
            .prefix(".simwindow-")
            .tempfile_in(&cache_dir)?;
        let staged_path = staged_binary.into_temp_path();
        let mut command = Command::new("swiftc");
        command.args(["-O", "-o"]).arg(&staged_path).arg(&src_path);
        let output = run_with_limits(
            &mut command,
            Duration::from_secs(120),
            1024 * 1024,
            "Swift helper compilation",
        )?;
        ensure_success(&output, "Swift helper compilation")?;

        // `tempfile` intentionally creates the staged file without execute
        // permissions. Set the owner bit before the atomic rename so a fresh
        // helper can be spawned immediately after installation.
        #[cfg(unix)]
        set_owner_executable(staged_path.as_ref())?;

        staged_path
            .persist(&bin_path)
            .map_err(|error| error.error)
            .context("Failed to atomically install Swift helper")?;

        atomic_write(&hash_path, current_hash.as_bytes())?;
        let _ = std::fs::remove_file(&src_path);
    }

    Ok(bin_path)
}

type WindowGeometry = (f64, f64, f64, f64);

/// Parse "x,y,w,h" string into (f64, f64, f64, f64)
fn parse_geometry(text: &str) -> Result<(f64, f64, f64, f64)> {
    let parts: Vec<f64> = text
        .trim()
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();

    if parts.len() != 4 {
        bail!("Failed to parse Simulator window geometry");
    }

    Ok((parts[0], parts[1], parts[2], parts[3]))
}

/// Get Simulator window geometry via CGWindowList Swift helper (primary)
/// or osascript System Events (fallback for older setups).
/// Returns (window_x, window_y, content_width, content_height)
fn get_simulator_window_geometry() -> Result<(f64, f64, f64, f64)> {
    // Primary: Swift helper using CGWindowListCopyWindowInfo (no TCC required).
    // Any compile, spawn, exit, or parse failure falls through to AppleScript;
    // the helper is an optimization, not a prerequisite for gestures.
    if let Ok(helper_path) = get_swift_helper_path() {
        let mut command = Command::new(&helper_path);
        if let Ok(output) = run_with_limits(
            &mut command,
            Duration::from_secs(10),
            64 * 1024,
            "Swift window geometry helper",
        ) {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                if let Ok(geometry) = parse_geometry(&text) {
                    return Ok(geometry);
                }
            }
        }
    }

    // Fallback: osascript (requires Accessibility/TCC permission)
    let script = r#"
tell application "System Events"
    tell process "Simulator"
        set win to front window
        set winPos to position of win
        set winSize to size of win
        set wx to item 1 of winPos
        set wy to item 2 of winPos
        set ww to item 1 of winSize
        set wh to item 2 of winSize
        return (wx as string) & "," & (wy as string) & "," & (ww as string) & "," & (wh as string)
    end tell
end tell
"#;
    let mut command = Command::new("osascript");
    command.args(["-e", script]);
    let output = run_with_limits(
        &mut command,
        Duration::from_secs(10),
        64 * 1024,
        "Simulator window geometry",
    )?;
    if !output.status.success() {
        bail!(
            "Cannot get Simulator window geometry. Grant Accessibility access to the terminal host."
        );
    }

    let text = String::from_utf8_lossy(&output.stdout).to_string();
    parse_geometry(&text)
}

#[derive(Debug, Clone, Copy)]
struct WindowGeometryCandidates {
    total_windows: usize,
    matching_windows: usize,
    matching_geometry: Option<WindowGeometry>,
}

fn escape_applescript_string(value: &str) -> Result<String> {
    if value
        .chars()
        .any(|character| character == '\n' || character == '\r' || character.is_control())
    {
        bail!("Simulator name contains unsupported control characters");
    }

    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    Ok(format!("\"{escaped}\""))
}

fn parse_target_window_geometry(text: &str) -> Result<WindowGeometryCandidates> {
    let fields: Vec<&str> = text.trim().splitn(3, '|').collect();
    if fields.len() != 3 {
        bail!("Failed to parse targeted Simulator window geometry");
    }

    let total_windows = fields[0]
        .trim()
        .parse::<usize>()
        .context("Invalid Simulator window count")?;
    let matching_windows = fields[1]
        .trim()
        .parse::<usize>()
        .context("Invalid matching Simulator window count")?;
    let matching_geometry = if fields[2].trim().is_empty() {
        None
    } else {
        Some(parse_geometry(fields[2])?)
    };

    Ok(WindowGeometryCandidates {
        total_windows,
        matching_windows,
        matching_geometry,
    })
}

fn select_target_window_geometry(candidates: WindowGeometryCandidates) -> Result<WindowGeometry> {
    if candidates.matching_windows == 1 {
        return candidates
            .matching_geometry
            .context("Target Simulator window did not provide geometry");
    }

    if candidates.matching_windows > 1 || candidates.total_windows > 1 {
        bail!(
            "Ambiguous Simulator window geometry for explicit target; \
             refusing to use another simulator"
        );
    }

    bail!(
        "Cannot uniquely identify the Simulator window for the explicit target; \
         refusing to use another simulator"
    )
}

/// Get geometry for an explicit target without falling back to another window.
///
/// System Events exposes the Simulator window title, but not its UDID. The
/// caller resolves the UDID to its simulator name first. A unique title match
/// is required whenever an explicit target is requested.
fn get_simulator_window_geometry_for(target: &SimulatorTarget) -> Result<WindowGeometry> {
    let target_name = escape_applescript_string(&target.name)?;
    let script = format!(
        r#"
tell application "System Events"
    tell process "Simulator"
        set allWindows to windows
        set totalWindowCount to count of allWindows
        set matchingWindowCount to 0
        set matchingGeometry to ""
        repeat with currentWindow in allWindows
            try
                set windowRef to contents of currentWindow
                set windowPosition to position of windowRef
                set windowSize to size of windowRef
                set currentGeometry to ((item 1 of windowPosition) as text) & "," & ((item 2 of windowPosition) as text) & "," & ((item 1 of windowSize) as text) & "," & ((item 2 of windowSize) as text)
                if (name of windowRef) is {target_name} then
                    set matchingWindowCount to matchingWindowCount + 1
                    set matchingGeometry to currentGeometry
                end if
            end try
        end repeat
        return (totalWindowCount as text) & "|" & (matchingWindowCount as text) & "|" & matchingGeometry
    end tell
end tell
"#,
    );
    let output = run_osascript(&script, "Targeted Simulator window geometry")?;
    ensure_success(&output, "Targeted Simulator window geometry")?;
    let text = String::from_utf8_lossy(&output.stdout);
    let candidates = parse_target_window_geometry(&text)?;
    select_target_window_geometry(candidates)
}

fn screen_coords_from_geometry(
    sim_x: i32,
    sim_y: i32,
    geometry: WindowGeometry,
    sim_w: f64,
    sim_h: f64,
) -> (i32, i32) {
    let (wx, wy, ww, wh) = geometry;

    // CGWindowList returns full window bounds (including toolbar chrome).
    // The toolbar is ~44pt; we subtract it to get the content area.
    // This holds for both CGWindowList and osascript paths.
    let toolbar_h = 44.0;
    let content_h = wh - toolbar_h;
    let scale_x = ww / sim_w;
    let scale_y = content_h / sim_h;
    let scale = scale_x.min(scale_y);

    let content_w = sim_w * scale;
    let actual_content_h = sim_h * scale;
    let offset_x = (ww - content_w) / 2.0;
    let offset_y = toolbar_h + (content_h - actual_content_h) / 2.0;

    let screen_x = wx + offset_x + (sim_x as f64) * scale;
    let screen_y = wy + offset_y + (sim_y as f64) * scale;

    (screen_x as i32, screen_y as i32)
}

/// Convert simulator coordinates to screen coordinates
/// sim_x, sim_y are in simulator pixel space (e.g. 1206x2622)
/// Returns screen coordinates for AppleScript click
fn sim_to_screen_coords(sim_x: i32, sim_y: i32, simulator: Option<&str>) -> Result<(i32, i32)> {
    let geometry = match simulator {
        None => get_simulator_window_geometry()?,
        Some(selector) => {
            let target = get_simulator_target(selector)?;
            get_simulator_window_geometry_for(&target)?
        }
    };

    // Get simulator resolution from screenshot
    let data = screenshot(simulator)?;
    let img = image::load_from_memory(&data)?;
    let sim_w = img.width() as f64;
    let sim_h = img.height() as f64;

    Ok(screen_coords_from_geometry(
        sim_x, sim_y, geometry, sim_w, sim_h,
    ))
}

/// Take screenshot and return PNG bytes.
pub fn screenshot(simulator: Option<&str>) -> Result<Vec<u8>> {
    let udid = get_simulator_udid(simulator)?;
    let temp_dir = private_temp_dir("ios-screenshot")?;
    let temp_path = temp_dir.path().join("screenshot.png");
    let temp_text = temp_path
        .to_str()
        .context("iOS screenshot path is not valid UTF-8")?;
    let output = simctl_exec(&["io", &udid, "screenshot", temp_text])?;

    if !output.status.success() {
        bail!("simctl screenshot failed");
    }

    read_bounded_file(&temp_path, 50 * 1024 * 1024, "iOS screenshot")
        .context("Failed to read screenshot")
}

/// Long press at coordinates using optional cliclick or AppleScript events.
pub fn long_press(x: i32, y: i32, duration: u32, simulator: Option<&str>) -> Result<()> {
    get_simulator_udid(simulator)?;
    let (screen_x, screen_y) = sim_to_screen_coords(x, y, simulator)?;
    let activate = run_osascript(
        "tell application \"Simulator\" to activate",
        "Simulator activation",
    )?;
    ensure_success(&activate, "Simulator activation")?;
    let args = [
        format!("dd:{screen_x},{screen_y}"),
        format!("w:{}", duration.max(1)),
        format!("du:{screen_x},{screen_y}"),
    ];
    let duration_secs = f64::from(duration.max(1)) / 1_000.0;
    let fallback_script = format!(
        r#"delay 0.2
tell application "System Events"
    mouse move to {{{screen_x}, {screen_y}}}
    mouse down
end tell
delay {duration_secs:.6}
tell application "System Events"
    mouse up
end tell"#
    );
    if run_cliclick(&args, "Simulator long press").is_err() {
        let output = run_osascript(&fallback_script, "Simulator long press fallback")?;
        ensure_success(&output, "Simulator long press fallback")?;
    }
    println!("Long press completed");
    Ok(())
}

/// Open URL in simulator (safe - no shell injection)
pub fn open_url(url: &str, simulator: Option<&str>) -> Result<()> {
    let udid = get_simulator_udid(simulator)?;

    let output = simctl_exec(&["openurl", &udid, url])?;

    if !output.status.success() {
        bail!("Failed to open URL");
    }

    println!("URL opened");
    Ok(())
}

/// Execute shell command in simulator (safe - uses spawn)
pub fn shell(command: &str, simulator: Option<&str>) -> Result<String> {
    let udid = get_simulator_udid(simulator)?;
    let output = simctl_exec(&["spawn", &udid, "/bin/sh", "-c", command])?;
    ensure_success(&output, "Simulator shell command")?;
    let stdout = terminal_safe(&output.stdout);
    print!("{stdout}");
    Ok(stdout)
}

/// Tap at coordinates using AppleScript
pub fn tap(x: i32, y: i32, simulator: Option<&str>) -> Result<()> {
    get_simulator_udid(simulator)?;
    let (screen_x, screen_y) = sim_to_screen_coords(x, y, simulator)?;
    let script = format!(
        "tell application \"Simulator\" to activate\n\
         delay 0.2\n\
         tell application \"System Events\" to click at {{{screen_x}, {screen_y}}}"
    );
    let output = run_osascript(&script, "Simulator tap")?;
    ensure_success(&output, "Simulator tap")?;
    println!("Tap completed");
    Ok(())
}

/// Swipe gesture using optional cliclick or AppleScript mouse events.
pub fn swipe(
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
    duration: u32,
    simulator: Option<&str>,
) -> Result<()> {
    get_simulator_udid(simulator)?;
    let (start_x, start_y) = sim_to_screen_coords(x1, y1, simulator)?;
    let (end_x, end_y) = sim_to_screen_coords(x2, y2, simulator)?;
    let activate = run_osascript(
        "tell application \"Simulator\" to activate",
        "Simulator activation",
    )?;
    ensure_success(&activate, "Simulator activation")?;
    let args = [
        format!("dd:{start_x},{start_y}"),
        format!("w:{}", duration.max(1)),
        format!("dm:{end_x},{end_y}"),
        format!("du:{end_x},{end_y}"),
    ];
    let duration_secs = f64::from(duration.max(1)) / 1_000.0;
    let step_count = 8_i64;
    let step_delay = duration_secs / step_count as f64;
    let mut fallback_script = format!(
        r#"delay 0.2
tell application "System Events"
    mouse move to {{{start_x}, {start_y}}}
    mouse down
end tell
delay {step_delay:.6}
"#
    );
    for step in 1..=step_count {
        let current_x =
            i64::from(start_x) + (i64::from(end_x) - i64::from(start_x)) * step / step_count;
        let current_y =
            i64::from(start_y) + (i64::from(end_y) - i64::from(start_y)) * step / step_count;
        fallback_script.push_str(&format!(
            "tell application \"System Events\"\n    mouse move to {{{current_x}, {current_y}}}\nend tell\n\
             delay {step_delay:.6}\n"
        ));
    }
    fallback_script.push_str("tell application \"System Events\"\n    mouse up\nend tell");
    if run_cliclick(&args, "Simulator swipe").is_err() {
        let output = run_osascript(&fallback_script, "Simulator swipe fallback")?;
        ensure_success(&output, "Simulator swipe fallback")?;
    }
    println!("Swipe completed");
    Ok(())
}

fn copy_to_clipboard(text: &str) -> Result<()> {
    let mut command = Command::new("pbcopy");
    let output = run_with_input_limits(
        &mut command,
        text.as_bytes().to_vec(),
        Duration::from_secs(5),
        64 * 1024,
        "Clipboard write",
    )?;
    ensure_success(&output, "Clipboard write")
}

/// Input text without exposing it through shell source or command output.
pub fn input_text(text: &str, simulator: Option<&str>) -> Result<()> {
    let udid = get_simulator_udid(simulator)?;

    if let Ok(output) = simctl_exec(&["io", &udid, "sendKeyboardInput", text]) {
        if output.status.success() {
            println!("Input accepted ({} characters)", text.chars().count());
            return Ok(());
        }
    }

    copy_to_clipboard(text)?;

    let script = r#"tell application "System Events"
        keystroke "v" using command down
    end tell"#;
    let output = run_osascript(script, "Simulator text paste")?;
    ensure_success(&output, "Simulator text paste")?;

    println!("Input accepted ({} characters)", text.chars().count());
    Ok(())
}

/// Press a key/button
pub fn press_key(key: &str, simulator: Option<&str>) -> Result<()> {
    let udid = get_simulator_udid(simulator)?;

    match key.to_lowercase().as_str() {
        "home" => {
            let script = r#"tell application "Simulator" to activate
            delay 0.3
            tell application "System Events" to key code 4 using {command down, shift down}"#;
            let output = run_osascript(script, "Simulator Home key")?;
            if !output.status.success() {
                let fallback = simctl_exec(&[
                    "spawn",
                    &udid,
                    "notifyutil",
                    "-p",
                    "com.apple.springboard.home",
                ])?;
                ensure_success(&fallback, "Simulator Home key")?;
            }
        }
        "lock" => {
            let script = r#"tell application "Simulator" to activate
            delay 0.1
            tell application "System Events"
                keystroke "l" using {command down}
            end tell"#;
            let output = run_osascript(script, "Simulator Lock key")?;
            ensure_success(&output, "Simulator Lock key")?;
        }
        "shake" => {
            let script = r#"tell application "Simulator" to activate
            delay 0.1
            tell application "System Events"
                keystroke "z" using {command down, control down}
            end tell"#;
            let output = run_osascript(script, "Simulator Shake gesture")?;
            ensure_success(&output, "Simulator Shake gesture")?;
        }
        _ => {
            let simctl_output = simctl_exec(&["io", &udid, "key", key]);
            if !matches!(&simctl_output, Ok(output) if output.status.success()) {
                validate_osascript_key(key)?;
                let script = format!(
                    r#"tell application "Simulator" to activate
                    delay 0.1
                    tell application "System Events"
                        keystroke "{}"
                    end tell"#,
                    key
                );
                let output = run_osascript(&script, "Simulator key press")?;
                ensure_success(&output, "Simulator key press")?;
            }
        }
    }

    println!("Key press completed");
    Ok(())
}

/// UI element from accessibility tree
#[derive(Serialize, Clone)]
pub struct UiElement {
    pub index: usize,
    pub role: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub title: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub value: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub description: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

const REDACTED_UI_TEXT: &str = "[REDACTED]";

fn is_secure_accessibility_node(role: &str, subrole: &str) -> bool {
    let role = role.to_ascii_lowercase();
    let subrole = subrole.to_ascii_lowercase();
    role.contains("secure")
        || role.contains("password")
        || subrole.contains("secure")
        || subrole.contains("password")
}

fn has_sensitive_accessibility_marker(value: &str) -> bool {
    let words = value
        .split(|character: char| !character.is_ascii_alphanumeric())
        .map(str::to_ascii_lowercase);
    if words.clone().any(|word| {
        matches!(
            word.as_str(),
            "pin" | "otp" | "password" | "passwd" | "passcode" | "cvv" | "cvc"
        )
    }) {
        return true;
    }

    let compact: String = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .map(|character| character.to_ascii_lowercase())
        .collect();
    [
        "onetimecode",
        "verificationcode",
        "securitycode",
        "pincode",
        "otpcode",
        "pinfield",
        "otpfield",
        "creditcard",
        "cardnumber",
        "ccnumber",
        "ccsecuritycode",
    ]
    .iter()
    .any(|marker| compact.contains(marker))
}

fn accessibility_text(value: &str) -> String {
    if value == "missing value" {
        String::new()
    } else {
        value.to_owned()
    }
}

fn is_text_entry_accessibility_role(value: &str) -> bool {
    let compact: String = value
        .chars()
        .filter_map(|character| {
            character
                .is_ascii_alphanumeric()
                .then_some(character.to_ascii_lowercase())
        })
        .collect();
    [
        "textfield",
        "textarea",
        "textview",
        "searchfield",
        "textbox",
        "textinput",
        "searchbox",
        "combobox",
        "spinbutton",
    ]
    .iter()
    .any(|marker| compact.contains(marker))
}

fn has_value_bearing_text_entry_value(role: &str, subrole: &str, value: &str) -> bool {
    !accessibility_text(value).trim().is_empty()
        && (is_text_entry_accessibility_role(role) || is_text_entry_accessibility_role(subrole))
}

fn ui_element_from_accessibility(
    index: usize,
    role: &str,
    subrole: &str,
    title: &str,
    value: &str,
    description: &str,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> UiElement {
    let secure = is_secure_accessibility_node(role, subrole)
        || has_sensitive_accessibility_marker(title)
        || has_sensitive_accessibility_marker(description)
        || has_value_bearing_text_entry_value(role, subrole, value);
    let (title, value, description) = if secure {
        (
            REDACTED_UI_TEXT.to_owned(),
            REDACTED_UI_TEXT.to_owned(),
            REDACTED_UI_TEXT.to_owned(),
        )
    } else {
        (
            accessibility_text(title),
            accessibility_text(value),
            accessibility_text(description),
        )
    };

    UiElement {
        index,
        role: role.to_owned(),
        title,
        value,
        description,
        x,
        y,
        width,
        height,
    }
}

fn accessibility_window_selection_for_name(name: &str) -> Result<String> {
    let target_name = escape_applescript_string(name)?;
    Ok(format!(
        r#"set allWindows to windows
set matchingWindowCount to 0
set matchingWindow to missing value
repeat with currentWindow in allWindows
    try
        set windowRef to contents of currentWindow
        if (name of windowRef) is {target_name} then
            set matchingWindowCount to matchingWindowCount + 1
            set matchingWindow to windowRef
        end if
    end try
end repeat
if matchingWindowCount = 1 then
    set win to matchingWindow
else
    error "Ambiguous Simulator window for explicit target"
end if"#,
    ))
}

fn accessibility_window_selection(simulator: Option<&str>) -> Result<String> {
    let Some(selector) = simulator else {
        return Ok("set win to front window".to_string());
    };

    let target = get_simulator_target(selector)?;
    accessibility_window_selection_for_name(&target.name)
}

fn accessibility_query_script(window_selection: &str) -> String {
    format!(
        r#"
tell application "System Events"
    tell process "Simulator"
        {window_selection}
        set allElems to entire contents of win
        set output to ""
        set idx to 0
        repeat with elem in allElems
            try
                set elemRole to role of elem as string
                set elemSubrole to ""
                try
                    set elemSubrole to subrole of elem as string
                end try

                set elemIsSecure to false
                ignoring case
                    if elemRole contains "secure" or elemRole contains "password" or elemSubrole contains "secure" or elemSubrole contains "password" then
                        set elemIsSecure to true
                    end if
                end ignoring

                set elemTitle to ""
                set elemValue to ""
                set elemDesc to ""
                if elemIsSecure then
                    set elemTitle to "[REDACTED]"
                    set elemValue to "[REDACTED]"
                    set elemDesc to "[REDACTED]"
                else
                    try
                        set elemTitle to title of elem
                    end try
                    try
                        set elemValue to value of elem as string
                    end try
                    try
                        set elemDesc to description of elem
                    end try
                end if

                set elemPos to position of elem
                set elemSize to size of elem
                set posX to item 1 of elemPos
                set posY to item 2 of elemPos
                set sW to item 1 of elemSize
                set sH to item 2 of elemSize
                set output to output & idx & "|" & elemRole & "|" & elemTitle & "|" & elemValue & "|" & elemDesc & "|" & posX & "," & posY & "|" & sW & "x" & sH & "|" & elemSubrole & linefeed
                set idx to idx + 1
            end try
        end repeat
        return output
    end tell
end tell
"#,
        window_selection = window_selection,
    )
}

/// Get accessibility tree from the requested Simulator window via AppleScript.
fn get_accessibility_elements(simulator: Option<&str>) -> Result<Vec<UiElement>> {
    let window_selection = accessibility_window_selection(simulator)?;
    let script = accessibility_query_script(&window_selection);
    let output = run_osascript(&script, "Simulator accessibility query")?;
    ensure_success(&output, "Simulator accessibility query")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut elements = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() < 8 {
            continue;
        }

        let Ok(index) = parts[0].parse::<usize>() else {
            continue;
        };
        let role = parts[1];
        let subrole = parts[7];

        let pos: Vec<i32> = parts[5]
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();
        let size: Vec<i32> = parts[6]
            .split('x')
            .filter_map(|s| s.trim().parse().ok())
            .collect();

        if pos.len() == 2 && size.len() == 2 {
            elements.push(ui_element_from_accessibility(
                index, role, subrole, parts[2], parts[3], parts[4], pos[0], pos[1], size[0],
                size[1],
            ));
        }
    }

    Ok(elements)
}

fn ui_element_label(element: &UiElement) -> &str {
    if !element.title.is_empty() {
        &element.title
    } else if !element.description.is_empty() {
        &element.description
    } else {
        &element.value
    }
}

fn render_ui_dump_json(elements: &[UiElement]) -> Result<String> {
    Ok(serde_json::to_string_pretty(elements)?)
}

fn render_ui_dump_text(elements: &[UiElement]) -> String {
    let mut output = String::new();
    for element in elements {
        output.push_str(&format!(
            "[{}] {} \"{}\" ({},{} {}x{})\n",
            element.index,
            terminal_safe(element.role.as_bytes()),
            terminal_safe(ui_element_label(element).as_bytes()),
            element.x,
            element.y,
            element.width,
            element.height
        ));
    }
    output
}

/// Dump UI hierarchy via Accessibility.
pub fn ui_dump(format: &str, simulator: Option<&str>) -> Result<()> {
    let elements = get_accessibility_elements(simulator)?;

    if elements.is_empty() {
        println!("No UI elements found. Ensure Simulator is in foreground.");
        return Ok(());
    }

    if format == "json" {
        let json = render_ui_dump_json(&elements)?;
        println!("{}", terminal_safe(json.as_bytes()));
    } else {
        print!("{}", render_ui_dump_text(&elements));
    }

    Ok(())
}

#[derive(Serialize)]
pub struct Simulator {
    pub name: String,
    pub udid: String,
    pub state: String,
    pub runtime: String,
}

/// List simulators
pub fn list_devices() -> Result<Vec<Simulator>> {
    let output = simctl_exec(&["list", "devices", "-j"])?;

    let json: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    let mut simulators = Vec::new();

    if let Some(devices) = json["devices"].as_object() {
        for (runtime, device_list) in devices {
            if let Some(devices) = device_list.as_array() {
                for device in devices {
                    let state = device["state"].as_str().unwrap_or("Unknown");
                    if device["isAvailable"].as_bool().unwrap_or(false) {
                        simulators.push(Simulator {
                            name: device["name"].as_str().unwrap_or("Unknown").to_string(),
                            udid: device["udid"].as_str().unwrap_or("").to_string(),
                            state: state.to_string(),
                            runtime: runtime.replace("com.apple.CoreSimulator.SimRuntime.", ""),
                        });
                    }
                }
            }
        }
    }

    simulators.sort_by(|a, b| {
        if a.state == "Booted" && b.state != "Booted" {
            std::cmp::Ordering::Less
        } else if a.state != "Booted" && b.state == "Booted" {
            std::cmp::Ordering::Greater
        } else {
            a.name.cmp(&b.name)
        }
    });

    Ok(simulators)
}

/// Print devices list
pub fn print_devices() -> Result<()> {
    let simulators = list_devices()?;
    println!("iOS Simulators:");
    println!("{}", terminal_safe_json(&simulators)?);
    Ok(())
}

/// List installed apps
pub fn list_apps(filter: Option<&str>, simulator: Option<&str>) -> Result<()> {
    let udid = get_simulator_udid(simulator)?;

    let output = simctl_exec(&["listapps", &udid])?;

    if !output.status.success() {
        bail!("simctl listapps failed: {}", terminal_safe(&output.stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    let bundle_re = regex::Regex::new(r#"^\s+"([^"]+)"\s+=\s+\{"#).unwrap();
    let display_re = regex::Regex::new(r#"CFBundleDisplayName\s*=\s*"?([^";]+)"?\s*;"#).unwrap();

    let mut apps: Vec<String> = Vec::new();
    let mut current_bundle: Option<String> = None;
    let mut current_display: Option<String> = None;

    for line in stdout.lines() {
        if let Some(cap) = bundle_re.captures(line) {
            if let Some(bundle) = current_bundle.take() {
                let display = current_display.take().unwrap_or_default();
                let entry = if display.is_empty() {
                    bundle
                } else {
                    format!("{} ({})", bundle, display)
                };
                apps.push(entry);
            }
            current_bundle = Some(cap[1].to_string());
            current_display = None;
        } else if current_bundle.is_some() {
            if let Some(cap) = display_re.captures(line) {
                current_display = Some(cap[1].trim().to_string());
            }
        }
    }
    if let Some(bundle) = current_bundle {
        let display = current_display.unwrap_or_default();
        let entry = if display.is_empty() {
            bundle
        } else {
            format!("{} ({})", bundle, display)
        };
        apps.push(entry);
    }

    if let Some(f) = filter {
        let f_lower = f.to_lowercase();
        apps.retain(|a| a.to_lowercase().contains(&f_lower));
    }

    apps.sort();
    apps.dedup();

    println!("Installed apps ({}):", apps.len());
    for app in &apps {
        println!("  {}", terminal_safe(app.as_bytes()));
    }
    Ok(())
}

/// Launch an app
pub fn launch_app(bundle_id: &str, simulator: Option<&str>) -> Result<()> {
    validate_identifier(bundle_id, "bundle identifier")?;
    let udid = get_simulator_udid(simulator)?;

    let output = simctl_exec(&["launch", &udid, bundle_id])?;

    if !output.status.success() {
        bail!(
            "Failed to launch {}: {}",
            bundle_id,
            terminal_safe(&output.stderr)
        );
    }

    println!("Launched: {}", terminal_safe(bundle_id.as_bytes()));
    Ok(())
}

/// Stop an app
pub fn stop_app(bundle_id: &str, simulator: Option<&str>) -> Result<()> {
    validate_identifier(bundle_id, "bundle identifier")?;
    let udid = get_simulator_udid(simulator)?;

    let output = simctl_exec(&["terminate", &udid, bundle_id])?;

    if !output.status.success() {
        bail!(
            "Failed to stop {}: {}",
            bundle_id,
            terminal_safe(&output.stderr)
        );
    }

    println!("Stopped: {}", terminal_safe(bundle_id.as_bytes()));
    Ok(())
}

/// Install an app
pub fn install_app(path: &str, simulator: Option<&str>) -> Result<()> {
    let udid = get_simulator_udid(simulator)?;

    println!("Installing {}...", terminal_safe(path.as_bytes()));

    let output = simctl_exec(&["install", &udid, path])?;

    if !output.status.success() {
        bail!("Failed to install: {}", terminal_safe(&output.stderr));
    }

    println!("Installed: {}", terminal_safe(path.as_bytes()));
    Ok(())
}

/// Uninstall an app
pub fn uninstall_app(bundle_id: &str, simulator: Option<&str>) -> Result<()> {
    validate_identifier(bundle_id, "bundle identifier")?;
    let udid = get_simulator_udid(simulator)?;

    println!("Uninstalling {}...", terminal_safe(bundle_id.as_bytes()));

    let output = simctl_exec(&["uninstall", &udid, bundle_id])?;

    if !output.status.success() {
        bail!("Failed to uninstall: {}", terminal_safe(&output.stderr));
    }

    println!("Uninstalled: {}", terminal_safe(bundle_id.as_bytes()));
    Ok(())
}

fn find_element_in_elements<'a>(elements: &'a [UiElement], query: &str) -> Option<&'a UiElement> {
    let query_lower = query.to_lowercase();

    elements.iter().find(|element| {
        let matches = element.title.to_lowercase().contains(&query_lower)
            || element.value.to_lowercase().contains(&query_lower)
            || element.description.to_lowercase().contains(&query_lower);
        matches && element.width > 0 && element.height > 0
    })
}

fn render_find_element_result(element: &UiElement) -> String {
    format!(
        "Found: \"{}\" role={} at ({},{}) size={}x{}",
        terminal_safe(ui_element_label(element).as_bytes()),
        terminal_safe(element.role.as_bytes()),
        element.x,
        element.y,
        element.width,
        element.height
    )
}

/// Find element by text via accessibility tree
pub fn find_element(query: &str, simulator: Option<&str>) -> Result<Option<(i32, i32)>> {
    let elements = get_accessibility_elements(simulator)?;

    if let Some(element) = find_element_in_elements(&elements, query) {
        let cx = element.x + element.width / 2;
        let cy = element.y + element.height / 2;
        println!("{}", render_find_element_result(element));
        return Ok(Some((cx, cy)));
    }

    println!("Element not found");
    Ok(None)
}

fn find_ui_element_in_elements(
    elements: &[UiElement],
    text: Option<&str>,
    resource_id: Option<&str>,
) -> Option<String> {
    let text_q = text.map(|s| s.to_lowercase());
    let res_q = resource_id.map(|s| s.to_lowercase());

    for element in elements {
        if let Some(q) = &text_q {
            let matches_title = element.title.to_lowercase().contains(q.as_str());
            let matches_value = element.value.to_lowercase().contains(q.as_str());
            let matches_desc = element.description.to_lowercase().contains(q.as_str());
            if !matches_title && !matches_value && !matches_desc {
                continue;
            }
        }

        if let Some(q) = &res_q {
            let matches_desc = element.description.to_lowercase().contains(q.as_str());
            let matches_title = element.title.to_lowercase().contains(q.as_str());
            if !matches_desc && !matches_title {
                continue;
            }
        }

        return Some(format!(
            "role=\"{}\" label=\"{}\" at ({},{}) size={}x{}",
            terminal_safe(element.role.as_bytes()),
            terminal_safe(ui_element_label(element).as_bytes()),
            element.x,
            element.y,
            element.width,
            element.height
        ));
    }

    None
}

/// Find a UI element on iOS matching any of the supplied criteria.
///
/// Matching is case-insensitive and partial (contains). Returns a human-readable
/// description of the first matching element, or `None` if nothing is found.
///
/// This is the iOS counterpart of `android::find_ui_element`, used by
/// `ui-wait`, `ui-assert-visible`, and `ui-assert-gone`.
pub fn find_ui_element(
    text: Option<&str>,
    resource_id: Option<&str>,
    simulator: Option<&str>,
) -> Result<Option<String>> {
    // iOS accessibility elements do not have a resource-id concept, but we
    // support the parameter for API symmetry with Android, treating it as a
    // match against the accessibility identifier / description.
    let elements = get_accessibility_elements(simulator)?;
    Ok(find_ui_element_in_elements(&elements, text, resource_id))
}

fn simulator_element_tap_script(x: i32, y: i32, simulator: Option<&str>) -> Result<String> {
    let Some(selector) = simulator else {
        return Ok(format!(
            r#"tell application "Simulator" to activate
delay 0.2
tell application "System Events"
    click at {{{}, {}}}
end tell"#,
            x, y
        ));
    };

    let target = get_simulator_target(selector)?;
    let window_selection = accessibility_window_selection_for_name(&target.name)?;
    Ok(format!(
        r#"tell application "Simulator" to activate
delay 0.2
tell application "System Events"
    tell process "Simulator"
        set frontmost to true
        {window_selection}
        perform action "AXRaise" of win
    end tell
    click at {{{x}, {y}}}
end tell"#,
        window_selection = window_selection,
        x = x,
        y = y,
    ))
}

/// Tap element by text
pub fn tap_element(query: &str, simulator: Option<&str>) -> Result<()> {
    if let Some((x, y)) = find_element(query, simulator)? {
        let script = simulator_element_tap_script(x, y, simulator)?;
        let output = run_osascript(&script, "Simulator element tap")?;
        ensure_success(&output, "Simulator element tap")?;
        println!("Element tap completed");
    } else {
        bail!("Element was not found");
    }
    Ok(())
}

/// Clear device logs
pub fn clear_logs(simulator: Option<&str>) -> Result<()> {
    let udid = get_simulator_udid(simulator)?;

    // Try predicate-based approach: show last 0 seconds effectively clears view
    let output = simctl_exec(&["spawn", &udid, "log", "erase", "--all"]);

    if let Ok(out) = output {
        if out.status.success() {
            println!("Logs cleared");
            return Ok(());
        }
    }

    // Fallback: log erase requires root, inform user
    println!("Note: log erase requires elevated privileges on iOS simulator");
    println!("Workaround: reboot simulator to clear logs (mcp-devices-cli reboot ios)");
    Ok(())
}

/// Get system info
pub fn get_system_info(simulator: Option<&str>) -> Result<()> {
    let udid = get_simulator_udid(simulator)?;

    let output = simctl_exec(&["list", "devices", "-j"])?;
    let json: serde_json::Value = serde_json::from_slice(&output.stdout)?;

    if let Some(devices) = json["devices"].as_object() {
        for (runtime, device_list) in devices {
            if let Some(devices) = device_list.as_array() {
                for device in devices {
                    let device_udid = device["udid"].as_str().unwrap_or("");
                    let is_booted = device["state"].as_str() == Some("Booted");

                    if device_udid == udid || (udid == "booted" && is_booted) {
                        println!("System Info:");
                        println!(
                            "  Name: {}",
                            terminal_safe(device["name"].as_str().unwrap_or("unknown").as_bytes()),
                        );
                        println!(
                            "  State: {}",
                            terminal_safe(device["state"].as_str().unwrap_or("unknown").as_bytes()),
                        );
                        println!(
                            "  Runtime: {}",
                            terminal_safe(
                                runtime
                                    .replace("com.apple.CoreSimulator.SimRuntime.", "")
                                    .as_bytes(),
                            ),
                        );
                        println!("  UDID: {}", terminal_safe(device_udid.as_bytes()));
                        return Ok(());
                    }
                }
            }
        }
    }

    println!("Device not found");
    Ok(())
}

/// Get current activity (foreground app) via launchctl
pub fn get_current_activity(simulator: Option<&str>) -> Result<()> {
    let udid = get_simulator_udid(simulator)?;

    let output = simctl_exec(&["spawn", &udid, "launchctl", "list"])?;
    ensure_success(&output, "Simulator process lookup")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let re = regex::Regex::new(r"UIKitApplication:([^\[]+)\[").unwrap();

    let mut apps: Vec<String> = Vec::new();
    for line in stdout.lines() {
        if let Some(cap) = re.captures(line) {
            let bundle = cap[1].to_string();
            // Skip system background services
            if !bundle.contains("WidgetRenderer")
                && !bundle.contains("ViewService")
                && !bundle.contains("Spotlight")
            {
                // Check if PID is running (first column is PID, "-" means not running)
                let pid = line.split_whitespace().next().unwrap_or("-");
                if pid != "-" {
                    apps.push(bundle);
                }
            }
        }
    }

    if apps.is_empty() {
        println!("No foreground app detected (SpringBoard/Home Screen)");
    } else {
        println!("Foreground app: {}", terminal_safe(apps[0].as_bytes()));
        for app in apps.iter().skip(1) {
            println!("Background app: {}", terminal_safe(app.as_bytes()));
        }
    }

    Ok(())
}

fn predicate_string_literal(value: &str) -> Result<String> {
    if value.is_empty() || value.len() > 255 || value.chars().any(char::is_control) {
        bail!("Invalid iOS log filter");
    }
    let mut literal = String::with_capacity(value.len() + 2);
    literal.push('"');
    for character in value.chars() {
        if matches!(character, '\\' | '"') {
            literal.push('\\');
        }
        literal.push(character);
    }
    literal.push('"');
    Ok(literal)
}

/// Get device logs
pub fn get_logs(filter: Option<&str>, lines: usize, simulator: Option<&str>) -> Result<()> {
    let udid = get_simulator_udid(simulator)?;

    let predicate;
    let mut args = vec![
        "spawn", &udid, "log", "show", "--last", "5m", "--style", "compact",
    ];

    if let Some(filter) = filter {
        predicate = format!(
            "processImagePath CONTAINS[c] {}",
            predicate_string_literal(filter)?
        );
        args.push("--predicate");
        args.push(&predicate);
    }

    let output = simctl_exec(&args)?;

    if !output.status.success() {
        if filter.is_some() {
            bail!("iOS log query failed");
        }
        let fallback = simctl_exec(&["spawn", &udid, "log", "show", "--last", "1m"])?;
        let stdout = terminal_safe(&fallback.stdout);
        for line in stdout.lines().take(lines) {
            println!("{line}");
        }
        return Ok(());
    }

    let stdout = terminal_safe(&output.stdout);
    for line in stdout.lines().take(lines) {
        println!("{line}");
    }
    Ok(())
}

/// Reboot simulator
pub fn reboot(simulator: Option<&str>) -> Result<()> {
    let udid = get_simulator_udid(simulator)?;

    println!("Rebooting simulator...");

    let _ = simctl_exec(&["shutdown", &udid]);
    std::thread::sleep(std::time::Duration::from_secs(1));

    let output = simctl_exec(&["boot", &udid])?;

    if !output.status.success() {
        bail!("Failed to reboot: {}", terminal_safe(&output.stderr));
    }

    println!("Reboot initiated");
    Ok(())
}

// ============== File Transfer ==============

/// File transfer requires an application container and is not exposed by this command.
pub fn push_file(_local: &str, _remote: &str, _simulator: Option<&str>) -> Result<()> {
    bail!("iOS Simulator file push is unsupported; use simctl addmedia or an app container")
}

/// File transfer requires an application container and is not exposed by this command.
pub fn pull_file(_remote: &str, _local: &str, _simulator: Option<&str>) -> Result<()> {
    bail!("iOS Simulator file pull is unsupported; use an app container")
}

// ============== Clipboard ==============

/// Get clipboard content (host clipboard since simulator shares it)
pub fn get_clipboard(_simulator: Option<&str>) -> Result<()> {
    let mut command = Command::new("pbpaste");
    let output = run_with_limits(
        &mut command,
        Duration::from_secs(5),
        1024 * 1024,
        "Clipboard read",
    )?;
    ensure_success(&output, "Clipboard read")?;
    println!("{}", terminal_safe(&output.stdout));
    Ok(())
}

/// Set clipboard content (host clipboard since simulator shares it)
pub fn set_clipboard(text: &str, _simulator: Option<&str>) -> Result<()> {
    copy_to_clipboard(text)?;
    println!("Clipboard set");
    Ok(())
}

// ============== Tests ==============

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ios_log_filter_is_an_escaped_predicate_literal() {
        let filter = "Runner\" OR processImagePath CONTAINS \"SpringBoard";
        let literal = predicate_string_literal(filter).unwrap();
        assert_eq!(
            format!("processImagePath CONTAINS[c] {literal}"),
            "processImagePath CONTAINS[c] \"Runner\\\" OR processImagePath CONTAINS \\\"SpringBoard\""
        );
        assert!(predicate_string_literal("Runner\0").is_err());
        assert!(predicate_string_literal("").is_err());
    }
    #[test]
    fn test_get_simulator_udid_booted() {
        let result = get_simulator_udid(None);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "booted");
    }

    #[test]
    fn explicit_target_selects_matching_geometry_across_two_windows() {
        let target_geometry = (700.0, 200.0, 400.0, 444.0);
        let other_geometry = (20.0, 40.0, 400.0, 444.0);
        let candidates = parse_target_window_geometry("2|1|700,200,400,444").unwrap();

        assert_eq!(candidates.matching_geometry, Some(target_geometry));
        assert_eq!(candidates.total_windows, 2);
        assert_eq!(candidates.matching_windows, 1);

        let selected = select_target_window_geometry(candidates).unwrap();
        assert_eq!(selected, target_geometry);
        assert_eq!(
            screen_coords_from_geometry(10, 20, selected, 100.0, 100.0),
            (740, 324)
        );
        assert_ne!(
            screen_coords_from_geometry(10, 20, other_geometry, 100.0, 100.0),
            (740, 324)
        );
    }

    #[test]
    fn explicit_target_rejects_ambiguous_multi_window_geometry() {
        let error = select_target_window_geometry(WindowGeometryCandidates {
            total_windows: 2,
            matching_windows: 0,
            matching_geometry: None,
        })
        .unwrap_err();

        assert!(error.to_string().contains("Ambiguous"));
    }

    #[test]
    fn explicit_target_rejects_unmatched_single_window_geometry() {
        let error = select_target_window_geometry(WindowGeometryCandidates {
            total_windows: 1,
            matching_windows: 0,
            matching_geometry: None,
        })
        .unwrap_err();

        assert!(error.to_string().contains("explicit target"));
    }

    #[test]
    fn explicit_accessibility_selection_rejects_front_window_fallback() {
        let selection = accessibility_window_selection_for_name("Target Simulator").unwrap();

        assert!(selection.contains("matchingWindowCount"));
        assert!(selection.contains("\"Target Simulator\""));
        assert!(selection.contains("Ambiguous Simulator window"));
        assert!(!selection.contains("front window"));
    }

    #[test]
    fn secure_accessibility_nodes_are_recognized_from_role_or_subrole() {
        assert!(is_secure_accessibility_node(
            "AXTextField",
            "AXSecureTextField"
        ));
        assert!(is_secure_accessibility_node(
            "AXSecureTextField",
            "AXTextField"
        ));
        assert!(is_secure_accessibility_node(
            "axtextfield",
            "axsecuretextfield"
        ));
        assert!(is_secure_accessibility_node(
            "AXPasswordField",
            "AXTextField"
        ));
        assert!(is_secure_accessibility_node(
            "AXTextField",
            "AXProtectedPasswordField"
        ));
        assert!(!is_secure_accessibility_node("AXTextField", "AXTextField"));
    }

    #[test]
    fn secure_accessibility_values_are_safe_in_dump_and_find_paths() {
        let secret = "credential-value";
        let secure = ui_element_from_accessibility(
            1,
            "AXTextField",
            "AXSecureTextField",
            secret,
            secret,
            secret,
            10,
            20,
            100,
            40,
        );
        let visible = ui_element_from_accessibility(
            2, "AXButton", "AXButton", "Continue", "Continue", "Continue", 40, 80, 100, 40,
        );
        let elements = vec![secure.clone(), visible];

        assert_eq!(secure.role, "AXTextField");
        assert_eq!(
            (secure.x, secure.y, secure.width, secure.height),
            (10, 20, 100, 40)
        );
        assert_eq!(secure.title, REDACTED_UI_TEXT);
        assert_eq!(secure.value, REDACTED_UI_TEXT);
        assert_eq!(secure.description, REDACTED_UI_TEXT);

        let json = render_ui_dump_json(&elements).unwrap();
        let text = render_ui_dump_text(&elements);
        assert!(!json.contains(secret));
        assert!(!text.contains(secret));
        assert!(json.contains("Continue"));
        assert!(text.contains("Continue"));
        assert!(text.contains("(40,80 100x40)"));

        assert!(find_element_in_elements(&elements, secret).is_none());
        assert!(find_ui_element_in_elements(&elements, Some(secret), None).is_none());

        let find_output = render_find_element_result(
            find_element_in_elements(&elements, REDACTED_UI_TEXT)
                .expect("redacted secure node should remain findable by its redaction marker"),
        );
        assert!(!find_output.contains(secret));

        let find_ui_output =
            find_ui_element_in_elements(&elements, Some("Continue"), None).unwrap();
        assert!(!find_ui_output.contains(secret));
        assert!(find_ui_output.contains("Continue"));
        assert!(find_ui_output.contains("at (40,80) size=100x40"));
    }

    #[test]
    fn accessibility_code_labels_redact_values_without_matching_shipping() {
        let otp = ui_element_from_accessibility(
            1,
            "AXTextField",
            "AXTextField",
            "Verification code",
            "731904",
            "One-time code",
            10,
            20,
            100,
            40,
        );
        let shipping = ui_element_from_accessibility(
            2,
            "AXTextField",
            "AXTextField",
            "Shipping",
            "visible value",
            "Shipping details",
            40,
            80,
            100,
            40,
        );

        assert_eq!(otp.title, REDACTED_UI_TEXT);
        assert_eq!(otp.value, REDACTED_UI_TEXT);
        assert_eq!(otp.description, REDACTED_UI_TEXT);
        assert_eq!(shipping.title, REDACTED_UI_TEXT);
        assert_eq!(shipping.value, REDACTED_UI_TEXT);
        assert_eq!(shipping.description, REDACTED_UI_TEXT);
        let shipping_json = render_ui_dump_json(&[shipping.clone()]).unwrap();
        let shipping_text = render_ui_dump_text(&[shipping]);
        assert!(!shipping_json.contains("visible value"));
        assert!(!shipping_text.contains("visible value"));
        assert!(shipping_json.contains(REDACTED_UI_TEXT));
        assert!(shipping_text.contains(REDACTED_UI_TEXT));
    }

    #[cfg(unix)]
    #[test]
    fn set_owner_executable_sets_user_execute_bit() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("swift-helper");
        std::fs::write(&path, b"helper").unwrap();

        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o600);
        std::fs::set_permissions(&path, permissions).unwrap();

        set_owner_executable(&path).unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_ne!(mode & 0o100, 0, "owner execute bit was not set");
        assert_eq!(mode & 0o077, 0, "group/world bits changed unexpectedly");
    }
}
