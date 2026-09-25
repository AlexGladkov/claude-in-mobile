//! Android device automation via ADB.
//!
//! # Shell-injection invariant (CWE-78)
//!
//! Any string handed to `adb shell <string>` is re-parsed by `sh` on the
//! device. Every dynamic segment of such a string MUST go through
//! [`crate::utils::device_shell::DeviceShellCmd`] — never `format!`. The
//! builder's `user_input(` / `validated(` call sites are the audit surface
//! for caller-controlled inputs. Plain `format!` in this module is allowed
//! ONLY for non-shell purposes (error messages, JSON payloads, file paths,
//! log lines, numeric formatting). When reviewing changes:
//!
//!   1. `rg 'adb_exec\(.*shell.*&[a-z_]+,' src/android.rs` lists every
//!      shell invocation. Each must be fed by a `DeviceShellCmd::render()`.
//!   2. `rg '\.user_input\(' src/android.rs` lists every untrusted shell
//!      segment. Each should be paired with a documented threat model.

use anyhow::{anyhow, bail, Context, Result};
use regex::Regex;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::utils::device_shell::DeviceShellCmd;
#[cfg(test)]
use crate::utils::private_state::create_private_dir;
use crate::utils::private_state::{
    atomic_write, create_private_file_if_missing, read_bounded_legacy_file, read_json_file,
    state_file, validate_identifier, validate_legacy_file_security,
};
use crate::utils::process::{ensure_success, run_with_limits, terminal_safe, terminal_safe_json};
use crate::utils::validate::{
    validate_permission_name, validate_pref_key, validate_relative_path, validate_sqlite_value,
    validate_xml_filename,
};

#[cfg(test)]
pub(crate) static LEGACY_STATE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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

fn password_regex() -> &'static Regex {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"password="([^"]*)""#).unwrap());
    &RE
}

fn is_text_entry_class(class: &str) -> bool {
    let compact: String = class
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .map(|character| character.to_ascii_lowercase())
        .collect();
    [
        "edittext",
        "textfield",
        "textinput",
        "autocompletetextview",
        "multiautocompletetextview",
        "searchview",
        "numberpicker",
    ]
    .iter()
    .any(|marker| compact.contains(marker))
}

fn has_sensitive_ui_marker(value: &str) -> bool {
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
        "creditcard",
        "cardnumber",
        "ccnumber",
        "ccsecuritycode",
        "securetextfield",
        "securetextinput",
    ]
    .iter()
    .any(|marker| compact.contains(marker))
}

fn is_sensitive_ui_node(
    class: &str,
    text: &str,
    resource_id: &str,
    content_desc: &str,
    password: bool,
) -> bool {
    password
        || is_text_entry_class(class)
        || has_sensitive_ui_marker(class)
        || has_sensitive_ui_marker(text)
        || has_sensitive_ui_marker(resource_id)
        || has_sensitive_ui_marker(content_desc)
}

fn is_sensitive_android_ui_node(node: &str) -> bool {
    let class = class_regex()
        .captures(node)
        .and_then(|capture| capture.get(1))
        .map_or("", |matched| matched.as_str());
    let text = text_regex()
        .captures(node)
        .and_then(|capture| capture.get(1))
        .map_or("", |matched| matched.as_str());
    let resource_id = resource_regex()
        .captures(node)
        .and_then(|capture| capture.get(1))
        .map_or("", |matched| matched.as_str());
    let content_desc = content_regex()
        .captures(node)
        .and_then(|capture| capture.get(1))
        .map_or("", |matched| matched.as_str());
    let password = password_regex()
        .captures(node)
        .and_then(|capture| capture.get(1))
        .is_some_and(|matched| matched.as_str().eq_ignore_ascii_case("true"));

    is_sensitive_ui_node(class, text, resource_id, content_desc, password)
}

fn redact_xml_attribute(node: &str, name: &str) -> String {
    let needle = format!("{name}=\"");
    let Some(attribute_start) = node.find(&needle) else {
        return node.to_owned();
    };
    let value_start = attribute_start + needle.len();
    let Some(value_end) = node[value_start..].find('"') else {
        return node.to_owned();
    };
    let value_end = value_start + value_end;
    if value_end == value_start {
        return node.to_owned();
    }

    let mut redacted = String::with_capacity(node.len());
    redacted.push_str(&node[..value_start]);
    redacted.push_str("[REDACTED]");
    redacted.push_str(&node[value_end..]);
    redacted
}

fn next_node_start(xml: &str, from: usize) -> Option<usize> {
    let mut search = from;
    loop {
        let start = search + xml.get(search..)?.find("<node")?;
        let after_name = start + "<node".len();
        let next = *xml.as_bytes().get(after_name)?;
        if !next.is_ascii_whitespace() && next != b'>' && next != b'/' {
            search = after_name;
            continue;
        }
        return Some(start);
    }
}

fn node_tag_end(xml: &str, start: usize) -> Option<usize> {
    let bytes = xml.as_bytes();
    let mut quote = None;
    for (index, byte) in bytes.iter().enumerate().skip(start + "<node".len()) {
        match quote {
            Some(delimiter) if *byte == delimiter => quote = None,
            None if *byte == b'"' || *byte == b'\'' => quote = Some(*byte),
            None if *byte == b'>' => return Some(index + 1),
            _ => {}
        }
    }
    None
}

fn sanitize_android_ui_xml(xml: &str) -> String {
    let mut output = String::with_capacity(xml.len());
    let mut cursor = 0;
    while let Some(start) = next_node_start(xml, cursor) {
        output.push_str(&xml[cursor..start]);
        let Some(end) = node_tag_end(xml, start) else {
            // A truncated tag is not safe to parse or display. Fail closed by
            // dropping it and the remaining malformed XML.
            return output;
        };
        let node = &xml[start..end];
        if is_sensitive_android_ui_node(node) {
            let redacted = redact_xml_attribute(node, "text");
            let redacted = redact_xml_attribute(&redacted, "resource-id");
            let redacted = redact_xml_attribute(&redacted, "content-desc");
            output.push_str(&redacted);
        } else {
            output.push_str(node);
        }
        cursor = end;
    }
    output.push_str(&xml[cursor..]);
    output
}

/// Build ADB command with optional device serial
fn adb_cmd(device: Option<&str>) -> Command {
    let mut cmd = Command::new("adb");
    if let Some(serial) = device {
        cmd.arg("-s").arg(serial);
    }
    cmd
}

/// Execute an ADB command with bounded output and a hard deadline.
fn adb_exec(
    device: Option<&str>,
    args: &[&str],
    timeout: Option<Duration>,
) -> Result<std::process::Output> {
    let mut command = adb_cmd(device);
    command.args(args);
    run_with_limits(
        &mut command,
        timeout.unwrap_or(Duration::from_secs(120)),
        64 * 1024 * 1024,
        "ADB command",
    )
}

/// Take screenshot and return PNG bytes
pub fn screenshot(device: Option<&str>) -> Result<Vec<u8>> {
    let output = adb_exec(device, &["exec-out", "screencap", "-p"], None)?;

    if !output.status.success() {
        bail!("adb screencap failed: {}", terminal_safe(&output.stderr));
    }

    Ok(output.stdout)
}

/// Tap at coordinates
pub fn tap(x: i32, y: i32, device: Option<&str>) -> Result<()> {
    let output = adb_exec(
        device,
        &["shell", "input", "tap", &x.to_string(), &y.to_string()],
        None,
    )?;

    if !output.status.success() {
        bail!("adb tap failed: {}", terminal_safe(&output.stderr));
    }

    println!("Tapped at ({}, {})", x, y);
    Ok(())
}

/// Long press at coordinates
pub fn long_press(x: i32, y: i32, duration: u32, device: Option<&str>) -> Result<()> {
    let output = adb_exec(
        device,
        &[
            "shell",
            "input",
            "swipe",
            &x.to_string(),
            &y.to_string(),
            &x.to_string(),
            &y.to_string(),
            &duration.to_string(),
        ],
        None,
    )?;

    if !output.status.success() {
        bail!("adb long press failed: {}", terminal_safe(&output.stderr));
    }

    println!("Long pressed at ({}, {}) for {}ms", x, y, duration);
    Ok(())
}

/// Open URL in default browser
pub fn open_url(url: &str, device: Option<&str>) -> Result<()> {
    let shell_cmd = DeviceShellCmd::new()
        .literal("am")
        .literal("start")
        .literal("-a")
        .literal("android.intent.action.VIEW")
        .literal("-d")
        .user_input(url)
        .render();
    let output = adb_exec(device, &["shell", &shell_cmd], None)?;
    if !output.status.success() {
        bail!("Failed to open URL");
    }
    println!("URL opened");
    Ok(())
}

/// Execute a shell command on the device.
pub fn shell(command: &str, device: Option<&str>) -> Result<String> {
    let output = adb_exec(device, &["shell", command], None)?;
    if !output.status.success() {
        let stderr = terminal_safe(&output.stderr);
        if stderr.is_empty() {
            bail!("adb shell failed: command failed");
        }
        bail!("adb shell failed: {}", stderr);
    }

    let stdout = terminal_safe(&output.stdout);
    print!("{stdout}");
    Ok(stdout)
}

/// Swipe gesture
pub fn swipe(
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
    duration: u32,
    device: Option<&str>,
) -> Result<()> {
    let output = adb_exec(
        device,
        &[
            "shell",
            "input",
            "swipe",
            &x1.to_string(),
            &y1.to_string(),
            &x2.to_string(),
            &y2.to_string(),
            &duration.to_string(),
        ],
        None,
    )?;

    if !output.status.success() {
        bail!("adb swipe failed: {}", terminal_safe(&output.stderr));
    }

    println!("Swiped from ({}, {}) to ({}, {})", x1, y1, x2, y2);
    Ok(())
}

/// Input text via `adb shell input text <string>`.
///
/// On-device `input text` receives a single token and treats `%s` as a literal
/// space (Android quirk). We POSIX-quote the value via [`DeviceShellCmd`] so
/// shell metacharacters cannot escape the argument; the `%s` swap stays as a
/// pre-quoting transformation so spaces become the literal-space sentinel
/// expected by `input text` rather than tripping the on-device tokenizer.
pub fn input_text(text: &str, device: Option<&str>) -> Result<()> {
    let with_space_sentinel = text.replace(' ', "%s");
    let shell_cmd = DeviceShellCmd::new()
        .literal("input")
        .literal("text")
        .user_input(&with_space_sentinel)
        .render();
    let output = adb_exec(device, &["shell", &shell_cmd], None)?;

    if !output.status.success() {
        bail!("adb input text failed");
    }

    println!("Input accepted ({} characters)", text.chars().count());
    Ok(())
}

