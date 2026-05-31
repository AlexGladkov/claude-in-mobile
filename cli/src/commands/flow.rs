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

use crate::utils::device_shell::DeviceShellCmd;
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
    // core interaction
    "tap", "tap-text", "input", "swipe", "find", "key", "launch", "stop",
    "screenshot", "wait", "ui-dump", "open-url",
    // Batch 1/2 — sensor
    "sensor-location", "sensor-battery", "sensor-notifications", "sensor-thermal",
    // Batch 1/2 — network
    "network-traffic", "network-connectivity", "network-proxy", "network-airplane",
    // Batch 1/2 — permissions
    "permission-grant", "permission-revoke", "permission-reset",
    // Batch 1/2 — intents
    "intent-start", "intent-broadcast", "intent-deeplink", "intent-services",
    // Batch 1/2 — sandbox
    "sandbox-prefs-read", "sandbox-prefs-write", "sandbox-sqlite-query",
    "sandbox-file-list", "sandbox-file-read",
    // Batch 1/2 — UI assertions
    "ui-wait", "ui-assert-visible", "ui-assert-gone",
    // Batch 1/2 — performance
    "perf-snapshot", "perf-crashes", "perf-framestats",
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
// `flow batch` — execute commands from MCP batch format
// ---------------------------------------------------------------------------

/// Batch command entry as received from the MCP `flow_batch` tool.
///
/// Format differs from [`FlowStep`]: uses `name` instead of `action` and
/// `arguments` instead of `args`. We normalise into [`FlowStep`] internally.
#[derive(Debug, serde::Deserialize)]
struct BatchCommand {
    name: String,
    #[serde(default)]
    arguments: Vec<String>,
}

