//! Flow command — execute multiple automation steps in one invocation.
//!
//! This is the CLI equivalent of the MCP `flow(action:'run')` tool.
//! Steps are read from a JSON file or stdin, each step maps to an existing
//! CLI action (tap, tap-text, input, find, etc.), and results are collected
//! into a single JSON output.

use std::io::Read as _;
use std::time::Instant;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use crate::{android, aurora, desktop, ios};

// ---------------------------------------------------------------------------
// Constants & limits
// ---------------------------------------------------------------------------

/// Maximum number of steps allowed in a single flow.
const MAX_STEPS: usize = 20;

/// Maximum allowed --max-duration value (ms).
const MAX_DURATION_LIMIT: u64 = 60_000;

/// Maximum screenshots captured per flow in turbo mode.
const MAX_SCREENSHOTS: usize = 5;

/// Actions that are explicitly blocked for security reasons.
const BLOCKED_ACTIONS: &[&str] = &["shell", "system_shell"];

/// All recognised action names — anything else is rejected.
const ALLOWED_ACTIONS: &[&str] = &[
    "tap", "tap-text", "input", "swipe", "find", "key", "launch", "stop",
    "screenshot", "wait", "ui-dump", "open-url",
];

// ---------------------------------------------------------------------------
// Step definition (input)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct FlowStep {
    pub action: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default = "default_on_error")]
    pub on_error: OnError,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OnError {
    Stop,
    Skip,
}

fn default_on_error() -> OnError {
    OnError::Stop
}

// ---------------------------------------------------------------------------
// Result types (output)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct FlowResult {
    pub completed: bool,
    #[serde(rename = "totalMs")]
    pub total_ms: u128,
    pub steps: Vec<StepResult>,
    pub passed: usize,
    pub failed: usize,
    pub total: usize,
}

#[derive(Serialize)]
pub struct StepResult {
    pub step: usize,
    pub action: String,
    pub success: bool,
    pub message: String,
    pub ms: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<String>,
}

// ---------------------------------------------------------------------------
// Platform context — avoids threading platform/device/simulator everywhere
// ---------------------------------------------------------------------------

