//! Android device automation via ADB

use std::process::Command;
use std::sync::OnceLock;
use std::time::Duration;
use anyhow::{Result, Context, bail};
use regex::Regex;
use serde::Serialize;

// Compiled regexes (created once, reused)
fn node_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"<node\s+[^>]+>"#).unwrap())
}

fn class_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"class="([^"]*)""#).unwrap())
}

fn text_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"text="([^"]*)""#).unwrap())
}

fn resource_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"resource-id="([^"]*)""#).unwrap())
}

fn content_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"content-desc="([^"]*)""#).unwrap())
}

fn bounds_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]""#).unwrap())
}

fn bounds_string_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"bounds="([^"]*)""#).unwrap())
}

fn clickable_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"clickable="([^"]*)""#).unwrap())
}

/// Build ADB command with optional device serial
fn adb_cmd(device: Option<&str>) -> Command {
    let mut cmd = Command::new("adb");
    if let Some(serial) = device {
        cmd.arg("-s").arg(serial);
    }
    cmd
}

/// Execute ADB command with timeout
fn adb_exec(device: Option<&str>, args: &[&str], timeout: Option<Duration>) -> Result<std::process::Output> {
    let mut cmd = adb_cmd(device);
    cmd.args(args);

    if let Some(_t) = timeout {
        // For now, just execute without timeout
        // Full timeout support would require tokio or similar
        cmd.output().context("Failed to execute adb command")
    } else {
        cmd.output().context("Failed to execute adb command")
    }
}

/// Take screenshot and return PNG bytes
pub fn screenshot(device: Option<&str>) -> Result<Vec<u8>> {
    let output = adb_exec(device, &["exec-out", "screencap", "-p"], None)?;

    if !output.status.success() {
        bail!("adb screencap failed: {}", String::from_utf8_lossy(&output.stderr));
    }

    Ok(output.stdout)
}

/// Tap at coordinates
pub fn tap(x: i32, y: i32, device: Option<&str>) -> Result<()> {
    let output = adb_exec(device, &["shell", "input", "tap", &x.to_string(), &y.to_string()], None)?;

    if !output.status.success() {
        bail!("adb tap failed: {}", String::from_utf8_lossy(&output.stderr));
    }

    println!("Tapped at ({}, {})", x, y);
    Ok(())
}

/// Long press at coordinates
pub fn long_press(x: i32, y: i32, duration: u32, device: Option<&str>) -> Result<()> {
    let output = adb_exec(device, &[
        "shell", "input", "swipe",
        &x.to_string(), &y.to_string(),
        &x.to_string(), &y.to_string(),
        &duration.to_string(),
    ], None)?;

    if !output.status.success() {
        bail!("adb long press failed: {}", String::from_utf8_lossy(&output.stderr));
    }

    println!("Long pressed at ({}, {}) for {}ms", x, y, duration);
    Ok(())
}

/// Open URL in default browser
pub fn open_url(url: &str, device: Option<&str>) -> Result<()> {
    let output = adb_exec(device, &["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url], None)?;

    if !output.status.success() {
        bail!("Failed to open URL: {}", String::from_utf8_lossy(&output.stderr));
    }

    println!("Opened URL: {}", url);
    Ok(())
}

/// Execute shell command on device
pub fn shell(command: &str, device: Option<&str>) -> Result<String> {
    let output = adb_exec(device, &["shell", command], None)?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() && !stderr.is_empty() {
        eprintln!("{}", stderr);
    }

    print!("{}", stdout);
    Ok(stdout)
}

/// Swipe gesture
pub fn swipe(x1: i32, y1: i32, x2: i32, y2: i32, duration: u32, device: Option<&str>) -> Result<()> {
    let output = adb_exec(device, &[
        "shell", "input", "swipe",
        &x1.to_string(), &y1.to_string(),
        &x2.to_string(), &y2.to_string(),
        &duration.to_string(),
    ], None)?;

    if !output.status.success() {
        bail!("adb swipe failed: {}", String::from_utf8_lossy(&output.stderr));
    }

    println!("Swiped from ({}, {}) to ({}, {})", x1, y1, x2, y2);
    Ok(())
}

/// Input text (with proper escaping)
pub fn input_text(text: &str, device: Option<&str>) -> Result<()> {
    // Escape special characters for shell
    let escaped = text
        .replace('\\', "\\\\")
        .replace(' ', "%s")
        .replace('\'', "\\'")
        .replace('"', "\\\"")
        .replace('&', "\\&")
        .replace('|', "\\|")
        .replace(';', "\\;")
        .replace('$', "\\$")
        .replace('`', "\\`");

    let output = adb_exec(device, &["shell", "input", "text", &escaped], None)?;

    if !output.status.success() {
        bail!("adb input text failed: {}", String::from_utf8_lossy(&output.stderr));
    }

    println!("Input text: {}", text);
    Ok(())
}

/// Press a key
pub fn press_key(key: &str, device: Option<&str>) -> Result<()> {
    let keycode = match key.to_lowercase().as_str() {
        "home" => "KEYCODE_HOME",
        "back" => "KEYCODE_BACK",
        "enter" | "return" => "KEYCODE_ENTER",
        "tab" => "KEYCODE_TAB",
        "delete" | "backspace" => "KEYCODE_DEL",
        "menu" => "KEYCODE_MENU",
        "power" => "KEYCODE_POWER",
        "volume_up" => "KEYCODE_VOLUME_UP",
        "volume_down" => "KEYCODE_VOLUME_DOWN",
        "camera" => "KEYCODE_CAMERA",
        "search" => "KEYCODE_SEARCH",
        "space" => "KEYCODE_SPACE",
        "escape" | "esc" => "KEYCODE_ESCAPE",
        "up" => "KEYCODE_DPAD_UP",
        "down" => "KEYCODE_DPAD_DOWN",
        "left" => "KEYCODE_DPAD_LEFT",
        "right" => "KEYCODE_DPAD_RIGHT",
        "app_switch" | "recent" => "KEYCODE_APP_SWITCH",
        _ => key,
    };

    let output = adb_exec(device, &["shell", "input", "keyevent", keycode], None)?;

    if !output.status.success() {
        bail!("adb keyevent failed: {}", String::from_utf8_lossy(&output.stderr));
    }

    println!("Pressed key: {} ({})", key, keycode);
    Ok(())
}

// ============== UI Dump (shared implementation) ==============

/// Get raw UI XML from device
fn get_ui_xml(device: Option<&str>) -> Result<String> {
    // Combined command: dump + cat + cleanup in one shell call
    let output = adb_exec(device, &[
        "shell",
        "uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 && cat /sdcard/ui.xml && rm /sdcard/ui.xml"
    ], None)?;

    if !output.status.success() {
        bail!("Failed to get UI dump: {}", String::from_utf8_lossy(&output.stderr));
    }

    let xml = String::from_utf8_lossy(&output.stdout).to_string();
    if xml.is_empty() || !xml.contains("<hierarchy") {
        bail!("UI dump returned empty or invalid XML");
    }

    Ok(xml)
}

/// UI Element with parsed bounds
#[derive(Clone, Debug, Serialize)]
pub struct UiElement {
    pub class: String,
    pub text: String,
    pub resource_id: String,
    pub content_desc: String,
    pub bounds: (i32, i32, i32, i32),
    pub clickable: bool,
}

impl UiElement {
    pub fn center(&self) -> (i32, i32) {
        ((self.bounds.0 + self.bounds.2) / 2, (self.bounds.1 + self.bounds.3) / 2)
    }

    pub fn label(&self) -> String {
        if !self.text.is_empty() {
            self.text.clone()
        } else if !self.content_desc.is_empty() {
            self.content_desc.clone()
        } else if !self.resource_id.is_empty() {
            self.resource_id.split('/').last().unwrap_or("").to_string()
        } else {
            self.class.split('.').last().unwrap_or("").to_string()
        }
    }

    #[allow(dead_code)]
    pub fn width(&self) -> i32 {
        self.bounds.2 - self.bounds.0
    }

    #[allow(dead_code)]
    pub fn height(&self) -> i32 {
        self.bounds.3 - self.bounds.1
    }
}

/// Parse UI XML into elements
fn parse_ui_elements(xml: &str) -> Vec<UiElement> {
    let mut elements = Vec::new();

    for node in node_regex().find_iter(xml) {
        let node_str = node.as_str();

        let class = class_regex().captures(node_str)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();

        let text = text_regex().captures(node_str)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();

        let resource_id = resource_regex().captures(node_str)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();

        let content_desc = content_regex().captures(node_str)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();

        let bounds = if let Some(caps) = bounds_regex().captures(node_str) {
            (
                caps[1].parse().unwrap_or(0),
                caps[2].parse().unwrap_or(0),
                caps[3].parse().unwrap_or(0),
                caps[4].parse().unwrap_or(0),
            )
        } else {
            continue;
        };

        let clickable = clickable_regex().captures(node_str)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str() == "true")
            .unwrap_or(false);

        if !class.is_empty() && (clickable || !text.is_empty() || !content_desc.is_empty()) {
            elements.push(UiElement {
                class,
                text,
                resource_id,
                content_desc,
                bounds,
                clickable,
            });
        }
    }

    elements
}

/// Get UI elements as structured data
pub fn get_ui_elements(device: Option<&str>) -> Result<Vec<UiElement>> {
    let xml = get_ui_xml(device)?;
    Ok(parse_ui_elements(&xml))
}

/// Dump UI hierarchy
pub fn ui_dump(format: &str, device: Option<&str>) -> Result<()> {
    let xml = get_ui_xml(device)?;

    if format == "json" {
        println!("{}", xml_to_json(&xml)?);
    } else {
        println!("{}", xml);
    }

    Ok(())
}

/// Convert UI XML to simplified JSON
fn xml_to_json(xml: &str) -> Result<String> {
    #[derive(Serialize)]
    struct UiElementJson {
        class: String,
        #[serde(skip_serializing_if = "String::is_empty")]
        text: String,
        #[serde(skip_serializing_if = "String::is_empty")]
        resource_id: String,
        #[serde(skip_serializing_if = "String::is_empty")]
        content_desc: String,
        bounds: String,
        clickable: bool,
    }

    let mut elements = Vec::new();

    for node in node_regex().find_iter(xml) {
        let node_str = node.as_str();

        let class = class_regex().captures(node_str)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();

        let text = text_regex().captures(node_str)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();

        let resource_id = resource_regex().captures(node_str)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();

        let content_desc = content_regex().captures(node_str)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();

        let bounds = bounds_string_regex().captures(node_str)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();

        let clickable = clickable_regex().captures(node_str)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str() == "true")
            .unwrap_or(false);

        if !class.is_empty() && !bounds.is_empty() {
            elements.push(UiElementJson {
                class,
                text,
                resource_id,
                content_desc,
                bounds,
                clickable,
            });
        }
    }

    Ok(serde_json::to_string_pretty(&elements)?)
}

// ============== Element Finding ==============

/// Find element by text/resource-id and return center coordinates
pub fn find_element(query: &str, device: Option<&str>) -> Result<Option<(i32, i32)>> {
    let xml = get_ui_xml(device)?;
    let query_lower = query.to_lowercase();

    for node in node_regex().find_iter(&xml) {
        let node_str = node.as_str();

        let text = text_regex().captures(node_str)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str())
            .unwrap_or("");

        let resource_id = resource_regex().captures(node_str)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str())
            .unwrap_or("");

        let content_desc = content_regex().captures(node_str)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str())
            .unwrap_or("");

        let matches = text.to_lowercase().contains(&query_lower)
            || resource_id.to_lowercase().contains(&query_lower)
            || content_desc.to_lowercase().contains(&query_lower);

        if matches {
            if let Some(caps) = bounds_regex().captures(node_str) {
                let x1: i32 = caps[1].parse().unwrap_or(0);
                let y1: i32 = caps[2].parse().unwrap_or(0);
                let x2: i32 = caps[3].parse().unwrap_or(0);
                let y2: i32 = caps[4].parse().unwrap_or(0);

                let center_x = (x1 + x2) / 2;
                let center_y = (y1 + y2) / 2;

                println!("Found: text=\"{}\" resource_id=\"{}\" content_desc=\"{}\"", text, resource_id, content_desc);
                println!("Bounds: [{},{}][{},{}] -> center: ({}, {})", x1, y1, x2, y2, center_x, center_y);

                return Ok(Some((center_x, center_y)));
            }
        }
    }

    println!("Element with '{}' not found", query);
    Ok(None)
}

/// Find a UI element matching any of the supplied criteria.
///
/// All supplied criteria must match (logical AND). Matching is case-insensitive
/// and partial (contains). Returns a human-readable description of the first
/// matching element, or `None` if no element satisfies all criteria.
///
/// This is the shared primitive used by `ui-wait`, `ui-assert-visible`, and
/// `ui-assert-gone`.
pub fn find_ui_element(
    text: Option<&str>,
    resource_id: Option<&str>,
    class_name: Option<&str>,
    device: Option<&str>,
) -> Result<Option<String>> {
    let xml = get_ui_xml(device)?;

    let text_q = text.map(|s| s.to_lowercase());
    let res_q = resource_id.map(|s| s.to_lowercase());
    let class_q = class_name.map(|s| s.to_lowercase());

    for node in node_regex().find_iter(&xml) {
        let node_str = node.as_str();

        if let Some(ref q) = text_q {
            let elem_text = text_regex().captures(node_str)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str().to_lowercase())
                .unwrap_or_default();
            let elem_desc = content_regex().captures(node_str)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str().to_lowercase())
                .unwrap_or_default();
            if !elem_text.contains(q.as_str()) && !elem_desc.contains(q.as_str()) {
                continue;
            }
        }

        if let Some(ref q) = res_q {
            let elem_res = resource_regex().captures(node_str)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str().to_lowercase())
                .unwrap_or_default();
            if !elem_res.contains(q.as_str()) {
                continue;
            }
        }

        if let Some(ref q) = class_q {
            let elem_class = class_regex().captures(node_str)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str().to_lowercase())
                .unwrap_or_default();
            if !elem_class.contains(q.as_str()) {
                continue;
            }
        }

        // All provided criteria matched — build a description string
        let elem_text = text_regex().captures(node_str)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str())
            .unwrap_or("");
        let elem_res = resource_regex().captures(node_str)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str())
            .unwrap_or("");
        let elem_class = class_regex().captures(node_str)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str())
            .unwrap_or("");
        let elem_bounds = bounds_string_regex().captures(node_str)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str())
            .unwrap_or("");

        let desc = format!(
            "class=\"{}\" text=\"{}\" resource_id=\"{}\" bounds={}",
            elem_class, elem_text, elem_res, elem_bounds
        );
        return Ok(Some(desc));
    }

    Ok(None)
}