/// Execute multiple commands sequentially using the MCP batch-command format.
///
/// JSON input format:
/// ```json
/// [{"name": "tap", "arguments": ["100", "200"]}, {"name": "input", "arguments": ["hello"]}]
/// ```
///
/// Output is the same [`FlowResult`] JSON format as `flow run`.
#[allow(clippy::too_many_arguments)]
pub fn batch(
    platform: &str,
    file: Option<&str>,
    stop_on_error: bool,
    turbo: bool,
    simulator: Option<&str>,
    device: Option<&str>,
    companion_path: Option<&str>,
) -> Result<()> {
    // Read input
    let json_text = match file {
        Some(path) => std::fs::read_to_string(path)
            .map_err(|e| anyhow::anyhow!("Cannot read file '{}': {}", path, e))?,
        None => {
            let mut buf = String::new();
            std::io::stdin().read_to_string(&mut buf)?;
            buf
        }
    };

    // Parse batch commands and map to FlowStep
    let commands: Vec<BatchCommand> = serde_json::from_str(&json_text)
        .map_err(|e| anyhow::anyhow!("Invalid batch command JSON: {}", e))?;

    if commands.is_empty() {
        bail!("Batch contains zero commands");
    }
    if commands.len() > MAX_STEPS {
        bail!(
            "Batch contains {} commands, maximum is {}",
            commands.len(),
            MAX_STEPS
        );
    }

    // Convert to FlowStep — name → action, arguments → args
    let steps: Vec<FlowStep> = commands
        .into_iter()
        .map(|cmd| FlowStep {
            action: cmd.name,
            args: cmd.arguments,
            on_error: if stop_on_error { OnError::Stop } else { OnError::Skip },
        })
        .collect();

    // Validate actions
    for (i, step) in steps.iter().enumerate() {
        let action = step.action.as_str();
        if BLOCKED_ACTIONS.contains(&action) {
            bail!(
                "Command {}: action '{}' is blocked for security reasons",
                i + 1,
                action
            );
        }
        if !ALLOWED_ACTIONS.contains(&action) {
            bail!(
                "Command {}: unknown action '{}'. Allowed: {}",
                i + 1,
                action,
                ALLOWED_ACTIONS.join(", ")
            );
        }
    }

    let ctx = PlatformCtx {
        platform,
        device,
        simulator,
        companion_path,
    };

    let total_start = std::time::Instant::now();
    let mut results: Vec<StepResult> = Vec::with_capacity(steps.len());
    let mut screenshots_taken: usize = 0;
    let mut all_passed = true;

    for (i, step) in steps.iter().enumerate() {
        let step_start = std::time::Instant::now();

        // Turbo fast-track (Android-only, same as flow run)
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

        let ui = if turbo { compact_ui_dump(&ctx).ok() } else { None };

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

        if !success && step.on_error == OnError::Stop {
            for j in (i + 1)..steps.len() {
                results.push(StepResult {
                    step: j + 1,
                    action: steps[j].action.clone(),
                    success: false,
                    message: "Skipped: previous command failed (stop_on_error=true)".into(),
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

    if all_passed { Ok(()) } else { bail!("") }
}

// ---------------------------------------------------------------------------
// `flow parallel` — run a flow file on multiple devices sequentially
// ---------------------------------------------------------------------------

/// Per-device result for `flow parallel`.
#[derive(serde::Serialize)]
struct DeviceFlowResult {
    device: String,
    result: FlowResult,
}

/// Run the same flow JSON on each device in `devices` (comma-separated)
/// sequentially. Produces a JSON array of per-device [`FlowResult`] objects.
pub fn parallel(
    platform: &str,
    file: Option<&str>,
    devices: &str,
    turbo: bool,
    max_duration: u64,
) -> Result<()> {
    let max_duration = max_duration.min(MAX_DURATION_LIMIT);

    // Read flow steps once — same steps are run on every device
    let json_text = match file {
        Some(path) => std::fs::read_to_string(path)
            .map_err(|e| anyhow::anyhow!("Cannot read file '{}': {}", path, e))?,
        None => {
            let mut buf = String::new();
            std::io::stdin().read_to_string(&mut buf)?;
            buf
        }
    };

    // Validate the step list once up-front (same for all devices)
    let steps: Vec<FlowStep> = serde_json::from_str(&json_text)
        .map_err(|e| anyhow::anyhow!("Invalid step JSON: {}", e))?;

    if steps.is_empty() {
        bail!("Flow contains zero steps");
    }
    if steps.len() > MAX_STEPS {
        bail!(
            "Flow contains {} steps, maximum is {}",
            steps.len(),
            MAX_STEPS
        );
    }

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

    let device_list: Vec<&str> = devices
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();

    if device_list.is_empty() {
        bail!("--devices must contain at least one device identifier");
    }

    let mut device_results: Vec<DeviceFlowResult> = Vec::with_capacity(device_list.len());

    for &device_id in &device_list {
        let ctx = PlatformCtx {
            platform,
            device: Some(device_id),
            simulator: Some(device_id),
            companion_path: None,
        };

        let total_start = std::time::Instant::now();
        let mut results: Vec<StepResult> = Vec::with_capacity(steps.len());
        let mut screenshots_taken: usize = 0;
        let mut all_passed = true;

        'steps: for (i, step) in steps.iter().enumerate() {
            if total_start.elapsed().as_millis() as u64 >= max_duration {
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
                break 'steps;
            }

            let step_start = std::time::Instant::now();

            // Turbo fast-track (Android-only)
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
                            continue 'steps;
                        }
                        Err(_) => { /* fall through */ }
                    }
                }
            }

            let exec_result = execute_step(&ctx, step);
            let step_ms = step_start.elapsed().as_millis();

            let (success, message) = match exec_result {
                Ok(msg) => (true, msg),
                Err(e) => (false, format!("{e}")),
            };

            let ui = if turbo { compact_ui_dump(&ctx).ok() } else { None };

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

            if !success && step.on_error == OnError::Stop {
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
                break 'steps;
            }
        }

        let total_ms = total_start.elapsed().as_millis();
        let passed = results.iter().filter(|r| r.success).count();
        let failed = results.iter().filter(|r| !r.success).count();
        let total = results.len();

        device_results.push(DeviceFlowResult {
            device: device_id.to_owned(),
            result: FlowResult {
                completed: all_passed,
                total_ms,
                steps: results,
                passed,
                failed,
                total,
            },
        });
    }

    println!("{}", serde_json::to_string_pretty(&device_results)?);

    let all_devices_passed = device_results.iter().all(|dr| dr.result.completed);
    if all_devices_passed {
        Ok(())
    } else {
        bail!("")
    }
}

// ---------------------------------------------------------------------------
// Step dispatcher — maps action names to existing platform functions
// ---------------------------------------------------------------------------

