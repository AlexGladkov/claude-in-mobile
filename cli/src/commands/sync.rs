//! Sync commands — coordinated multi-device testing.
//!
//! A sync group defines named roles (each mapped to a device ID).
//! Steps are tagged by role and executed sequentially across the active group.
//! Group state is stored in a private per-user state directory.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::cli::SyncCommands;
use crate::utils::private_state::{
    atomic_write, read_bounded_file, read_json_file, state_dir, state_file, validate_identifier,
};
use crate::utils::process::terminal_safe;

const MAX_GROUP_BYTES: u64 = 1024 * 1024;
const MAX_GROUPS: usize = 128;
const MAX_ROLES: usize = 64;

const MAX_STEPS_BYTES: u64 = 1024 * 1024;
const MAX_STEPS: usize = 1_000;
const MAX_STEP_ARGS: usize = 64;
const MAX_STEP_ARG_BYTES: usize = 4_096;
// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/// One device role inside a sync group.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceRole {
    pub name: String,
    #[serde(rename = "deviceId")]
    pub device_id: String,
}

/// A single cross-role step in a `sync run` JSON file.
#[derive(Debug, Deserialize)]
pub struct SyncStep {
    pub role: String,
    pub action: String,
    #[serde(default)]
    pub args: Vec<String>,
}

/// Persisted sync group state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncGroup {
    pub name: String,
    pub roles: Vec<DeviceRole>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    /// Summary of the last `sync run` invocation (for `sync status`).
    #[serde(rename = "lastRun", default, skip_serializing_if = "Option::is_none")]
    pub last_run: Option<SyncRunSummary>,
}

/// Brief record of the most recent run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncRunSummary {
    pub timestamp: String,
    pub passed: usize,
    pub failed: usize,
    #[serde(rename = "totalMs")]
    pub total_ms: u128,
}

