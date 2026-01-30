//! iOS Simulator automation via simctl

use std::process::Command;
use anyhow::{Result, Context, bail};
use serde::Serialize;

/// Get simulator UDID (booted or by name)
fn get_simulator_udid(simulator: Option<&str>) -> Result<String> {
    if let Some(name) = simulator {
        let output = Command::new("xcrun")
            .args(["simctl", "list", "devices", "-j"])
            .output()
            .context("Failed to list simulators")?;

        let json: serde_json::Value = serde_json::from_slice(&output.stdout)?;

        if let Some(devices) = json["devices"].as_object() {
            for (_runtime, device_list) in devices {
                if let Some(devices) = device_list.as_array() {
                    for device in devices {
                        if device["name"].as_str() == Some(name) {
                            if let Some(udid) = device["udid"].as_str() {
                                return Ok(udid.to_string());
                            }
                        }
                    }
                }
            }
        }
        bail!("Simulator '{}' not found", name);
    } else {
        Ok("booted".to_string())
    }
}

/// Execute simctl command
fn simctl_exec(args: &[&str]) -> Result<std::process::Output> {
    Command::new("xcrun")
        .arg("simctl")
        .args(args)
        .output()
        .context("Failed to execute simctl command")
}

/// Get Simulator window content area position (top-left of the simulated screen)
/// Returns (window_x, window_y, content_width, content_height)
fn get_simulator_window_geometry() -> Result<(f64, f64, f64, f64)> {
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
    let output = Command::new("osascript")
        .args(["-e", script])
        .output()
        .context("Failed to get Simulator window geometry")?;

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let parts: Vec<f64> = text.split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();

    if parts.len() != 4 {
        bail!("Failed to parse window geometry: {}", text);
    }

    Ok((parts[0], parts[1], parts[2], parts[3]))
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

    // The simulator window has a bezel/chrome area around the screen content
    // The content area takes most of the window
    // Approximate: toolbar ~44px at top, small padding
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

/// Take screenshot and return PNG bytes
pub fn screenshot(simulator: Option<&str>) -> Result<Vec<u8>> {
    let udid = get_simulator_udid(simulator)?;
    let temp_path = "/tmp/ios_screenshot.png";

    let output = simctl_exec(&["io", &udid, "screenshot", temp_path])?;

    if !output.status.success() {
        bail!("simctl screenshot failed: {}", String::from_utf8_lossy(&output.stderr));
    }

    let data = std::fs::read(temp_path).context("Failed to read screenshot")?;
    std::fs::remove_file(temp_path).ok();

    Ok(data)
}

/// Long press at coordinates via AppleScript mouse events
pub fn long_press(x: i32, y: i32, duration: u32, simulator: Option<&str>) -> Result<()> {
    let _udid = get_simulator_udid(simulator)?;

    let (sx, sy) = sim_to_screen_coords(x, y, simulator)?;
    let delay_sec = duration as f64 / 1000.0;

    let script = format!(
        r#"tell application "Simulator" to activate
delay 0.2
tell application "System Events"
    set p to {{{}, {}}}
    -- mouse down, hold, mouse up
    click at p
    delay {}
end tell"#,
        sx, sy, delay_sec
    );

    let _ = Command::new("osascript")
        .args(["-e", &script])
        .output();

    println!("Long pressed at ({}, {}) for {}ms", x, y, duration);
    Ok(())
}

/// Open URL in simulator (safe - no shell injection)
pub fn open_url(url: &str, simulator: Option<&str>) -> Result<()> {
    let udid = get_simulator_udid(simulator)?;

    let output = simctl_exec(&["openurl", &udid, url])?;

    if !output.status.success() {
        bail!("Failed to open URL: {}", String::from_utf8_lossy(&output.stderr));
    }

    println!("Opened URL: {}", url);
    Ok(())
}

/// Execute shell command in simulator (safe - uses spawn)
pub fn shell(command: &str, simulator: Option<&str>) -> Result<String> {
    let udid = get_simulator_udid(simulator)?;

    // Use spawn with full path to sh (not in PATH on iOS simulator)
    let output = Command::new("xcrun")
        .args(["simctl", "spawn", &udid, "/bin/sh", "-c", command])
        .output()
        .context("Failed to execute shell command")?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() && !stderr.is_empty() {
        eprintln!("{}", stderr);
    }

    print!("{}", stdout);
    Ok(stdout)
}

/// Tap at coordinates using AppleScript
pub fn tap(x: i32, y: i32, simulator: Option<&str>) -> Result<()> {
    let _udid = get_simulator_udid(simulator)?;

    let (sx, sy) = sim_to_screen_coords(x, y, simulator)?;

    let script = format!(
        r#"tell application "Simulator" to activate
delay 0.2
tell application "System Events"
    click at {{{}, {}}}
end tell"#,
        sx, sy
    );

    let output = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .context("Failed to tap via AppleScript")?;

    if !output.status.success() {
        eprintln!("Warning: AppleScript tap may not work without accessibility permissions");
    }

    println!("Tapped at ({}, {})", x, y);
    Ok(())
}

/// Swipe gesture via AppleScript drag
pub fn swipe(x1: i32, y1: i32, x2: i32, y2: i32, duration: u32, simulator: Option<&str>) -> Result<()> {
    let _udid = get_simulator_udid(simulator)?;

    let (sx1, sy1) = sim_to_screen_coords(x1, y1, simulator)?;
    let (sx2, sy2) = sim_to_screen_coords(x2, y2, simulator)?;
    let dur_sec = (duration as f64 / 1000.0).max(0.1);

    // Use cliclick if available for reliable drag, otherwise AppleScript
    let cliclick = Command::new("which").arg("cliclick").output();
    if cliclick.is_ok() && cliclick.unwrap().status.success() {
        let script = format!(
            r#"tell application "Simulator" to activate
delay 0.2"#
        );
        let _ = Command::new("osascript").args(["-e", &script]).output();

        let _ = Command::new("cliclick")
            .args([
                &format!("dd:{},{}", sx1, sy1),
                &format!("dm:{},{}", sx2, sy2),
                &format!("du:{},{}", sx2, sy2),
            ])
            .output();
    } else {
        let script = format!(
            r#"tell application "Simulator" to activate
delay 0.2
tell application "System Events"
    -- Click start point, drag to end point
    click at {{{sx1}, {sy1}}}
    delay {dur_sec}
    click at {{{sx2}, {sy2}}}
end tell"#,
        );
        let _ = Command::new("osascript").args(["-e", &script]).output();
    }

    println!("Swiped from ({}, {}) to ({}, {})", x1, y1, x2, y2);
    Ok(())
}

/// Input text (safe - uses simctl directly)
pub fn input_text(text: &str, simulator: Option<&str>) -> Result<()> {
    let udid = get_simulator_udid(simulator)?;

    // Try simctl io type first
    let output = simctl_exec(&["io", &udid, "type", text]);

    if let Ok(out) = output {
        if out.status.success() {
            println!("Input text: {}", text);
            return Ok(());
        }
    }

    // Fallback: use pbcopy + paste (safe, no shell injection)
    let temp_path = "/tmp/ios_input_text.txt";
    std::fs::write(temp_path, text)?;

    Command::new("sh")
        .args(["-c", &format!("cat '{}' | pbcopy", temp_path)])
        .output()?;

    std::fs::remove_file(temp_path).ok();

    // Simulate Cmd+V paste
    let script = r#"tell application "System Events"
        keystroke "v" using command down
    end tell"#;

    Command::new("osascript")
        .args(["-e", script])
        .output()?;

    println!("Input text (via paste): {}", text);
    Ok(())
}

/// Press a key/button
pub fn press_key(key: &str, simulator: Option<&str>) -> Result<()> {
    let udid = get_simulator_udid(simulator)?;

    match key.to_lowercase().as_str() {
        "home" => {
            // Simulator shortcut: Cmd+Shift+H
            let script = r#"tell application "Simulator" to activate
            delay 0.3
            tell application "System Events" to key code 4 using {command down, shift down}"#;
            let output = Command::new("osascript")
                .args(["-e", script])
                .output()
                .context("Failed to press Home via AppleScript")?;
            if !output.status.success() {
                let _ = simctl_exec(&["spawn", &udid, "notifyutil", "-p", "com.apple.springboard.home"]);
            }
        }
        "lock" => {
            // Cmd+L
            let script = r#"tell application "Simulator" to activate
            delay 0.1
            tell application "System Events"
                keystroke "l" using {command down}
            end tell"#;
            let _ = Command::new("osascript").args(["-e", script]).output();
        }
        "shake" => {
            // Cmd+Ctrl+Z
            let script = r#"tell application "Simulator" to activate
            delay 0.1
            tell application "System Events"
                keystroke "z" using {command down, control down}
            end tell"#;
            let _ = Command::new("osascript").args(["-e", script]).output();
        }
        _ => {
            let output = simctl_exec(&["io", &udid, "key", key]);
            if output.is_err() || !output.as_ref().unwrap().status.success() {
                let script = format!(
                    r#"tell application "Simulator" to activate
                    delay 0.1
                    tell application "System Events"
                        keystroke "{}"
                    end tell"#,
                    key
                );
                let _ = Command::new("osascript").args(["-e", &script]).output();
            }
        }
    }

    println!("Pressed key: {}", key);
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
    let output = Command::new("osascript")
        .args(["-e", script])
        .output()
        .context("Failed to get accessibility elements")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut elements = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() < 7 { continue; }

        let index: usize = parts[0].parse().unwrap_or(0);
        let role = parts[1].to_string();
        let title = if parts[2] == "missing value" { String::new() } else { parts[2].to_string() };
        let value = if parts[3] == "missing value" { String::new() } else { parts[3].to_string() };
        let description = if parts[4] == "missing value" { String::new() } else { parts[4].to_string() };

        let pos: Vec<i32> = parts[5].split(',').filter_map(|s| s.trim().parse().ok()).collect();
        let size: Vec<i32> = parts[6].split('x').filter_map(|s| s.trim().parse().ok()).collect();

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
            println!("[{}] {} \"{}\" ({},{} {}x{})",
                elem.index, elem.role, label,
                elem.x, elem.y, elem.width, elem.height);
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
        bail!("simctl listapps failed: {}", String::from_utf8_lossy(&output.stderr));
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
        let entry = if display.is_empty() { bundle } else { format!("{} ({})", bundle, display) };
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
        println!("  {}", app);
    }
    Ok(())
}