fn execute_step(ctx: &PlatformCtx<'_>, step: &FlowStep) -> Result<String> {
    match step.action.as_str() {
        // core
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
        // Batch 1/2 — sensor
        "sensor-location" => step_sensor_location(ctx, &step.args),
        "sensor-battery" => step_sensor_battery(ctx, &step.args),
        "sensor-notifications" => step_sensor_notifications(ctx, &step.args),
        "sensor-thermal" => step_sensor_thermal(ctx, &step.args),
        // Batch 1/2 — network
        "network-traffic" => step_network_traffic(ctx, &step.args),
        "network-connectivity" => step_network_connectivity(ctx),
        "network-proxy" => step_network_proxy(ctx, &step.args),
        "network-airplane" => step_network_airplane(ctx, &step.args),
        // Batch 1/2 — permissions
        "permission-grant" => step_permission_grant(ctx, &step.args),
        "permission-revoke" => step_permission_revoke(ctx, &step.args),
        "permission-reset" => step_permission_reset(ctx, &step.args),
        // Batch 1/2 — intents
        "intent-start" => step_intent_start(ctx, &step.args),
        "intent-broadcast" => step_intent_broadcast(ctx, &step.args),
        "intent-deeplink" => step_intent_deeplink(ctx, &step.args),
        "intent-services" => step_intent_services(ctx, &step.args),
        // Batch 1/2 — sandbox
        "sandbox-prefs-read" => step_sandbox_prefs_read(ctx, &step.args),
        "sandbox-prefs-write" => step_sandbox_prefs_write(ctx, &step.args),
        "sandbox-sqlite-query" => step_sandbox_sqlite_query(ctx, &step.args),
        "sandbox-file-list" => step_sandbox_file_list(ctx, &step.args),
        "sandbox-file-read" => step_sandbox_file_read(ctx, &step.args),
        // Batch 1/2 — UI assertions
        "ui-wait" => step_ui_wait(ctx, &step.args),
        "ui-assert-visible" => step_ui_assert_visible(ctx, &step.args),
        "ui-assert-gone" => step_ui_assert_gone(ctx, &step.args),
        // Batch 1/2 — performance
        "perf-snapshot" => step_perf_snapshot(ctx, &step.args),
        "perf-crashes" => step_perf_crashes(ctx, &step.args),
        "perf-framestats" => step_perf_framestats(ctx, &step.args),
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
// Batch 2 — sensor step helpers (Android-only)
// ---------------------------------------------------------------------------

fn step_sensor_location(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    require_args(args, 2, "sensor-location")?;
    let lat: f64 = args[0].parse().map_err(|_| anyhow::anyhow!("Invalid latitude"))?;
    let lon: f64 = args[1].parse().map_err(|_| anyhow::anyhow!("Invalid longitude"))?;
    let alt: f64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0.0);
    android::sensor_location(lat, lon, alt, ctx.device)?;
    Ok(format!("GPS mocked to ({}, {})", lat, lon))
}

fn step_sensor_battery(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    let level = args.first().and_then(|s| s.parse::<u8>().ok());
    let status = args.get(1).map(|s| s.as_str());
    let plugged = args.get(2).map(|s| s.as_str());
    android::sensor_battery(level, status, plugged, false, ctx.device)?;
    Ok(format!("Battery override applied"))
}

fn step_sensor_notifications(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    let pkg_filter = args.first().map(|s| s.as_str());
    android::sensor_notifications(pkg_filter, ctx.device)?;
    Ok("Notifications listed".into())
}

fn step_sensor_thermal(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    let reset = args.first().map(|s| s == "reset").unwrap_or(false);
    let status = if reset { None } else { args.first().map(|s| s.as_str()) };
    android::sensor_thermal(status, reset, ctx.device)?;
    Ok(if reset { "Thermal status reset".into() } else { format!("Thermal status set") })
}

// ---------------------------------------------------------------------------
// Batch 2 — network step helpers (Android-only)
// ---------------------------------------------------------------------------

fn step_network_traffic(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    let pkg = args.first().map(|s| s.as_str());
    android::network_traffic(pkg, ctx.device)?;
    Ok("Network traffic retrieved".into())
}

fn step_network_connectivity(ctx: &PlatformCtx<'_>) -> Result<String> {
    android::network_connectivity(ctx.device)?;
    Ok("Network connectivity retrieved".into())
}

fn step_network_proxy(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    let clear = args.first().map(|s| s == "clear").unwrap_or(false);
    let host = if !clear { args.first().map(|s| s.as_str()) } else { None };
    let port: Option<u16> = args.get(1).and_then(|s| s.parse().ok());
    android::network_proxy(host, port, clear, ctx.device)?;
    Ok("Network proxy updated".into())
}

fn step_network_airplane(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    require_args(args, 1, "network-airplane")?;
    let on = args[0] == "on";
    android::network_airplane(on, ctx.device)?;
    Ok(format!("Airplane mode {}", if on { "ON" } else { "OFF" }))
}

// ---------------------------------------------------------------------------
// Batch 2 — permission step helpers
// ---------------------------------------------------------------------------

fn step_permission_grant(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    require_args(args, 2, "permission-grant")?;
    android::permission_grant(&args[0], &args[1], ctx.device)?;
    Ok(format!("Granted {} to {}", args[1], args[0]))
}

fn step_permission_revoke(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    require_args(args, 2, "permission-revoke")?;
    android::permission_revoke(&args[0], &args[1], ctx.device)?;
    Ok(format!("Revoked {} from {}", args[1], args[0]))
}

fn step_permission_reset(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    require_args(args, 1, "permission-reset")?;
    android::permission_reset(&args[0], ctx.device)?;
    Ok(format!("Permissions reset for {}", args[0]))
}

// ---------------------------------------------------------------------------
// Batch 2 — intent step helpers (Android-only)
// ---------------------------------------------------------------------------

fn step_intent_start(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    // args: [action?, component?, data?, category?, package?]
    let action = args.first().filter(|s| !s.is_empty()).map(|s| s.as_str());
    let component = args.get(1).filter(|s| !s.is_empty()).map(|s| s.as_str());
    let data = args.get(2).filter(|s| !s.is_empty()).map(|s| s.as_str());
    let category = args.get(3).filter(|s| !s.is_empty()).map(|s| s.as_str());
    let package = args.get(4).filter(|s| !s.is_empty()).map(|s| s.as_str());
    android::intent_start(action, component, data, category, package, None, None, ctx.device)?;
    Ok("Intent started".into())
}

fn step_intent_broadcast(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    require_args(args, 1, "intent-broadcast")?;
    let action = &args[0];
    let package = args.get(1).map(|s| s.as_str());
    android::intent_broadcast(action, package, None, None, ctx.device)?;
    Ok(format!("Broadcast sent: {}", action))
}

fn step_intent_deeplink(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    require_args(args, 1, "intent-deeplink")?;
    let uri = &args[0];
    android::intent_deeplink(uri, None, ctx.device)?;
    Ok(format!("Deep-link opened: {}", uri))
}

fn step_intent_services(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    let pkg = args.first().map(|s| s.as_str());
    android::intent_services(pkg, ctx.device)?;
    Ok("Services listed".into())
}

// ---------------------------------------------------------------------------
// Batch 2 — sandbox step helpers (Android-only)
// ---------------------------------------------------------------------------

fn step_sandbox_prefs_read(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    require_args(args, 1, "sandbox-prefs-read")?;
    let pkg = &args[0];
    let file = args.get(1).map(|s| s.as_str());
    android::sandbox_prefs_read(pkg, file, ctx.device)?;
    Ok(format!("Preferences read for {}", pkg))
}

fn step_sandbox_prefs_write(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    require_args(args, 4, "sandbox-prefs-write")?;
    android::sandbox_prefs_write(&args[0], &args[1], &args[2], &args[3], args.get(4).map(|s| s.as_str()), ctx.device)?;
    Ok(format!("Preference written: {}.{} = {}", args[1], args[2], args[3]))
}

fn step_sandbox_sqlite_query(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    require_args(args, 3, "sandbox-sqlite-query")?;
    android::sandbox_sqlite_query(&args[0], &args[1], &args[2], ctx.device)?;
    Ok("SQLite query executed".into())
}

fn step_sandbox_file_list(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    require_args(args, 1, "sandbox-file-list")?;
    let path = args.get(1).map(|s| s.as_str());
    android::sandbox_file_list(&args[0], path, ctx.device)?;
    Ok(format!("File list for {}", args[0]))
}

fn step_sandbox_file_read(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    require_args(args, 2, "sandbox-file-read")?;
    let max_bytes: Option<u64> = args.get(2).and_then(|s| s.parse().ok());
    android::sandbox_file_read(&args[0], &args[1], max_bytes, ctx.device)?;
    Ok(format!("File read: {}/{}", args[0], args[1]))
}

// ---------------------------------------------------------------------------
// Batch 2 — UI assertion step helpers
// ---------------------------------------------------------------------------

fn step_ui_wait(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    require_args(args, 1, "ui-wait")?;
    let query = &args[0];
    let timeout: u64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(5000);
    let interval: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(500);
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout);

    loop {
        let found = match ctx.platform {
            "android" => android::find_element(query, ctx.device)?,
            "ios" => ios::find_element(query, ctx.simulator)?,
            _ => bail!("Unsupported platform for ui-wait"),
        };
        if found.is_some() {
            return Ok(format!("Element '{}' appeared", query));
        }
        if std::time::Instant::now() >= deadline {
            bail!("Timed out waiting for element '{}'", query);
        }
        std::thread::sleep(std::time::Duration::from_millis(interval));
    }
}