struct PlatformCtx<'a> {
    platform: &'a str,
    device: Option<&'a str>,
    simulator: Option<&'a str>,
    companion_path: Option<&'a str>,
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
pub fn run(
    platform: &str,
    file: Option<&str>,
    turbo: bool,
    max_duration: u64,
    _stop_on_error: bool,
    simulator: Option<&str>,
    device: Option<&str>,
    companion_path: Option<&str>,
) -> Result<()> {
    // -- Validate max-duration ------------------------------------------------
    let max_duration = max_duration.min(MAX_DURATION_LIMIT);

    // -- Read steps -----------------------------------------------------------
    let json_text = match file {
        Some(path) => std::fs::read_to_string(path)
            .map_err(|e| anyhow::anyhow!("Cannot read file '{}': {}", path, e))?,
        None => {
            let mut buf = String::new();
            std::io::stdin().read_to_string(&mut buf)?;
            buf
        }
    };

    let steps: Vec<FlowStep> = serde_json::from_str(&json_text)
        .map_err(|e| anyhow::anyhow!("Invalid step JSON: {}", e))?;

    // -- Validate step count --------------------------------------------------
    if steps.is_empty() {
        bail!("Flow contains zero steps");
    }
    if steps.len() > MAX_STEPS {
        bail!("Flow contains {} steps, maximum is {}", steps.len(), MAX_STEPS);
    }

    // -- Validate actions -----------------------------------------------------
    for (i, step) in steps.iter().enumerate() {
        let action = step.action.as_str();
        if BLOCKED_ACTIONS.contains(&action) {
            bail!(
                "Step {}: action '{}' is blocked for security reasons",
                i + 1,
                action
            );
        }
        if !ALLOWED_ACTIONS.contains(&action) {
            bail!(
                "Step {}: unknown action '{}'. Allowed: {}",
                i + 1,
                action,
                ALLOWED_ACTIONS.join(", ")
            );
        }
    }

    // -- Execute steps --------------------------------------------------------
    let ctx = PlatformCtx {
        platform,
        device,
        simulator,
        companion_path,
    };

    let total_start = Instant::now();
    let mut results: Vec<StepResult> = Vec::with_capacity(steps.len());
    let mut screenshots_taken: usize = 0;
    let mut all_passed = true;

    for (i, step) in steps.iter().enumerate() {
        // Check total duration budget
        if total_start.elapsed().as_millis() as u64 >= max_duration {
            // Record remaining steps as skipped
            for j in i..steps.len() {
                results.push(StepResult {
                    step: j + 1,
                    action: steps[j].action.clone(),
                    success: false,
                    message: "Skipped: max duration exceeded".into(),
                    ms: 0,
                    ui: None,
                    screenshot: None,
                });
            }
            all_passed = false;
            break;
        }

        let step_start = Instant::now();

        // -- Turbo fast-track: combine action + UI dump in 1 ADB call (Android only) --
        if turbo && ctx.platform == "android" {
            if let Some((shell_cmd, desc)) = build_fast_track_cmd(step, &ctx) {
                match android::exec_with_ui_dump(&shell_cmd, ctx.device) {
                    Ok((_, ui_xml)) => {
                        let ui = if !ui_xml.is_empty() {
                            Some(android::compact_ui_from_xml(&ui_xml))
                        } else {
                            None
                        };
                        results.push(StepResult {
                            step: i + 1,
                            action: step.action.clone(),
                            success: true,
                            message: desc,
                            ms: step_start.elapsed().as_millis(),
                            ui,
                            screenshot: None,
                        });
                        continue;
                    }
                    Err(_) => { /* fall through to normal path */ }
                }
            }
        }

        let exec_result = execute_step(&ctx, step);
        let step_ms = step_start.elapsed().as_millis();

        let (success, message) = match exec_result {
            Ok(msg) => (true, msg),
            Err(e) => (false, format!("{e}")),
        };

        // -- Turbo: ui-dump after each step -----------------------------------
        let ui = if turbo {
            compact_ui_dump(&ctx).ok()
        } else {
            None
        };

        // -- Turbo: screenshot on failure -------------------------------------
        let screenshot_path = if turbo && !success && screenshots_taken < MAX_SCREENSHOTS {
            match capture_failure_screenshot(&ctx, i + 1) {
                Ok(path) => {
                    screenshots_taken += 1;
                    Some(path)
                }
                Err(_) => None,
            }
        } else {
            None
        };

        if !success {
            all_passed = false;
        }

        results.push(StepResult {
            step: i + 1,
            action: step.action.clone(),
            success,
            message,
            ms: step_ms,
            ui,
            screenshot: screenshot_path,
        });

        // Decide whether to continue
        if !success && step.on_error == OnError::Stop {
            // Record remaining as skipped
            for j in (i + 1)..steps.len() {
                results.push(StepResult {
                    step: j + 1,
                    action: steps[j].action.clone(),
                    success: false,
                    message: "Skipped: previous step failed (on_error=stop)".into(),
                    ms: 0,
                    ui: None,
                    screenshot: None,
                });
            }
            break;
        }
    }

    let total_ms = total_start.elapsed().as_millis();
    let passed = results.iter().filter(|r| r.success).count();
    let failed = results.iter().filter(|r| !r.success).count();
    let total = results.len();

    let output = FlowResult {
        completed: all_passed,
        total_ms,
        steps: results,
        passed,
        failed,
        total,
    };

    println!("{}", serde_json::to_string_pretty(&output)?);

    if all_passed {
        Ok(())
    } else {
        // Return error so exit code is 1
        bail!("")
    }
}

// ---------------------------------------------------------------------------
// Step dispatcher — maps action names to existing platform functions
// ---------------------------------------------------------------------------

fn execute_step(ctx: &PlatformCtx<'_>, step: &FlowStep) -> Result<String> {
    match step.action.as_str() {
        "tap" => step_tap(ctx, &step.args),
        "tap-text" => step_tap_text(ctx, &step.args),
        "input" => step_input(ctx, &step.args),
        "swipe" => step_swipe(ctx, &step.args),
        "find" => step_find(ctx, &step.args),
        "key" => step_key(ctx, &step.args),
        "launch" => step_launch(ctx, &step.args),
        "stop" => step_stop(ctx, &step.args),
        "screenshot" => step_screenshot(ctx, &step.args),
        "wait" => step_wait(&step.args),
        "ui-dump" => step_ui_dump(ctx),
        "open-url" => step_open_url(ctx, &step.args),
        _ => bail!("Unhandled action '{}'", step.action),
    }
}

// ---------------------------------------------------------------------------
// Individual step implementations
// ---------------------------------------------------------------------------

fn require_args(args: &[String], min: usize, action: &str) -> Result<()> {
    if args.len() < min {
        bail!("{} requires at least {} argument(s), got {}", action, min, args.len());
    }
    Ok(())
}