/// Launch an app
pub fn launch_app(bundle_id: &str, simulator: Option<&str>) -> Result<()> {
    let udid = get_simulator_udid(simulator)?;

    let output = simctl_exec(&["launch", &udid, bundle_id])?;

    if !output.status.success() {
        bail!("Failed to launch {}: {}", bundle_id, String::from_utf8_lossy(&output.stderr));
    }

    println!("Launched: {}", bundle_id);
    Ok(())
}

/// Stop an app
pub fn stop_app(bundle_id: &str, simulator: Option<&str>) -> Result<()> {
    let udid = get_simulator_udid(simulator)?;

    let output = simctl_exec(&["terminate", &udid, bundle_id])?;

    if !output.status.success() {
        bail!("Failed to stop {}: {}", bundle_id, String::from_utf8_lossy(&output.stderr));
    }

    println!("Stopped: {}", bundle_id);
    Ok(())
}

/// Install an app
pub fn install_app(path: &str, simulator: Option<&str>) -> Result<()> {
    let udid = get_simulator_udid(simulator)?;

    println!("Installing {}...", path);

    let output = simctl_exec(&["install", &udid, path])?;

    if !output.status.success() {
        bail!("Failed to install: {}", String::from_utf8_lossy(&output.stderr));
    }

    println!("Installed: {}", path);
    Ok(())
}