fn resolve_android_keycode(key: &str) -> Option<&'static str> {
    match key.to_ascii_lowercase().as_str() {
        "home" => Some("KEYCODE_HOME"),
        "back" => Some("KEYCODE_BACK"),
        "enter" | "return" => Some("KEYCODE_ENTER"),
        "tab" => Some("KEYCODE_TAB"),
        "delete" | "backspace" => Some("KEYCODE_DEL"),
        "menu" => Some("KEYCODE_MENU"),
        "power" => Some("KEYCODE_POWER"),
        "volume_up" => Some("KEYCODE_VOLUME_UP"),
        "volume_down" => Some("KEYCODE_VOLUME_DOWN"),
        "camera" => Some("KEYCODE_CAMERA"),
        "search" => Some("KEYCODE_SEARCH"),
        "space" => Some("KEYCODE_SPACE"),
        "escape" | "esc" => Some("KEYCODE_ESCAPE"),
        "up" => Some("KEYCODE_DPAD_UP"),
        "down" => Some("KEYCODE_DPAD_DOWN"),
        "left" => Some("KEYCODE_DPAD_LEFT"),
        "right" => Some("KEYCODE_DPAD_RIGHT"),
        "app_switch" | "recent" => Some("KEYCODE_APP_SWITCH"),
        _ => None,
    }
}

/// Press a key
pub fn press_key(key: &str, device: Option<&str>) -> Result<()> {
    let keycode = resolve_android_keycode(key)
        .ok_or_else(|| anyhow!("Unsupported Android key: {}", terminal_safe(key.as_bytes())))?;

    let output = adb_exec(device, &["shell", "input", "keyevent", keycode], None)?;

    if !output.status.success() {
        bail!("adb keyevent failed: {}", terminal_safe(&output.stderr));
    }

    println!(
        "Pressed key: {} ({})",
        terminal_safe(key.as_bytes()),
        terminal_safe(keycode.as_bytes())
    );
    Ok(())
}

// ============== UI Dump (shared implementation) ==============

static UI_DUMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn ui_dump_shell_command(path: &str) -> String {
    let quoted_path = DeviceShellCmd::new().user_input(path).render();
    format!(
        "trap 'rm -f {quoted_path}' 0; uiautomator dump {quoted_path} >/dev/null 2>&1 && cat {quoted_path}"
    )
}

/// Fetch unredacted UI XML for internal selector matching only.
fn get_raw_ui_xml(device: Option<&str>) -> Result<String> {
    // Combined command: dump + cat + cleanup in one shell call
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let counter = UI_DUMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let path = format!(
        "/data/local/tmp/mcp-devices-ui-{}-{timestamp}-{counter}.xml",
        std::process::id()
    );
    let shell_command = ui_dump_shell_command(&path);
    let output = adb_exec(device, &["shell", &shell_command], None)?;

    if !output.status.success() {
        bail!("Failed to get UI dump: {}", terminal_safe(&output.stderr));
    }

    let xml = String::from_utf8_lossy(&output.stdout).to_string();
    if xml.is_empty() || !xml.contains("<hierarchy") {
        bail!("UI dump returned empty or invalid XML");
    }

    Ok(xml)
}

/// Return only redacted UI XML to output-facing consumers.
fn get_ui_xml(device: Option<&str>) -> Result<String> {
    Ok(sanitize_android_ui_xml(&get_raw_ui_xml(device)?))
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
        (
            (self.bounds.0 + self.bounds.2) / 2,
            (self.bounds.1 + self.bounds.3) / 2,
        )
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
    let safe_xml = sanitize_android_ui_xml(xml);
    let mut elements = Vec::new();

    for node in node_regex().find_iter(&safe_xml) {
        let node_str = node.as_str();

        let class = class_regex()
            .captures(node_str)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();

        let text = text_regex()
            .captures(node_str)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();

        let resource_id = resource_regex()
            .captures(node_str)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();

        let content_desc = content_regex()
            .captures(node_str)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();

        let Some(caps) = bounds_regex().captures(node_str) else {
            continue;
        };
        let Ok(x1) = caps[1].parse::<i32>() else {
            continue;
        };
        let Ok(y1) = caps[2].parse::<i32>() else {
            continue;
        };
        let Ok(x2) = caps[3].parse::<i32>() else {
            continue;
        };
        let Ok(y2) = caps[4].parse::<i32>() else {
            continue;
        };
        if x2 < x1 || y2 < y1 {
            continue;
        }
        let bounds = (x1, y1, x2, y2);

        let clickable = clickable_regex()
            .captures(node_str)
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
        let json = xml_to_json(&xml)?;
        println!("{}", terminal_safe(json.as_bytes()));
    } else {
        println!("{}", terminal_safe(xml.as_bytes()));
    }

    Ok(())
}

/// Convert UI XML to simplified JSON
fn xml_to_json(xml: &str) -> Result<String> {
    let safe_xml = sanitize_android_ui_xml(xml);
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

    for node in node_regex().find_iter(&safe_xml) {
        let node_str = node.as_str();

        let class = class_regex()
            .captures(node_str)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();

        let text = text_regex()
            .captures(node_str)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();

        let resource_id = resource_regex()
            .captures(node_str)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();

        let content_desc = content_regex()
            .captures(node_str)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();

        let bounds = bounds_string_regex()
            .captures(node_str)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default();

        let clickable = clickable_regex()
            .captures(node_str)
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
struct AndroidUiElementMatch<'a> {
    text: &'a str,
    resource_id: &'a str,
    content_desc: &'a str,
    bounds: (i32, i32, i32, i32),
    center: (i32, i32),
    sensitive: bool,
}

fn find_element_in_xml<'a>(xml: &'a str, query: &str) -> Result<Option<AndroidUiElementMatch<'a>>> {
    let query_lower = query.to_lowercase();
    for node in node_regex().find_iter(xml) {
        let node_str = node.as_str();
        let text = text_regex()
            .captures(node_str)
            .and_then(|capture| capture.get(1))
            .map(|matched| matched.as_str())
            .unwrap_or("");
        let resource_id = resource_regex()
            .captures(node_str)
            .and_then(|capture| capture.get(1))
            .map(|matched| matched.as_str())
            .unwrap_or("");
        let content_desc = content_regex()
            .captures(node_str)
            .and_then(|capture| capture.get(1))
            .map(|matched| matched.as_str())
            .unwrap_or("");

        if !text.to_lowercase().contains(&query_lower)
            && !resource_id.to_lowercase().contains(&query_lower)
            && !content_desc.to_lowercase().contains(&query_lower)
        {
            continue;
        }

        let Some(captures) = bounds_regex().captures(node_str) else {
            continue;
        };
        let coordinates = (
            captures[1].parse::<i32>(),
            captures[2].parse::<i32>(),
            captures[3].parse::<i32>(),
            captures[4].parse::<i32>(),
        );
        let (Ok(x1), Ok(y1), Ok(x2), Ok(y2)) = coordinates else {
            continue;
        };
        if x2 < x1 || y2 < y1 {
            continue;
        }
        let center_x = i32::try_from((i64::from(x1) + i64::from(x2)) / 2)
            .context("Android element horizontal bounds overflow")?;
        let center_y = i32::try_from((i64::from(y1) + i64::from(y2)) / 2)
            .context("Android element vertical bounds overflow")?;

        return Ok(Some(AndroidUiElementMatch {
            text,
            resource_id,
            content_desc,
            bounds: (x1, y1, x2, y2),
            center: (center_x, center_y),
            sensitive: is_sensitive_android_ui_node(node_str),
        }));
    }
    Ok(None)
}

fn safe_android_ui_value(value: &str, sensitive: bool) -> &str {
    if sensitive {
        "[REDACTED]"
    } else {
        value
    }
}

/// Find element by text/resource-id and return center coordinates
pub fn find_element(query: &str, device: Option<&str>) -> Result<Option<(i32, i32)>> {
    let xml = get_raw_ui_xml(device)?;
    let Some(found) = find_element_in_xml(&xml, query)? else {
        println!("Requested element was not found");
        return Ok(None);
    };

    println!(
        "Found: text=\"{}\" resource_id=\"{}\" content_desc=\"{}\"",
        terminal_safe(safe_android_ui_value(found.text, found.sensitive).as_bytes()),
        terminal_safe(safe_android_ui_value(found.resource_id, found.sensitive).as_bytes()),
        terminal_safe(safe_android_ui_value(found.content_desc, found.sensitive).as_bytes())
    );
    println!(
        "Bounds: [{},{}][{},{}] -> center: ({}, {})",
        found.bounds.0,
        found.bounds.1,
        found.bounds.2,
        found.bounds.3,
        found.center.0,
        found.center.1
    );
    Ok(Some(found.center))
}