fn step_ui_assert_visible(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    require_args(args, 1, "ui-assert-visible")?;
    let query = &args[0];
    let found = match ctx.platform {
        "android" => android::find_element(query, ctx.device)?,
        "ios" => ios::find_element(query, ctx.simulator)?,
        _ => bail!("Unsupported platform for ui-assert-visible"),
    };
    if found.is_none() {
        bail!("Element '{}' not found (assert-visible failed)", query);
    }
    Ok(format!("Element '{}' is visible", query))
}

fn step_ui_assert_gone(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    require_args(args, 1, "ui-assert-gone")?;
    let query = &args[0];
    let found = match ctx.platform {
        "android" => android::find_element(query, ctx.device)?,
        "ios" => ios::find_element(query, ctx.simulator)?,
        _ => bail!("Unsupported platform for ui-assert-gone"),
    };
    if found.is_some() {
        bail!("Element '{}' is still present (assert-gone failed)", query);
    }
    Ok(format!("Element '{}' is gone", query))
}

// ---------------------------------------------------------------------------
// Batch 3 — performance step helpers (Android-only)
// ---------------------------------------------------------------------------

fn step_perf_snapshot(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    require_args(args, 1, "perf-snapshot")?;
    android::perf_snapshot(&args[0], ctx.device)?;
    Ok(format!("Perf snapshot captured for {}", args[0]))
}