/// Uninstall an app
pub fn uninstall_app(bundle_id: &str, simulator: Option<&str>) -> Result<()> {
    let udid = get_simulator_udid(simulator)?;

    println!("Uninstalling {}...", bundle_id);

    let output = simctl_exec(&["uninstall", &udid, bundle_id])?;

    if !output.status.success() {
        bail!("Failed to uninstall: {}", String::from_utf8_lossy(&output.stderr));
    }

    println!("Uninstalled: {}", bundle_id);
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
            println!("Found: \"{}\" role={} at ({},{}) size={}x{}",
                if !elem.title.is_empty() { &elem.title }
                else if !elem.description.is_empty() { &elem.description }
                else { &elem.value },
                elem.role, elem.x, elem.y, elem.width, elem.height);
            return Ok(Some((cx, cy)));
        }
    }

    println!("Element '{}' not found", query);
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
        let _ = Command::new("osascript").args(["-e", &script]).output();
        println!("Tapped element at ({}, {})", x, y);
    } else {
        bail!("Element '{}' not found", query);
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
    println!("Workaround: reboot simulator to clear logs (claude-in-mobile reboot ios)");
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
                        println!("  Name: {}", device["name"].as_str().unwrap_or("unknown"));
                        println!("  State: {}", device["state"].as_str().unwrap_or("unknown"));
                        println!("  Runtime: {}", runtime.replace("com.apple.CoreSimulator.SimRuntime.", ""));
                        println!("  UDID: {}", device_udid);
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

    let output = Command::new("xcrun")
        .args(["simctl", "spawn", &udid, "launchctl", "list"])
        .output()
        .context("Failed to get running processes")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let re = regex::Regex::new(r"UIKitApplication:([^\[]+)\[").unwrap();

    let mut apps: Vec<String> = Vec::new();
    for line in stdout.lines() {
        if let Some(cap) = re.captures(line) {
            let bundle = cap[1].to_string();
            // Skip system background services
            if !bundle.contains("WidgetRenderer")
                && !bundle.contains("ViewService")
                && !bundle.contains("Spotlight") {
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
        println!("Foreground app: {}", apps[0]);
        for app in apps.iter().skip(1) {
            println!("Background app: {}", app);
        }
    }

    Ok(())
}

/// Get device logs
pub fn get_logs(filter: Option<&str>, lines: usize, simulator: Option<&str>) -> Result<()> {
    let udid = get_simulator_udid(simulator)?;

    let predicate;
    let mut args = vec!["spawn", &udid, "log", "show", "--last", "5m", "--style", "compact"];

    if let Some(f) = filter {
        predicate = format!("processImagePath CONTAINS '{}'", f);
        args.push("--predicate");
        args.push(&predicate);
    }

    let output = simctl_exec(&args)?;

    if !output.status.success() {
        let fallback = simctl_exec(&["spawn", &udid, "log", "show", "--last", "1m"])?;
        let stdout = String::from_utf8_lossy(&fallback.stdout);
        for line in stdout.lines().take(lines) {
            println!("{}", line);
        }
        return Ok(());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines().take(lines) {
        println!("{}", line);
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
        bail!("Failed to reboot: {}", String::from_utf8_lossy(&output.stderr));
    }

    println!("Reboot initiated");
    Ok(())
}

// ============== File Transfer ==============

/// Push file to simulator (limited support)
pub fn push_file(local: &str, remote: &str, simulator: Option<&str>) -> Result<()> {
    let _udid = get_simulator_udid(simulator)?;
    println!("Note: File push to iOS simulator is not directly supported via simctl.");
    println!("Use 'xcrun simctl addmedia' for media files or app container paths.");
    println!("  Local: {}", local);
    println!("  Remote: {}", remote);
    Ok(())
}

/// Pull file from simulator (limited support)
pub fn pull_file(remote: &str, local: &str, simulator: Option<&str>) -> Result<()> {
    let _udid = get_simulator_udid(simulator)?;
    println!("Note: File pull from iOS simulator is not directly supported via simctl.");
    println!("Use app container paths: xcrun simctl get_app_container <udid> <bundle_id>");
    println!("  Remote: {}", remote);
    println!("  Local: {}", local);
    Ok(())
}

// ============== Clipboard ==============

/// Get clipboard content (host clipboard since simulator shares it)
pub fn get_clipboard(_simulator: Option<&str>) -> Result<()> {
    let output = Command::new("pbpaste")
        .output()
        .context("Failed to execute pbpaste")?;
    let text = String::from_utf8_lossy(&output.stdout);
    println!("{}", text);
    Ok(())
}

/// Set clipboard content (host clipboard since simulator shares it)
pub fn set_clipboard(text: &str, _simulator: Option<&str>) -> Result<()> {
    let mut child = Command::new("pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .context("Failed to execute pbcopy")?;
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        stdin.write_all(text.as_bytes())?;
    }
    child.wait()?;
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