fn find_ui_element_in_xml(
    xml: &str,
    text: Option<&str>,
    resource_id: Option<&str>,
    class_name: Option<&str>,
) -> Option<String> {
    let text_query = text.map(str::to_lowercase);
    let resource_query = resource_id.map(str::to_lowercase);
    let class_query = class_name.map(str::to_lowercase);

    for node in node_regex().find_iter(xml) {
        let node_str = node.as_str();

        if let Some(query) = text_query.as_deref() {
            let element_text = text_regex()
                .captures(node_str)
                .and_then(|capture| capture.get(1))
                .map(|matched| matched.as_str().to_lowercase())
                .unwrap_or_default();
            let element_desc = content_regex()
                .captures(node_str)
                .and_then(|capture| capture.get(1))
                .map(|matched| matched.as_str().to_lowercase())
                .unwrap_or_default();
            if !element_text.contains(query) && !element_desc.contains(query) {
                continue;
            }
        }

        if let Some(query) = resource_query.as_deref() {
            let element_resource_id = resource_regex()
                .captures(node_str)
                .and_then(|capture| capture.get(1))
                .map(|matched| matched.as_str().to_lowercase())
                .unwrap_or_default();
            if !element_resource_id.contains(query) {
                continue;
            }
        }

        if let Some(query) = class_query.as_deref() {
            let element_class = class_regex()
                .captures(node_str)
                .and_then(|capture| capture.get(1))
                .map(|matched| matched.as_str().to_lowercase())
                .unwrap_or_default();
            if !element_class.contains(query) {
                continue;
            }
        }

        let element_text = text_regex()
            .captures(node_str)
            .and_then(|capture| capture.get(1))
            .map(|matched| matched.as_str())
            .unwrap_or("");
        let element_resource_id = resource_regex()
            .captures(node_str)
            .and_then(|capture| capture.get(1))
            .map(|matched| matched.as_str())
            .unwrap_or("");
        let element_class = class_regex()
            .captures(node_str)
            .and_then(|capture| capture.get(1))
            .map(|matched| matched.as_str())
            .unwrap_or("");
        let element_bounds = bounds_string_regex()
            .captures(node_str)
            .and_then(|capture| capture.get(1))
            .map(|matched| matched.as_str())
            .unwrap_or("");
        let sensitive = is_sensitive_android_ui_node(node_str);

        return Some(format!(
            "class=\"{}\" text=\"{}\" resource_id=\"{}\" bounds={}",
            element_class,
            safe_android_ui_value(element_text, sensitive),
            safe_android_ui_value(element_resource_id, sensitive),
            element_bounds,
        ));
    }
    None
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
    let xml = get_raw_ui_xml(device)?;
    Ok(find_ui_element_in_xml(&xml, text, resource_id, class_name))
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
    let mut command = Command::new("adb");
    command.args(["devices", "-l"]);
    let output = run_with_limits(
        &mut command,
        Duration::from_secs(30),
        1024 * 1024,
        "ADB device listing",
    )?;
    ensure_success(&output, "ADB device listing")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut devices = Vec::new();

    for line in stdout.lines().skip(1) {
        if line.trim().is_empty() {
            continue;
        }

        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 2 {
            let model = parts
                .iter()
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
    println!("{}", terminal_safe_json(&devices)?);
    Ok(())
}

// ============== App Management ==============

/// List installed apps
pub fn list_apps(filter: Option<&str>, device: Option<&str>) -> Result<()> {
    let output = adb_exec(device, &["shell", "pm", "list", "packages", "-3"], None)?;

    if !output.status.success() {
        bail!("pm list packages failed: {}", terminal_safe(&output.stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut apps: Vec<String> = stdout
        .lines()
        .filter_map(|line| line.strip_prefix("package:"))
        .filter(|pkg| filter.map_or(true, |f| pkg.to_lowercase().contains(&f.to_lowercase())))
        .map(|s| s.to_string())
        .collect();

    apps.sort();

    println!("Installed apps ({}):", apps.len());
    for app in &apps {
        println!("  {}", terminal_safe(app.as_bytes()));
    }
    Ok(())
}

/// Launch an app (using am start for speed)
pub fn launch_app(package: &str, device: Option<&str>) -> Result<()> {
    validate_package_name(package)?;

    // Resolve launcher activity and start in one shell call.
    //
    // Note: the `$( … )` command-substitution is part of the trusted command
    // template; only `<package>` is dynamic and is validated above + quoted
    // by the builder. The substitution itself runs on-device and is bounded
    // by the surrounding literal flags.
    let resolve = DeviceShellCmd::new()
        .literal("cmd")
        .literal("package")
        .literal("resolve-activity")
        .literal("--brief")
        .literal("-c")
        .literal("android.intent.category.LAUNCHER")
        .validated(package, validate_package_name)?
        .literal("|")
        .literal("tail")
        .literal("-1")
        .render();
    let cmd = DeviceShellCmd::new()
        .literal("am")
        .literal("start")
        .literal("-a")
        .literal("android.intent.action.MAIN")
        .literal("-c")
        .literal("android.intent.category.LAUNCHER")
        .raw_trusted(format!("$({})", resolve))
        .render();

    let output = adb_exec(device, &["shell", &cmd], None)?;

    if !output.status.success() {
        // Fallback to monkey if resolve-activity fails (older Android)
        let fallback = adb_exec(
            device,
            &[
                "shell",
                "monkey",
                "-p",
                package,
                "-c",
                "android.intent.category.LAUNCHER",
                "1",
            ],
            None,
        )?;

        if !fallback.status.success() {
            bail!("Failed to launch {}", package);
        }
    }

    println!("Launched: {}", package);
    Ok(())
}

/// Stop an app
pub fn stop_app(package: &str, device: Option<&str>) -> Result<()> {
    validate_package_name(package)?;
    let cmd = DeviceShellCmd::new()
        .literal("am")
        .literal("force-stop")
        .validated(package, validate_package_name)?
        .render();
    let output = adb_exec(device, &["shell", &cmd], None)?;

    if !output.status.success() {
        bail!(
            "Failed to stop {}: {}",
            package,
            terminal_safe(&output.stderr)
        );
    }

    println!("Stopped: {}", package);
    Ok(())
}

/// Install an APK
pub fn install_app(path: &str, device: Option<&str>) -> Result<()> {
    println!("Installing {}...", terminal_safe(path.as_bytes()));

    let output = adb_exec(device, &["install", "-r", path], None)?;

    if !output.status.success() {
        bail!("Failed to install: {}", terminal_safe(&output.stderr));
    }

    println!("Installed: {}", terminal_safe(path.as_bytes()));
    Ok(())
}

/// Uninstall an app
pub fn uninstall_app(package: &str, device: Option<&str>) -> Result<()> {
    validate_package_name(package)?;
    println!("Uninstalling {}...", terminal_safe(package.as_bytes()));

    let output = adb_exec(device, &["uninstall", package], None)?;

    if !output.status.success() {
        bail!("Failed to uninstall: {}", terminal_safe(&output.stderr));
    }

    println!("Uninstalled: {}", terminal_safe(package.as_bytes()));
    Ok(())
}

// ============== System Commands ==============

/// Clear device logs
pub fn clear_logs(device: Option<&str>) -> Result<()> {
    let output = adb_exec(device, &["logcat", "-c"], None)?;

    if !output.status.success() {
        bail!("logcat clear failed: {}", terminal_safe(&output.stderr));
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
            }
            .to_string();
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
    println!(
        "  Memory: {} kB available / {} kB total",
        mem_available, mem_total
    );

    Ok(())
}

/// Get current activity/app
pub fn get_current_activity(device: Option<&str>) -> Result<()> {
    let output = adb_exec(device, &["shell", "dumpsys", "window"], None)?;
    let out = String::from_utf8_lossy(&output.stdout);

    for line in out.lines() {
        if line.contains("mCurrentFocus") || line.contains("mFocusedApp") {
            println!("{}", terminal_safe(line.trim().as_bytes()));
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
        bail!("logcat failed: {}", terminal_safe(&output.stderr));
    }

    print!("{}", terminal_safe(&output.stdout));
    Ok(())
}

/// Reboot device
pub fn reboot(device: Option<&str>) -> Result<()> {
    println!("Rebooting device...");
    let output = adb_exec(device, &["reboot"], None)?;

    if !output.status.success() {
        bail!("Failed to reboot: {}", terminal_safe(&output.stderr));
    }

    println!("Reboot initiated");
    Ok(())
}

/// Turn screen on/off
pub fn screen_power(on: bool, device: Option<&str>) -> Result<()> {
    // First check screen state
    let output = adb_exec(device, &["shell", "dumpsys", "power"], None)?;
    let power_out = String::from_utf8_lossy(&output.stdout);

    let is_screen_on =
        power_out.contains("mWakefulness=Awake") || power_out.contains("Display Power: state=ON");

    if on && !is_screen_on {
        // Turn screen on
        adb_exec(
            device,
            &["shell", "input", "keyevent", "KEYCODE_WAKEUP"],
            None,
        )?;
        println!("Screen turned ON");
    } else if !on && is_screen_on {
        // Turn screen off
        adb_exec(
            device,
            &["shell", "input", "keyevent", "KEYCODE_SLEEP"],
            None,
        )?;
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
                    let w: u32 = parts[0].parse().context("Invalid Android screen width")?;
                    let h: u32 = parts[1].parse().context("Invalid Android screen height")?;
                    if w == 0 || h == 0 {
                        bail!("Android screen size must be positive");
                    }
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
        } else if class_lower.contains("scroll")
            || class_lower.contains("recycler")
            || class_lower.contains("listview")
        {
            analysis.scrollable.push(info);
        } else if class_lower.contains("image") {
            analysis.images.push(info);
        }
    }

    println!("{}", terminal_safe_json(&analysis)?);
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
        let res_lower = elem
            .resource_id
            .to_lowercase()
            .replace('_', " ")
            .replace('/', " ");

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
            println!(
                "Found: \"{}\" (confidence: {}%)",
                terminal_safe_line(&elem.label()),
                best_score
            );
            tap(cx, cy, device)?;
            return Ok(());
        }
    }

    bail!(
        "No element matching '{}' found with confidence >= {}%",
        terminal_safe_line(description),
        min_confidence
    );
}

/// Push file to device
pub fn push_file(local: &str, remote: &str, device: Option<&str>) -> Result<()> {
    let output = adb_exec(device, &["push", local, remote], None)?;
    if !output.status.success() {
        bail!("adb push failed: {}", terminal_safe(&output.stderr));
    }
    println!(
        "Pushed {} -> {}",
        terminal_safe(local.as_bytes()),
        terminal_safe(remote.as_bytes())
    );
    Ok(())
}

/// Pull file from device
pub fn pull_file(remote: &str, local: &str, device: Option<&str>) -> Result<()> {
    let output = adb_exec(device, &["pull", remote, local], None)?;
    if !output.status.success() {
        bail!("adb pull failed: {}", terminal_safe(&output.stderr));
    }
    println!(
        "Pulled {} -> {}",
        terminal_safe(remote.as_bytes()),
        terminal_safe(local.as_bytes())
    );
    Ok(())
}

/// Get clipboard content
pub fn get_clipboard(device: Option<&str>) -> Result<()> {
    let output = adb_exec(
        device,
        &[
            "shell",
            "service",
            "call",
            "clipboard",
            "2",
            "s16",
            "com.android.shell",
        ],
        None,
    )?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Parse parcel response - extract string between single quotes
    if let Some(start) = stdout.find('\'') {
        if let Some(end) = stdout[start + 1..].find('\'') {
            let text = &stdout[start + 1..start + 1 + end];
            println!("{}", terminal_safe(text.replace("\\n", "\n").as_bytes()));
            return Ok(());
        }
    }
    println!("{}", terminal_safe(stdout.as_bytes()));
    Ok(())
}

/// Set clipboard content
pub fn set_clipboard(text: &str, device: Option<&str>) -> Result<()> {
    let cmd = DeviceShellCmd::new()
        .literal("am")
        .literal("broadcast")
        .literal("-a")
        .literal("clipper.set")
        .literal("-e")
        .literal("text")
        .user_input(text)
        .render();
    let output = adb_exec(device, &["shell", &cmd], None)?;
    if !output.status.success() {
        // Fallback: try input method, preserving its exit status and quoting
        // free-form clipboard text as a device-shell argument.
        let fallback_cmd = DeviceShellCmd::new()
            .literal("service")
            .literal("call")
            .literal("clipboard")
            .literal("1")
            .literal("s16")
            .literal("com.android.shell")
            .literal("s16")
            .user_input(text)
            .render();
        let fallback = adb_exec(device, &["shell", &fallback_cmd], None)?;
        if !fallback.status.success() {
            let stderr = terminal_safe(&fallback.stderr);
            if stderr.is_empty() {
                bail!("Failed to set clipboard: command failed");
            }
            bail!("Failed to set clipboard: {}", stderr);
        }
    }
    println!("Clipboard set");
    Ok(())
}

/// Compose the trusted shell fragment used by the turbo fast-track.
///
/// The action status is captured before the optional UI dump. The final exit
/// status is always the action status, so a failed dump cannot make flow replay
/// a successfully completed action, while a failed action remains an error.
fn compose_ui_dump_command(shell_cmd: &str) -> String {
    format!(
        "{shell_cmd}; action_status=$?; if [ \"$action_status\" -eq 0 ]; then \
         uiautomator dump /dev/tty; \
         fi; exit \"$action_status\""
    )
}

/// Execute an action command + UI dump in a single adb shell invocation.
///
/// Returns `(action_output, ui_xml)`. UI dump failures are non-fatal after a
/// successful action; the action's nonzero exit status is always propagated.
///
/// `shell_cmd` is a pre-composed, trusted shell fragment (produced by the
/// turbo fast-track builders in `flow.rs`). It is joined with a trusted UI
/// dump suffix via [`DeviceShellCmd::raw_trusted`] — DO NOT pass user input.
pub fn exec_with_ui_dump(shell_cmd: &str, device: Option<&str>) -> Result<(String, String)> {
    let combined = DeviceShellCmd::new()
        .raw_trusted(compose_ui_dump_command(shell_cmd))
        .render();
    let output = adb_exec(device, &["shell", &combined], None)?;
    if !output.status.success() {
        let stderr = terminal_safe(&output.stderr);
        if stderr.is_empty() {
            bail!("ADB action failed: command failed");
        }
        bail!("ADB action failed: {}", stderr);
    }
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();

    // Split at XML boundary.
    let xml_start = stdout.find("<?xml").or_else(|| stdout.find("<hierarchy"));
    match xml_start {
        Some(idx) => {
            let action_output = stdout[..idx].trim().to_string();
            let mut ui_xml = stdout[idx..].to_string();
            // Strip "UI hierarchy dumped to: /dev/tty" prefix if present.
            if let Some(xml_idx) = ui_xml.find("<?xml") {
                if xml_idx > 0 {
                    ui_xml = ui_xml[xml_idx..].to_string();
                }
            }
            ui_xml = sanitize_android_ui_xml(&ui_xml);
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
pub fn sensor_location(
    latitude: f64,
    longitude: f64,
    altitude: f64,
    device: Option<&str>,
) -> Result<()> {
    // Detect if this is an emulator by checking the device serial prefix
    let is_emulator = device
        .map(|d| d.starts_with("emulator-"))
        .unwrap_or_else(|| {
            adb_exec(
                device,
                &["shell", "getprop", "ro.build.characteristics"],
                None,
            )
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("emulator"))
            .unwrap_or(false)
        });

    if is_emulator {
        // `emu geo fix <lon> <lat> [<alt>]` — note: longitude before latitude in emu command.
        // Coordinates are `f64`; they cannot contain shell metacharacters.
        let cmd = DeviceShellCmd::new()
            .literal("emu")
            .literal("geo")
            .literal("fix")
            .user_input(&longitude.to_string())
            .user_input(&latitude.to_string())
            .user_input(&altitude.to_string())
            .render();
        let output = adb_exec(device, &["shell", &cmd], None)?;
        if !output.status.success() {
            bail!("emu geo fix failed: {}", terminal_safe(&output.stderr));
        }
    } else {
        // Broadcast a mock location to any registered listener.
        let cmd = DeviceShellCmd::new()
            .literal("am")
            .literal("broadcast")
            .literal("-a")
            .literal("com.android.shell.action.MOCK_LOCATION")
            .literal("--ef")
            .literal("latitude")
            .user_input(&latitude.to_string())
            .literal("--ef")
            .literal("longitude")
            .user_input(&longitude.to_string())
            .literal("--ef")
            .literal("altitude")
            .user_input(&altitude.to_string())
            .render();
        let output = adb_exec(device, &["shell", &cmd], None)?;
        if !output.status.success() {
            bail!(
                "Mock location broadcast failed: {}",
                terminal_safe(&output.stderr)
            );
        }
    }

    println!(
        "Location set: lat={}, lon={}, alt={}",
        latitude, longitude, altitude
    );
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
            bail!("Battery reset failed: {}", terminal_safe(&output.stderr));
        }
        println!("Battery state reset");
        return Ok(());
    }

    if let Some(lvl) = level {
        if lvl > 100 {
            bail!("Battery level must be 0-100, got {}", lvl);
        }
        let output = adb_exec(
            device,
            &[
                "shell",
                "dumpsys",
                "battery",
                "set",
                "level",
                &lvl.to_string(),
            ],
            None,
        )?;
        if !output.status.success() {
            bail!(
                "Failed to set battery level: {}",
                terminal_safe(&output.stderr)
            );
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
        let output = adb_exec(
            device,
            &["shell", "dumpsys", "battery", "set", "status", code],
            None,
        )?;
        if !output.status.success() {
            bail!(
                "Failed to set battery status: {}",
                terminal_safe(&output.stderr)
            );
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
        let output = adb_exec(
            device,
            &["shell", "dumpsys", "battery", "set", "ac", code],
            None,
        )?;
        if !output.status.success() {
            bail!(
                "Failed to set battery plugged state: {}",
                terminal_safe(&output.stderr)
            );
        }
        println!("Battery plugged set to {}", p);
    }

    Ok(())
}

/// Read active notifications from `dumpsys notification --noredact`.
pub fn sensor_notifications(package: Option<&str>, device: Option<&str>) -> Result<()> {
    let output = adb_exec(
        device,
        &["shell", "dumpsys", "notification", "--noredact"],
        None,
    )?;
    if !output.status.success() {
        bail!(
            "dumpsys notification failed: {}",
            terminal_safe(&output.stderr)
        );
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
                        pkg: &str,
                        notif_id: &str,
                        tag: &str,
                        title: &str,
                        body: &str,
                        channel: &str,
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
                flush_record(
                    &mut notifications,
                    &pkg,
                    &notif_id,
                    &tag,
                    &title,
                    &body,
                    &channel,
                    package,
                );
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
            notif_id = trimmed
                .trim_start_matches("id=")
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_string();
        } else if trimmed.starts_with("tag=") {
            tag = trimmed
                .trim_start_matches("tag=")
                .trim()
                .trim_matches('"')
                .to_string();
        } else if trimmed.contains("android.title=") {
            title = trimmed
                .split("android.title=")
                .nth(1)
                .unwrap_or("")
                .trim()
                .to_string();
        } else if trimmed.contains("android.text=") {
            body = trimmed
                .split("android.text=")
                .nth(1)
                .unwrap_or("")
                .trim()
                .to_string();
        } else if trimmed.starts_with("channel=Channel{") {
            channel = trimmed
                .split("id=")
                .nth(1)
                .and_then(|s| s.split(',').next())
                .unwrap_or("")
                .trim()
                .to_string();
        }
    }

    if in_record {
        flush_record(
            &mut notifications,
            &pkg,
            &notif_id,
            &tag,
            &title,
            &body,
            &channel,
            package,
        );
    }

    println!("{}", terminal_safe_json(&notifications)?);
    Ok(())
}

/// Override or reset thermal status via `cmd thermalservice`.
pub fn sensor_thermal(status: Option<&str>, reset: bool, device: Option<&str>) -> Result<()> {
    if reset {
        let output = adb_exec(device, &["shell", "cmd", "thermalservice", "reset"], None)?;
        if !output.status.success() {
            bail!("Thermal reset failed: {}", terminal_safe(&output.stderr));
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

    let output = adb_exec(
        device,
        &["shell", "cmd", "thermalservice", "override-status", code],
        None,
    )?;
    if !output.status.success() {
        bail!("Thermal override failed: {}", terminal_safe(&output.stderr));
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
                    trimmed
                        .trim_start_matches("userId=")
                        .split_whitespace()
                        .next()
                        .map(|s| s.to_string())
                } else {
                    None
                }
            })
            .ok_or_else(|| anyhow::anyhow!("Could not determine UID for package '{}'", pkg))?;

        // Read xt_qtaguid stats and sum rx/tx bytes for the matching uid
        let stats_out = adb_exec(
            device,
            &["shell", "cat", "/proc/net/xt_qtaguid/stats"],
            None,
        )?;
        let stats_text = String::from_utf8_lossy(&stats_out.stdout);

        let mut rx_bytes: u64 = 0;
        let mut tx_bytes: u64 = 0;
        let mut rx_packets: u64 = 0;
        let mut tx_packets: u64 = 0;

        for line in stats_text.lines().skip(1) {
            // Format: idx iface acct_tag_hex uid_tag_int cnt_set rx_bytes rx_packets tx_bytes tx_packets ...
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() >= 9 {
                let Ok(row_uid) = cols[3].parse::<u64>() else {
                    continue;
                };
                // uid_tag_int encodes uid in upper 32 bits when tag != 0
                let actual_uid: u64 = if row_uid > 100_000 {
                    row_uid >> 32
                } else {
                    row_uid
                };
                if actual_uid.to_string() == uid {
                    let values = (
                        cols[5].parse::<u64>(),
                        cols[6].parse::<u64>(),
                        cols[7].parse::<u64>(),
                        cols[8].parse::<u64>(),
                    );
                    let (Ok(rx_b), Ok(rx_p), Ok(tx_b), Ok(tx_p)) = values else {
                        continue;
                    };
                    rx_bytes = rx_bytes
                        .checked_add(rx_b)
                        .context("Android RX byte count overflow")?;
                    rx_packets = rx_packets
                        .checked_add(rx_p)
                        .context("Android RX packet count overflow")?;
                    tx_bytes = tx_bytes
                        .checked_add(tx_b)
                        .context("Android TX byte count overflow")?;
                    tx_packets = tx_packets
                        .checked_add(tx_p)
                        .context("Android TX packet count overflow")?;
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

        println!("{}", terminal_safe_json(&result)?);
    } else {
        // Global stats from netstats
        let output = adb_exec(device, &["shell", "dumpsys", "netstats", "--detail"], None)?;
        if !output.status.success() {
            bail!("netstats failed: {}", terminal_safe(&output.stderr));
        }
        print!("{}", terminal_safe(&output.stdout));
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
            active_network = t
                .trim_start_matches("Active default network:")
                .trim()
                .to_string();
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
                wifi_ssid = ssid
                    .split(',')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .trim_matches('"')
                    .to_string();
            }
        }
    }

    let result = serde_json::json!({
        "active_network": active_network,
        "wifi_state": wifi_state,
        "wifi_ssid": wifi_ssid,
        "mobile_state": mobile_state,
    });

    println!("{}", terminal_safe_json(&result)?);
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
        let output = adb_exec(
            device,
            &["shell", "settings", "put", "global", "http_proxy", ":0"],
            None,
        )?;
        if !output.status.success() {
            bail!("Failed to clear proxy: {}", terminal_safe(&output.stderr));
        }
        println!("HTTP proxy cleared");
        return Ok(());
    }

    if host.is_none() && port.is_none() {
        // Read current proxy
        let output = adb_exec(
            device,
            &["shell", "settings", "get", "global", "http_proxy"],
            None,
        )?;
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let display_value = if value.is_empty() || value == "null" {
            "(none)".to_string()
        } else {
            terminal_safe_line(&value)
        };
        println!("Current HTTP proxy: {display_value}");
        return Ok(());
    }

    let h = host.ok_or_else(|| anyhow::anyhow!("--host is required when setting proxy"))?;
    let p = port.ok_or_else(|| anyhow::anyhow!("--port is required when setting proxy"))?;
    let proxy_value = format!("{}:{}", h, p);

    let output = adb_exec(
        device,
        &[
            "shell",
            "settings",
            "put",
            "global",
            "http_proxy",
            &proxy_value,
        ],
        None,
    )?;
    if !output.status.success() {
        bail!("Failed to set proxy: {}", terminal_safe(&output.stderr));
    }

    println!("HTTP proxy set to {}", terminal_safe_line(&proxy_value));
    Ok(())
}

/// Enable or disable airplane mode.
pub fn network_airplane(enabled: bool, device: Option<&str>) -> Result<()> {
    let value = if enabled { "1" } else { "0" };

    // Set the global setting
    let out1 = adb_exec(
        device,
        &[
            "shell",
            "settings",
            "put",
            "global",
            "airplane_mode_on",
            value,
        ],
        None,
    )?;
    if !out1.status.success() {
        bail!(
            "Failed to set airplane_mode_on: {}",
            terminal_safe(&out1.stderr)
        );
    }

    // Broadcast the change so Android applies it immediately
    let out2 = adb_exec(
        device,
        &[
            "shell",
            "am",
            "broadcast",
            "-a",
            "android.intent.action.AIRPLANE_MODE",
            "--ez",
            "state",
            if enabled { "true" } else { "false" },
        ],
        None,
    )?;
    if !out2.status.success() {
        bail!(
            "Airplane mode broadcast failed: {}",
            terminal_safe(&out2.stderr)
        );
    }

    println!(
        "Airplane mode {}",
        if enabled { "enabled" } else { "disabled" }
    );
    Ok(())
}

// ============== Permission Commands ==============

/// Grant a permission to a package (Android).
pub fn permission_grant(package: &str, permission: &str, device: Option<&str>) -> Result<()> {
    validate_package_name(package)?;
    validate_permission_name(permission)?;
    let cmd = DeviceShellCmd::new()
        .literal("pm")
        .literal("grant")
        .validated(package, validate_package_name)?
        .validated(permission, validate_permission_name)?
        .render();
    let output = adb_exec(device, &["shell", &cmd], None)?;
    let stderr = terminal_safe(&output.stderr);
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
    validate_permission_name(permission)?;
    let cmd = DeviceShellCmd::new()
        .literal("pm")
        .literal("revoke")
        .validated(package, validate_package_name)?
        .validated(permission, validate_permission_name)?
        .render();
    let output = adb_exec(device, &["shell", &cmd], None)?;
    let stderr = terminal_safe(&output.stderr);
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
    let cmd = DeviceShellCmd::new()
        .literal("pm")
        .literal("reset-permissions")
        .validated(package, validate_package_name)?
        .render();
    let output = adb_exec(device, &["shell", &cmd], None)?;
    if !output.status.success() {
        bail!(
            "pm reset-permissions failed: {}",
            terminal_safe(&output.stderr)
        );
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
    let mut cmd = DeviceShellCmd::new().literal("am").literal("start");

    if let Some(a) = action {
        cmd = cmd.literal("-a").user_input(a);
    }
    if let Some(c) = component {
        cmd = cmd.literal("-n").user_input(c);
    }
    if let Some(d) = data {
        cmd = cmd.literal("-d").user_input(d);
    }
    if let Some(cat) = category {
        cmd = cmd.literal("-c").user_input(cat);
    }
    if let Some(pkg) = package {
        cmd = cmd
            .literal("--package")
            .validated(pkg, validate_package_name)?;
    }
    if let Some(f) = flags {
        cmd = cmd.literal("-f").user_input(f);
    }
    if let Some(extras_json) = extras {
        cmd = append_extras_to_cmd(cmd, extras_json)?;
    }

    let rendered = cmd.render();
    let output = adb_exec(device, &["shell", &rendered], None)?;
    if !output.status.success() {
        bail!("Android intent start failed");
    }
    if String::from_utf8_lossy(&output.stdout)
        .to_ascii_lowercase()
        .contains("error:")
    {
        bail!("Android intent start failed");
    }
    println!("Intent started");
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
    let mut cmd = DeviceShellCmd::new()
        .literal("am")
        .literal("broadcast")
        .literal("-a")
        .user_input(action);

    if let Some(pkg) = package {
        cmd = cmd
            .literal("--package")
            .validated(pkg, validate_package_name)?;
    }
    if let Some(comp) = component {
        cmd = cmd.literal("-n").user_input(comp);
    }
    if let Some(extras_json) = extras {
        cmd = append_extras_to_cmd(cmd, extras_json)?;
    }

    let rendered = cmd.render();
    let output = adb_exec(device, &["shell", &rendered], None)?;
    if !output.status.success() {
        bail!("Android broadcast failed");
    }
    println!("Broadcast sent");
    Ok(())
}

/// Open a deep-link URI via `am start -a android.intent.action.VIEW -d <uri>`.
pub fn intent_deeplink(uri: &str, package: Option<&str>, device: Option<&str>) -> Result<()> {
    let mut cmd = DeviceShellCmd::new()
        .literal("am")
        .literal("start")
        .literal("-a")
        .literal("android.intent.action.VIEW")
        .literal("-d")
        .user_input(uri);
    if let Some(pkg) = package {
        cmd = cmd
            .literal("--package")
            .validated(pkg, validate_package_name)?;
    }

    let rendered = cmd.render();
    let output = adb_exec(device, &["shell", &rendered], None)?;
    if !output.status.success()
        || String::from_utf8_lossy(&output.stdout)
            .to_ascii_lowercase()
            .contains("error:")
    {
        bail!("Android deep-link failed");
    }
    println!("Deep-link opened");
    Ok(())
}

/// List running services via `dumpsys activity services`.
pub fn intent_services(package: Option<&str>, device: Option<&str>) -> Result<()> {
    let mut cmd = DeviceShellCmd::new()
        .literal("dumpsys")
        .literal("activity")
        .literal("services");
    if let Some(pkg) = package {
        cmd = cmd.validated(pkg, validate_package_name)?;
    }

    let rendered = cmd.render();
    let output = adb_exec(device, &["shell", &rendered], None)?;
    if !output.status.success() {
        bail!(
            "dumpsys activity services failed: {}",
            terminal_safe(&output.stderr)
        );
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
        print!("{}", terminal_safe(text.as_bytes()));
    } else {
        println!("{}", terminal_safe_json(&services)?);
    }

    Ok(())
}

// ============== Sandbox Commands ==============

/// Read SharedPreferences XML from app sandbox via `run-as`.
///
/// SECURITY: `package` is validated at entry (whitelist) AND single-quoted by
/// the builder. The XML path is composed from a trusted `shared_prefs/` prefix
/// plus a validated filename, then single-quoted as well.
pub fn sandbox_prefs_read(package: &str, file: Option<&str>, device: Option<&str>) -> Result<()> {
    validate_package_name(package)?;
    let filename = file.unwrap_or("default_preferences");
    let xml_file = if filename.ends_with(".xml") {
        filename.to_string()
    } else {
        format!("{}.xml", filename)
    };
    validate_xml_filename(&xml_file)?;

    let prefs_path = format!("shared_prefs/{}", xml_file);
    let cmd = DeviceShellCmd::new()
        .literal("run-as")
        .validated(package, validate_package_name)?
        .literal("cat")
        .user_input(&prefs_path)
        .render();
    let output = adb_exec(device, &["shell", &cmd], None)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = terminal_safe(&output.stderr);

    if !output.status.success() || stderr.contains("Permission denied") {
        bail!("sandbox prefs read failed: {}", stderr);
    }

    print!("{}", terminal_safe(stdout.as_bytes()));
    Ok(())
}

/// Write or update a preference key in SharedPreferences XML via `run-as` + `sed`.
///
/// SECURITY: `package`, `xml_file`, `key`, and `value` are all interpolated raw
/// into a device-side `sh` command (`sh -c 'run-as <pkg> sed -i ...'`). All are
/// whitelisted at entry; the `sed` expression itself is single-quoted but that
/// is defence-in-depth only — the validators are the primary guarantee.
pub fn sandbox_prefs_write(
    package: &str,
    file: &str,
    key: &str,
    value: &str,
    pref_type: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    validate_package_name(package)?;
    validate_pref_key(key)?;
    validate_sqlite_value(value)?;

    let xml_file = if file.ends_with(".xml") {
        file.to_string()
    } else {
        format!("{}.xml", file)
    };
    validate_xml_filename(&xml_file)?;

    let type_tag = match pref_type.unwrap_or("string") {
        "boolean" | "bool" => "boolean",
        "int" | "integer" => "int",
        "long" => "long",
        "float" => "float",
        _ => "string",
    };

    // Build sed expression to replace existing entry in the XML.
    // `key` is whitelisted to `[A-Za-z0-9._-]` and `value` is whitelisted by
    // `validate_sqlite_value` — both are safe to embed inside the sed pattern.
    let sed_expr = if type_tag == "string" {
        format!(
            r#"s|<string name="{}">[^<]*</string>|<string name="{}">{}</string>|g"#,
            key, key, value
        )
    } else {
        format!(
            r#"s|<{t} name="{k}" value="[^"]*" />|<{t} name="{k}" value="{v}" />|g"#,
            t = type_tag,
            k = key,
            v = value
        )
    };

    let path = format!("shared_prefs/{}", xml_file);
    let cmd = DeviceShellCmd::new()
        .literal("run-as")
        .validated(package, validate_package_name)?
        .literal("sed")
        .literal("-i")
        .user_input(&sed_expr)
        .user_input(&path)
        .render();

    let output = adb_exec(device, &["shell", &cmd], None)?;
    let stderr = terminal_safe(&output.stderr);

    if !output.status.success() || stderr.contains("Permission denied") {
        bail!("sandbox prefs write failed");
    }

    println!(
        "Preference updated: {}.{} (type: {})",
        xml_file, key, type_tag
    );
    Ok(())
}

/// Execute a SQLite query on the app's database via `run-as`.
///
/// SECURITY: `package` and `database` are interpolated raw into a device-side
/// `sh` command. `query` is wrapped in single quotes and `'` chars are escaped
/// as `'\''` — this is the standard shell-safe quoting for arbitrary SQL.
/// The SQL string itself is intentionally pass-through because SQL *is* the
/// API surface of this command; the user is expected to be trusted to write
/// SQL. The whitelists on `package`/`database` prevent breaking out of the
/// surrounding shell command.
pub fn sandbox_sqlite_query(
    package: &str,
    database: &str,
    query: &str,
    device: Option<&str>,
) -> Result<()> {
    validate_package_name(package)?;

    let db_path = if database.starts_with('/') {
        // Caller explicitly requested an absolute path on the device. We still
        // ban shell metachars; the rest of the path is treated as opaque.
        for b in database.bytes() {
            let bad = matches!(
                b,
                b';' | b'&'
                    | b'|'
                    | b'<'
                    | b'>'
                    | b'$'
                    | b'('
                    | b')'
                    | b'{'
                    | b'}'
                    | b'*'
                    | b'?'
                    | b'['
                    | b']'
                    | b'\\'
                    | b'\''
                    | b'"'
                    | b'`'
                    | b'\n'
                    | b'\r'
                    | b'\t'
                    | b' '
                    | 0
            );
            if bad {
                bail!(
                    "Database path '{}' contains a disallowed character",
                    database
                );
            }
        }
        if database.split('/').any(|seg| seg == "..") {
            bail!("Database path '{}' contains '..'", database);
        }
        database.to_string()
    } else {
        validate_relative_path(database)?;
        format!("databases/{}", database)
    };

    // `query` is intentionally passed through unvalidated — SQL *is* this
    // command's API. The builder POSIX-quotes it so embedded shell metachars
    // (`;`, `$`, backticks, etc.) cannot break out of the surrounding shell.
    let cmd = DeviceShellCmd::new()
        .literal("run-as")
        .validated(package, validate_package_name)?
        .literal("sqlite3")
        .user_input(&db_path)
        .user_input(query)
        .render();

    let output = adb_exec(device, &["shell", &cmd], None)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = terminal_safe(&output.stderr);

    if !output.status.success() || stderr.contains("Permission denied") {
        bail!("sqlite query failed: {}", stderr);
    }

    print!("{}", terminal_safe(stdout.as_bytes()));
    Ok(())
}

/// List files in the app sandbox directory via `run-as`.
///
/// SECURITY: `package` and `dir` are interpolated raw into a device-side `sh`
/// command. Both are whitelisted at entry.
pub fn sandbox_file_list(package: &str, path: Option<&str>, device: Option<&str>) -> Result<()> {
    validate_package_name(package)?;
    let dir = path.unwrap_or(".");
    validate_relative_path(dir)?;
    let cmd = DeviceShellCmd::new()
        .literal("run-as")
        .validated(package, validate_package_name)?
        .literal("ls")
        .literal("-la")
        .validated(dir, validate_relative_path)?
        .render();

    let output = adb_exec(device, &["shell", &cmd], None)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = terminal_safe(&output.stderr);

    if !output.status.success() || stderr.contains("Permission denied") {
        bail!("sandbox file list failed: {}", stderr);
    }

    print!("{}", terminal_safe(stdout.as_bytes()));
    Ok(())
}

/// Read a file from the app sandbox via `run-as`, with optional byte limit.
///
/// SECURITY: `package` and `path` are interpolated raw into a device-side `sh`
/// command. Both are whitelisted at entry. `max_bytes` is a `u64` so it is
/// safe to format directly.
pub fn sandbox_file_read(
    package: &str,
    path: &str,
    max_bytes: Option<u64>,
    device: Option<&str>,
) -> Result<()> {
    validate_package_name(package)?;
    validate_relative_path(path)?;

    let cmd = if let Some(limit) = max_bytes {
        // `dd if=<path> bs=1 count=<n>` — `if=…` and `count=…` are single
        // argv tokens; the prefixes are static literals, the values are
        // quoted by the builder. `2>/dev/null` is a shell-level redirect,
        // so it stays a separate trusted literal.
        let if_arg = format!("if={}", path);
        let count_arg = format!("count={}", limit);
        DeviceShellCmd::new()
            .literal("run-as")
            .validated(package, validate_package_name)?
            .literal("dd")
            .user_input(&if_arg)
            .literal("bs=1")
            // `limit` is `u64`; no metachars possible — `user_input` is
            // used here purely for consistency with the `if=` segment.
            .user_input(&count_arg)
            .literal("2>/dev/null")
            .render()
    } else {
        DeviceShellCmd::new()
            .literal("run-as")
            .validated(package, validate_package_name)?
            .literal("cat")
            .validated(path, validate_relative_path)?
            .render()
    };

    let output = adb_exec(device, &["shell", &cmd], None)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = terminal_safe(&output.stderr);

    if !output.status.success() || stderr.contains("Permission denied") {
        bail!("sandbox file read failed: {}", stderr);
    }

    print!("{}", terminal_safe(stdout.as_bytes()));
    Ok(())
}

// ============== Performance Commands ==============

/// Parse total PSS (kB) from `dumpsys meminfo <pkg>` output.
fn parse_total_pss(meminfo: &str) -> Option<u64> {
    for line in meminfo.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("TOTAL PSS:") || trimmed.starts_with("TOTAL:") {
            let column = trimmed
                .split_whitespace()
                .nth(2)
                .or_else(|| trimmed.split_whitespace().nth(1));
            if let Some(value) = column {
                let digits: String = value.chars().filter(char::is_ascii_digit).collect();
                if let Ok(parsed) = digits.parse::<u64>() {
                    return Some(parsed);
                }
            }
        }
        if trimmed.contains("TOTAL HEAP:") {
            if let Some(value) = trimmed.split_whitespace().nth(2) {
                let digits: String = value.chars().filter(char::is_ascii_digit).collect();
                if let Ok(parsed) = digits.parse::<u64>() {
                    return Some(parsed);
                }
            }
        }
    }

    let mut sum = 0_u64;
    let mut found_heap = false;
    for line in meminfo.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("Native Heap") || trimmed.starts_with("Dalvik Heap") {
            if let Some(value) = trimmed
                .split_whitespace()
                .find(|token| !token.is_empty() && token.chars().all(|char| char.is_ascii_digit()))
            {
                if let Ok(parsed) = value.parse::<u64>() {
                    sum = sum.saturating_add(parsed);
                    found_heap = true;
                }
            }
        }
    }
    found_heap.then_some(sum)
}

/// Parse top-level memory MB from `dumpsys meminfo <pkg>`.
fn parse_meminfo(meminfo: &str) -> Option<(f64, u64)> {
    let total_pss = parse_total_pss(meminfo)?;
    Some((total_pss as f64 / 1024.0, total_pss))
}

/// Parse CPU percent for a package from `dumpsys cpuinfo` output.
fn parse_cpu_percent(cpuinfo: &str, package: &str) -> Option<f64> {
    for line in cpuinfo.lines() {
        if line.contains(package) {
            if let Some(percent) = line.trim().split('%').next() {
                let numeric: String = percent
                    .trim()
                    .chars()
                    .filter(|char| char.is_ascii_digit() || *char == '.')
                    .collect();
                if let Ok(value) = numeric.parse::<f64>() {
                    return value.is_finite().then_some(value);
                }
            }
        }
    }
    None
}

/// Parse battery charge level from `dumpsys battery`.
fn parse_battery_level(battery: &str) -> Option<u8> {
    for line in battery.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("level:") {
            return trimmed
                .split_once(':')
                .and_then(|(_, value)| value.trim().parse::<u8>().ok())
                .filter(|level| *level <= 100);
        }
    }
    None
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

    let (memory_mb, total_pss) =
        parse_meminfo(&meminfo_text).context("Android memory metrics are unavailable")?;
    let cpu_percent = parse_cpu_percent(&cpuinfo_text, package)
        .context("Android CPU metrics are unavailable for the package")?;
    let battery_level =
        parse_battery_level(&battery_text).context("Android battery metrics are unavailable")?;

    let mut total_frames = None;
    let mut janky_frames = None;
    for line in gfxinfo_text.lines() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("Total frames rendered:") {
            total_frames = value.trim().parse::<u64>().ok();
        }
        if let Some(value) = trimmed.strip_prefix("Janky frames:") {
            janky_frames = value
                .split_whitespace()
                .next()
                .and_then(|count| count.parse::<u64>().ok());
        }
    }
    let total_frames = total_frames.context("Android total frame count is unavailable")?;
    let janky_frames = janky_frames.context("Android janky frame count is unavailable")?;
    let janky_percent = if total_frames == 0 {
        0.0
    } else {
        (janky_frames as f64 / total_frames as f64) * 100.0
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
    println!("{}", terminal_safe_json(&snapshot)?);
    Ok(())
}

const MAX_PERF_BASELINE_BYTES: u64 = 64 * 1024;
const LEGACY_TMP_DIR_ENV: &str = "MCP_DEVICES_LEGACY_TMP_DIR";
#[cfg(test)]
const TEST_STATE_ROOT_ENV: &str = "MCP_DEVICES_TEST_STATE_ROOT";

fn performance_baseline_path(name: &str) -> Result<PathBuf> {
    validate_identifier(name, "baseline name")?;
    #[cfg(test)]
    if let Some(root) = std::env::var_os(TEST_STATE_ROOT_ENV) {
        let directory = PathBuf::from(root).join("performance-baselines");
        create_private_dir(&directory)?;
        return Ok(directory.join(format!("{name}.json")));
    }
    state_file("performance-baselines", name, "json")
}

fn legacy_tmp_dir() -> PathBuf {
    std::env::var_os(LEGACY_TMP_DIR_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

fn legacy_baseline_path(name: &str) -> PathBuf {
    legacy_tmp_dir().join(format!("claude-mobile-baseline-{name}.json"))
}

fn migrate_legacy_baseline(name: &str, destination: &Path) -> Result<()> {
    validate_identifier(name, "baseline name")?;
    match fs::symlink_metadata(destination) {
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Cannot inspect baseline {}", destination.display()));
        }
    }

    let legacy = legacy_baseline_path(name);
    let metadata = match fs::symlink_metadata(&legacy) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Cannot inspect legacy baseline {}", legacy.display()));
        }
    };
    validate_legacy_file_security(&legacy, &metadata, "Legacy performance baseline")?;

    let contents =
        read_bounded_legacy_file(&legacy, MAX_PERF_BASELINE_BYTES, "performance baseline")?;
    serde_json::from_slice::<serde_json::Value>(&contents).with_context(|| {
        format!(
            "Corrupt legacy performance baseline at {}",
            legacy.display()
        )
    })?;
    if create_private_file_if_missing(destination, &contents, "performance baseline")? {
        match fs::remove_file(&legacy) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "Cannot remove migrated performance baseline {}",
                        legacy.display()
                    )
                });
            }
        }
    }
    Ok(())
}

