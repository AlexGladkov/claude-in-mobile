//! iOS Simulator automation via simctl

use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tempfile::Builder;

use crate::utils::private_state::{
    atomic_write, cache_dir, private_temp_dir, read_bounded_file, validate_identifier,
};
use crate::utils::process::{ensure_success, run_with_limits, terminal_safe};
use crate::utils::validate::validate_osascript_key;

/// Get simulator UDID (booted or by name)
fn get_simulator_udid(simulator: Option<&str>) -> Result<String> {
    let Some(name) = simulator else {
        return Ok("booted".to_string());
    };
    let output = simctl_exec(&["list", "devices", "-j"])?;
    ensure_success(&output, "Simulator discovery")?;
    let json: serde_json::Value = serde_json::from_slice(&output.stdout)?;

    if let Some(runtimes) = json["devices"].as_object() {
        for devices in runtimes.values().filter_map(serde_json::Value::as_array) {
            for device in devices {
                if device["name"].as_str() == Some(name) {
                    if let Some(udid) = device["udid"].as_str() {
                        return Ok(udid.to_string());
                    }
                }
            }
        }
    }
    bail!("Requested simulator was not found")
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
        staged_path
            .persist(&bin_path)
            .map_err(|error| error.error)
            .context("Failed to atomically install Swift helper")?;

        atomic_write(&hash_path, current_hash.as_bytes())?;
        let _ = std::fs::remove_file(&src_path);
    }

    Ok(bin_path)
}

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
    // Primary: Swift helper using CGWindowListCopyWindowInfo (no TCC required)
    if let Ok(helper_path) = get_swift_helper_path() {
        let mut command = Command::new(&helper_path);
        let output = run_with_limits(
            &mut command,
            Duration::from_secs(10),
            64 * 1024,
            "Swift window geometry helper",
        )?;

        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout).to_string();
            return parse_geometry(&text);
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

/// Convert simulator coordinates to screen coordinates
/// sim_x, sim_y are in simulator pixel space (e.g. 1206x2622)
/// Returns screen coordinates for AppleScript click
fn sim_to_screen_coords(sim_x: i32, sim_y: i32, simulator: Option<&str>) -> Result<(i32, i32)> {
    let (wx, wy, ww, wh) = get_simulator_window_geometry()?;

    // Get simulator resolution from screenshot
    let data = screenshot(simulator)?;
    let img = image::load_from_memory(&data)?;
    let sim_w = img.width() as f64;
    let sim_h = img.height() as f64;

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

    Ok((screen_x as i32, screen_y as i32))
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

/// Long press at coordinates via AppleScript mouse events
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
    run_cliclick(&args, "Simulator long press")
        .context("Long press requires the cliclick executable")?;
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

/// Swipe gesture via AppleScript drag
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
    run_cliclick(&args, "Simulator swipe").context("Swipe requires the cliclick executable")?;
    println!("Swipe completed");
    Ok(())
}

