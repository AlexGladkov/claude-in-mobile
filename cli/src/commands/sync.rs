//! Sync commands — coordinated multi-device testing.
//!
//! A sync group defines named roles (each mapped to a device ID).
//! Steps are tagged by role and executed sequentially across the active group.
//! Group state is stored in a private per-user state directory.

use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::cli::SyncCommands;
use crate::utils::private_state::{
    atomic_write, create_private_file_if_missing, read_bounded_file, read_bounded_legacy_file,
    read_json_file, state_dir, validate_identifier, validate_legacy_file_security,
};

#[cfg(test)]
use crate::utils::private_state::create_private_dir;
use crate::utils::process::{install_deadline, terminal_safe};

const MAX_GROUP_BYTES: u64 = 1024 * 1024;
const MAX_GROUPS: usize = 128;
const MAX_LEGACY_SCAN_ENTRIES: usize = 4096;
const MAX_STATE_SCAN_ENTRIES: usize = 4096;
const MAX_ROLES: usize = 64;

const MAX_STEPS_BYTES: u64 = 1024 * 1024;
const MAX_STEPS: usize = 1_000;
const LEGACY_TMP_DIR_ENV: &str = "MCP_DEVICES_LEGACY_TMP_DIR";
#[cfg(test)]
const TEST_STATE_ROOT_ENV: &str = "MCP_DEVICES_TEST_STATE_ROOT";
const MAX_STEP_ARGS: usize = 64;
const MAX_STEP_ARG_BYTES: usize = 4_096;
const MAX_ASSERT_RETRIES: u32 = 5;
const MAX_ASSERT_DELAY_MS: u64 = 30_000;
const MAX_ASSERT_CROSS_DURATION_MS: u64 = 60_000;
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
fn sync_group_dir() -> Result<PathBuf> {
    #[cfg(test)]
    if let Some(root) = std::env::var_os(TEST_STATE_ROOT_ENV) {
        let directory = PathBuf::from(root).join("sync-groups");
        create_private_dir(&directory)?;
        return Ok(directory);
    }
    state_dir("sync-groups")
}

static SYNC_GROUP_STATE_LOCK: Mutex<()> = Mutex::new(());

struct SyncGroupStateGuard {
    _file: File,
    _process_guard: MutexGuard<'static, ()>,
}

fn lock_sync_group_state() -> Result<SyncGroupStateGuard> {
    let process_guard = SYNC_GROUP_STATE_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("Sync group state lock poisoned"))?;
    let path = sync_group_dir()?.join(".lock");
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    options.mode(0o600);
    let file = options
        .open(&path)
        .with_context(|| format!("Cannot open sync group lock {}", path.display()))?;
    file.lock()
        .with_context(|| format!("Cannot lock sync group state {}", path.display()))?;
    Ok(SyncGroupStateGuard {
        _file: file,
        _process_guard: process_guard,
    })
}

fn group_path(name: &str) -> Result<PathBuf> {
    validate_identifier(name, "sync group name")?;
    Ok(sync_group_dir()?.join(format!("{name}.json")))
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

fn legacy_tmp_dir() -> PathBuf {
    std::env::var_os(LEGACY_TMP_DIR_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

fn legacy_group_path(name: &str) -> PathBuf {
    legacy_tmp_dir().join(format!("claude-mobile-sync-{name}.json"))
}

fn migrate_legacy_group(name: &str, destination: &Path) -> Result<()> {
    validate_identifier(name, "sync group name")?;
    match fs::symlink_metadata(destination) {
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Cannot inspect sync group {}", destination.display()));
        }
    }

    let legacy = legacy_group_path(name);
    let metadata = match fs::symlink_metadata(&legacy) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Cannot inspect legacy sync group {}", legacy.display()));
        }
    };
    validate_legacy_file_security(&legacy, &metadata, "Legacy sync group")?;

    let contents = read_bounded_legacy_file(&legacy, MAX_GROUP_BYTES, "sync group state")?;
    let group: SyncGroup = serde_json::from_slice(&contents)
        .with_context(|| format!("Corrupt legacy sync group at {}", legacy.display()))?;
    validate_group(&group)?;
    if group.name != name {
        bail!("Legacy sync group identity does not match its storage path");
    }
    if create_private_file_if_missing(destination, &contents, "sync group state")? {
        match fs::remove_file(&legacy) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("Cannot remove migrated sync group {}", legacy.display())
                });
            }
        }
    }
    Ok(())
}