/// Save a perf snapshot as a named baseline in private user state.
pub fn perf_baseline(package: &str, name: &str, device: Option<&str>) -> Result<()> {
    validate_package_name(package)?;
    let snapshot = collect_perf_snapshot_value(package, device)?;
    let path = performance_baseline_path(name)?;
    let json = serde_json::to_vec_pretty(&snapshot)?;
    atomic_write(&path, &json)?;

    println!(
        "Baseline '{}' saved to {}",
        terminal_safe(name.as_bytes()),
        terminal_safe(path.display().to_string().as_bytes())
    );
    println!("{}", String::from_utf8_lossy(&json));
    Ok(())
}

fn required_metric(value: &serde_json::Value, label: &str) -> Result<f64> {
    let parsed = match value {
        serde_json::Value::Number(number) => number.as_f64(),
        serde_json::Value::String(text) => text.parse::<f64>().ok(),
        _ => None,
    };
    parsed
        .filter(|metric| metric.is_finite())
        .ok_or_else(|| anyhow::anyhow!("Performance metric '{label}' is missing or invalid"))
}

/// Compare current perf metrics against a saved baseline, reporting deltas.
pub fn perf_compare(package: &str, name: &str, device: Option<&str>) -> Result<()> {
    validate_package_name(package)?;
    let path = performance_baseline_path(name)?;
    migrate_legacy_baseline(name, &path)?;
    let baseline: serde_json::Value =
        read_json_file(&path, MAX_PERF_BASELINE_BYTES, "performance baseline")
            .map_err(|_| anyhow::anyhow!("Baseline '{}' not found or is invalid", name))?;

    let current = collect_perf_snapshot_value(package, device)?;

    let baseline_mem = required_metric(&baseline["memoryMb"], "baseline.memoryMb")?;
    let current_mem = required_metric(&current["memoryMb"], "current.memoryMb")?;
    let baseline_cpu = required_metric(&baseline["cpuPercent"], "baseline.cpuPercent")?;
    let current_cpu = required_metric(&current["cpuPercent"], "current.cpuPercent")?;
    let baseline_pss = required_metric(&baseline["totalPssKb"], "baseline.totalPssKb")?;
    let current_pss = required_metric(&current["totalPssKb"], "current.totalPssKb")?;
    let baseline_janky = required_metric(
        &baseline["framestats"]["jankyPercent"],
        "baseline.framestats.jankyPercent",
    )?;
    let current_janky = required_metric(
        &current["framestats"]["jankyPercent"],
        "current.framestats.jankyPercent",
    )?;

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
        check_metric("memoryMb", baseline_mem, current_mem),
        check_metric("totalPssKb", baseline_pss, current_pss),
        check_metric("cpuPercent", baseline_cpu, current_cpu),
        check_metric("jankyPercent", baseline_janky, current_janky),
    ];

    let overall_pass = metrics
        .iter()
        .all(|metric| metric["pass"].as_bool().unwrap_or(false));

    let result = serde_json::json!({
        "package": package,
        "baseline": name,
        "overallPass": overall_pass,
        "overallStatus": if overall_pass { "PASS" } else { "FAIL" },
        "regressionThreshold": "20%",
        "metrics": metrics,
    });

    println!("{}", terminal_safe_json(&result)?);
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

    eprintln!(
        "Collecting {} samples for {} (interval {}ms)...",
        count, package, interval_ms
    );

    for i in 0..count {
        if i > 0 && interval_ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(interval_ms));
        }

        let meminfo_out = adb_exec(device, &["shell", "dumpsys", "meminfo", package], None)?;
        let cpuinfo_out = adb_exec(device, &["shell", "dumpsys", "cpuinfo"], None)?;

        let meminfo_text = String::from_utf8_lossy(&meminfo_out.stdout);
        let cpuinfo_text = String::from_utf8_lossy(&cpuinfo_out.stdout);

        let (mem_mb, total_pss) =
            parse_meminfo(&meminfo_text).context("Memory metrics were unavailable")?;
        let cpu =
            parse_cpu_percent(&cpuinfo_text, package).context("CPU metrics were unavailable")?;

        mem_samples.push(mem_mb);
        cpu_samples.push(cpu);
        pss_samples.push(total_pss as f64);

        eprintln!(
            "  sample {}/{}: mem={:.1}MB cpu={:.1}%",
            i + 1,
            count,
            mem_mb,
            cpu
        );
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

    println!("{}", terminal_safe_json(&result)?);
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

    println!("{}", terminal_safe_json(&result)?);
    Ok(())
}