fn step_tap(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    require_args(args, 2, "tap")?;
    let x: i32 = args[0].parse().map_err(|_| anyhow::anyhow!("Invalid x coordinate"))?;
    let y: i32 = args[1].parse().map_err(|_| anyhow::anyhow!("Invalid y coordinate"))?;
    match ctx.platform {
        "android" => android::tap(x, y, ctx.device)?,
        "ios" => ios::tap(x, y, ctx.simulator)?,
        "aurora" => aurora::tap(x, y, ctx.device)?,
        "desktop" => desktop::tap(x, y, ctx.companion_path)?,
        _ => bail!("Unsupported platform for tap"),
    }
    Ok(format!("Tapped at ({}, {})", x, y))
}

fn step_tap_text(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    require_args(args, 1, "tap-text")?;
    let query = &args[0];
    match ctx.platform {
        "android" => android::tap_element(query, ctx.device)?,
        "ios" => ios::tap_element(query, ctx.simulator)?,
        "desktop" => desktop::tap_by_text(query, ctx.companion_path)?,
        _ => bail!("Unsupported platform for tap-text"),
    }
    Ok(format!("Tapped \"{}\"", query))
}

fn step_input(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    require_args(args, 1, "input")?;
    let text = &args[0];
    match ctx.platform {
        "android" => android::input_text(text, ctx.device)?,
        "ios" => ios::input_text(text, ctx.simulator)?,
        "aurora" => aurora::input_text(text, ctx.device)?,
        "desktop" => desktop::input_text(text, ctx.companion_path)?,
        _ => bail!("Unsupported platform for input"),
    }
    Ok(format!("Typed \"{}\"", text))
}

fn step_swipe(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    require_args(args, 4, "swipe")?;
    let x1: i32 = args[0].parse().map_err(|_| anyhow::anyhow!("Invalid x1"))?;
    let y1: i32 = args[1].parse().map_err(|_| anyhow::anyhow!("Invalid y1"))?;
    let x2: i32 = args[2].parse().map_err(|_| anyhow::anyhow!("Invalid x2"))?;
    let y2: i32 = args[3].parse().map_err(|_| anyhow::anyhow!("Invalid y2"))?;
    let duration: u32 = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(300);
    match ctx.platform {
        "android" => android::swipe(x1, y1, x2, y2, duration, ctx.device)?,
        "ios" => ios::swipe(x1, y1, x2, y2, duration, ctx.simulator)?,
        "aurora" => aurora::swipe(x1, y1, x2, y2, duration, ctx.device)?,
        _ => bail!("Unsupported platform for swipe"),
    }
    Ok(format!("Swiped ({},{}) -> ({},{})", x1, y1, x2, y2))
}

fn step_find(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    require_args(args, 1, "find")?;
    let query = &args[0];
    let found = match ctx.platform {
        "android" => android::find_element(query, ctx.device)?,
        "ios" => ios::find_element(query, ctx.simulator)?,
        _ => bail!("Unsupported platform for find"),
    };
    match found {
        Some((x, y)) => Ok(format!("Found \"{}\" at ({}, {})", query, x, y)),
        None => bail!("Element \"{}\" not found", query),
    }
}

fn step_key(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    require_args(args, 1, "key")?;
    let key = &args[0];
    match ctx.platform {
        "android" => android::press_key(key, ctx.device)?,
        "ios" => ios::press_key(key, ctx.simulator)?,
        "aurora" => aurora::press_key(key, ctx.device)?,
        "desktop" => desktop::press_key(key, ctx.companion_path)?,
        _ => bail!("Unsupported platform for key"),
    }
    Ok(format!("Pressed key \"{}\"", key))
}

fn step_launch(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    require_args(args, 1, "launch")?;
    let package = &args[0];
    match ctx.platform {
        "android" => android::launch_app(package, ctx.device)?,
        "ios" => ios::launch_app(package, ctx.simulator)?,
        "aurora" => aurora::launch_app(package, ctx.device)?,
        "desktop" => desktop::launch_app(package, ctx.companion_path)?,
        _ => bail!("Unsupported platform for launch"),
    }
    Ok(format!("Launched \"{}\"", package))
}

fn step_stop(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    require_args(args, 1, "stop")?;
    let package = &args[0];
    match ctx.platform {
        "android" => android::stop_app(package, ctx.device)?,
        "ios" => ios::stop_app(package, ctx.simulator)?,
        "aurora" => aurora::stop_app(package, ctx.device)?,
        "desktop" => desktop::stop_app(package, ctx.companion_path)?,
        _ => bail!("Unsupported platform for stop"),
    }
    Ok(format!("Stopped \"{}\"", package))
}