fn validate_group(group: &SyncGroup) -> Result<()> {
    validate_identifier(&group.name, "sync group name")?;
    if group.roles.is_empty() || group.roles.len() > MAX_ROLES {
        bail!("Sync group must contain between 1 and {MAX_ROLES} roles");
    }
    let mut seen = std::collections::HashSet::new();
    for role in &group.roles {
        validate_identifier(&role.name, "role name")?;
        validate_identifier(&role.device_id, "device id")?;
        if !seen.insert(&role.name) {
            bail!("Duplicate role name '{}'.", role.name);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

fn group_path(name: &str) -> Result<PathBuf> {
    state_file("sync-groups", name, "json")
}

// ---------------------------------------------------------------------------
// Time helper (reuse simple impl from recorder, no external crate)
// ---------------------------------------------------------------------------

fn now_iso8601() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (y, mo, d, h, mi, s) = epoch_to_datetime(secs);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mo, d, h, mi, s)
}

#[allow(clippy::many_single_char_names)]
fn epoch_to_datetime(secs: u64) -> (u64, u64, u64, u64, u64, u64) {
    let s = secs % 60;
    let total_min = secs / 60;
    let mi = total_min % 60;
    let total_h = total_min / 60;
    let h = total_h % 24;
    let mut days = total_h / 24;
    let mut y = 1970u64;
    loop {
        let leap = is_leap(y);
        let diy: u64 = if leap { 366 } else { 365 };
        if days < diy {
            break;
        }
        days -= diy;
        y += 1;
    }
    let months: [u64; 12] = if is_leap(y) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut mo = 1u64;
    for dim in &months {
        if days < *dim {
            break;
        }
        days -= dim;
        mo += 1;
    }
    (y, mo, days + 1, h, mi, s)
}

fn is_leap(y: u64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

fn read_group(name: &str) -> Result<SyncGroup> {
    let path = group_path(name)?;
    let group = read_json_file(&path, MAX_GROUP_BYTES, "sync group state")
        .with_context(|| format!("No valid sync group '{name}' found"))?;
    validate_group(&group)?;
    Ok(group)
}

fn write_group(group: &SyncGroup) -> Result<()> {
    validate_group(group)?;
    let path = group_path(&group.name)?;
    let text = serde_json::to_vec_pretty(group)?;
    if text.len() as u64 > MAX_GROUP_BYTES {
        bail!("Sync group state exceeds {MAX_GROUP_BYTES} bytes");
    }
    atomic_write(&path, &text)
        .with_context(|| format!("Cannot write sync group to {}", path.display()))
}

fn all_group_paths() -> Result<Vec<PathBuf>> {
    let dir = state_dir("sync-groups")?;
    let paths = fs::read_dir(dir)?
        .take(MAX_GROUPS + 1)
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    if paths.len() > MAX_GROUPS {
        bail!("Sync group directory exceeds {MAX_GROUPS} entries");
    }
    Ok(paths)
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Dispatch a [`SyncCommands`] variant to its handler.
pub fn run(command: SyncCommands) -> Result<()> {
    match command {
        SyncCommands::CreateGroup { name, roles } => cmd_create_group(&name, &roles),
        SyncCommands::Run {
            group_name,
            file,
            max_duration,
        } => cmd_run(&group_name, &file, max_duration),
        SyncCommands::AssertCross {
            group_name,
            source_role,
            source_action,
            source_args,
            target_role,
            target_action,
            target_args,
            delay_ms,
            retries,
        } => cmd_assert_cross(
            &group_name,
            &source_role,
            &source_action,
            source_args.as_deref(),
            &target_role,
            &target_action,
            target_args.as_deref(),
            delay_ms,
            retries,
        ),
        SyncCommands::Status { group_name } => cmd_status(&group_name),
        SyncCommands::List => cmd_list(),
        SyncCommands::Destroy { group_name } => cmd_destroy(&group_name),
    }
}

// ---------------------------------------------------------------------------
// sync create-group
// ---------------------------------------------------------------------------

fn cmd_create_group(name: &str, roles_json: &str) -> Result<()> {
    let path = group_path(name)?;
    if path.exists() {
        bail!(
            "Sync group '{}' already exists. Destroy it first with `sync destroy {}`.",
            name,
            name
        );
    }

    let roles: Vec<DeviceRole> = serde_json::from_str(roles_json).context(
        "--roles must be a JSON array, e.g. '[{\"name\":\"sender\",\"deviceId\":\"abc\"}]'",
    )?;

    if roles.is_empty() || roles.len() > MAX_ROLES {
        bail!("Sync group must contain between 1 and {MAX_ROLES} roles");
    }
    let mut seen = std::collections::HashSet::new();
    for role in &roles {
        validate_identifier(&role.name, "role name")?;
        validate_identifier(&role.device_id, "device id")?;
        if !seen.insert(&role.name) {
            bail!("Duplicate role name '{}'.", role.name);
        }
    }

    let group = SyncGroup {
        name: name.to_owned(),
        roles,
        created_at: now_iso8601(),
        last_run: None,
    };

    write_group(&group)?;

    println!(
        "Sync group '{}' created ({} roles).",
        name,
        group.roles.len()
    );
    for r in &group.roles {
        println!("  {} -> device '{}'", r.name, r.device_id);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// sync run
// ---------------------------------------------------------------------------

fn cmd_run(group_name: &str, file: &str, max_duration: Option<u64>) -> Result<()> {
    let mut group = read_group(group_name)?;

    let steps_data = read_bounded_file(Path::new(file), MAX_STEPS_BYTES, "sync steps file")
        .with_context(|| {
            format!(
                "Cannot read steps file '{}'",
                terminal_safe(file.as_bytes())
            )
        })?;
    let steps: Vec<SyncStep> = serde_json::from_slice(&steps_data)
        .context("Steps file must be a JSON array of sync steps")?;

    if steps.is_empty() || steps.len() > MAX_STEPS {
        bail!("Steps file must contain between 1 and {MAX_STEPS} steps.");
    }
    for step in &steps {
        validate_identifier(&step.role, "step role")?;
        validate_identifier(&step.action, "step action")?;
        if step.args.len() > MAX_STEP_ARGS
            || step
                .args
                .iter()
                .any(|argument| argument.len() > MAX_STEP_ARG_BYTES)
        {
            bail!(
                "Each sync step accepts at most {MAX_STEP_ARGS} arguments of {MAX_STEP_ARG_BYTES} bytes"
            );
        }
    }

    let max_dur_ms = max_duration.unwrap_or(u64::MAX);
    let run_start = Instant::now();

    println!(
        "Running {} steps across sync group '{}' …",
        steps.len(),
        group_name
    );

    let mut passed = 0usize;
    let mut failed = 0usize;

    for (i, step) in steps.iter().enumerate() {
        if run_start.elapsed().as_millis() as u64 >= max_dur_ms {
            println!("Max duration reached, stopping.");
            break;
        }

        // Resolve the device ID for this role.
        let role_entry = group
            .roles
            .iter()
            .find(|r| r.name == step.role)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "Step {}: role '{}' not found in group '{}'",
                    i + 1,
                    step.role,
                    group_name
                )
            })?;
        let device_id = role_entry.device_id.clone();

        print!(
            "  [{}] {}/{}: {} … ",
            terminal_safe(step.role.as_bytes()),
            i + 1,
            steps.len(),
            terminal_safe(step.action.as_bytes()),
        );

        let result = execute_sync_step(&step.action, &step.args, &device_id);
        match result {
            Ok(msg) => {
                println!("OK  {}", terminal_safe(msg.as_bytes()));
                passed += 1;
            }
            Err(e) => {
                println!("FAIL  {}", terminal_safe(e.to_string().as_bytes()));
                failed += 1;
            }
        }
    }

    let total_ms = run_start.elapsed().as_millis();

    // Persist last-run summary.
    group.last_run = Some(SyncRunSummary {
        timestamp: now_iso8601(),
        passed,
        failed,
        total_ms,
    });
    write_group(&group)?;

    println!(
        "\nDone: {} passed, {} failed ({}ms).",
        passed, failed, total_ms
    );

    if failed > 0 {
        bail!("Sync run finished with {} failure(s)", failed);
    }
    Ok(())
}

/// Execute one step against an Android device (Android-only for sync, since device IDs are ADB serials).
fn execute_sync_step(action: &str, args: &[String], device_id: &str) -> Result<String> {
    use crate::android;

    let dev = if device_id.is_empty() {
        None
    } else {
        Some(device_id)
    };

    match action {
        "tap" => {
            if args.len() < 2 {
                bail!("tap requires 2 args");
            }
            let x: i32 = args[0].parse()?;
            let y: i32 = args[1].parse()?;
            android::tap(x, y, dev)?;
            Ok(format!("Tapped ({}, {})", x, y))
        }
        "tap-text" => {
            if args.is_empty() {
                bail!("tap-text requires 1 arg");
            }
            android::tap_element(&args[0], dev)?;
            Ok(format!("Tapped \"{}\"", args[0]))
        }
        "input" => {
            if args.is_empty() {
                bail!("input requires 1 arg");
            }
            android::input_text(&args[0], dev)?;
            Ok(format!("Typed \"{}\"", args[0]))
        }
        "swipe" => {
            if args.len() < 4 {
                bail!("swipe requires 4 args");
            }
            let x1: i32 = args[0].parse()?;
            let y1: i32 = args[1].parse()?;
            let x2: i32 = args[2].parse()?;
            let y2: i32 = args[3].parse()?;
            let dur: u32 = match args.get(4) {
                Some(value) => value
                    .parse()
                    .map_err(|_| anyhow::anyhow!("Invalid swipe duration"))?,
                None => 300,
            };
            if !(1..=60_000).contains(&dur) {
                bail!("Swipe duration must be between 1 and 60000 ms");
            }
            android::swipe(x1, y1, x2, y2, dur, dev)?;
            Ok(format!("Swiped ({},{}) -> ({},{})", x1, y1, x2, y2))
        }
        "key" => {
            if args.is_empty() {
                bail!("key requires 1 arg");
            }
            android::press_key(&args[0], dev)?;
            Ok(format!("Pressed key \"{}\"", args[0]))
        }
        "wait" => {
            if args.is_empty() {
                bail!("wait requires 1 arg");
            }
            let ms: u64 = args[0].parse()?;
            if ms > 60_000 {
                bail!("Wait duration must not exceed 60000 ms");
            }
            std::thread::sleep(std::time::Duration::from_millis(ms));
            Ok(format!("Waited {}ms", ms))
        }
        "launch" => {
            if args.is_empty() {
                bail!("launch requires 1 arg");
            }
            android::launch_app(&args[0], dev)?;
            Ok(format!("Launched \"{}\"", args[0]))
        }
        "stop" => {
            if args.is_empty() {
                bail!("stop requires 1 arg");
            }
            android::stop_app(&args[0], dev)?;
            Ok(format!("Stopped \"{}\"", args[0]))
        }
        other => bail!("Unsupported sync action '{}'", other),
    }
}

// ---------------------------------------------------------------------------
// sync assert-cross
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn cmd_assert_cross(
    group_name: &str,
    source_role: &str,
    source_action: &str,
    source_args: Option<&str>,
    target_role: &str,
    target_action: &str,
    target_args: Option<&str>,
    delay_ms: Option<u64>,
    retries: u32,
) -> Result<()> {
    let group = read_group(group_name)?;

    let src_device = role_device(&group, source_role)?;
    let tgt_device = role_device(&group, target_role)?;

    let src_args = parse_args_opt(source_args)?;
    let tgt_args = parse_args_opt(target_args)?;

    println!(
        "Cross-device assertion: [{}]:{} -> delay {}ms -> [{}]:{}",
        source_role,
        source_action,
        delay_ms.unwrap_or(0),
        target_role,
        target_action
    );

    // Execute source action.
    execute_sync_step(source_action, &src_args, &src_device).with_context(|| {
        format!(
            "Source action '{}' on role '{}' failed",
            source_action, source_role
        )
    })?;
    println!("  Source [{}] OK", source_role);

    // Optional delay between source and target.
    if let Some(d) = delay_ms {
        if d > 0 {
            std::thread::sleep(std::time::Duration::from_millis(d));
        }
    }

    // Execute target action with retries.
    let mut last_err = String::new();
    let attempt_count = retries.max(1);
    for attempt in 0..attempt_count {
        match execute_sync_step(target_action, &tgt_args, &tgt_device) {
            Ok(msg) => {
                println!(
                    "  Target [{}] OK  {} (attempt {})",
                    target_role,
                    msg,
                    attempt + 1
                );
                return Ok(());
            }
            Err(e) => {
                last_err = format!("{}", e);
                if attempt + 1 < attempt_count {
                    println!(
                        "  Target [{}] attempt {} failed: {}. Retrying…",
                        target_role,
                        attempt + 1,
                        last_err
                    );
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
            }
        }
    }

    bail!(
        "Target action '{}' on role '{}' failed after {} attempt(s): {}",
        target_action,
        target_role,
        attempt_count,
        last_err
    )
}

fn role_device(group: &SyncGroup, role_name: &str) -> Result<String> {
    group
        .roles
        .iter()
        .find(|r| r.name == role_name)
        .map(|r| r.device_id.clone())
        .ok_or_else(|| anyhow::anyhow!("Role '{}' not found in group '{}'", role_name, group.name))
}

fn parse_args_opt(raw: Option<&str>) -> Result<Vec<String>> {
    match raw {
        None | Some("") => Ok(vec![]),
        Some(s) => serde_json::from_str(s).context(
            "--source-args / --target-args must be a JSON array, e.g. '[\"100\",\"200\"]'",
        ),
    }
}

// ---------------------------------------------------------------------------
// sync status
// ---------------------------------------------------------------------------

fn cmd_status(group_name: &str) -> Result<()> {
    let group = read_group(group_name)?;

    println!("Sync group: '{}'", terminal_safe(group.name.as_bytes()));
    println!("  Created : {}", terminal_safe(group.created_at.as_bytes()));
    println!("  Roles   : {}", group.roles.len());
    for role in &group.roles {
        println!("    {} -> device '{}'", role.name, role.device_id);
    }

    if let Some(run) = &group.last_run {
        println!("  Last run: {}", terminal_safe(run.timestamp.as_bytes()));
        println!(
            "    passed={}, failed={}, total={}ms",
            run.passed, run.failed, run.total_ms
        );
    } else {
        println!("  Last run: (none)");
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// sync list
// ---------------------------------------------------------------------------

fn cmd_list() -> Result<()> {
    let paths = all_group_paths()?;
    if paths.is_empty() {
        println!("No active sync groups.");
        return Ok(());
    }

    for path in &paths {
        if let Ok(group) = read_json_file::<SyncGroup>(path, MAX_GROUP_BYTES, "sync group state") {
            if validate_group(&group).is_ok() {
                let roles: Vec<&str> = group.roles.iter().map(|role| role.name.as_str()).collect();
                println!("{} — roles: [{}]", group.name, roles.join(", "));
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// sync destroy
// ---------------------------------------------------------------------------

fn cmd_destroy(group_name: &str) -> Result<()> {
    let path = group_path(group_name)?;
    if !path.exists() {
        bail!("No sync group '{}' found.", group_name);
    }
    fs::remove_file(&path).with_context(|| format!("Cannot delete {}", path.display()))?;
    println!("Sync group '{}' destroyed.", group_name);
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sync_group_serialization_round_trip() {
        let group = SyncGroup {
            name: "chat-test".into(),
            roles: vec![
                DeviceRole {
                    name: "sender".into(),
                    device_id: "emulator-5554".into(),
                },
                DeviceRole {
                    name: "receiver".into(),
                    device_id: "emulator-5556".into(),
                },
            ],
            created_at: "2026-05-27T12:00:00Z".into(),
            last_run: None,
        };

        let json = serde_json::to_string(&group).unwrap();
        let parsed: SyncGroup = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.name, "chat-test");
        assert_eq!(parsed.roles.len(), 2);
        assert_eq!(parsed.roles[0].name, "sender");
        assert_eq!(parsed.roles[1].device_id, "emulator-5556");
        assert!(parsed.last_run.is_none());
    }

    #[test]
    fn test_sync_step_deserialization() {
        let json = r#"[
            {"role": "sender", "action": "tap", "args": ["100", "200"]},
            {"role": "receiver", "action": "wait", "args": ["500"]}
        ]"#;
        let steps: Vec<SyncStep> = serde_json::from_str(json).unwrap();
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].role, "sender");
        assert_eq!(steps[0].action, "tap");
        assert_eq!(steps[1].role, "receiver");
    }

    #[test]
    fn test_roles_json_parsing() {
        let json = r#"[{"name":"sender","deviceId":"abc"},{"name":"receiver","deviceId":"def"}]"#;
        let roles: Vec<DeviceRole> = serde_json::from_str(json).unwrap();
        assert_eq!(roles.len(), 2);
        assert_eq!(roles[0].name, "sender");
        assert_eq!(roles[0].device_id, "abc");
    }

    #[test]
    fn test_duplicate_role_names_detected() {
        let roles = vec![
            DeviceRole {
                name: "sender".into(),
                device_id: "aaa".into(),
            },
            DeviceRole {
                name: "sender".into(),
                device_id: "bbb".into(),
            },
        ];

        let mut seen = std::collections::HashSet::new();
        let has_duplicate = roles.iter().any(|r| !seen.insert(&r.name));
        assert!(has_duplicate);
    }

    #[test]
    fn test_role_device_lookup_found() {
        let group = SyncGroup {
            name: "g".into(),
            roles: vec![DeviceRole {
                name: "sender".into(),
                device_id: "dev-1".into(),
            }],
            created_at: "".into(),
            last_run: None,
        };
        let result = role_device(&group, "sender");
        assert_eq!(result.unwrap(), "dev-1");
    }

    #[test]
    fn test_role_device_lookup_not_found() {
        let group = SyncGroup {
            name: "g".into(),
            roles: vec![],
            created_at: "".into(),
            last_run: None,
        };
        assert!(role_device(&group, "nonexistent").is_err());
    }

    #[test]
    fn test_parse_args_opt_none() {
        let args = parse_args_opt(None).unwrap();
        assert!(args.is_empty());
    }

    #[test]
    fn test_parse_args_opt_empty_string() {
        let args = parse_args_opt(Some("")).unwrap();
        assert!(args.is_empty());
    }

    #[test]
    fn test_parse_args_opt_valid() {
        let args = parse_args_opt(Some(r#"["100","200"]"#)).unwrap();
        assert_eq!(args, vec!["100", "200"]);
    }

    #[test]
    fn test_parse_args_opt_invalid_json() {
        assert!(parse_args_opt(Some("not json")).is_err());
    }

    #[test]
    fn group_path_rejects_traversal() {
        assert!(group_path("../escape").is_err());
        assert!(group_path("valid-group").is_ok());
    }

    #[test]
    fn test_now_iso8601_format() {
        let ts = now_iso8601();
        assert_eq!(ts.len(), 20);
        assert!(ts.ends_with('Z'));
    }

    #[test]
    fn test_sync_run_summary_serialization() {
        let summary = SyncRunSummary {
            timestamp: "2026-05-27T12:00:00Z".into(),
            passed: 5,
            failed: 1,
            total_ms: 3_200,
        };
        let json = serde_json::to_string(&summary).unwrap();
        assert!(json.contains("\"passed\":5"));
        assert!(json.contains("\"failed\":1"));
        assert!(json.contains("\"totalMs\":3200"));
    }
}