fn copy_to_clipboard(text: &str) -> Result<()> {
    let mut child = Command::new("pbcopy")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("Failed to start pbcopy")?;
    child
        .stdin
        .take()
        .context("pbcopy stdin was unavailable")?
        .write_all(text.as_bytes())?;

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait()? {
            if !status.success() {
                bail!("pbcopy failed");
            }
            return Ok(());
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("pbcopy timed out");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
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

/// Get accessibility tree from Simulator window via AppleScript
fn get_accessibility_elements() -> Result<Vec<UiElement>> {
    let script = r#"
tell application "System Events"
    tell process "Simulator"
        set win to front window
        set allElems to entire contents of win
        set output to ""
        set idx to 0
        repeat with elem in allElems
            try
                set elemRole to role of elem
                set elemTitle to ""
                try
                    set elemTitle to title of elem
                end try
                set elemValue to ""
                try
                    set elemValue to value of elem as string
                end try
                set elemDesc to ""
                try
                    set elemDesc to description of elem
                end try
                set elemPos to position of elem
                set elemSize to size of elem
                set posX to item 1 of elemPos
                set posY to item 2 of elemPos
                set sW to item 1 of elemSize
                set sH to item 2 of elemSize
                set output to output & idx & "|" & elemRole & "|" & elemTitle & "|" & elemValue & "|" & elemDesc & "|" & posX & "," & posY & "|" & sW & "x" & sH & linefeed
                set idx to idx + 1
            end try
        end repeat
        return output
    end tell
end tell
"#;
    let output = run_osascript(script, "Simulator accessibility query")?;
    ensure_success(&output, "Simulator accessibility query")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut elements = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() < 7 {
            continue;
        }

        let Ok(index) = parts[0].parse::<usize>() else {
            continue;
        };
        let role = parts[1].to_string();
        let title = if parts[2] == "missing value" {
            String::new()
        } else {
            parts[2].to_string()
        };
        let value = if parts[3] == "missing value" {
            String::new()
        } else {
            parts[3].to_string()
        };
        let description = if parts[4] == "missing value" {
            String::new()
        } else {
            parts[4].to_string()
        };

        let pos: Vec<i32> = parts[5]
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();
        let size: Vec<i32> = parts[6]
            .split('x')
            .filter_map(|s| s.trim().parse().ok())
            .collect();

        if pos.len() == 2 && size.len() == 2 {
            elements.push(UiElement {
                index,
                role,
                title,
                value,
                description,
                x: pos[0],
                y: pos[1],
                width: size[0],
                height: size[1],
            });
        }
    }

    Ok(elements)
}

/// Dump UI hierarchy via Accessibility
pub fn ui_dump(format: &str, _simulator: Option<&str>) -> Result<()> {
    let elements = get_accessibility_elements()?;

    if elements.is_empty() {
        println!("No UI elements found. Ensure Simulator is in foreground.");
        return Ok(());
    }

    if format == "json" {
        println!("{}", serde_json::to_string_pretty(&elements)?);
    } else {
        for elem in &elements {
            let label = if !elem.title.is_empty() {
                &elem.title
            } else if !elem.description.is_empty() {
                &elem.description
            } else if !elem.value.is_empty() {
                &elem.value
            } else {
                ""
            };
            println!(
                "[{}] {} \"{}\" ({},{} {}x{})",
                elem.index,
                terminal_safe(elem.role.as_bytes()),
                terminal_safe(label.as_bytes()),
                elem.x,
                elem.y,
                elem.width,
                elem.height
            );
        }
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
    println!("{}", serde_json::to_string_pretty(&simulators)?);
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

/// Find element by text via accessibility tree
pub fn find_element(query: &str, _simulator: Option<&str>) -> Result<Option<(i32, i32)>> {
    let elements = get_accessibility_elements()?;
    let query_lower = query.to_lowercase();

    for elem in &elements {
        let matches = elem.title.to_lowercase().contains(&query_lower)
            || elem.value.to_lowercase().contains(&query_lower)
            || elem.description.to_lowercase().contains(&query_lower);

        if matches && elem.width > 0 && elem.height > 0 {
            let cx = elem.x + elem.width / 2;
            let cy = elem.y + elem.height / 2;
            println!(
                "Found: \"{}\" role={} at ({},{}) size={}x{}",
                if !elem.title.is_empty() {
                    &elem.title
                } else if !elem.description.is_empty() {
                    &elem.description
                } else {
                    &elem.value
                },
                elem.role,
                elem.x,
                elem.y,
                elem.width,
                elem.height
            );
            return Ok(Some((cx, cy)));
        }
    }

    println!("Element '{}' not found", terminal_safe(query.as_bytes()));
    Ok(None)
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
    let _ = simulator; // simctl-based accessibility lookup does not need UDID here

    let elements = get_accessibility_elements()?;

    let text_q = text.map(|s| s.to_lowercase());
    let res_q = resource_id.map(|s| s.to_lowercase());

    for elem in &elements {
        if let Some(q) = &text_q {
            let matches_title = elem.title.to_lowercase().contains(q.as_str());
            let matches_value = elem.value.to_lowercase().contains(q.as_str());
            let matches_desc = elem.description.to_lowercase().contains(q.as_str());
            if !matches_title && !matches_value && !matches_desc {
                continue;
            }
        }

        if let Some(q) = &res_q {
            let matches_desc = elem.description.to_lowercase().contains(q.as_str());
            let matches_title = elem.title.to_lowercase().contains(q.as_str());
            if !matches_desc && !matches_title {
                continue;
            }
        }

        let label = if !elem.title.is_empty() {
            &elem.title
        } else if !elem.description.is_empty() {
            &elem.description
        } else {
            &elem.value
        };

        let desc = format!(
            "role=\"{}\" label=\"{}\" at ({},{}) size={}x{}",
            elem.role, label, elem.x, elem.y, elem.width, elem.height
        );
        return Ok(Some(desc));
    }

    Ok(None)
}

/// Tap element by text
pub fn tap_element(query: &str, simulator: Option<&str>) -> Result<()> {
    if let Some((x, y)) = find_element(query, simulator)? {
        // These are screen coordinates already (from AppleScript), tap directly
        let script = format!(
            r#"tell application "Simulator" to activate
delay 0.2
tell application "System Events"
    click at {{{}, {}}}
end tell"#,
            x, y
        );
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

/// Get device logs
pub fn get_logs(filter: Option<&str>, lines: usize, simulator: Option<&str>) -> Result<()> {
    let udid = get_simulator_udid(simulator)?;

    let predicate;
    let mut args = vec![
        "spawn", &udid, "log", "show", "--last", "5m", "--style", "compact",
    ];

    if let Some(f) = filter {
        predicate = format!("processImagePath CONTAINS '{}'", f);
        args.push("--predicate");
        args.push(&predicate);
    }

    let output = simctl_exec(&args)?;

    if !output.status.success() {
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
    fn test_get_simulator_udid_booted() {
        let result = get_simulator_udid(None);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "booted");
    }
}