/// Tap element by text/resource-id
pub fn tap_element(query: &str, device: Option<&str>) -> Result<()> {
    if let Some((x, y)) = find_element(query, device)? {
        tap(x, y, device)?;
    } else {
        bail!("Element '{}' not found", query);
    }
    Ok(())
}

// ============== Device Management ==============

#[derive(Serialize)]
pub struct Device {
    pub serial: String,
    pub state: String,
    pub model: Option<String>,
}

/// List connected devices
pub fn list_devices() -> Result<Vec<Device>> {
    let output = Command::new("adb")
        .args(["devices", "-l"])
        .output()
        .context("Failed to execute adb devices")?;

    if !output.status.success() {
        bail!("adb devices failed: {}", String::from_utf8_lossy(&output.stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut devices = Vec::new();

    for line in stdout.lines().skip(1) {
        if line.trim().is_empty() {
            continue;
        }

        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 2 {
            let model = parts.iter()
                .find(|p| p.starts_with("model:"))
                .map(|p| p.trim_start_matches("model:").to_string());

            devices.push(Device {
                serial: parts[0].to_string(),
                state: parts[1].to_string(),
                model,
            });
        }
    }

    Ok(devices)
}

/// Print devices list
pub fn print_devices() -> Result<()> {
    let devices = list_devices()?;
    println!("Android devices:");
    println!("{}", serde_json::to_string_pretty(&devices)?);
    Ok(())
}

// ============== App Management ==============

/// List installed apps
pub fn list_apps(filter: Option<&str>, device: Option<&str>) -> Result<()> {
    let output = adb_exec(device, &["shell", "pm", "list", "packages", "-3"], None)?;

    if !output.status.success() {
        bail!("pm list packages failed: {}", String::from_utf8_lossy(&output.stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut apps: Vec<String> = stdout
        .lines()
        .filter_map(|line| line.strip_prefix("package:"))
        .filter(|pkg| {
            filter.map_or(true, |f| pkg.to_lowercase().contains(&f.to_lowercase()))
        })
        .map(|s| s.to_string())
        .collect();

    apps.sort();

    println!("Installed apps ({}):", apps.len());
    for app in &apps {
        println!("  {}", app);
    }
    Ok(())
}

/// Launch an app (using am start for speed)
pub fn launch_app(package: &str, device: Option<&str>) -> Result<()> {
    // Resolve launcher activity and start in one shell call
    let cmd = format!(
        "am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER \
         $(cmd package resolve-activity --brief -c android.intent.category.LAUNCHER {} | tail -1)",
        package
    );

    let output = adb_exec(device, &["shell", &cmd], None)?;

    if !output.status.success() {
        // Fallback to monkey if resolve-activity fails (older Android)
        let fallback = adb_exec(device, &[
            "shell", "monkey", "-p", package,
            "-c", "android.intent.category.LAUNCHER", "1"
        ], None)?;

        if !fallback.status.success() {
            bail!("Failed to launch {}", package);
        }
    }

    println!("Launched: {}", package);
    Ok(())
}

/// Stop an app
pub fn stop_app(package: &str, device: Option<&str>) -> Result<()> {
    let output = adb_exec(device, &["shell", "am", "force-stop", package], None)?;

    if !output.status.success() {
        bail!("Failed to stop {}: {}", package, String::from_utf8_lossy(&output.stderr));
    }

    println!("Stopped: {}", package);
    Ok(())
}

/// Install an APK
pub fn install_app(path: &str, device: Option<&str>) -> Result<()> {
    println!("Installing {}...", path);

    let output = adb_exec(device, &["install", "-r", path], None)?;

    if !output.status.success() {
        bail!("Failed to install: {}", String::from_utf8_lossy(&output.stderr));
    }

    println!("Installed: {}", path);
    Ok(())
}

/// Uninstall an app
pub fn uninstall_app(package: &str, device: Option<&str>) -> Result<()> {
    println!("Uninstalling {}...", package);

    let output = adb_exec(device, &["uninstall", package], None)?;

    if !output.status.success() {
        bail!("Failed to uninstall: {}", String::from_utf8_lossy(&output.stderr));
    }

    println!("Uninstalled: {}", package);
    Ok(())
}

// ============== System Commands ==============

/// Clear device logs
pub fn clear_logs(device: Option<&str>) -> Result<()> {
    let output = adb_exec(device, &["logcat", "-c"], None)?;

    if !output.status.success() {
        bail!("logcat clear failed: {}", String::from_utf8_lossy(&output.stderr));
    }

    println!("Logs cleared");
    Ok(())
}

/// Get system info (battery, memory)
pub fn get_system_info(device: Option<&str>) -> Result<()> {
    let battery = adb_exec(device, &["shell", "dumpsys", "battery"], None)?;
    let battery_out = String::from_utf8_lossy(&battery.stdout);

    let mut battery_level = "unknown".to_string();
    let mut battery_status = "unknown".to_string();
    for line in battery_out.lines() {
        if line.contains("level:") {
            battery_level = line.split(':').nth(1).unwrap_or("").trim().to_string();
        }
        if line.contains("status:") {
            let status_code = line.split(':').nth(1).unwrap_or("").trim();
            battery_status = match status_code {
                "1" => "Unknown",
                "2" => "Charging",
                "3" => "Discharging",
                "4" => "Not charging",
                "5" => "Full",
                _ => status_code,
            }.to_string();
        }
    }

    let meminfo = adb_exec(device, &["shell", "cat", "/proc/meminfo"], None)?;
    let mem_out = String::from_utf8_lossy(&meminfo.stdout);
    let mut mem_total = "unknown".to_string();
    let mut mem_available = "unknown".to_string();
    for line in mem_out.lines() {
        if line.starts_with("MemTotal:") {
            mem_total = line.split_whitespace().nth(1).unwrap_or("").to_string();
        }
        if line.starts_with("MemAvailable:") {
            mem_available = line.split_whitespace().nth(1).unwrap_or("").to_string();
        }
    }

    println!("System Info:");
    println!("  Battery: {}% ({})", battery_level, battery_status);
    println!("  Memory: {} kB available / {} kB total", mem_available, mem_total);

    Ok(())
}

/// Get current activity/app
pub fn get_current_activity(device: Option<&str>) -> Result<()> {
    let output = adb_exec(device, &["shell", "dumpsys", "window"], None)?;
    let out = String::from_utf8_lossy(&output.stdout);

    for line in out.lines() {
        if line.contains("mCurrentFocus") || line.contains("mFocusedApp") {
            println!("{}", line.trim());
        }
    }

    Ok(())
}

/// Get device logs
pub fn get_logs(filter: Option<&str>, lines: usize, device: Option<&str>) -> Result<()> {
    let lines_str = lines.to_string();
    let mut args = vec!["logcat", "-d", "-t", &lines_str];

    if let Some(f) = filter {
        args.push("-s");
        args.push(f);
    }

    let output = adb_exec(device, &args, None)?;

    if !output.status.success() {
        bail!("logcat failed: {}", String::from_utf8_lossy(&output.stderr));
    }

    print!("{}", String::from_utf8_lossy(&output.stdout));
    Ok(())
}

/// Reboot device
pub fn reboot(device: Option<&str>) -> Result<()> {
    println!("Rebooting device...");
    let output = adb_exec(device, &["reboot"], None)?;

    if !output.status.success() {
        bail!("Failed to reboot: {}", String::from_utf8_lossy(&output.stderr));
    }

    println!("Reboot initiated");
    Ok(())
}

/// Turn screen on/off
pub fn screen_power(on: bool, device: Option<&str>) -> Result<()> {
    // First check screen state
    let output = adb_exec(device, &["shell", "dumpsys", "power"], None)?;
    let power_out = String::from_utf8_lossy(&output.stdout);

    let is_screen_on = power_out.contains("mWakefulness=Awake") ||
                       power_out.contains("Display Power: state=ON");

    if on && !is_screen_on {
        // Turn screen on
        adb_exec(device, &["shell", "input", "keyevent", "KEYCODE_WAKEUP"], None)?;
        println!("Screen turned ON");
    } else if !on && is_screen_on {
        // Turn screen off
        adb_exec(device, &["shell", "input", "keyevent", "KEYCODE_SLEEP"], None)?;
        println!("Screen turned OFF");
    } else {
        println!("Screen is already {}", if on { "ON" } else { "OFF" });
    }

    Ok(())
}

/// Get screen resolution
pub fn get_screen_size(device: Option<&str>) -> Result<(u32, u32)> {
    let output = adb_exec(device, &["shell", "wm", "size"], None)?;
    let out = String::from_utf8_lossy(&output.stdout);

    // Parse "Physical size: 1080x2400"
    for line in out.lines() {
        if line.contains("Physical size:") || line.contains("Override size:") {
            if let Some(size) = line.split(':').nth(1) {
                let parts: Vec<&str> = size.trim().split('x').collect();
                if parts.len() == 2 {
                    let w: u32 = parts[0].parse().unwrap_or(1080);
                    let h: u32 = parts[1].parse().unwrap_or(1920);
                    return Ok((w, h));
                }
            }
        }
    }

    Ok((1080, 1920)) // Default fallback
}

/// Analyze screen and return structured element categories
pub fn analyze_screen(device: Option<&str>) -> Result<()> {
    let elements = get_ui_elements(device)?;

    #[derive(Serialize)]
    struct ScreenAnalysis {
        buttons: Vec<ElementInfo>,
        inputs: Vec<ElementInfo>,
        texts: Vec<ElementInfo>,
        scrollable: Vec<ElementInfo>,
        images: Vec<ElementInfo>,
    }

    #[derive(Serialize)]
    struct ElementInfo {
        label: String,
        center: (i32, i32),
        bounds: (i32, i32, i32, i32),
        resource_id: String,
    }

    let mut analysis = ScreenAnalysis {
        buttons: vec![],
        inputs: vec![],
        texts: vec![],
        scrollable: vec![],
        images: vec![],
    };

    for elem in &elements {
        let info = ElementInfo {
            label: elem.label(),
            center: elem.center(),
            bounds: elem.bounds,
            resource_id: elem.resource_id.clone(),
        };

        let class_lower = elem.class.to_lowercase();
        if class_lower.contains("button") || (elem.clickable && !class_lower.contains("layout")) {
            analysis.buttons.push(info);
        } else if class_lower.contains("edittext") || class_lower.contains("input") {
            analysis.inputs.push(info);
        } else if class_lower.contains("textview") || class_lower.contains("text") {
            analysis.texts.push(info);
        } else if class_lower.contains("scroll") || class_lower.contains("recycler") || class_lower.contains("listview") {
            analysis.scrollable.push(info);
        } else if class_lower.contains("image") {
            analysis.images.push(info);
        }
    }

    println!("{}", serde_json::to_string_pretty(&analysis)?);
    Ok(())
}

/// Find element by fuzzy description and tap it
pub fn find_and_tap(description: &str, min_confidence: u32, device: Option<&str>) -> Result<()> {
    let elements = get_ui_elements(device)?;
    let desc_lower = description.to_lowercase();

    let mut best_score: u32 = 0;
    let mut best_element: Option<&UiElement> = None;

    for elem in &elements {
        let mut score: u32 = 0;
        let text_lower = elem.text.to_lowercase();
        let content_lower = elem.content_desc.to_lowercase();
        let res_lower = elem.resource_id.to_lowercase().replace('_', " ").replace('/', " ");

        // Exact text match
        if text_lower == desc_lower {
            score = score.max(100);
        }
        // Exact content-desc match
        if content_lower == desc_lower {
            score = score.max(95);
        }
        // Text contains description
        if !text_lower.is_empty() && text_lower.contains(&desc_lower) {
            score = score.max(80);
        }
        // Content-desc contains description
        if !content_lower.is_empty() && content_lower.contains(&desc_lower) {
            score = score.max(75);
        }
        // Resource-id contains description
        if !res_lower.is_empty() && res_lower.contains(&desc_lower) {
            score = score.max(60);
        }
        // Word match in text (words longer than 2 chars)
        for word in desc_lower.split_whitespace() {
            if word.len() > 2 && text_lower.contains(word) {
                score = score.max(40);
            }
            if word.len() > 2 && content_lower.contains(word) {
                score = score.max(35);
            }
        }

        // Bonus for clickable
        if score > 0 && elem.clickable {
            score = (score + 10).min(100);
        }

        if score > best_score {
            best_score = score;
            best_element = Some(elem);
        }
    }

    if best_score >= min_confidence {
        if let Some(elem) = best_element {
            let (cx, cy) = elem.center();
            println!("Found: \"{}\" (confidence: {}%)", elem.label(), best_score);
            tap(cx, cy, device)?;
            return Ok(());
        }
    }

    bail!("No element matching '{}' found with confidence >= {}%", description, min_confidence);
}

/// Push file to device
pub fn push_file(local: &str, remote: &str, device: Option<&str>) -> Result<()> {
    let output = adb_exec(device, &["push", local, remote], None)?;
    if !output.status.success() {
        bail!("adb push failed: {}", String::from_utf8_lossy(&output.stderr));
    }
    println!("Pushed {} -> {}", local, remote);
    Ok(())
}

/// Pull file from device
pub fn pull_file(remote: &str, local: &str, device: Option<&str>) -> Result<()> {
    let output = adb_exec(device, &["pull", remote, local], None)?;
    if !output.status.success() {
        bail!("adb pull failed: {}", String::from_utf8_lossy(&output.stderr));
    }
    println!("Pulled {} -> {}", remote, local);
    Ok(())
}

/// Get clipboard content
pub fn get_clipboard(device: Option<&str>) -> Result<()> {
    let output = adb_exec(device, &["shell", "service", "call", "clipboard", "2", "s16", "com.android.shell"], None)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Parse parcel response - extract string between single quotes
    if let Some(start) = stdout.find('\'') {
        if let Some(end) = stdout[start+1..].find('\'') {
            let text = &stdout[start+1..start+1+end];
            println!("{}", text.replace("\\n", "\n"));
            return Ok(());
        }
    }
    println!("{}", stdout);
    Ok(())
}

/// Set clipboard content
pub fn set_clipboard(text: &str, device: Option<&str>) -> Result<()> {
    let cmd = format!("am broadcast -a clipper.set -e text '{}'", text.replace('\'', "'\\''"));
    let output = adb_exec(device, &["shell", &cmd], None)?;
    if !output.status.success() {
        // Fallback: try input method
        let _ = adb_exec(device, &["shell", "service", "call", "clipboard", "1", "s16", "com.android.shell", "s16", text], None)?;
    }
    println!("Clipboard set");
    Ok(())
}

/// Execute an action command + UI dump in a single adb shell invocation (turbo fast-track).
/// Returns (action_output, ui_xml). ui_xml may be empty if dump failed.
pub fn exec_with_ui_dump(shell_cmd: &str, device: Option<&str>) -> Result<(String, String)> {
    let combined = format!("{} && uiautomator dump /dev/tty", shell_cmd);
    let output = adb_exec(device, &["shell", &combined], None)?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();

    // Split at XML boundary
    let xml_start = stdout.find("<?xml").or_else(|| stdout.find("<hierarchy"));
    match xml_start {
        Some(idx) => {
            let action_output = stdout[..idx].trim().to_string();
            let mut ui_xml = stdout[idx..].to_string();
            // Strip "UI hierachy dumped to: /dev/tty" prefix if present before <?xml
            if let Some(xml_idx) = ui_xml.find("<?xml") {
                if xml_idx > 0 {
                    ui_xml = ui_xml[xml_idx..].to_string();
                }
            }
            Ok((action_output, ui_xml))
        }
        None => Ok((stdout.trim().to_string(), String::new())),
    }
}

/// Parse UI XML into compact one-line summary of interactive elements (reused by turbo fast-track).
pub fn compact_ui_from_xml(xml: &str) -> String {
    let elements = parse_ui_elements(xml);
    let parts: Vec<String> = elements
        .iter()
        .take(20)
        .map(|e| {
            let short_class = e.class.split('.').last().unwrap_or(&e.class);
            if !e.text.is_empty() {
                format!("{} \"{}\"", short_class, e.text)
            } else if !e.content_desc.is_empty() {
                format!("{} \"{}\"", short_class, e.content_desc)
            } else {
                short_class.to_string()
            }
        })
        .collect();
    parts.join(" | ")
}

// ============== Sensor Commands ==============

/// Set mock GPS location on emulator or physical device.
/// On emulator: uses `emu geo fix`. On physical device: broadcasts a mock location.
pub fn sensor_location(latitude: f64, longitude: f64, altitude: f64, device: Option<&str>) -> Result<()> {
    // Detect if this is an emulator by checking the device serial prefix
    let is_emulator = device
        .map(|d| d.starts_with("emulator-"))
        .unwrap_or_else(|| {
            adb_exec(device, &["shell", "getprop", "ro.build.characteristics"], None)
                .map(|o| String::from_utf8_lossy(&o.stdout).contains("emulator"))
                .unwrap_or(false)
        });

    if is_emulator {
        // `emu geo fix <lon> <lat> [<alt>]` — note: longitude before latitude in emu command
        let cmd = format!("emu geo fix {} {} {}", longitude, latitude, altitude);
        let output = adb_exec(device, &["shell", &cmd], None)?;
        if !output.status.success() {
            bail!("emu geo fix failed: {}", String::from_utf8_lossy(&output.stderr));
        }
    } else {
        // Broadcast a mock location to any registered listener
        let cmd = format!(
            "am broadcast -a com.android.shell.action.MOCK_LOCATION \
             --ef latitude {} --ef longitude {} --ef altitude {}",
            latitude, longitude, altitude
        );
        let output = adb_exec(device, &["shell", &cmd], None)?;
        if !output.status.success() {
            bail!("Mock location broadcast failed: {}", String::from_utf8_lossy(&output.stderr));
        }
    }

    println!("Location set: lat={}, lon={}, alt={}", latitude, longitude, altitude);
    Ok(())
}

/// Manipulate battery state via `dumpsys battery set`.
pub fn sensor_battery(
    level: Option<u8>,
    status: Option<&str>,
    plugged: Option<&str>,
    reset: bool,
    device: Option<&str>,
) -> Result<()> {
    if reset {
        let output = adb_exec(device, &["shell", "dumpsys", "battery", "reset"], None)?;
        if !output.status.success() {
            bail!("Battery reset failed: {}", String::from_utf8_lossy(&output.stderr));
        }
        println!("Battery state reset");
        return Ok(());
    }

    if let Some(lvl) = level {
        if lvl > 100 {
            bail!("Battery level must be 0-100, got {}", lvl);
        }
        let output = adb_exec(device, &["shell", "dumpsys", "battery", "set", "level", &lvl.to_string()], None)?;
        if !output.status.success() {
            bail!("Failed to set battery level: {}", String::from_utf8_lossy(&output.stderr));
        }
        println!("Battery level set to {}%", lvl);
    }

    if let Some(s) = status {
        // Android BatteryManager status codes: 1=unknown,2=charging,3=discharging,4=not_charging,5=full
        let s_lower = s.to_lowercase();
        let code = match s_lower.as_str() {
            "unknown" => "1",
            "charging" => "2",
            "discharging" => "3",
            "not_charging" | "not-charging" => "4",
            "full" => "5",
            other => other,
        };
        let output = adb_exec(device, &["shell", "dumpsys", "battery", "set", "status", code], None)?;
        if !output.status.success() {
            bail!("Failed to set battery status: {}", String::from_utf8_lossy(&output.stderr));
        }
        println!("Battery status set to {}", s);
    }

    if let Some(p) = plugged {
        // plugged codes: 0=unplugged,1=ac,2=usb,4=wireless
        let p_lower = p.to_lowercase();
        let code = match p_lower.as_str() {
            "unplugged" | "none" => "0",
            "ac" => "1",
            "usb" => "2",
            "wireless" => "4",
            other => other,
        };
        let output = adb_exec(device, &["shell", "dumpsys", "battery", "set", "ac", code], None)?;
        if !output.status.success() {
            bail!("Failed to set battery plugged state: {}", String::from_utf8_lossy(&output.stderr));
        }
        println!("Battery plugged set to {}", p);
    }

    Ok(())
}

/// Read active notifications from `dumpsys notification --noredact`.
pub fn sensor_notifications(package: Option<&str>, device: Option<&str>) -> Result<()> {
    let output = adb_exec(device, &["shell", "dumpsys", "notification", "--noredact"], None)?;
    if !output.status.success() {
        bail!("dumpsys notification failed: {}", String::from_utf8_lossy(&output.stderr));
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut notifications: Vec<serde_json::Value> = Vec::new();

    // Each notification block starts with "  NotificationRecord(" and ends at the next one
    let mut in_record = false;
    let mut pkg = String::new();
    let mut notif_id = String::new();
    let mut tag = String::new();
    let mut title = String::new();
    let mut body = String::new();
    let mut channel = String::new();

    let flush_record = |notifications: &mut Vec<serde_json::Value>,
                         pkg: &str, notif_id: &str, tag: &str,
                         title: &str, body: &str, channel: &str,
                         filter: Option<&str>| {
        if !pkg.is_empty() && filter.map_or(true, |f| pkg == f) {
            notifications.push(serde_json::json!({
                "package": pkg,
                "id": notif_id,
                "tag": tag,
                "title": title,
                "text": body,
                "channel": channel,
            }));
        }
    };

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("NotificationRecord(") {
            if in_record {
                flush_record(&mut notifications, &pkg, &notif_id, &tag, &title, &body, &channel, package);
            }
            in_record = true;
            pkg.clear();
            notif_id.clear();
            tag.clear();
            title.clear();
            body.clear();
            channel.clear();
            continue;
        }
        if !in_record {
            continue;
        }
        if trimmed.starts_with("pkg=") {
            pkg = trimmed.trim_start_matches("pkg=").trim().to_string();
        } else if trimmed.starts_with("id=") {
            notif_id = trimmed.trim_start_matches("id=").split_whitespace().next()
                .unwrap_or("").to_string();
        } else if trimmed.starts_with("tag=") {
            tag = trimmed.trim_start_matches("tag=").trim().trim_matches('"').to_string();
        } else if trimmed.contains("android.title=") {
            title = trimmed.split("android.title=").nth(1).unwrap_or("").trim().to_string();
        } else if trimmed.contains("android.text=") {
            body = trimmed.split("android.text=").nth(1).unwrap_or("").trim().to_string();
        } else if trimmed.starts_with("channel=Channel{") {
            channel = trimmed
                .split("id=").nth(1)
                .and_then(|s| s.split(',').next())
                .unwrap_or("").trim().to_string();
        }
    }

    if in_record {
        flush_record(&mut notifications, &pkg, &notif_id, &tag, &title, &body, &channel, package);
    }

    println!("{}", serde_json::to_string_pretty(&notifications)?);
    Ok(())
}

/// Override or reset thermal status via `cmd thermalservice`.
pub fn sensor_thermal(status: Option<&str>, reset: bool, device: Option<&str>) -> Result<()> {
    if reset {
        let output = adb_exec(device, &["shell", "cmd", "thermalservice", "reset"], None)?;
        if !output.status.success() {
            bail!("Thermal reset failed: {}", String::from_utf8_lossy(&output.stderr));
        }
        println!("Thermal status reset");
        return Ok(());
    }

    let s = status.ok_or_else(|| anyhow::anyhow!("Either --status or --reset is required"))?;

    // Android ThermalStatus codes: 0=NONE,1=LIGHT,2=MODERATE,3=SEVERE,4=CRITICAL,5=EMERGENCY,6=SHUTDOWN
    let s_lower = s.to_lowercase();
    let code = match s_lower.as_str() {
        "none" => "0",
        "light" => "1",
        "moderate" => "2",
        "severe" => "3",
        "critical" => "4",
        "emergency" => "5",
        "shutdown" => "6",
        other => other,
    };

    let output = adb_exec(device, &["shell", "cmd", "thermalservice", "override-status", code], None)?;
    if !output.status.success() {
        bail!("Thermal override failed: {}", String::from_utf8_lossy(&output.stderr));
    }

    println!("Thermal status set to {}", s);
    Ok(())
}

// ============== Network Commands ==============

/// Show per-app or global network traffic stats.
pub fn network_traffic(package: Option<&str>, device: Option<&str>) -> Result<()> {
    if let Some(pkg) = package {
        validate_package_name(pkg)?;

        // Resolve UID for the package first
        let uid_out = adb_exec(device, &["shell", "dumpsys", "package", pkg], None)?;
        let uid_text = String::from_utf8_lossy(&uid_out.stdout);

        let uid = uid_text
            .lines()
            .find_map(|line| {
                let trimmed = line.trim();
                if trimmed.starts_with("userId=") {
                    trimmed.trim_start_matches("userId=").split_whitespace().next().map(|s| s.to_string())
                } else {
                    None
                }
            })
            .ok_or_else(|| anyhow::anyhow!("Could not determine UID for package '{}'", pkg))?;

        // Read xt_qtaguid stats and sum rx/tx bytes for the matching uid
        let stats_out = adb_exec(device, &["shell", "cat", "/proc/net/xt_qtaguid/stats"], None)?;
        let stats_text = String::from_utf8_lossy(&stats_out.stdout);

        let mut rx_bytes: u64 = 0;
        let mut tx_bytes: u64 = 0;
        let mut rx_packets: u64 = 0;
        let mut tx_packets: u64 = 0;

        for line in stats_text.lines().skip(1) {
            // Format: idx iface acct_tag_hex uid_tag_int cnt_set rx_bytes rx_packets tx_bytes tx_packets ...
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() >= 9 {
                let row_uid: u64 = cols[3].parse().unwrap_or(0);
                // uid_tag_int encodes uid in upper 32 bits when tag != 0
                let actual_uid: u64 = if row_uid > 100_000 { row_uid >> 32 } else { row_uid };
                if actual_uid.to_string() == uid {
                    rx_bytes += cols[5].parse::<u64>().unwrap_or(0);
                    rx_packets += cols[6].parse::<u64>().unwrap_or(0);
                    tx_bytes += cols[7].parse::<u64>().unwrap_or(0);
                    tx_packets += cols[8].parse::<u64>().unwrap_or(0);
                }
            }
        }

        let result = serde_json::json!({
            "package": pkg,
            "uid": uid,
            "rx_bytes": rx_bytes,
            "rx_packets": rx_packets,
            "tx_bytes": tx_bytes,
            "tx_packets": tx_packets,
            "rx_mb": format!("{:.2}", rx_bytes as f64 / 1_048_576.0),
            "tx_mb": format!("{:.2}", tx_bytes as f64 / 1_048_576.0),
        });

        println!("{}", serde_json::to_string_pretty(&result)?);
    } else {
        // Global stats from netstats
        let output = adb_exec(device, &["shell", "dumpsys", "netstats", "--detail"], None)?;
        if !output.status.success() {
            bail!("netstats failed: {}", String::from_utf8_lossy(&output.stderr));
        }
        print!("{}", String::from_utf8_lossy(&output.stdout));
    }

    Ok(())
}

/// Show connectivity and WiFi status.
pub fn network_connectivity(device: Option<&str>) -> Result<()> {
    let conn_out = adb_exec(device, &["shell", "dumpsys", "connectivity"], None)?;
    let wifi_out = adb_exec(device, &["shell", "dumpsys", "wifi"], None)?;

    let conn_text = String::from_utf8_lossy(&conn_out.stdout);
    let wifi_text = String::from_utf8_lossy(&wifi_out.stdout);

    let mut active_network = String::new();
    let mut wifi_state = String::new();
    let mut wifi_ssid = String::new();
    let mut mobile_state = String::new();

    for line in conn_text.lines() {
        let t = line.trim();
        if t.starts_with("Active default network:") {
            active_network = t.trim_start_matches("Active default network:").trim().to_string();
        }
        if t.contains("MOBILE") && t.contains("state:") {
            mobile_state = t.to_string();
        }
    }

    for line in wifi_text.lines() {
        let t = line.trim();
        if t.starts_with("Wi-Fi is ") || t.starts_with("mWifiState=") {
            wifi_state = t.to_string();
        }
        if t.contains("SSID:") {
            if let Some(ssid) = t.split("SSID:").nth(1) {
                wifi_ssid = ssid.split(',').next().unwrap_or("").trim().trim_matches('"').to_string();
            }
        }
    }

    let result = serde_json::json!({
        "active_network": active_network,
        "wifi_state": wifi_state,
        "wifi_ssid": wifi_ssid,
        "mobile_state": mobile_state,
    });

    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

/// Get, set, or clear the HTTP proxy via `settings global http_proxy`.
pub fn network_proxy(
    host: Option<&str>,
    port: Option<u16>,
    clear: bool,
    device: Option<&str>,
) -> Result<()> {
    if clear {
        let output = adb_exec(device, &["shell", "settings", "put", "global", "http_proxy", ":0"], None)?;
        if !output.status.success() {
            bail!("Failed to clear proxy: {}", String::from_utf8_lossy(&output.stderr));
        }
        println!("HTTP proxy cleared");
        return Ok(());
    }

    if host.is_none() && port.is_none() {
        // Read current proxy
        let output = adb_exec(device, &["shell", "settings", "get", "global", "http_proxy"], None)?;
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        println!(
            "Current HTTP proxy: {}",
            if value.is_empty() || value == "null" { "(none)".to_string() } else { value }
        );
        return Ok(());
    }

    let h = host.ok_or_else(|| anyhow::anyhow!("--host is required when setting proxy"))?;
    let p = port.ok_or_else(|| anyhow::anyhow!("--port is required when setting proxy"))?;
    let proxy_value = format!("{}:{}", h, p);

    let output = adb_exec(device, &["shell", "settings", "put", "global", "http_proxy", &proxy_value], None)?;
    if !output.status.success() {
        bail!("Failed to set proxy: {}", String::from_utf8_lossy(&output.stderr));
    }

    println!("HTTP proxy set to {}", proxy_value);
    Ok(())
}

/// Enable or disable airplane mode.
pub fn network_airplane(enabled: bool, device: Option<&str>) -> Result<()> {
    let value = if enabled { "1" } else { "0" };

    // Set the global setting
    let out1 = adb_exec(device, &["shell", "settings", "put", "global", "airplane_mode_on", value], None)?;
    if !out1.status.success() {
        bail!("Failed to set airplane_mode_on: {}", String::from_utf8_lossy(&out1.stderr));
    }

    // Broadcast the change so Android applies it immediately
    let out2 = adb_exec(device, &[
        "shell", "am", "broadcast",
        "-a", "android.intent.action.AIRPLANE_MODE",
        "--ez", "state", if enabled { "true" } else { "false" },
    ], None)?;
    if !out2.status.success() {
        bail!("Airplane mode broadcast failed: {}", String::from_utf8_lossy(&out2.stderr));
    }

    println!("Airplane mode {}", if enabled { "enabled" } else { "disabled" });
    Ok(())
}

// ============== Permission Commands ==============

/// Grant a permission to a package (Android).
pub fn permission_grant(package: &str, permission: &str, device: Option<&str>) -> Result<()> {
    validate_package_name(package)?;
    let output = adb_exec(device, &["shell", "pm", "grant", package, permission], None)?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        bail!("pm grant failed: {}", stderr);
    }
    if stderr.to_lowercase().contains("exception") || stderr.to_lowercase().contains("error:") {
        bail!("pm grant error: {}", stderr);
    }
    println!("Granted {} to {}", permission, package);
    Ok(())
}

/// Revoke a permission from a package (Android).
pub fn permission_revoke(package: &str, permission: &str, device: Option<&str>) -> Result<()> {
    validate_package_name(package)?;
    let output = adb_exec(device, &["shell", "pm", "revoke", package, permission], None)?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        bail!("pm revoke failed: {}", stderr);
    }
    if stderr.to_lowercase().contains("exception") || stderr.to_lowercase().contains("error:") {
        bail!("pm revoke error: {}", stderr);
    }
    println!("Revoked {} from {}", permission, package);
    Ok(())
}

/// Reset all runtime permissions for a package (Android).
pub fn permission_reset(package: &str, device: Option<&str>) -> Result<()> {
    validate_package_name(package)?;
    let output = adb_exec(device, &["shell", "pm", "reset-permissions", package], None)?;
    if !output.status.success() {
        bail!("pm reset-permissions failed: {}", String::from_utf8_lossy(&output.stderr));
    }
    println!("Permissions reset for {}", package);
    Ok(())
}

// ============== Intent Commands ==============

/// Start an activity via `am start`.
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
    let mut args: Vec<String> = vec!["shell".into(), "am".into(), "start".into()];

    if let Some(a) = action {
        args.push("-a".into());
        args.push(a.into());
    }
    if let Some(c) = component {
        args.push("-n".into());
        args.push(c.into());
    }
    if let Some(d) = data {
        args.push("-d".into());
        args.push(d.into());
    }
    if let Some(cat) = category {
        args.push("-c".into());
        args.push(cat.into());
    }
    if let Some(pkg) = package {
        validate_package_name(pkg)?;
        args.push("--package".into());
        args.push(pkg.into());
    }
    if let Some(f) = flags {
        args.push("-f".into());
        args.push(f.into());
    }
    if let Some(extras_json) = extras {
        append_extras_args(&mut args, extras_json)?;
    }

    let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = adb_exec(device, &args_ref, None)?;
    let stdout = String::from_utf8_lossy(&output.stdout);

    if !output.status.success() {
        bail!("am start failed: {}", String::from_utf8_lossy(&output.stderr));
    }
    if stdout.to_lowercase().contains("error:") {
        bail!("am start error: {}", stdout);
    }

    print!("{}", stdout);
    Ok(())
}

/// Send a broadcast intent via `am broadcast`.
pub fn intent_broadcast(
    action: &str,
    package: Option<&str>,
    component: Option<&str>,
    extras: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    let mut args: Vec<String> = vec!["shell".into(), "am".into(), "broadcast".into()];
    args.push("-a".into());
    args.push(action.into());

    if let Some(pkg) = package {
        validate_package_name(pkg)?;
        args.push("--package".into());
        args.push(pkg.into());
    }
    if let Some(comp) = component {
        args.push("-n".into());
        args.push(comp.into());
    }
    if let Some(extras_json) = extras {
        append_extras_args(&mut args, extras_json)?;
    }

    let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = adb_exec(device, &args_ref, None)?;

    if !output.status.success() {
        bail!("am broadcast failed: {}", String::from_utf8_lossy(&output.stderr));
    }

    print!("{}", String::from_utf8_lossy(&output.stdout));
    Ok(())
}

/// Open a deep-link URI via `am start -a android.intent.action.VIEW -d <uri>`.
pub fn intent_deeplink(uri: &str, package: Option<&str>, device: Option<&str>) -> Result<()> {
    let mut args: Vec<String> = vec![
        "shell".into(), "am".into(), "start".into(),
        "-a".into(), "android.intent.action.VIEW".into(),
        "-d".into(), uri.into(),
    ];
    if let Some(pkg) = package {
        validate_package_name(pkg)?;
        args.push("--package".into());
        args.push(pkg.into());
    }

    let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = adb_exec(device, &args_ref, None)?;
    let stdout = String::from_utf8_lossy(&output.stdout);

    if !output.status.success() {
        bail!("Deep-link failed: {}", String::from_utf8_lossy(&output.stderr));
    }
    if stdout.to_lowercase().contains("error:") {
        bail!("Deep-link error: {}", stdout);
    }

    println!("Opened deep-link: {}", uri);
    Ok(())
}

/// List running services via `dumpsys activity services`.
pub fn intent_services(package: Option<&str>, device: Option<&str>) -> Result<()> {
    let mut cmd_args = vec!["shell", "dumpsys", "activity", "services"];
    if let Some(pkg) = package {
        cmd_args.push(pkg);
    }

    let output = adb_exec(device, &cmd_args, None)?;
    if !output.status.success() {
        bail!("dumpsys activity services failed: {}", String::from_utf8_lossy(&output.stderr));
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut services: Vec<serde_json::Value> = Vec::new();

    for line in text.lines() {
        let trimmed = line.trim();
        // Lines like: * ServiceRecord{deadbeef com.pkg/.MyService}
        if trimmed.starts_with("* ServiceRecord{") {
            let record = &trimmed["* ServiceRecord{".len()..];
            if let Some(close) = record.find('}') {
                let inner = &record[..close];
                let parts: Vec<&str> = inner.split_whitespace().collect();
                if parts.len() >= 2 {
                    services.push(serde_json::json!({
                        "component": parts[1],
                        "addr": parts[0],
                    }));
                }
            }
        }
    }

    if services.is_empty() {
        print!("{}", text);
    } else {
        println!("{}", serde_json::to_string_pretty(&services)?);
    }

    Ok(())
}

// ============== Sandbox Commands ==============

/// Read SharedPreferences XML from app sandbox via `run-as`.
pub fn sandbox_prefs_read(package: &str, file: Option<&str>, device: Option<&str>) -> Result<()> {
    validate_package_name(package)?;
    let filename = file.unwrap_or("default_preferences");
    let xml_file = if filename.ends_with(".xml") {
        filename.to_string()
    } else {
        format!("{}.xml", filename)
    };

    let cmd = format!("run-as {} cat shared_prefs/{}", package, xml_file);
    let output = adb_exec(device, &["shell", &cmd], None)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if !output.status.success() || stderr.contains("Permission denied") {
        bail!("sandbox prefs read failed: {}", stderr);
    }

    print!("{}", stdout);
    Ok(())
}

/// Write or update a preference key in SharedPreferences XML via `run-as` + `sed`.
pub fn sandbox_prefs_write(
    package: &str,
    file: &str,
    key: &str,
    value: &str,
    pref_type: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    validate_package_name(package)?;

    let xml_file = if file.ends_with(".xml") {
        file.to_string()
    } else {
        format!("{}.xml", file)
    };

    let type_tag = match pref_type.unwrap_or("string") {
        "boolean" | "bool" => "boolean",
        "int" | "integer" => "int",
        "long" => "long",
        "float" => "float",
        _ => "string",
    };

    // Build sed expression to replace existing entry in the XML
    let sed_expr = if type_tag == "string" {
        format!(
            r#"s|<string name="{}">[^<]*</string>|<string name="{}">{}</string>|g"#,
            key, key, value
        )
    } else {
        format!(
            r#"s|<{t} name="{k}" value="[^"]*" />|<{t} name="{k}" value="{v}" />|g"#,
            t = type_tag, k = key, v = value
        )
    };

    let path = format!("shared_prefs/{}", xml_file);
    let cmd = format!("run-as {} sed -i '{}' {}", package, sed_expr, path);

    let output = adb_exec(device, &["shell", &cmd], None)?;
    let stderr = String::from_utf8_lossy(&output.stderr);

    if !output.status.success() || stderr.contains("Permission denied") {
        bail!("sandbox prefs write failed: {}", stderr);
    }

    println!("Updated {}.{} = {} (type: {})", xml_file, key, value, type_tag);
    Ok(())
}

/// Execute a SQLite query on the app's database via `run-as`.
pub fn sandbox_sqlite_query(
    package: &str,
    database: &str,
    query: &str,
    device: Option<&str>,
) -> Result<()> {
    validate_package_name(package)?;

    let db_path = if database.starts_with('/') {
        database.to_string()
    } else {
        format!("databases/{}", database)
    };

    // Escape single quotes in query for shell safety
    let escaped_query = query.replace('\'', "'\\''");
    let cmd = format!("run-as {} sqlite3 {} '{}'", package, db_path, escaped_query);

    let output = adb_exec(device, &["shell", &cmd], None)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if !output.status.success() || stderr.contains("Permission denied") {
        bail!("sqlite query failed: {}", stderr);
    }

    print!("{}", stdout);
    Ok(())
}

/// List files in the app sandbox directory via `run-as`.
pub fn sandbox_file_list(package: &str, path: Option<&str>, device: Option<&str>) -> Result<()> {
    validate_package_name(package)?;
    let dir = path.unwrap_or(".");
    let cmd = format!("run-as {} ls -la {}", package, dir);

    let output = adb_exec(device, &["shell", &cmd], None)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if !output.status.success() || stderr.contains("Permission denied") {
        bail!("sandbox file list failed: {}", stderr);
    }

    print!("{}", stdout);
    Ok(())
}

/// Read a file from the app sandbox via `run-as`, with optional byte limit.
pub fn sandbox_file_read(
    package: &str,
    path: &str,
    max_bytes: Option<u64>,
    device: Option<&str>,
) -> Result<()> {
    validate_package_name(package)?;

    let cmd = if let Some(limit) = max_bytes {
        format!("run-as {} dd if={} bs=1 count={} 2>/dev/null", package, path, limit)
    } else {
        format!("run-as {} cat {}", package, path)
    };

    let output = adb_exec(device, &["shell", &cmd], None)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if !output.status.success() || stderr.contains("Permission denied") {
        bail!("sandbox file read failed: {}", stderr);
    }

    print!("{}", stdout);
    Ok(())
}

// ============== Performance Commands ==============

/// Parse total PSS (kB) from `dumpsys meminfo <pkg>` output.
fn parse_total_pss(meminfo: &str) -> u64 {
    // Look for "TOTAL PSS:" or "TOTAL:" line depending on Android version
    for line in meminfo.lines() {
        let t = line.trim();
        if t.starts_with("TOTAL PSS:") || t.starts_with("TOTAL:") {
            // e.g. "TOTAL PSS:   52,345  ..."  or  "TOTAL          123456   ..."
            let col = t.split_whitespace().nth(2).or_else(|| t.split_whitespace().nth(1));
            if let Some(v) = col {
                let clean: String = v.chars().filter(|c| c.is_ascii_digit()).collect();
                if let Ok(n) = clean.parse::<u64>() {
                    return n;
                }
            }
        }
        // Alternative: "TOTAL HEAP:" summary line
        if t.contains("TOTAL HEAP:") {
            if let Some(v) = t.split_whitespace().nth(2) {
                let clean: String = v.chars().filter(|c| c.is_ascii_digit()).collect();
                if let Ok(n) = clean.parse::<u64>() {
                    return n;
                }
            }
        }
    }
    // Fallback: sum "Native Heap" + "Dalvik Heap" PSS columns.
    // dumpsys meminfo rows look like: "Native Heap   12288   ..."
    // "Native Heap" is 2 words, so the first numeric column is at index 2.
    let mut sum: u64 = 0;
    for line in meminfo.lines() {
        let t = line.trim();
        if t.starts_with("Native Heap") || t.starts_with("Dalvik Heap") {
            // Find the first token that is entirely digits
            if let Some(v) = t.split_whitespace().find(|tok| tok.chars().all(|c| c.is_ascii_digit()) && !tok.is_empty()) {
                sum += v.parse::<u64>().unwrap_or(0);
            }
        }
    }
    sum
}

/// Parse top-level memory MB from `dumpsys meminfo <pkg>`.
/// Returns `(memory_mb, total_pss_kb)`.
fn parse_meminfo(meminfo: &str) -> (f64, u64) {
    let total_pss = parse_total_pss(meminfo);
    let memory_mb = total_pss as f64 / 1024.0;
    (memory_mb, total_pss)
}

/// Parse CPU percent for a package from `dumpsys cpuinfo` output.
fn parse_cpu_percent(cpuinfo: &str, package: &str) -> f64 {
    for line in cpuinfo.lines() {
        if line.contains(package) {
            // Format: "  15% 1234/com.example.app: ..."
            if let Some(pct_str) = line.trim().split('%').next() {
                let clean: String = pct_str.trim().chars().filter(|c| c.is_ascii_digit() || *c == '.').collect();
                if let Ok(v) = clean.parse::<f64>() {
                    return v;
                }
            }
        }
    }
    0.0
}

/// Parse battery charge level from `dumpsys batterystats --charged <pkg>`.
fn parse_battery_level(battery: &str) -> u8 {
    for line in battery.lines() {
        let t = line.trim();
        if t.starts_with("level:") {
            if let Some(v) = t.split(':').nth(1) {
                if let Ok(n) = v.trim().parse::<u8>() {
                    return n;
                }
            }
        }
    }
    0
}

/// Collect a single performance snapshot for a package.
/// Returns a `serde_json::Value` with the parsed metrics.
fn collect_perf_snapshot_value(package: &str, device: Option<&str>) -> Result<serde_json::Value> {
    validate_package_name(package)?;

    let meminfo_out = adb_exec(device, &["shell", "dumpsys", "meminfo", package], None)?;
    let cpuinfo_out = adb_exec(device, &["shell", "dumpsys", "cpuinfo"], None)?;
    let battery_out = adb_exec(device, &["shell", "dumpsys", "battery"], None)?;
    let gfxinfo_out = adb_exec(device, &["shell", "dumpsys", "gfxinfo", package], None)?;

    let meminfo_text = String::from_utf8_lossy(&meminfo_out.stdout);
    let cpuinfo_text = String::from_utf8_lossy(&cpuinfo_out.stdout);
    let battery_text = String::from_utf8_lossy(&battery_out.stdout);
    let gfxinfo_text = String::from_utf8_lossy(&gfxinfo_out.stdout);

    let (memory_mb, total_pss) = parse_meminfo(&meminfo_text);
    let cpu_percent = parse_cpu_percent(&cpuinfo_text, package);
    let battery_level = parse_battery_level(&battery_text);

    // Parse janky frames from gfxinfo
    let mut total_frames: u64 = 0;
    let mut janky_frames: u64 = 0;
    for line in gfxinfo_text.lines() {
        let t = line.trim();
        if t.starts_with("Total frames rendered:") {
            if let Some(v) = t.split(':').nth(1) {
                total_frames = v.trim().parse().unwrap_or(0);
            }
        }
        if t.starts_with("Janky frames:") {
            if let Some(v) = t.split(':').nth(1) {
                // "Janky frames: 123 (45.67%)"
                janky_frames = v.trim().split_whitespace().next().unwrap_or("0")
                    .parse().unwrap_or(0);
            }
        }
    }

    let janky_percent = if total_frames > 0 {
        (janky_frames as f64 / total_frames as f64) * 100.0
    } else {
        0.0
    };

    Ok(serde_json::json!({
        "package": package,
        "memoryMb": format!("{:.2}", memory_mb),
        "totalPssKb": total_pss,
        "cpuPercent": cpu_percent,
        "batteryLevel": battery_level,
        "framestats": {
            "totalFrames": total_frames,
            "jankyFrames": janky_frames,
            "jankyPercent": format!("{:.2}", janky_percent),
        }
    }))
}

/// Capture memory/CPU/battery/framestats snapshot for a package.
pub fn perf_snapshot(package: &str, device: Option<&str>) -> Result<()> {
    let snapshot = collect_perf_snapshot_value(package, device)?;
    println!("{}", serde_json::to_string_pretty(&snapshot)?);
    Ok(())
}

/// Save a perf-snapshot as a named baseline JSON file under /tmp.
pub fn perf_baseline(package: &str, name: &str, device: Option<&str>) -> Result<()> {
    validate_package_name(package)?;

    if name.is_empty() {
        bail!("Baseline name cannot be empty");
    }
    // Sanitise name to prevent path traversal: only alnum, dash, underscore allowed
    if !name.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        bail!("Baseline name '{}' must contain only alphanumerics, dashes, and underscores", name);
    }

    let snapshot = collect_perf_snapshot_value(package, device)?;
    let path = format!("/tmp/claude-mobile-baseline-{}.json", name);
    let json_str = serde_json::to_string_pretty(&snapshot)?;
    std::fs::write(&path, &json_str)?;

    println!("Baseline '{}' saved to {}", name, path);
    println!("{}", json_str);
    Ok(())
}

/// Compare current perf metrics against a saved baseline, reporting deltas.
pub fn perf_compare(package: &str, name: &str, device: Option<&str>) -> Result<()> {
    validate_package_name(package)?;

    if !name.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        bail!("Baseline name '{}' contains invalid characters", name);
    }

    let path = format!("/tmp/claude-mobile-baseline-{}.json", name);
    let baseline_str = std::fs::read_to_string(&path)
        .map_err(|e| anyhow::anyhow!("Baseline '{}' not found at {}: {}", name, path, e))?;
    let baseline: serde_json::Value = serde_json::from_str(&baseline_str)
        .map_err(|e| anyhow::anyhow!("Failed to parse baseline JSON: {}", e))?;

    let current = collect_perf_snapshot_value(package, device)?;

    // Helper: parse f64 from either string or number JSON value
    let to_f64 = |v: &serde_json::Value| -> f64 {
        match v {
            serde_json::Value::Number(n) => n.as_f64().unwrap_or(0.0),
            serde_json::Value::String(s) => s.parse::<f64>().unwrap_or(0.0),
            _ => 0.0,
        }
    };

    let baseline_mem  = to_f64(&baseline["memoryMb"]);
    let current_mem   = to_f64(&current["memoryMb"]);
    let baseline_cpu  = to_f64(&baseline["cpuPercent"]);
    let current_cpu   = to_f64(&current["cpuPercent"]);
    let baseline_pss  = to_f64(&baseline["totalPssKb"]);
    let current_pss   = to_f64(&current["totalPssKb"]);
    let baseline_janky = to_f64(&baseline["framestats"]["jankyPercent"]);
    let current_janky  = to_f64(&current["framestats"]["jankyPercent"]);

    // >20% regression threshold
    let regression_threshold = 0.20_f64;

    let check_metric = |label: &str, base: f64, curr: f64| -> serde_json::Value {
        let delta = curr - base;
        let delta_pct = if base > 0.0 { delta / base } else { 0.0 };
        let passed = delta_pct <= regression_threshold;
        serde_json::json!({
            "metric": label,
            "baseline": format!("{:.2}", base),
            "current": format!("{:.2}", curr),
            "delta": format!("{:+.2}", delta),
            "deltaPercent": format!("{:+.1}%", delta_pct * 100.0),
            "pass": passed,
            "status": if passed { "PASS" } else { "FAIL" }
        })
    };

    let metrics = vec![
        check_metric("memoryMb",       baseline_mem,   current_mem),
        check_metric("totalPssKb",     baseline_pss,   current_pss),
        check_metric("cpuPercent",     baseline_cpu,   current_cpu),
        check_metric("jankyPercent",   baseline_janky, current_janky),
    ];

    let overall_pass = metrics.iter().all(|m| m["pass"].as_bool().unwrap_or(true));

    let result = serde_json::json!({
        "package": package,
        "baseline": name,
        "overallPass": overall_pass,
        "overallStatus": if overall_pass { "PASS" } else { "FAIL" },
        "regressionThreshold": "20%",
        "metrics": metrics,
    });

    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

/// Collect N perf samples at `interval_ms` and report min/max/avg for each metric.
pub fn perf_monitor(
    package: &str,
    count: u32,
    interval_ms: u64,
    device: Option<&str>,
) -> Result<()> {
    validate_package_name(package)?;

    if count == 0 {
        bail!("--count must be at least 1");
    }

    let mut mem_samples: Vec<f64> = Vec::with_capacity(count as usize);
    let mut cpu_samples: Vec<f64> = Vec::with_capacity(count as usize);
    let mut pss_samples: Vec<f64> = Vec::with_capacity(count as usize);

    eprintln!("Collecting {} samples for {} (interval {}ms)...", count, package, interval_ms);

    for i in 0..count {
        if i > 0 && interval_ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(interval_ms));
        }

        let meminfo_out = adb_exec(device, &["shell", "dumpsys", "meminfo", package], None)?;
        let cpuinfo_out = adb_exec(device, &["shell", "dumpsys", "cpuinfo"], None)?;

        let meminfo_text = String::from_utf8_lossy(&meminfo_out.stdout);
        let cpuinfo_text = String::from_utf8_lossy(&cpuinfo_out.stdout);

        let (mem_mb, total_pss) = parse_meminfo(&meminfo_text);
        let cpu = parse_cpu_percent(&cpuinfo_text, package);

        mem_samples.push(mem_mb);
        cpu_samples.push(cpu);
        pss_samples.push(total_pss as f64);

        eprintln!("  sample {}/{}: mem={:.1}MB cpu={:.1}%", i + 1, count, mem_mb, cpu);
    }

    let stats = |samples: &[f64]| -> serde_json::Value {
        let n = samples.len() as f64;
        let min = samples.iter().cloned().fold(f64::INFINITY, f64::min);
        let max = samples.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let avg = samples.iter().sum::<f64>() / n;
        serde_json::json!({
            "min": format!("{:.2}", min),
            "max": format!("{:.2}", max),
            "avg": format!("{:.2}", avg),
        })
    };

    let result = serde_json::json!({
        "package": package,
        "samples": count,
        "intervalMs": interval_ms,
        "memoryMb": stats(&mem_samples),
        "cpuPercent": stats(&cpu_samples),
        "totalPssKb": stats(&pss_samples),
    });

    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

/// Extract recent crashes and ANRs from logcat.
pub fn perf_crashes(package: Option<&str>, lines: usize, device: Option<&str>) -> Result<()> {
    if let Some(pkg) = package {
        validate_package_name(pkg)?;
    }

    let lines_str = lines.to_string();

    // Crash buffer: crash-specific log buffer
    let crash_out = adb_exec(
        device,
        &["logcat", "-d", "-b", "crash", "-t", &lines_str],
        None,
    )?;

    // AndroidRuntime errors (from main buffer)
    let runtime_out = adb_exec(
        device,
        &["logcat", "-d", "-s", "AndroidRuntime:E", "-t", &lines_str],
        None,
    )?;

    let crash_text = String::from_utf8_lossy(&crash_out.stdout).to_string();
    let runtime_text = String::from_utf8_lossy(&runtime_out.stdout).to_string();

    // Try to check /data/anr/ directory for ANR traces (may fail without root)
    let anr_out = adb_exec(device, &["shell", "ls", "-t", "/data/anr/"], None);
    let anr_files: Vec<String> = anr_out
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter(|l| !l.trim().is_empty())
                .map(|l| l.trim().to_string())
                .collect()
        })
        .unwrap_or_default();

    // Filter lines by package if provided
    let filter_by_pkg = |text: &str, pkg: Option<&str>| -> Vec<String> {
        if let Some(p) = pkg {
            let mut keep = false;
            let mut result = Vec::new();
            for line in text.lines() {
                // AndroidRuntime crash sections start with "FATAL EXCEPTION"
                if line.contains("FATAL EXCEPTION") {
                    keep = line.contains(p);
                }
                if line.contains(p) {
                    keep = true;
                }
                if keep {
                    result.push(line.to_string());
                }
            }
            result
        } else {
            text.lines().map(|l| l.to_string()).collect()
        }
    };

    let crash_lines = filter_by_pkg(&crash_text, package);
    let runtime_lines = filter_by_pkg(&runtime_text, package);

    let result = serde_json::json!({
        "package": package.unwrap_or("(all)"),
        "crashBuffer": crash_lines,
        "runtimeErrors": runtime_lines,
        "anrFiles": anr_files,
        "note": "ANR files under /data/anr/ require root or adb shell run-as access"
    });

    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

/// Detailed frame rendering stats via `dumpsys gfxinfo <pkg> framestats`.
pub fn perf_framestats(package: &str, device: Option<&str>) -> Result<()> {
    validate_package_name(package)?;

    let output = adb_exec(device, &["shell", "dumpsys", "gfxinfo", package, "framestats"], None)?;
    if !output.status.success() {
        bail!("gfxinfo framestats failed: {}", String::from_utf8_lossy(&output.stderr));
    }

    let text = String::from_utf8_lossy(&output.stdout);

    // Parse summary section
    let mut total_frames: u64 = 0;
    let mut janky_frames: u64 = 0;
    let mut p50_ms: f64 = 0.0;
    let mut p90_ms: f64 = 0.0;
    let mut p95_ms: f64 = 0.0;
    let mut p99_ms: f64 = 0.0;

    // Collect raw frame durations from the CSV section (nanoseconds)
    // The framestats section has lines: INTENDED_VSYNC,VSYNC,OLDEST_INPUT_EVENT,...
    // Each data row has 14 comma-separated nanosecond timestamps.
    // Frame duration = FRAME_COMPLETED (col 13) - INTENDED_VSYNC (col 0)
    let mut frame_durations_ms: Vec<f64> = Vec::new();
    let mut in_data_section = false;

    for line in text.lines() {
        let t = line.trim();

        // Summary stats parsed from human-readable section
        if t.starts_with("Total frames rendered:") {
            if let Some(v) = t.split(':').nth(1) {
                total_frames = v.trim().parse().unwrap_or(0);
            }
        } else if t.starts_with("Janky frames:") {
            if let Some(v) = t.split(':').nth(1) {
                janky_frames = v.trim().split_whitespace().next().unwrap_or("0")
                    .parse().unwrap_or(0);
            }
        } else if t.starts_with("50th percentile:") {
            p50_ms = t.split(':').nth(1).and_then(|s| {
                s.trim().trim_end_matches("ms").trim().parse::<f64>().ok()
            }).unwrap_or(0.0);
        } else if t.starts_with("90th percentile:") {
            p90_ms = t.split(':').nth(1).and_then(|s| {
                s.trim().trim_end_matches("ms").trim().parse::<f64>().ok()
            }).unwrap_or(0.0);
        } else if t.starts_with("95th percentile:") {
            p95_ms = t.split(':').nth(1).and_then(|s| {
                s.trim().trim_end_matches("ms").trim().parse::<f64>().ok()
            }).unwrap_or(0.0);
        } else if t.starts_with("99th percentile:") {
            p99_ms = t.split(':').nth(1).and_then(|s| {
                s.trim().trim_end_matches("ms").trim().parse::<f64>().ok()
            }).unwrap_or(0.0);
        }

        // Detect CSV header row: "INTENDED_VSYNC,VSYNC,..."
        if t.starts_with("INTENDED_VSYNC") {
            in_data_section = true;
            continue;
        }
        // End of data section (empty line or "---" separator)
        if in_data_section && (t.is_empty() || t.starts_with("---")) {
            in_data_section = false;
        }

        if in_data_section {
            let cols: Vec<&str> = t.split(',').collect();
            if cols.len() >= 14 {
                let intended: u64 = cols[0].trim().parse().unwrap_or(0);
                let completed: u64 = cols[13].trim().parse().unwrap_or(0);
                if completed > intended && intended > 0 {
                    let duration_ns = completed - intended;
                    frame_durations_ms.push(duration_ns as f64 / 1_000_000.0);
                }
            }
        }
    }

    // If summary wasn't in dumpsys output, compute from raw frame data
    if total_frames == 0 && !frame_durations_ms.is_empty() {
        total_frames = frame_durations_ms.len() as u64;
        // 16.67ms = 60fps target
        janky_frames = frame_durations_ms.iter().filter(|&&d| d > 16.67).count() as u64;
    }

    let janky_percent = if total_frames > 0 {
        (janky_frames as f64 / total_frames as f64) * 100.0
    } else {
        0.0
    };

    let result = serde_json::json!({
        "package": package,
        "totalFrames": total_frames,
        "jankyFrames": janky_frames,
        "jankyPercent": format!("{:.2}", janky_percent),
        "percentiles": {
            "p50ms": p50_ms,
            "p90ms": p90_ms,
            "p95ms": p95_ms,
            "p99ms": p99_ms,
        },
        "rawFrameCount": frame_durations_ms.len(),
        "note": "Janky = frame > 16.67ms (< 60 fps). Run app activity before capturing."
    });

    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

// ============== Shared Helpers ==============

/// Validate that a string looks like an Android package name (e.g. com.example.app).
fn validate_package_name(package: &str) -> Result<()> {
    if package.is_empty() {
        bail!("Package name cannot be empty");
    }
    let valid = package
        .chars()
        .all(|c| c.is_alphanumeric() || c == '.' || c == '_' || c == '-');
    if !valid {
        bail!(
            "Invalid package name '{}': only alphanumerics, dots, underscores, and hyphens allowed",
            package
        );
    }
    Ok(())
}

/// Append `--es`/`--ez`/`--ei`/`--ef` extras from a JSON object string to an args list.
fn append_extras_args(args: &mut Vec<String>, extras_json: &str) -> Result<()> {
    let parsed: serde_json::Value =
        serde_json::from_str(extras_json).context("--extras must be a valid JSON object")?;
    let obj = parsed
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("--extras must be a JSON object, not an array or scalar"))?;

    for (k, v) in obj {
        match v {
            serde_json::Value::String(s) => {
                args.push("--es".into());
                args.push(k.clone());
                args.push(s.clone());
            }
            serde_json::Value::Bool(b) => {
                args.push("--ez".into());
                args.push(k.clone());
                args.push(b.to_string());
            }
            serde_json::Value::Number(n) => {
                if n.is_i64() {
                    args.push("--ei".into());
                } else {
                    args.push("--ef".into());
                }
                args.push(k.clone());
                args.push(n.to_string());
            }
            _ => {
                args.push("--es".into());
                args.push(k.clone());
                args.push(v.to_string());
            }
        }
    }
    Ok(())
}

// ============== Tests ==============

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_ui_elements() {
        let xml = r#"
            <node class="android.widget.Button" text="Click me" bounds="[0,0][100,50]" clickable="true" resource-id="" content-desc=""/>
            <node class="android.widget.TextView" text="Hello" bounds="[0,50][200,100]" clickable="false" resource-id="com.app:id/text" content-desc=""/>
        "#;

        let elements = parse_ui_elements(xml);
        assert_eq!(elements.len(), 2);
        assert_eq!(elements[0].text, "Click me");
        assert!(elements[0].clickable);
        assert_eq!(elements[0].center(), (50, 25));
        assert_eq!(elements[1].resource_id, "com.app:id/text");
    }

    #[test]
    fn test_ui_element_label() {
        let elem = UiElement {
            class: "android.widget.Button".to_string(),
            text: "".to_string(),
            resource_id: "com.app:id/my_button".to_string(),
            content_desc: "".to_string(),
            bounds: (0, 0, 100, 50),
            clickable: true,
        };

        assert_eq!(elem.label(), "my_button");
    }

    #[test]
    fn test_regexes_compile() {
        // Ensure all regexes compile without panic
        let _ = node_regex();
        let _ = class_regex();
        let _ = text_regex();
        let _ = resource_regex();
        let _ = content_regex();
        let _ = bounds_regex();
        let _ = clickable_regex();
    }

    // ===== Performance parsing tests =====

    #[test]
    fn test_parse_total_pss_total_pss_line() {
        let meminfo = "TOTAL PSS:   51200  kB\nNative Heap   12000\nDalvik Heap   8000";
        // TOTAL PSS: col[2] = "kB" which has no digits — fallback to col[1] = "51200"
        // The implementation tries col[2] first, then col[1], so 51200 should be found
        let pss = parse_total_pss(meminfo);
        assert!(pss > 0, "Expected non-zero PSS from TOTAL PSS line");
    }

    #[test]
    fn test_parse_total_pss_fallback_heap_sum() {
        let meminfo = "Native Heap   12288\nDalvik Heap   8192\nOther Heap   1024";
        let pss = parse_total_pss(meminfo);
        // Should sum Native Heap + Dalvik Heap = 12288 + 8192 = 20480
        assert_eq!(pss, 20480);
    }

    #[test]
    fn test_parse_total_pss_empty() {
        let pss = parse_total_pss("");
        assert_eq!(pss, 0);
    }

    #[test]
    fn test_parse_meminfo_returns_mb() {
        let meminfo = "Native Heap   10240\nDalvik Heap   10240";
        let (mem_mb, total_pss) = parse_meminfo(meminfo);
        assert_eq!(total_pss, 20480);
        assert!((mem_mb - 20.0_f64).abs() < 0.01, "Expected ~20 MB, got {}", mem_mb);
    }

    #[test]
    fn test_parse_cpu_percent_found() {
        let cpuinfo = "  15% 1234/com.example.app: 10% user + 5% kernel\n  5% 999/system: 5% user\n";
        let pct = parse_cpu_percent(cpuinfo, "com.example.app");
        assert!((pct - 15.0).abs() < 0.01, "Expected 15.0%, got {}", pct);
    }

    #[test]
    fn test_parse_cpu_percent_not_found() {
        let cpuinfo = "  10% 999/other.app: 10% user\n";
        let pct = parse_cpu_percent(cpuinfo, "com.example.app");
        assert_eq!(pct, 0.0);
    }

    #[test]
    fn test_parse_battery_level() {
        let battery = "Current Battery Service state:\n  AC powered: false\n  level: 87\n  scale: 100\n";
        let level = parse_battery_level(battery);
        assert_eq!(level, 87);
    }

    #[test]
    fn test_parse_battery_level_missing() {
        let battery = "no battery info here";
        let level = parse_battery_level(battery);
        assert_eq!(level, 0);
    }

    #[test]
    fn test_validate_package_name_valid() {
        assert!(validate_package_name("com.example.app").is_ok());
        assert!(validate_package_name("org.test_app-v2").is_ok());
    }

    #[test]
    fn test_validate_package_name_invalid() {
        assert!(validate_package_name("").is_err());
        assert!(validate_package_name("com.example/app").is_err());
        assert!(validate_package_name("../etc/passwd").is_err());
    }
}