/// Detailed frame rendering stats via `dumpsys gfxinfo <pkg> framestats`.
pub fn perf_framestats(package: &str, device: Option<&str>) -> Result<()> {
    validate_package_name(package)?;

    let output = adb_exec(
        device,
        &["shell", "dumpsys", "gfxinfo", package, "framestats"],
        None,
    )?;
    if !output.status.success() {
        bail!(
            "gfxinfo framestats failed: {}",
            terminal_safe(&output.stderr)
        );
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
                janky_frames = v
                    .trim()
                    .split_whitespace()
                    .next()
                    .unwrap_or("0")
                    .parse()
                    .unwrap_or(0);
            }
        } else if t.starts_with("50th percentile:") {
            p50_ms = t
                .split(':')
                .nth(1)
                .and_then(|s| s.trim().trim_end_matches("ms").trim().parse::<f64>().ok())
                .unwrap_or(0.0);
        } else if t.starts_with("90th percentile:") {
            p90_ms = t
                .split(':')
                .nth(1)
                .and_then(|s| s.trim().trim_end_matches("ms").trim().parse::<f64>().ok())
                .unwrap_or(0.0);
        } else if t.starts_with("95th percentile:") {
            p95_ms = t
                .split(':')
                .nth(1)
                .and_then(|s| s.trim().trim_end_matches("ms").trim().parse::<f64>().ok())
                .unwrap_or(0.0);
        } else if t.starts_with("99th percentile:") {
            p99_ms = t
                .split(':')
                .nth(1)
                .and_then(|s| s.trim().trim_end_matches("ms").trim().parse::<f64>().ok())
                .unwrap_or(0.0);
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

    println!("{}", terminal_safe_json(&result)?);
    Ok(())
}