fn step_perf_crashes(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    let pkg = args.first().map(|s| s.as_str());
    let lines: usize = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(50);
    android::perf_crashes(pkg, lines, ctx.device)?;
    Ok("Crash log retrieved".into())
}

fn step_perf_framestats(ctx: &PlatformCtx<'_>, args: &[String]) -> Result<String> {
    require_args(args, 1, "perf-framestats")?;
    android::perf_framestats(&args[0], ctx.device)?;
    Ok(format!("Frame stats captured for {}", args[0]))
}

// ---------------------------------------------------------------------------
// Turbo fast-track helpers (Android-only)
// ---------------------------------------------------------------------------

// `escape_adb_text` was retired in v3.10.3 (issue #42). Text composition for
// `adb shell input text …` now goes through
// [`crate::utils::device_shell::DeviceShellCmd`], which POSIX-quotes the
// payload by construction. The Android `%s`-as-space sentinel is still
// applied below.

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
            // i32 values are metachar-free; user_input is used for consistency.
            let cmd = DeviceShellCmd::new()
                .literal("input")
                .literal("tap")
                .user_input(&x.to_string())
                .user_input(&y.to_string())
                .render();
            Some((cmd, format!("Tapped at ({}, {})", x, y)))
        }
        "key" if !step.args.is_empty() => {
            let keycode = resolve_keycode(&step.args[0])?;
            let cmd = DeviceShellCmd::new()
                .literal("input")
                .literal("keyevent")
                .literal(keycode)
                .render();
            Some((cmd, format!("Pressed key \"{}\"", step.args[0])))
        }
        "input" if !step.args.is_empty() => {
            // Android's `input text` treats `%s` as a literal space; we apply
            // the sentinel before POSIX-quoting via the builder.
            let with_space_sentinel = step.args[0].replace(' ', "%s");
            let cmd = DeviceShellCmd::new()
                .literal("input")
                .literal("text")
                .user_input(&with_space_sentinel)
                .render();
            Some((cmd, format!("Typed \"{}\"", step.args[0])))
        }
        "swipe" if step.args.len() >= 4 => {
            let x1 = step.args[0].parse::<i32>().ok()?;
            let y1 = step.args[1].parse::<i32>().ok()?;
            let x2 = step.args[2].parse::<i32>().ok()?;
            let y2 = step.args[3].parse::<i32>().ok()?;
            let dur: u32 = step.args.get(4).and_then(|s| s.parse().ok()).unwrap_or(300);
            let cmd = DeviceShellCmd::new()
                .literal("input")
                .literal("swipe")
                .user_input(&x1.to_string())
                .user_input(&y1.to_string())
                .user_input(&x2.to_string())
                .user_input(&y2.to_string())
                .user_input(&dur.to_string())
                .render();
            Some((cmd, format!("Swiped ({},{}) -> ({},{})", x1, y1, x2, y2)))
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