fn step_screenshot(ctx: &PlatformCtx<'_>, _args: &[String]) -> Result<String> {
    let _data = match ctx.platform {
        "android" => android::screenshot(ctx.device)?,
        "ios" => ios::screenshot(ctx.simulator)?,
        "aurora" => aurora::screenshot(ctx.device)?,
        "desktop" => desktop::screenshot(ctx.companion_path)?,
        _ => bail!("Unsupported platform for screenshot"),
    };
    Ok("Screenshot captured".into())
}

fn step_wait(args: &[String]) -> Result<String> {
    require_args(args, 1, "wait")?;
    let ms: u64 = args[0].parse().map_err(|_| anyhow::anyhow!("Invalid ms value"))?;
    std::thread::sleep(std::time::Duration::from_millis(ms));
    Ok(format!("Waited {}ms", ms))
}

fn step_ui_dump(ctx: &PlatformCtx<'_>) -> Result<String> {
    match ctx.platform {
        "android" => android::ui_dump("json", ctx.device)?,
        "ios" => ios::ui_dump("json", ctx.simulator)?,
        "desktop" => desktop::get_ui(ctx.companion_path)?,
        _ => bail!("Unsupported platform for ui-dump"),
    }
    Ok("UI dump completed".into())
}

fn step_open_url(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    require_args(args, 1, "open-url")?;
    let url = &args[0];
    match ctx.platform {
        "android" => android::open_url(url, ctx.device)?,
        "ios" => ios::open_url(url, ctx.simulator)?,
        "aurora" => aurora::open_url(url, ctx.device)?,
        _ => bail!("Unsupported platform for open-url"),
    }
    Ok(format!("Opened URL \"{}\"", url))
}

// ---------------------------------------------------------------------------
// Turbo fast-track helpers (Android-only)
// ---------------------------------------------------------------------------

/// Escape text for `adb shell input text "..."`.
fn escape_adb_text(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace(' ', "%s")
        .replace('\'', "\\'")
        .replace('"', "\\\"")
        .replace('&', "\\&")
        .replace('|', "\\|")
        .replace(';', "\\;")
        .replace('$', "\\$")
        .replace('`', "\\`")
}