fn legacy_group_candidates() -> Result<Vec<String>> {
    let directory = legacy_tmp_dir();
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "Cannot inspect legacy sync groups in {}",
                    directory.display()
                )
            });
        }
    };
    let mut candidates = Vec::new();
    for (index, entry) in entries.enumerate() {
        if index >= MAX_LEGACY_SCAN_ENTRIES {
            bail!(
                "Legacy sync group directory exceeds scan limit of {MAX_LEGACY_SCAN_ENTRIES} entries"
            );
        }
        let path = entry?.path();
        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !file_name.starts_with("claude-mobile-sync-") {
            continue;
        }
        let Some(name) = file_name
            .strip_prefix("claude-mobile-sync-")
            .and_then(|value| value.strip_suffix(".json"))
        else {
            continue;
        };
        if validate_identifier(name, "sync group name").is_ok() {
            candidates.push(name.to_owned());
        }
    }
    if candidates.len() > MAX_GROUPS {
        bail!("Legacy sync group directory exceeds {MAX_GROUPS} entries");
    }
    candidates.sort();
    Ok(candidates)
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

fn read_group(name: &str) -> Result<SyncGroup> {
    let path = group_path(name)?;
    migrate_legacy_group(name, &path)?;
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
    let dir = sync_group_dir()?;
    let mut paths = Vec::new();
    for (index, entry) in fs::read_dir(dir)?.enumerate() {
        if index >= MAX_STATE_SCAN_ENTRIES {
            bail!("Sync group directory exceeds scan limit of {MAX_STATE_SCAN_ENTRIES} entries");
        }
        let path = entry?.path();
        if path.extension().and_then(|value| value.to_str()) == Some("json") {
            paths.push(path);
        }
    }

    for name in legacy_group_candidates()? {
        let path = group_path(&name)?;
        migrate_legacy_group(&name, &path)?;
        if !paths.iter().any(|existing| existing == &path) {
            paths.push(path);
        }
    }
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
            max_duration,
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
            max_duration,
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
    let _state_lock = lock_sync_group_state()?;
    let path = group_path(name)?;
    migrate_legacy_group(name, &path)?;
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
    let group = {
        let _state_lock = lock_sync_group_state()?;
        read_group(group_name)?
    };

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

    let max_duration = max_duration.map(Duration::from_millis);
    let run_start = Instant::now();
    let deadline = max_duration.and_then(|duration| run_start.checked_add(duration));
    let _deadline_guard = install_deadline(deadline);

    println!(
        "Running {} steps across sync group '{}' …",
        steps.len(),
        group_name
    );

    let mut passed = 0usize;
    let mut failed = 0usize;
    let mut duration_exhausted = false;

    for (i, step) in steps.iter().enumerate() {
        if max_duration.is_some_and(|limit| run_start.elapsed() >= limit) {
            println!("Max duration reached, stopping.");
            duration_exhausted = true;
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

        let result =
            execute_sync_step_with_deadline(&step.action, &step.args, &device_id, deadline);
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

        if max_duration.is_some_and(|limit| run_start.elapsed() >= limit) {
            println!("Max duration reached, stopping.");
            duration_exhausted = true;
            break;
        }
    }

    let total_ms = run_start.elapsed().as_millis();

    // Merge the summary into the latest state under the lock so concurrent
    // group changes are not overwritten by this run's earlier snapshot.
    let summary = SyncRunSummary {
        timestamp: now_iso8601(),
        passed,
        failed,
        total_ms,
    };
    let _state_lock = lock_sync_group_state()?;
    let path = group_path(group_name)?;
    match fs::symlink_metadata(&path) {
        Ok(_) => {
            let mut latest = read_group(group_name)?;
            let same_group = latest.created_at == group.created_at
                && latest.roles.len() == group.roles.len()
                && latest
                    .roles
                    .iter()
                    .zip(&group.roles)
                    .all(|(current, original)| {
                        current.name == original.name && current.device_id == original.device_id
                    });
            if same_group {
                latest.last_run = Some(summary);
                write_group(&latest)?;
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Cannot inspect sync group {}", path.display()));
        }
    }

    println!(
        "\nDone: {} passed, {} failed ({}ms).",
        passed, failed, total_ms
    );

    if duration_exhausted {
        bail!("Sync run did not complete within max duration");
    }
    if failed > 0 {
        bail!("Sync run finished with {} failure(s)", failed);
    }
    Ok(())
}

fn input_acknowledgement(text: &str) -> String {
    format!("Typed {} characters", text.chars().count())
}

/// Execute one step, bounding a `wait` action by the run's remaining budget.
fn execute_sync_step_with_deadline(
    action: &str,
    args: &[String],
    device_id: &str,
    deadline: Option<Instant>,
) -> Result<String> {
    use crate::android;
    ensure_deadline(deadline, "Sync action")?;

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
            Ok(input_acknowledgement(&args[0]))
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
            let wait_duration = Duration::from_millis(ms);
            if let Some(deadline) = deadline {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if wait_duration > remaining {
                    if !remaining.is_zero() {
                        std::thread::sleep(remaining);
                    }
                    bail!("Wait duration of {ms}ms exceeds the remaining sync run duration");
                }
            }
            std::thread::sleep(wait_duration);
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

fn validate_assert_cross_options(delay_ms: Option<u64>, retries: u32) -> Result<()> {
    if !(1..=MAX_ASSERT_RETRIES).contains(&retries) {
        bail!("--retries must be between 1 and {MAX_ASSERT_RETRIES}");
    }
    if delay_ms.is_some_and(|delay| delay > MAX_ASSERT_DELAY_MS) {
        bail!("--delay-ms must not exceed {MAX_ASSERT_DELAY_MS}ms");
    }
    Ok(())
}

fn ensure_deadline(deadline: Option<Instant>, operation: &str) -> Result<()> {
    if deadline.is_some_and(|limit| Instant::now() >= limit) {
        bail!("{operation} exceeded max duration");
    }
    Ok(())
}

fn sleep_with_deadline(
    duration: Duration,
    deadline: Option<Instant>,
    operation: &str,
) -> Result<()> {
    ensure_deadline(deadline, operation)?;
    let Some(limit) = deadline else {
        std::thread::sleep(duration);
        return Ok(());
    };

    let remaining = limit.saturating_duration_since(Instant::now());
    let sleep_for = duration.min(remaining);
    if !sleep_for.is_zero() {
        std::thread::sleep(sleep_for);
    }
    if sleep_for < duration {
        bail!("{operation} exceeded max duration");
    }
    Ok(())
}

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
    max_duration: u64,
) -> Result<()> {
    let max_duration = max_duration.min(MAX_ASSERT_CROSS_DURATION_MS);
    let run_start = Instant::now();
    let deadline = run_start.checked_add(Duration::from_millis(max_duration));
    let _deadline_guard = install_deadline(deadline);
    ensure_deadline(deadline, "Cross-device assertion")?;
    validate_assert_cross_options(delay_ms, retries)?;
    let group = read_group(group_name)?;

    let src_device = role_device(&group, source_role)?;
    let tgt_device = role_device(&group, target_role)?;

    let src_args = parse_args_opt(source_args)?;
    let tgt_args = parse_args_opt(target_args)?;

    println!(
        "Cross-device assertion: [{}]:{} -> delay {}ms -> [{}]:{}",
        terminal_safe(source_role.as_bytes()),
        terminal_safe(source_action.as_bytes()),
        delay_ms.unwrap_or(0),
        terminal_safe(target_role.as_bytes()),
        terminal_safe(target_action.as_bytes())
    );

    // Execute source action.
    ensure_deadline(deadline, "Cross-device assertion")?;
    execute_sync_step_with_deadline(source_action, &src_args, &src_device, deadline).with_context(
        || {
            format!(
                "Source action '{}' on role '{}' failed",
                terminal_safe(source_action.as_bytes()),
                terminal_safe(source_role.as_bytes())
            )
        },
    )?;
    println!("  Source [{}] OK", source_role);

    // Optional delay between source and target.
    if let Some(d) = delay_ms {
        sleep_with_deadline(
            Duration::from_millis(d),
            deadline,
            "Cross-device assertion delay",
        )?;
    }

    // Execute target action with retries.
    let mut last_err = String::new();
    let attempt_count = retries;
    for attempt in 0..attempt_count {
        ensure_deadline(deadline, "Cross-device assertion")?;
        match execute_sync_step_with_deadline(target_action, &tgt_args, &tgt_device, deadline) {
            Ok(msg) => {
                ensure_deadline(deadline, "Cross-device assertion")?;
                println!(
                    "  Target [{}] OK  {} (attempt {})",
                    terminal_safe(target_role.as_bytes()),
                    terminal_safe(msg.as_bytes()),
                    attempt + 1
                );
                return Ok(());
            }
            Err(e) => {
                last_err = format!("{}", e);
                if deadline.is_some_and(|limit| Instant::now() >= limit) {
                    bail!(
                        "Cross-device assertion exceeded max duration while running target action"
                    );
                }
                if attempt + 1 < attempt_count {
                    println!(
                        "  Target [{}] attempt {} failed: {}. Retrying…",
                        terminal_safe(target_role.as_bytes()),
                        attempt + 1,
                        terminal_safe(last_err.as_bytes())
                    );
                    sleep_with_deadline(
                        Duration::from_millis(500),
                        deadline,
                        "Cross-device assertion retry delay",
                    )?;
                }
            }
        }
    }

    bail!(
        "Target action '{}' on role '{}' failed after {} attempt(s): {}",
        terminal_safe(target_action.as_bytes()),
        terminal_safe(target_role.as_bytes()),
        attempt_count,
        terminal_safe(last_err.as_bytes())
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
    let _state_lock = lock_sync_group_state()?;
    let path = group_path(group_name)?;
    migrate_legacy_group(group_name, &path)?;
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

    const SYNC_LOCK_TEST_READY: &str = "MCP_DEVICES_TEST_SYNC_LOCK_READY";
    const SYNC_LOCK_TEST_ACQUIRED: &str = "MCP_DEVICES_TEST_SYNC_LOCK_ACQUIRED";

    #[test]
    fn sync_group_lock_child_worker() {
        let Some(ready_path) = std::env::var_os(SYNC_LOCK_TEST_READY) else {
            return;
        };
        let acquired_path = std::env::var_os(SYNC_LOCK_TEST_ACQUIRED)
            .expect("child lock test requires acquired marker path");
        fs::write(ready_path, b"ready").unwrap();
        let _state_lock = lock_sync_group_state().unwrap();
        fs::write(acquired_path, b"acquired").unwrap();
    }

    #[test]
    fn sync_group_lock_serializes_independent_processes() {
        let state_root = tempfile::tempdir().unwrap();
        let group_dir = state_root.path().join("sync-groups");
        create_private_dir(&group_dir).unwrap();
        let lock_path = group_dir.join(".lock");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        options.mode(0o600);
        let lock_file = options.open(lock_path).unwrap();
        lock_file.lock().unwrap();

        let ready_path = state_root.path().join("child-ready");
        let acquired_path = state_root.path().join("child-acquired");
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("sync_group_lock_child_worker")
            .env(TEST_STATE_ROOT_ENV, state_root.path())
            .env(SYNC_LOCK_TEST_READY, &ready_path)
            .env(SYNC_LOCK_TEST_ACQUIRED, &acquired_path)
            .spawn()
            .unwrap();

        let start_deadline = Instant::now() + Duration::from_secs(5);
        while !ready_path.exists() && Instant::now() < start_deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(ready_path.exists(), "child did not start the lock attempt");
        std::thread::sleep(Duration::from_millis(100));
        assert!(
            !acquired_path.exists(),
            "child acquired the lock while another process held it"
        );

        drop(lock_file);
        assert!(child.wait().unwrap().success());
        assert!(acquired_path.exists());
    }

    #[test]
    fn input_acknowledgement_never_includes_entered_text() {
        let entered = "github_pat_secret_value";
        let acknowledgement = input_acknowledgement(entered);

        assert_eq!(acknowledgement, "Typed 23 characters");
        assert!(!acknowledgement.contains(entered));
    }

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

    #[test]
    fn assert_cross_rejects_invalid_retry_and_delay_values() {
        assert!(validate_assert_cross_options(Some(0), 1).is_ok());
        assert!(
            validate_assert_cross_options(Some(MAX_ASSERT_DELAY_MS), MAX_ASSERT_RETRIES).is_ok()
        );
        assert!(validate_assert_cross_options(None, 0).is_err());
        assert!(validate_assert_cross_options(None, MAX_ASSERT_RETRIES + 1).is_err());
        assert!(validate_assert_cross_options(Some(MAX_ASSERT_DELAY_MS + 1), 1).is_err());
    }

    #[test]
    fn sync_wait_is_bounded_by_the_remaining_run_duration() {
        let started = Instant::now();
        let deadline = started
            .checked_add(Duration::from_millis(5))
            .expect("short test deadline");
        let args = vec!["50".to_owned()];
        let error =
            execute_sync_step_with_deadline("wait", &args, "device-1", Some(deadline)).unwrap_err();

        assert!(error.to_string().contains("remaining sync run duration"));
        assert!(started.elapsed() < Duration::from_millis(100));
    }

    #[test]
    fn assert_cross_delays_stop_at_the_total_deadline() {
        let started = Instant::now();
        let deadline = started
            .checked_add(Duration::from_millis(5))
            .expect("short assertion deadline");

        let error = sleep_with_deadline(
            Duration::from_millis(50),
            Some(deadline),
            "Cross-device assertion delay",
        )
        .expect_err("delay should exceed the total assertion deadline");

        assert!(error.to_string().contains("exceeded max duration"));
        assert!(started.elapsed() < Duration::from_millis(100));
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
    fn legacy_sync_group_is_listed_migrated_and_not_clobbered() {
        let _lock = crate::android::LEGACY_STATE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let legacy_root = tempfile::tempdir().unwrap();
        let state_root = tempfile::tempdir().unwrap();
        let _legacy_env = EnvGuard::set(LEGACY_TMP_DIR_ENV, legacy_root.path());
        let _state_env = EnvGuard::set(TEST_STATE_ROOT_ENV, state_root.path());
        let private_dir = sync_group_dir().unwrap();
        for index in 0..=MAX_GROUPS {
            let unrelated = private_dir.join(format!("unrelated-{index}.tmp"));
            std::fs::write(unrelated, b"{}").unwrap();
        }

        let name = "migration-group";
        let group = SyncGroup {
            name: name.to_owned(),
            roles: vec![DeviceRole {
                name: "sender".to_owned(),
                device_id: "device-1".to_owned(),
            }],
            created_at: "2026-05-27T12:00:00Z".to_owned(),
            last_run: None,
        };
        for index in 0..=MAX_GROUPS {
            let unrelated = legacy_root.path().join(format!("unrelated-{index}.json"));
            std::fs::write(unrelated, b"{}").unwrap();
        }
        let legacy_path = legacy_group_path(name);
        std::fs::write(&legacy_path, serde_json::to_vec(&group).unwrap()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&legacy_path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }

        let destination = group_path(name).unwrap();
        let paths = all_group_paths().unwrap();
        assert!(paths.iter().any(|path| path == &destination));
        let migrated = read_group(name).unwrap();
        assert_eq!(migrated.roles[0].device_id, "device-1");

        let mut stale = group;
        stale.roles[0].device_id = "stale-device".to_owned();
        std::fs::write(&legacy_path, serde_json::to_vec(&stale).unwrap()).unwrap();
        let _ = all_group_paths().unwrap();
        let retained = read_group(name).unwrap();
        assert_eq!(retained.roles[0].device_id, "device-1");
    }
    #[test]
    fn legacy_sync_group_listing_rejects_malformed_candidate() {
        let _lock = crate::android::LEGACY_STATE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let legacy_root = tempfile::tempdir().unwrap();
        let state_root = tempfile::tempdir().unwrap();
        let _legacy_env = EnvGuard::set(LEGACY_TMP_DIR_ENV, legacy_root.path());
        let _state_env = EnvGuard::set(TEST_STATE_ROOT_ENV, state_root.path());

        let legacy_path = legacy_group_path("broken-group");
        std::fs::write(legacy_path, b"{not-json").unwrap();
        assert!(all_group_paths().is_err());
    }

    #[test]
    fn sync_run_fails_when_duration_leaves_steps_unexecuted() {
        let _lock = crate::android::LEGACY_STATE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let legacy_root = tempfile::tempdir().unwrap();
        let state_root = tempfile::tempdir().unwrap();
        let _legacy_env = EnvGuard::set(LEGACY_TMP_DIR_ENV, legacy_root.path());
        let _state_env = EnvGuard::set(TEST_STATE_ROOT_ENV, state_root.path());

        let group = SyncGroup {
            name: "duration-group".to_owned(),
            roles: vec![DeviceRole {
                name: "sender".to_owned(),
                device_id: "device-1".to_owned(),
            }],
            created_at: "2026-05-27T12:00:00Z".to_owned(),
            last_run: None,
        };
        write_group(&group).unwrap();

        let steps_path = state_root.path().join("steps.json");
        std::fs::write(
            &steps_path,
            br#"[{"role":"sender","action":"wait","args":["100"]},{"role":"sender","action":"wait","args":["1"]}]"#,
        )
        .unwrap();

        let started = Instant::now();
        let error = cmd_run("duration-group", steps_path.to_str().unwrap(), Some(5)).unwrap_err();

        assert!(error
            .to_string()
            .contains("did not complete within max duration"));
        assert!(started.elapsed() < Duration::from_millis(100));
        let saved = read_group("duration-group").unwrap();
        let summary = saved.last_run.unwrap();
        assert_eq!(summary.passed, 0);
        assert_eq!(summary.failed, 1);
    }

    #[test]
    fn sync_run_reports_incomplete_when_final_wait_consumes_budget() {
        let _lock = crate::android::LEGACY_STATE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let legacy_root = tempfile::tempdir().unwrap();
        let state_root = tempfile::tempdir().unwrap();
        let _legacy_env = EnvGuard::set(LEGACY_TMP_DIR_ENV, legacy_root.path());
        let _state_env = EnvGuard::set(TEST_STATE_ROOT_ENV, state_root.path());

        let group = SyncGroup {
            name: "final-wait-group".to_owned(),
            roles: vec![DeviceRole {
                name: "sender".to_owned(),
                device_id: "device-1".to_owned(),
            }],
            created_at: "2026-05-27T12:00:00Z".to_owned(),
            last_run: None,
        };
        write_group(&group).unwrap();

        let steps_path = state_root.path().join("final-wait-steps.json");
        std::fs::write(
            &steps_path,
            br#"[{"role":"sender","action":"wait","args":["100"]}]"#,
        )
        .unwrap();

        let error = cmd_run("final-wait-group", steps_path.to_str().unwrap(), Some(5)).unwrap_err();

        assert!(error
            .to_string()
            .contains("did not complete within max duration"));
        let saved = read_group("final-wait-group").unwrap();
        let summary = saved.last_run.unwrap();
        assert_eq!(summary.passed, 0);
        assert_eq!(summary.failed, 1);
    }

    #[cfg(unix)]
    #[test]
    fn legacy_sync_group_rejects_group_writable_file_before_import() {
        use std::os::unix::fs::PermissionsExt;

        let _lock = crate::android::LEGACY_STATE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let legacy_root = tempfile::tempdir().unwrap();
        let state_root = tempfile::tempdir().unwrap();
        let _legacy_env = EnvGuard::set(LEGACY_TMP_DIR_ENV, legacy_root.path());
        let _state_env = EnvGuard::set(TEST_STATE_ROOT_ENV, state_root.path());

        let name = "insecure-group";
        let legacy_path = legacy_group_path(name);
        let group = SyncGroup {
            name: name.to_owned(),
            roles: vec![DeviceRole {
                name: "sender".to_owned(),
                device_id: "device-1".to_owned(),
            }],
            created_at: "2026-05-27T12:00:00Z".to_owned(),
            last_run: None,
        };
        std::fs::write(&legacy_path, serde_json::to_vec(&group).unwrap()).unwrap();
        std::fs::set_permissions(&legacy_path, std::fs::Permissions::from_mode(0o666)).unwrap();

        let destination = group_path(name).unwrap();
        let error = migrate_legacy_group(name, &destination).unwrap_err();
        assert!(error.to_string().contains("group/world-writable"));
        assert!(!destination.exists());
    }
}