// ============== Shared Helpers ==============

fn terminal_safe_line(text: &str) -> String {
    let flattened = text.replace('\n', " ").replace('\t', " ");
    terminal_safe(flattened.as_bytes())
}

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
            terminal_safe(package.as_bytes())
        );
    }
    Ok(())
}

/// Append `--es`/`--ez`/`--ei`/`--ef` extras parsed from a JSON object string
/// to a [`DeviceShellCmd`] builder. All keys and values become `user_input(…)`
/// segments — they are POSIX-quoted on render, so embedded metacharacters in
/// JSON values cannot escape the surrounding `am` invocation.
fn append_extras_to_cmd(mut cmd: DeviceShellCmd, extras_json: &str) -> Result<DeviceShellCmd> {
    let parsed: serde_json::Value =
        serde_json::from_str(extras_json).context("--extras must be a valid JSON object")?;
    let obj = parsed
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("--extras must be a JSON object, not an array or scalar"))?;

    for (k, v) in obj {
        match v {
            serde_json::Value::String(s) => {
                cmd = cmd.literal("--es").user_input(k).user_input(s);
            }
            serde_json::Value::Bool(b) => {
                cmd = cmd.literal("--ez").user_input(k).user_input(&b.to_string());
            }
            serde_json::Value::Number(n) => {
                cmd = if n.is_i64() {
                    cmd.literal("--ei")
                } else {
                    cmd.literal("--ef")
                };
                cmd = cmd.user_input(k).user_input(&n.to_string());
            }
            _ => {
                cmd = cmd.literal("--es").user_input(k).user_input(&v.to_string());
            }
        }
    }
    Ok(cmd)
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
    fn android_key_event_only_accepts_named_keys() {
        assert_eq!(resolve_android_keycode("HOME"), Some("KEYCODE_HOME"));
        assert_eq!(resolve_android_keycode("return"), Some("KEYCODE_ENTER"));
        assert_eq!(
            resolve_android_keycode("app_switch"),
            Some("KEYCODE_APP_SWITCH")
        );
        assert_eq!(resolve_android_keycode("KEYCODE_HOME"), None);
        assert_eq!(resolve_android_keycode("HOME;rm -rf /"), None);
    }

    #[test]
    fn sensitive_android_ui_values_are_redacted_in_xml_and_structured_output() {
        let xml = r#"<hierarchy>
            <node class="android.widget.EditText" text="hunter2" resource-id="com.app:id/password" content-desc="Password" password="true" bounds="[0,0][100,50]" clickable="true"/>
            <node class="android.widget.EditText" text="731904" resource-id="com.app:id/otp_input" content-desc="One-time code" password="false" bounds="[0,50][100,100]" clickable="true"/>
            <node class="android.widget.TextView" text="Shipping details" resource-id="com.app:id/shipping" content-desc="Shipping status" password="false" bounds="[0,100][200,150]" clickable="false"/>
        </hierarchy>"#;
        let secrets = ["hunter2", "731904", "com.app:id/password", "otp_input"];

        let sanitized_xml = sanitize_android_ui_xml(xml);
        let parsed = parse_ui_elements(xml);
        let json = xml_to_json(xml).expect("safe UI JSON");

        for output in [&sanitized_xml, &json] {
            for secret in secrets {
                assert!(!output.contains(secret), "leaked {secret} in {output}");
            }
        }
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].text, "[REDACTED]");
        assert_eq!(parsed[0].resource_id, "[REDACTED]");
        assert_eq!(parsed[1].text, "[REDACTED]");
        assert_eq!(parsed[1].content_desc, "[REDACTED]");
        assert_eq!(parsed[2].text, "Shipping details");
        assert!(sanitized_xml.contains("text=\"Shipping details\""));
        assert!(json.contains("Shipping details"));
    }

    #[test]
    fn android_ui_redaction_parses_node_attributes_containing_angle_brackets() {
        let secret = "account>731904";
        let xml = format!(
            r#"<hierarchy><node text="{secret}" class="android.widget.EditText" resource-id="com.app:id/account" content-desc="" password="false" bounds="[0,0][100,50]"/></hierarchy>"#
        );

        let sanitized = sanitize_android_ui_xml(&xml);
        let elements = parse_ui_elements(&xml);

        assert!(!sanitized.contains(secret));
        assert_eq!(elements.len(), 1);
        assert_eq!(elements[0].text, "[REDACTED]");
        assert_eq!(elements[0].class, "android.widget.EditText");
    }

    #[test]
    fn empty_android_text_entry_redacts_identifier_and_accessibility_label() {
        let xml = r#"<hierarchy><node class="android.widget.EditText" text="" resource-id="com.app:id/email" content-desc="Email address" password="false" bounds="[0,0][100,50]" clickable="false"/></hierarchy>"#;

        let parsed = parse_ui_elements(xml);
        let sanitized = sanitize_android_ui_xml(xml);

        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].text, "");
        assert_eq!(parsed[0].resource_id, "[REDACTED]");
        assert_eq!(parsed[0].content_desc, "[REDACTED]");
        assert!(!sanitized.contains("com.app:id/email"));
        assert!(!sanitized.contains("Email address"));
    }

    #[test]
    fn secure_android_ui_fields_remain_findable_but_never_appear_in_results() {
        let xml = r#"<hierarchy>
            <node class="android.widget.EditText" text="731904" resource-id="com.app:id/otp_input" content-desc="One-time code" password="false" bounds="[0,50][100,100]" clickable="true"/>
        </hierarchy>"#;

        let found = find_element_in_xml(xml, "731904")
            .unwrap()
            .expect("secure field should remain targetable");
        assert_eq!(found.center, (50, 75));
        assert!(found.sensitive);
        assert_eq!(
            safe_android_ui_value(found.text, found.sensitive),
            "[REDACTED]"
        );
        assert_eq!(
            safe_android_ui_value(found.resource_id, found.sensitive),
            "[REDACTED]",
        );

        let description = find_ui_element_in_xml(xml, Some("731904"), Some("otp_input"), None)
            .expect("secure field should remain discoverable by text and resource id");
        assert!(!description.contains("731904"));
        assert!(!description.contains("otp_input"));
        assert!(description.contains("[REDACTED]"));
    }

    #[test]
    fn turbo_command_preserves_action_status_for_ui_dump() {
        let command = compose_ui_dump_command("input text 'safe'");
        assert!(command.contains("action_status=$?"));
        assert!(command.contains("if [ \"$action_status\" -eq 0 ]"));
        assert!(command.contains("exit \"$action_status\""));
    }

    #[cfg(unix)]
    #[test]
    fn ui_dump_shell_command_removes_partial_output_after_dump_failure() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let fake_bin = temp.path().join("bin");
        std::fs::create_dir(&fake_bin).unwrap();
        let uiautomator = fake_bin.join("uiautomator");
        std::fs::write(&uiautomator, "#!/bin/sh\nprintf secret > \"$2\"\nexit 1\n").unwrap();
        let mut permissions = std::fs::metadata(&uiautomator).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&uiautomator, permissions).unwrap();

        let dump_path = temp.path().join("ui.xml");
        let command = ui_dump_shell_command(dump_path.to_str().unwrap());
        let path = format!("{}:/bin:/usr/bin", fake_bin.display());
        let output = Command::new("sh")
            .args(["-c", &command])
            .env("PATH", path)
            .output()
            .unwrap();

        assert!(!output.status.success());
        assert!(!dump_path.exists(), "partial UI dump was not cleaned up");
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
        let _ = password_regex();
    }

    // ===== Performance parsing tests =====

    #[test]
    fn test_parse_total_pss_total_pss_line() {
        let meminfo = "TOTAL PSS:   51200  kB\nNative Heap   12000\nDalvik Heap   8000";
        let pss = parse_total_pss(meminfo).expect("PSS");
        assert_eq!(pss, 51200);
    }

    #[test]
    fn test_parse_total_pss_fallback_heap_sum() {
        let meminfo = "Native Heap   12288\nDalvik Heap   8192\nOther Heap   1024";
        assert_eq!(parse_total_pss(meminfo), Some(20480));
    }

    #[test]
    fn test_parse_total_pss_empty() {
        assert_eq!(parse_total_pss(""), None);
    }

    #[test]
    fn test_parse_meminfo_returns_mb() {
        let meminfo = "Native Heap   10240\nDalvik Heap   10240";
        let (mem_mb, total_pss) = parse_meminfo(meminfo).expect("memory metrics");
        assert_eq!(total_pss, 20480);
        assert!((mem_mb - 20.0_f64).abs() < 0.01);
    }

    #[test]
    fn test_parse_cpu_percent_found() {
        let cpuinfo =
            "  15% 1234/com.example.app: 10% user + 5% kernel\n  5% 999/system: 5% user\n";
        let percent = parse_cpu_percent(cpuinfo, "com.example.app").expect("CPU percent");
        assert!((percent - 15.0).abs() < 0.01);
    }

    #[test]
    fn test_parse_cpu_percent_not_found() {
        let cpuinfo = "  10% 999/other.app: 10% user\n";
        assert_eq!(parse_cpu_percent(cpuinfo, "com.example.app"), None);
    }

    #[test]
    fn test_parse_battery_level() {
        let battery =
            "Current Battery Service state:\n  AC powered: false\n  level: 87\n  scale: 100\n";
        assert_eq!(parse_battery_level(battery), Some(87));
    }

    #[test]
    fn test_parse_battery_level_missing() {
        assert_eq!(parse_battery_level("no battery info here"), None);
    }

    #[test]
    fn invalid_performance_metric_is_rejected() {
        assert!(required_metric(&serde_json::Value::Null, "memory").is_err());
        assert!(required_metric(&serde_json::json!("NaN"), "memory").is_err());
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

    #[test]
    fn uninstall_rejects_terminal_controls_before_adb() {
        let error = uninstall_app("com.example\u{001b}[31m", None)
            .unwrap_err()
            .to_string();

        assert!(error.contains("Invalid package name"));
        assert!(!error.contains('\u{001b}'));
    }

    #[test]
    fn terminal_safe_line_removes_controls_and_line_breaks() {
        assert_eq!(
            terminal_safe_line("red\u{001b}[31m\nblue\u{061c}\u{202e}"),
            "red[31m blue"
        );
    }
    struct EnvGuard {
        key: &'static str,
        previous: Option<std::ffi::OsString>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: &std::path::Path) -> Self {
            let previous = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, previous }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            if let Some(value) = &self.previous {
                std::env::set_var(self.key, value);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    #[test]
    fn legacy_baseline_migrates_and_does_not_clobber_private_state() {
        let _lock = LEGACY_STATE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let legacy_root = tempfile::tempdir().unwrap();
        let state_root = tempfile::tempdir().unwrap();
        let _legacy_env = EnvGuard::set(LEGACY_TMP_DIR_ENV, legacy_root.path());
        let _state_env = EnvGuard::set(TEST_STATE_ROOT_ENV, state_root.path());

        let name = "migration-baseline";
        let legacy_path = legacy_root
            .path()
            .join(format!("claude-mobile-baseline-{name}.json"));
        std::fs::write(
            &legacy_path,
            br#"{"memoryMb":"1","cpuPercent":"2","totalPssKb":3,"framestats":{"jankyPercent":"4"}}"#,
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&legacy_path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }

        let destination = performance_baseline_path(name).unwrap();
        migrate_legacy_baseline(name, &destination).unwrap();
        let migrated: serde_json::Value = read_json_file(
            &destination,
            MAX_PERF_BASELINE_BYTES,
            "performance baseline",
        )
        .unwrap();
        assert_eq!(migrated["memoryMb"], "1");

        std::fs::write(
            &legacy_path,
            br#"{"memoryMb":"stale","cpuPercent":"stale","totalPssKb":0,"framestats":{"jankyPercent":"stale"}}"#,
        )
        .unwrap();
        migrate_legacy_baseline(name, &destination).unwrap();
        let retained: serde_json::Value = read_json_file(
            &destination,
            MAX_PERF_BASELINE_BYTES,
            "performance baseline",
        )
        .unwrap();
        assert_eq!(retained["memoryMb"], "1");
    }

    #[cfg(unix)]
    #[test]
    fn legacy_baseline_rejects_group_writable_file_before_import() {
        use std::os::unix::fs::PermissionsExt;

        let _lock = LEGACY_STATE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let legacy_root = tempfile::tempdir().unwrap();
        let state_root = tempfile::tempdir().unwrap();
        let _legacy_env = EnvGuard::set(LEGACY_TMP_DIR_ENV, legacy_root.path());
        let _state_env = EnvGuard::set(TEST_STATE_ROOT_ENV, state_root.path());

        let name = "insecure-baseline";
        let legacy_path = legacy_root
            .path()
            .join(format!("claude-mobile-baseline-{name}.json"));
        std::fs::write(
            &legacy_path,
            br#"{"memoryMb":"1","cpuPercent":"2","totalPssKb":3,"framestats":{"jankyPercent":"4"}}"#,
        )
        .unwrap();
        std::fs::set_permissions(&legacy_path, std::fs::Permissions::from_mode(0o666)).unwrap();

        let destination = performance_baseline_path(name).unwrap();
        let error = migrate_legacy_baseline(name, &destination).unwrap_err();
        assert!(error.to_string().contains("group/world-writable"));
        assert!(!destination.exists());
    }
}