/// Resolve a key name to its Android keyevent code string.
fn resolve_keycode(key: &str) -> Option<&'static str> {
    match key.to_lowercase().as_str() {
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

/// Build shell command + description for simple Android actions eligible for fast-track.
/// Returns None if the action is not eligible (fall through to normal path).
fn build_fast_track_cmd(step: &FlowStep, ctx: &PlatformCtx<'_>) -> Option<(String, String)> {
    if ctx.platform != "android" {
        return None;
    }
    match step.action.as_str() {
        "tap" if step.args.len() >= 2 => {
            let x = step.args[0].parse::<i32>().ok()?;
            let y = step.args[1].parse::<i32>().ok()?;
            Some((
                format!("input tap {} {}", x, y),
                format!("Tapped at ({}, {})", x, y),
            ))
        }
        "key" if !step.args.is_empty() => {
            let keycode = resolve_keycode(&step.args[0])?;
            Some((
                format!("input keyevent {}", keycode),
                format!("Pressed key \"{}\"", step.args[0]),
            ))
        }
        "input" if !step.args.is_empty() => {
            let escaped = escape_adb_text(&step.args[0]);
            Some((
                format!("input text \"{}\"", escaped),
                format!("Typed \"{}\"", step.args[0]),
            ))
        }
        "swipe" if step.args.len() >= 4 => {
            let x1 = step.args[0].parse::<i32>().ok()?;
            let y1 = step.args[1].parse::<i32>().ok()?;
            let x2 = step.args[2].parse::<i32>().ok()?;
            let y2 = step.args[3].parse::<i32>().ok()?;
            let dur: u32 = step.args.get(4).and_then(|s| s.parse().ok()).unwrap_or(300);
            Some((
                format!("input swipe {} {} {} {} {}", x1, y1, x2, y2, dur),
                format!("Swiped ({},{}) -> ({},{})", x1, y1, x2, y2),
            ))
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Turbo helpers
// ---------------------------------------------------------------------------

/// Produce a compact one-line summary of interactive UI elements.
fn compact_ui_dump(ctx: &PlatformCtx<'_>) -> Result<String> {
    match ctx.platform {
        "android" => {
            let elements = android::get_ui_elements(ctx.device)?;
            let parts: Vec<String> = elements
                .iter()
                .take(20) // cap to avoid huge output
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
            Ok(parts.join(" | "))
        }
        // iOS and desktop don't expose a cheap structured element list the
        // same way Android does, so we return a placeholder.
        _ => Ok("(ui dump not available for this platform in turbo mode)".into()),
    }
}

/// Capture a screenshot and save to a temp file, returning the path.
fn capture_failure_screenshot(ctx: &PlatformCtx<'_>, step_num: usize) -> Result<String> {
    let data = match ctx.platform {
        "android" => android::screenshot(ctx.device)?,
        "ios" => ios::screenshot(ctx.simulator)?,
        "aurora" => aurora::screenshot(ctx.device)?,
        "desktop" => desktop::screenshot(ctx.companion_path)?,
        _ => bail!("Cannot capture screenshot for platform"),
    };

    let path = format!("/tmp/flow-step{}-fail.png", step_num);
    std::fs::write(&path, &data)?;
    Ok(path)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_steps_valid() {
        let json = r#"[
            {"action": "tap-text", "args": ["Login"]},
            {"action": "input", "args": ["test@test.com"]},
            {"action": "wait", "args": ["500"]}
        ]"#;
        let steps: Vec<FlowStep> = serde_json::from_str(json).unwrap();
        assert_eq!(steps.len(), 3);
        assert_eq!(steps[0].action, "tap-text");
        assert_eq!(steps[0].args, vec!["Login"]);
        assert_eq!(steps[1].action, "input");
        assert_eq!(steps[2].action, "wait");
    }

    #[test]
    fn test_parse_steps_with_on_error() {
        let json = r#"[
            {"action": "tap-text", "args": ["Login"], "on_error": "skip"},
            {"action": "find", "args": ["Dashboard"], "on_error": "stop"}
        ]"#;
        let steps: Vec<FlowStep> = serde_json::from_str(json).unwrap();
        assert_eq!(steps[0].on_error, OnError::Skip);
        assert_eq!(steps[1].on_error, OnError::Stop);
    }

    #[test]
    fn test_default_on_error_is_stop() {
        let json = r#"[{"action": "tap-text", "args": ["OK"]}]"#;
        let steps: Vec<FlowStep> = serde_json::from_str(json).unwrap();
        assert_eq!(steps[0].on_error, OnError::Stop);
    }

    #[test]
    fn test_blocked_actions() {
        assert!(BLOCKED_ACTIONS.contains(&"shell"));
        assert!(BLOCKED_ACTIONS.contains(&"system_shell"));
    }

    #[test]
    fn test_allowed_actions_complete() {
        // All allowed actions must be present
        let expected = vec![
            "tap", "tap-text", "input", "swipe", "find", "key",
            "launch", "stop", "screenshot", "wait", "ui-dump", "open-url",
        ];
        for action in &expected {
            assert!(ALLOWED_ACTIONS.contains(action), "Missing allowed action: {}", action);
        }
    }

    #[test]
    fn test_require_args_ok() {
        let args = vec!["a".into(), "b".into()];
        assert!(require_args(&args, 2, "test").is_ok());
        assert!(require_args(&args, 1, "test").is_ok());
    }

    #[test]
    fn test_require_args_fail() {
        let args: Vec<String> = vec!["a".into()];
        assert!(require_args(&args, 2, "test").is_err());
    }

    #[test]
    fn test_step_count_limit() {
        // Verify that MAX_STEPS is 20
        assert_eq!(MAX_STEPS, 20);
    }

    #[test]
    fn test_max_duration_limit() {
        assert_eq!(MAX_DURATION_LIMIT, 60_000);
    }

    #[test]
    fn test_flow_result_serialization() {
        let result = FlowResult {
            completed: true,
            total_ms: 1234,
            steps: vec![
                StepResult {
                    step: 1,
                    action: "tap-text".into(),
                    success: true,
                    message: "Tapped \"Login\"".into(),
                    ms: 120,
                    ui: Some("Button \"Login\" | EditText".into()),
                    screenshot: None,
                },
                StepResult {
                    step: 2,
                    action: "find".into(),
                    success: false,
                    message: "Element not found".into(),
                    ms: 5000,
                    ui: None,
                    screenshot: Some("/tmp/flow-step2-fail.png".into()),
                },
            ],
            passed: 1,
            failed: 1,
            total: 2,
        };

        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"completed\":true"));
        assert!(json.contains("\"totalMs\":1234"));
        assert!(json.contains("\"passed\":1"));
        assert!(json.contains("\"failed\":1"));
        // ui field should be present for step 1
        assert!(json.contains("\"ui\":\"Button"));
        // screenshot should be absent for step 1 (skip_serializing_if)
        // but present for step 2
        assert!(json.contains("flow-step2-fail.png"));
    }

    #[test]
    fn test_empty_args_default() {
        let json = r#"[{"action": "screenshot"}]"#;
        let steps: Vec<FlowStep> = serde_json::from_str(json).unwrap();
        assert!(steps[0].args.is_empty());
    }
}
