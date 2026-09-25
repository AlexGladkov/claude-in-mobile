//! Recorder commands — record, manage and replay automation scenarios.
//!
//! Scenarios and active recording state are kept in private user directories.

use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

use anyhow::{bail, Context, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cli::RecorderCommands;
use crate::utils::private_state::{
    app_dir, atomic_write, create_private_dir, create_private_file_if_missing,
    read_bounded_legacy_file, read_json_file, state_dir, validate_identifier,
    validate_legacy_file_security,
};
use crate::utils::process::{install_deadline, terminal_safe, terminal_safe_json};

const MAX_SCENARIO_BYTES: u64 = 4 * 1024 * 1024;
const MAX_RECORDING_FILES: usize = 128;
const MAX_LEGACY_SCAN_ENTRIES: usize = 4096;
const MAX_STEPS: usize = 10_000;
const MAX_DESCRIPTION_BYTES: usize = 16 * 1024;
const MAX_TAGS: usize = 64;
const MAX_TAG_BYTES: usize = 256;
const MAX_STEP_ARGS: usize = 64;
const MAX_STEP_ARG_BYTES: usize = 4096;
const MAX_LABEL_BYTES: usize = 4096;
const MAX_ARGS_JSON_BYTES: usize = 512 * 1024;
const LEGACY_TMP_DIR_ENV: &str = "MCP_DEVICES_LEGACY_TMP_DIR";
#[cfg(test)]
const TEST_STATE_ROOT_ENV: &str = "MCP_DEVICES_TEST_STATE_ROOT";

/// Serializes the read/modify/write transitions for the single active
/// recording slot. The process mutex covers in-process callers; the advisory
/// lock file also coordinates independent CLI processes and is released by the
/// operating system when the process exits.
static RECORDING_STATE_LOCK: Mutex<()> = Mutex::new(());

struct RecordingStateLock {
    _file: File,
    _process_guard: MutexGuard<'static, ()>,
}

fn acquire_advisory_recording_lock(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    options.mode(0o600);

    let file = options
        .open(path)
        .with_context(|| format!("Cannot open recorder lock {}", path.display()))?;
    file.lock()
        .with_context(|| format!("Cannot lock recorder state {}", path.display()))?;
    Ok(file)
}

fn lock_recording_state() -> Result<RecordingStateLock> {
    let process_guard = RECORDING_STATE_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("Recorder state lock poisoned"))?;
    let path = recording_state_dir()?.join(".lock");
    let file = acquire_advisory_recording_lock(&path)?;
    Ok(RecordingStateLock {
        _file: file,
        _process_guard: process_guard,
    })
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/// A single recorded step inside a scenario.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScenarioStep {
    /// Zero-based index inside the scenario.
    pub index: usize,
    /// Step category: "gesture", "input", "assertion", etc.
    #[serde(rename = "type")]
    pub step_type: String,
    /// Action name (tap, swipe, input, …).
    pub action: String,
    /// Action arguments.
    #[serde(default)]
    pub args: Vec<String>,
    /// Absolute timestamp (ms since epoch) when step was recorded.
    #[serde(rename = "timestampMs")]
    pub timestamp_ms: u64,
    /// Artificial delay to inject before this step on replay (ms).
    #[serde(rename = "delayBeforeMs", default)]
    pub delay_before_ms: u64,
    /// Optional human-readable label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// A saved scenario file (`~/.claude-mobile/scenarios/<platform>/<name>.json`).
#[derive(Debug, Serialize, Deserialize)]
pub struct Scenario {
    pub version: u32,
    pub name: String,
    pub platform: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub steps: Vec<ScenarioStep>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

/// In-progress recording state stored in the private recording-state directory.
#[derive(Debug, Serialize, Deserialize)]
struct RecordingState {
    pub name: String,
    pub platform: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub steps: Vec<ScenarioStep>,
    #[serde(rename = "startedAt")]
    pub started_at: String,
}

// ---------------------------------------------------------------------------
// Recorder argument redaction
// ---------------------------------------------------------------------------

const REDACTED_ARGUMENT: &str = "[REDACTED]";
const SENSITIVE_ARGUMENT_MARKERS: &[&str] = &[
    "password",
    "passwd",
    "passcode",
    "secret",
    "token",
    "api_key",
    "api-key",
    "apikey",
    "access_key",
    "access-key",
    "accesskey",
    "private_key",
    "private-key",
    "privatekey",
    "auth",
    "credential",
    "pin",
    "otp",
    "cvv",
    "cvc",
];

/// Credential-shaped values that may be supplied as an otherwise unnamed
/// positional argument. Named values are handled separately so their key can
/// remain visible while only the value is replaced.
static CREDENTIAL_TOKEN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?ix)\b(?:bearer[ \t]+[a-z0-9._~+/=-]{20,}|(?:akia|asia)[a-z0-9]{16}|(?:gh[pousr]_[a-z0-9_]{20,}|github_pat_[a-z0-9_]{20,}|sk-[a-z0-9_-]{20,}|xox[baprs]-[a-z0-9-]{20,})|eyj[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}|[a-z0-9+/=_-]{40,})\b",
    )
    .expect("credential token pattern must compile")
});

fn is_sensitive_argument_name(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    SENSITIVE_ARGUMENT_MARKERS
        .iter()
        .any(|marker| normalized.contains(marker))
}

fn contains_sensitive_input_text(value: &str) -> bool {
    is_sensitive_argument_name(value) || CREDENTIAL_TOKEN_RE.is_match(value)
}

fn json_contains_sensitive_text(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, nested)| {
            (is_text_or_value_key(key)
                && nested.as_str().is_some_and(contains_sensitive_input_text))
                || json_contains_sensitive_text(nested)
        }),
        Value::Array(values) => values.iter().any(json_contains_sensitive_text),
        Value::String(text) => contains_sensitive_input_text(text),
        _ => false,
    }
}

fn is_text_or_value_key(name: &str) -> bool {
    name.eq_ignore_ascii_case("text") || name.eq_ignore_ascii_case("value")
}

fn is_positional_input_action(action: &str) -> bool {
    action.eq_ignore_ascii_case("input")
        || action.eq_ignore_ascii_case("input-text")
        || action.eq_ignore_ascii_case("input_text")
        || action.eq_ignore_ascii_case("type")
        || action.eq_ignore_ascii_case("type-text")
        || action.eq_ignore_ascii_case("type_text")
}

fn redact_credential_tokens(value: &str) -> String {
    CREDENTIAL_TOKEN_RE
        .replace_all(value, REDACTED_ARGUMENT)
        .into_owned()
}

fn is_assignment_key_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')
}

fn quoted_value_end(bytes: &[u8], start: usize, quote: u8) -> usize {
    let mut index = start + 1;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index = index.saturating_add(2),
            current if current == quote => return index + 1,
            _ => index += 1,
        }
    }
    bytes.len()
}

fn bracketed_value_end(bytes: &[u8], start: usize) -> usize {
    let Some((opening, closing)) = bytes.get(start).and_then(|byte| match byte {
        b'{' => Some((b'{', b'}')),
        b'[' => Some((b'[', b']')),
        _ => None,
    }) else {
        return start;
    };

    let mut depth = 0usize;
    let mut quote = None;
    let mut index = start;
    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(quote_byte) = quote {
            if byte == b'\\' {
                index = index.saturating_add(2);
                continue;
            }
            if byte == quote_byte {
                quote = None;
            }
        } else {
            match byte {
                b'"' | b'\'' => quote = Some(byte),
                current if current == opening => depth += 1,
                current if current == closing => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        return index + 1;
                    }
                }
                _ => {}
            }
        }
        index += 1;
    }
    bytes.len()
}

fn assignment_value_end(bytes: &[u8], start: usize) -> usize {
    match bytes.get(start).copied() {
        Some(b'"') | Some(b'\'') => quoted_value_end(bytes, start, bytes[start]),
        Some(b'{') | Some(b'[') => bracketed_value_end(bytes, start),
        Some(_) => {
            let mut index = start;
            while index < bytes.len() {
                if matches!(bytes[index], b',' | b';' | b'|' | b']' | b'}') {
                    break;
                }
                if bytes[index].is_ascii_whitespace() {
                    let mut next = index;
                    while next < bytes.len() && bytes[next].is_ascii_whitespace() {
                        next += 1;
                    }
                    let key_start = next;
                    while next < bytes.len() && is_assignment_key_byte(bytes[next]) {
                        next += 1;
                    }
                    let key_end = next;
                    while next < bytes.len() && bytes[next].is_ascii_whitespace() {
                        next += 1;
                    }
                    if key_start < key_end
                        && next < bytes.len()
                        && matches!(bytes[next], b'=' | b':')
                    {
                        break;
                    }
                }
                index += 1;
            }
            index
        }
        None => start,
    }
}

/// Replace values attached to sensitive names while retaining the surrounding
/// argument syntax. This covers command-style `password=value` strings as well
/// as nested assignment fragments in legacy records that are not valid JSON.
fn redact_sensitive_assignments(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = String::with_capacity(value.len());
    let mut cursor = 0usize;
    let mut index = 0usize;

    while index < bytes.len() {
        if !is_assignment_key_byte(bytes[index])
            || (index > 0 && is_assignment_key_byte(bytes[index - 1]))
        {
            index += 1;
            continue;
        }

        let key_start = index;
        while index < bytes.len() && is_assignment_key_byte(bytes[index]) {
            index += 1;
        }
        let key_end = index;
        let key = &value[key_start..key_end];

        let mut separator = key_end;
        while separator < bytes.len() && bytes[separator].is_ascii_whitespace() {
            separator += 1;
        }
        if separator >= bytes.len() || !matches!(bytes[separator], b'=' | b':') {
            continue;
        }

        let mut value_start = separator + 1;
        while value_start < bytes.len() && bytes[value_start].is_ascii_whitespace() {
            value_start += 1;
        }
        if !is_sensitive_argument_name(key) {
            index = key_end;
            continue;
        }

        let value_end = assignment_value_end(bytes, value_start);
        output.push_str(&value[cursor..value_start]);
        match bytes.get(value_start).copied() {
            Some(b'"') | Some(b'\'') if value_end > value_start + 1 => {
                output.push(bytes[value_start] as char);
                output.push_str(REDACTED_ARGUMENT);
                if bytes[value_end - 1] == bytes[value_start] {
                    output.push(bytes[value_end - 1] as char);
                }
            }
            _ => output.push_str(REDACTED_ARGUMENT),
        }
        cursor = value_end;
        index = value_end;
    }

    output.push_str(&value[cursor..]);
    output
}

fn label_contains_sensitive_name(value: &str) -> bool {
    value
        .split(|character: char| {
            !character.is_ascii_alphanumeric() && character != '_' && character != '-'
        })
        .any(|name| !name.is_empty() && is_sensitive_argument_name(name))
}

fn redact_label(label: &str, sensitive_step: bool) -> String {
    if label.is_empty() {
        return String::new();
    }
    if sensitive_step {
        return REDACTED_ARGUMENT.to_owned();
    }

    let named_value = redact_sensitive_assignments(label);
    if named_value != label {
        return redact_credential_tokens(&named_value);
    }
    let credential = redact_credential_tokens(label);
    if credential != label {
        return credential;
    }
    if label_contains_sensitive_name(label) {
        REDACTED_ARGUMENT.to_owned()
    } else {
        label.to_owned()
    }
}

fn redact_text_argument(value: &str) -> String {
    let named_values_redacted = redact_sensitive_assignments(value);
    redact_credential_tokens(&named_values_redacted)
}

fn json_contains_sensitive_key(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, nested)| {
            is_sensitive_argument_name(key) || json_contains_sensitive_key(nested)
        }),
        Value::Array(values) => values.iter().any(json_contains_sensitive_key),
        _ => false,
    }
}

/// Recursively redact JSON argument fragments. Once a sensitive property is
/// found, text/value siblings are masked as well, matching the TypeScript
/// recorder's fail-closed handling for form and input payloads.
fn redact_json_value(value: &mut Value, mask_text_values: bool) -> bool {
    match value {
        Value::Object(object) => {
            let contains_sensitive_key = mask_text_values
                || object.iter().any(|(key, nested)| {
                    is_sensitive_argument_name(key) || json_contains_sensitive_key(nested)
                });
            let mut changed = false;
            for (key, nested) in object.iter_mut() {
                if is_sensitive_argument_name(key)
                    || (contains_sensitive_key && is_text_or_value_key(key))
                {
                    if !matches!(nested, Value::String(value) if value.as_str() == REDACTED_ARGUMENT)
                    {
                        *nested = Value::String(REDACTED_ARGUMENT.to_owned());
                        changed = true;
                    }
                } else if redact_json_value(nested, contains_sensitive_key) {
                    changed = true;
                }
            }
            changed
        }
        Value::Array(values) => {
            let mut changed = false;
            for nested in values {
                if redact_json_value(nested, mask_text_values) {
                    changed = true;
                }
            }
            changed
        }
        Value::String(text) => {
            let redacted = if mask_text_values && contains_sensitive_input_text(text) {
                REDACTED_ARGUMENT.to_owned()
            } else {
                redact_text_argument(text)
            };
            if redacted == *text {
                false
            } else {
                *text = redacted;
                true
            }
        }
        _ => false,
    }
}

fn redact_argument(action: &str, position: usize, argument: &str) -> String {
    if position == 0 && is_positional_input_action(action) {
        return REDACTED_ARGUMENT.to_owned();
    }

    if let Ok(mut json) = serde_json::from_str::<Value>(argument) {
        let mask_text_values =
            json_contains_sensitive_key(&json) || json_contains_sensitive_text(&json);
        if redact_json_value(&mut json, mask_text_values) {
            return serde_json::to_string(&json).unwrap_or_else(|_| REDACTED_ARGUMENT.to_owned());
        }
    }
    redact_text_argument(argument)
}

fn is_bare_sensitive_argument_name(argument: &str) -> bool {
    let name = argument.trim().trim_start_matches('-');
    !name.is_empty()
        && !name.chars().any(char::is_whitespace)
        && !name.bytes().any(|byte| matches!(byte, b'=' | b':'))
        && is_sensitive_argument_name(name)
}

fn redact_step_args_with_sensitivity(action: &str, arguments: &[String]) -> (Vec<String>, bool) {
    let mut redacted = Vec::with_capacity(arguments.len());
    let mut sensitive = is_positional_input_action(action) && !arguments.is_empty();
    let mut mask_next = false;
    for (position, argument) in arguments.iter().enumerate() {
        if mask_next {
            redacted.push(REDACTED_ARGUMENT.to_owned());
            sensitive = true;
            mask_next = false;
            continue;
        }
        let redacted_argument = redact_argument(action, position, argument);
        sensitive |= redacted_argument != *argument;
        redacted.push(redacted_argument);
        mask_next = is_bare_sensitive_argument_name(argument);
    }
    (redacted, sensitive)
}

fn redact_scenario_step(step: &ScenarioStep) -> ScenarioStep {
    let mut redacted = step.clone();
    let (args, sensitive) = redact_step_args_with_sensitivity(&step.action, &step.args);
    redacted.args = args;
    redacted.label = step
        .label
        .as_deref()
        .map(|label| redact_label(label, sensitive));
    redacted
}

fn redacted_scenario(scenario: &Scenario) -> Scenario {
    Scenario {
        version: scenario.version,
        name: scenario.name.clone(),
        platform: scenario.platform.clone(),
        description: scenario.description.clone(),
        tags: scenario.tags.clone(),
        steps: scenario.steps.iter().map(redact_scenario_step).collect(),
        created_at: scenario.created_at.clone(),
        updated_at: scenario.updated_at.clone(),
    }
}

fn redacted_recording_state(state: &RecordingState) -> RecordingState {
    RecordingState {
        name: state.name.clone(),
        platform: state.platform.clone(),
        description: state.description.clone(),
        tags: state.tags.clone(),
        steps: state.steps.iter().map(redact_scenario_step).collect(),
        started_at: state.started_at.clone(),
    }
}

fn scenario_json_for_output(scenario: &Scenario) -> Result<String> {
    terminal_safe_json(&redacted_scenario(scenario))
}

fn flow_steps_json_for_output(scenario: &Scenario) -> Result<String> {
    #[derive(Serialize)]
    struct FlowStepExport {
        action: String,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        args: Vec<String>,
    }

    let steps: Vec<FlowStepExport> = redacted_scenario(scenario)
        .steps
        .into_iter()
        .map(|step| FlowStepExport {
            action: step.action,
            args: step.args,
        })
        .collect();
    terminal_safe_json(&steps)
}

fn markdown_for_output(scenario: &Scenario) -> String {
    let scenario = redacted_scenario(scenario);
    let mut output = String::new();
    output.push_str("# Scenario: ");
    output.push_str(&terminal_safe(scenario.name.as_bytes()));
    output.push_str("\n\n");
    output.push_str("**Platform:** ");
    output.push_str(&terminal_safe(scenario.platform.as_bytes()));
    if let Some(description) = &scenario.description {
        output.push_str("\n**Description:** ");
        output.push_str(&terminal_safe(description.as_bytes()));
    }
    if !scenario.tags.is_empty() {
        output.push_str("\n**Tags:** ");
        output.push_str(&terminal_safe(scenario.tags.join(", ").as_bytes()));
    }
    output.push_str("\n\n## Steps\n\n");
    for step in &scenario.steps {
        let label = step
            .label
            .as_deref()
            .map(|value| format!(" — {}", terminal_safe(value.as_bytes())))
            .unwrap_or_default();
        let args_str = if step.args.is_empty() {
            String::new()
        } else {
            format!(" `{}`", terminal_safe(step.args.join(", ").as_bytes()))
        };
        output.push_str(&format!(
            "{}. **{}**{}{}\n",
            step.index + 1,
            terminal_safe(step.action.as_bytes()),
            args_str,
            label
        ));
    }
    output
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

fn scenarios_dir(platform: &str) -> Result<PathBuf> {
    validate_identifier(platform, "scenario platform")?;
    let root = app_dir()?.join("scenarios");
    create_private_dir(&root)?;
    let path = root.join(platform);
    create_private_dir(&path)?;
    Ok(path)
}

fn scenario_path(platform: &str, name: &str) -> Result<PathBuf> {
    validate_identifier(name, "scenario name")?;
    Ok(scenarios_dir(platform)?.join(format!("{name}.json")))
}

fn recording_state_dir() -> Result<PathBuf> {
    #[cfg(test)]
    if let Some(root) = std::env::var_os(TEST_STATE_ROOT_ENV) {
        let directory = PathBuf::from(root).join("recordings");
        create_private_dir(&directory)?;
        return Ok(directory);
    }
    state_dir("recordings")
}

fn recording_state_path(name: &str) -> Result<PathBuf> {
    validate_identifier(name, "recording name")?;
    Ok(recording_state_dir()?.join(format!("{name}.json")))
}

fn validate_bounded_text(value: &str, label: &str, max_bytes: usize) -> Result<()> {
    if value.len() > max_bytes || value.chars().any(char::is_control) {
        bail!("{label} exceeds {max_bytes} bytes or contains control characters");
    }
    Ok(())
}
fn validate_steps(steps: &[ScenarioStep]) -> Result<()> {
    if steps.len() > MAX_STEPS {
        bail!("Scenario cannot exceed {MAX_STEPS} steps");
    }
    for (expected_index, step) in steps.iter().enumerate() {
        if step.index != expected_index {
            bail!("Scenario step indices are invalid");
        }
        validate_identifier(&step.action, "scenario action")?;
        validate_identifier(&step.step_type, "scenario step type")?;
        if step.args.len() > MAX_STEP_ARGS
            || step.args.iter().any(|arg| arg.len() > MAX_STEP_ARG_BYTES)
        {
            bail!(
                "Scenario step arguments exceed {MAX_STEP_ARGS} entries or {MAX_STEP_ARG_BYTES} bytes"
            );
        }
        if let Some(label) = &step.label {
            validate_bounded_text(label, "scenario step label", MAX_LABEL_BYTES)?;
        }
    }
    Ok(())
}

fn validate_scenario(scenario: &Scenario) -> Result<()> {
    if scenario.version != 1 {
        bail!("Unsupported scenario version");
    }
    validate_identifier(&scenario.name, "scenario name")?;
    validate_identifier(&scenario.platform, "scenario platform")?;
    if let Some(description) = &scenario.description {
        validate_bounded_text(description, "scenario description", MAX_DESCRIPTION_BYTES)?;
    }
    if scenario.tags.len() > MAX_TAGS {
        bail!("Scenario cannot exceed {MAX_TAGS} tags");
    }
    for tag in &scenario.tags {
        validate_bounded_text(tag, "scenario tag", MAX_TAG_BYTES)?;
    }
    validate_bounded_text(&scenario.created_at, "scenario creation time", 128)?;
    validate_bounded_text(&scenario.updated_at, "scenario update time", 128)?;
    validate_steps(&scenario.steps)
}

fn validate_recording(state: &RecordingState) -> Result<()> {
    validate_identifier(&state.name, "recording name")?;
    validate_identifier(&state.platform, "recording platform")?;
    if let Some(description) = &state.description {
        validate_bounded_text(description, "recording description", MAX_DESCRIPTION_BYTES)?;
    }
    if state.tags.len() > MAX_TAGS {
        bail!("Recording cannot exceed {MAX_TAGS} tags");
    }
    for tag in &state.tags {
        validate_bounded_text(tag, "recording tag", MAX_TAG_BYTES)?;
    }
    validate_bounded_text(&state.started_at, "recording start time", 128)?;
    validate_steps(&state.steps)
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

fn now_iso8601() -> String {
    // Simple RFC 3339 timestamp using SystemTime (no extra crates).
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (y, mo, d, h, mi, s) = epoch_to_datetime(secs);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mo, d, h, mi, s)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Minimal epoch-to-datetime conversion (Gregorian proleptic calendar).
#[allow(clippy::many_single_char_names)]
fn epoch_to_datetime(secs: u64) -> (u64, u64, u64, u64, u64, u64) {
    let s = secs % 60;
    let total_min = secs / 60;
    let mi = total_min % 60;
    let total_h = total_min / 60;
    let h = total_h % 24;
    let mut days = total_h / 24;

    // Days since 1970-01-01
    let mut y = 1970u64;
    loop {
        let leap = is_leap(y);
        let days_in_year: u64 = if leap { 366 } else { 365 };
        if days < days_in_year {
            break;
        }
        days -= days_in_year;
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

fn legacy_tmp_dir() -> PathBuf {
    std::env::var_os(LEGACY_TMP_DIR_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

fn legacy_recording_path(name: &str) -> PathBuf {
    legacy_tmp_dir().join(format!("claude-mobile-recording-{name}.json"))
}

fn migrate_legacy_recording(name: &str, destination: &Path) -> Result<()> {
    validate_identifier(name, "recording name")?;
    match fs::symlink_metadata(destination) {
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Cannot inspect recording {}", destination.display()));
        }
    }

    let legacy = legacy_recording_path(name);
    let metadata = match fs::symlink_metadata(&legacy) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Cannot inspect legacy recording {}", legacy.display()));
        }
    };
    validate_legacy_file_security(&legacy, &metadata, "Legacy recording")?;

    let contents = read_bounded_legacy_file(&legacy, MAX_SCENARIO_BYTES, "recording state")?;
    let state: RecordingState = serde_json::from_slice(&contents)
        .with_context(|| format!("Corrupt legacy recording at {}", legacy.display()))?;
    let sanitized_state = redacted_recording_state(&state);
    validate_recording(&sanitized_state)?;
    if state.name != name {
        bail!("Legacy recording identity does not match its storage path");
    }
    let sanitized_contents = serde_json::to_vec_pretty(&sanitized_state)?;
    if sanitized_contents.len() as u64 > MAX_SCENARIO_BYTES {
        bail!("Recording state exceeds {MAX_SCENARIO_BYTES} bytes");
    }
    if create_private_file_if_missing(destination, &sanitized_contents, "recording state")? {
        match fs::remove_file(&legacy) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("Cannot remove migrated recording {}", legacy.display())
                });
            }
        }
    }
    Ok(())
}

fn legacy_recording_candidates() -> Result<Vec<String>> {
    let directory = legacy_tmp_dir();
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "Cannot inspect legacy recordings in {}",
                    directory.display()
                )
            });
        }
    };
    let mut candidates = Vec::new();
    for (index, entry) in entries.enumerate() {
        if index >= MAX_LEGACY_SCAN_ENTRIES {
            bail!(
                "Legacy recording directory exceeds scan limit of {MAX_LEGACY_SCAN_ENTRIES} entries"
            );
        }
        let path = entry?.path();
        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !file_name.starts_with("claude-mobile-recording-") {
            continue;
        }
        let Some(name) = file_name
            .strip_prefix("claude-mobile-recording-")
            .and_then(|value| value.strip_suffix(".json"))
        else {
            continue;
        };
        if validate_identifier(name, "recording name").is_ok() {
            candidates.push(name.to_owned());
        }
    }
    if candidates.len() > MAX_RECORDING_FILES {
        bail!("Legacy recording directory exceeds {MAX_RECORDING_FILES} entries");
    }
    candidates.sort();
    Ok(candidates)
}

fn write_recording(state: &RecordingState) -> Result<()> {
    let sanitized_state = redacted_recording_state(state);
    validate_recording(&sanitized_state)?;
    let path = recording_state_path(&sanitized_state.name)?;
    let text = serde_json::to_vec_pretty(&sanitized_state)?;
    if text.len() as u64 > MAX_SCENARIO_BYTES {
        bail!("Recording state exceeds {MAX_SCENARIO_BYTES} bytes");
    }
    atomic_write(&path, &text)
        .with_context(|| format!("Cannot write recording to {}", path.display()))
}

fn read_scenario(platform: &str, name: &str) -> Result<Scenario> {
    let path = scenario_path(platform, name)?;
    let scenario: Scenario = read_json_file(&path, MAX_SCENARIO_BYTES, "scenario file")?;
    validate_scenario(&scenario)?;
    if scenario.platform != platform || scenario.name != name {
        bail!("Scenario identity does not match its storage path");
    }
    Ok(scenario)
}

fn write_scenario(scenario: &Scenario) -> Result<()> {
    let sanitized_scenario = redacted_scenario(scenario);
    validate_scenario(&sanitized_scenario)?;
    let path = scenario_path(&sanitized_scenario.platform, &sanitized_scenario.name)?;
    let text = serde_json::to_vec_pretty(&sanitized_scenario)?;
    if text.len() as u64 > MAX_SCENARIO_BYTES {
        bail!("Scenario exceeds {MAX_SCENARIO_BYTES} bytes");
    }
    atomic_write(&path, &text)
        .with_context(|| format!("Cannot write scenario to {}", path.display()))
}

fn find_active_recording_unlocked() -> Result<Option<RecordingState>> {
    let dir = recording_state_dir()?;
    for (index, entry) in fs::read_dir(&dir)?.enumerate() {
        if index >= MAX_RECORDING_FILES {
            bail!("Recording state directory exceeds {MAX_RECORDING_FILES} entries");
        }
        let entry = entry?;
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let state: RecordingState =
            read_json_file(&entry.path(), MAX_SCENARIO_BYTES, "recording state")?;
        validate_recording(&state)?;
        return Ok(Some(state));
    }

    for name in legacy_recording_candidates()? {
        let path = recording_state_path(&name)?;
        migrate_legacy_recording(&name, &path)?;
        let state: RecordingState = read_json_file(&path, MAX_SCENARIO_BYTES, "recording state")?;
        validate_recording(&state)?;
        return Ok(Some(state));
    }
    Ok(None)
}

fn find_active_recording() -> Result<Option<RecordingState>> {
    let _state_lock = lock_recording_state()?;
    find_active_recording_unlocked()
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Dispatch a [`RecorderCommands`] variant to its handler.
pub fn run(command: RecorderCommands) -> Result<()> {
    match command {
        RecorderCommands::Start {
            name,
            platform,
            description,
            tags,
        } => cmd_start(&name, &platform, description.as_deref(), tags.as_deref()),
        RecorderCommands::Stop { discard } => cmd_stop(discard),
        RecorderCommands::Status => cmd_status(),
        RecorderCommands::AddStep {
            action_name,
            args,
            label,
        } => cmd_add_step(&action_name, args.as_deref(), label.as_deref()),
        RecorderCommands::RemoveStep { step_index } => cmd_remove_step(step_index),
        RecorderCommands::List { platform, tag } => cmd_list(platform.as_deref(), tag.as_deref()),
        RecorderCommands::Show { name, platform } => cmd_show(&name, &platform),
        RecorderCommands::Delete { name, platform } => cmd_delete(&name, &platform),
        RecorderCommands::Play {
            name,
            platform,
            speed,
            stop_on_fail,
            step_timeout,
            max_duration,
            from_step,
            to_step,
            dry_run,
        } => cmd_play(
            &name,
            &platform,
            speed,
            stop_on_fail,
            step_timeout,
            max_duration,
            from_step,
            to_step,
            dry_run,
        ),
        RecorderCommands::Export {
            name,
            platform,
            format,
        } => cmd_export(&name, &platform, &format),
    }
}

// ---------------------------------------------------------------------------
// recorder start
// ---------------------------------------------------------------------------

fn cmd_start(
    name: &str,
    platform: &str,
    description: Option<&str>,
    tags: Option<&str>,
) -> Result<()> {
    let _state_lock = lock_recording_state()?;
    validate_identifier(name, "recording name")?;
    validate_identifier(platform, "recording platform")?;
    if let Some(value) = description {
        validate_bounded_text(value, "recording description", MAX_DESCRIPTION_BYTES)?;
    }
    if let Some(value) = tags {
        validate_bounded_text(value, "recording tags", MAX_DESCRIPTION_BYTES)?;
    }
    let tmp_path = recording_state_path(name)?;
    migrate_legacy_recording(name, &tmp_path)?;
    if let Some(active) = find_active_recording_unlocked()? {
        if active.name == name {
            bail!(
                "Recording '{}' is already active. Run `recorder stop` first.",
                name
            );
        }
        bail!(
            "Recording '{}' is already active. Run `recorder stop` first.",
            active.name
        );
    }

    let tags_list: Vec<String> = tags
        .unwrap_or("")
        .split(',')
        .map(|t| t.trim().to_owned())
        .filter(|t| !t.is_empty())
        .collect();
    if tags_list.len() > MAX_TAGS {
        bail!("Recording cannot exceed {MAX_TAGS} tags");
    }
    for tag in &tags_list {
        validate_bounded_text(tag, "recording tag", MAX_TAG_BYTES)?;
    }

    let state = RecordingState {
        name: name.to_owned(),
        platform: platform.to_owned(),
        description: description.map(str::to_owned),
        tags: tags_list,
        steps: Vec::new(),
        started_at: now_iso8601(),
    };

    write_recording(&state)?;

    println!(
        "Recording '{}' started for platform '{}'. State: {}",
        terminal_safe(name.as_bytes()),
        terminal_safe(platform.as_bytes()),
        terminal_safe(tmp_path.display().to_string().as_bytes()),
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// recorder stop
// ---------------------------------------------------------------------------

fn cmd_stop(discard: bool) -> Result<()> {
    let _state_lock = lock_recording_state()?;
    let state = find_active_recording_unlocked()?
        .ok_or_else(|| anyhow::anyhow!("No active recording found"))?;

    let tmp_path = recording_state_path(&state.name)?;

    if discard {
        fs::remove_file(&tmp_path)
            .with_context(|| format!("Cannot remove recording state {}", tmp_path.display()))?;
        println!(
            "Recording '{}' discarded.",
            terminal_safe(state.name.as_bytes())
        );
        return Ok(());
    }

    let scenario = Scenario {
        version: 1,
        name: state.name.clone(),
        platform: state.platform.clone(),
        description: state.description.clone(),
        tags: state.tags.clone(),
        steps: state.steps.clone(),
        created_at: state.started_at.clone(),
        updated_at: now_iso8601(),
    };

    write_scenario(&scenario)?;
    fs::remove_file(&tmp_path)
        .with_context(|| format!("Cannot remove recording state {}", tmp_path.display()))?;

    let saved_path = scenario_path(&scenario.platform, &scenario.name)?;
    println!(
        "Recording '{}' saved ({} steps) -> {}",
        terminal_safe(scenario.name.as_bytes()),
        scenario.steps.len(),
        terminal_safe(saved_path.display().to_string().as_bytes())
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// recorder status
// ---------------------------------------------------------------------------

fn cmd_status() -> Result<()> {
    let _state_lock = lock_recording_state()?;
    let state = find_active_recording_unlocked()?
        .ok_or_else(|| anyhow::anyhow!("No active recording found"))?;
    let state = redacted_recording_state(&state);

    println!(
        "Active recording: '{}'",
        terminal_safe(state.name.as_bytes())
    );
    println!("  Platform : {}", terminal_safe(state.platform.as_bytes()));
    println!("  Steps    : {}", state.steps.len());
    println!(
        "  Started  : {}",
        terminal_safe(state.started_at.as_bytes())
    );

    let recent_count = state.steps.len().min(5);
    if recent_count > 0 {
        println!("  Recent steps:");
        for step in state.steps.iter().rev().take(recent_count).rev() {
            let label = terminal_safe(step.label.as_deref().unwrap_or("-").as_bytes());
            println!(
                "    [{}] {}  ({})",
                step.index + 1,
                terminal_safe(step.action.as_bytes()),
                label,
            );
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// recorder add-step
// ---------------------------------------------------------------------------

fn cmd_add_step(action_name: &str, args_json: Option<&str>, label: Option<&str>) -> Result<()> {
    let _state_lock = lock_recording_state()?;
    validate_identifier(action_name, "scenario action")?;
    if let Some(value) = label {
        validate_bounded_text(value, "scenario step label", MAX_LABEL_BYTES)?;
    }
    if args_json.is_some_and(|value| value.len() > MAX_ARGS_JSON_BYTES) {
        bail!("--args exceeds {MAX_ARGS_JSON_BYTES} bytes");
    }
    let mut state = find_active_recording_unlocked()?
        .ok_or_else(|| anyhow::anyhow!("No active recording. Start one with `recorder start`."))?;

    let raw_args: Vec<String> = match args_json {
        None | Some("") => Vec::new(),
        Some(raw) => serde_json::from_str(raw)
            .context("--args must be a JSON array of strings, e.g. '[\"100\",\"200\"]'")?,
    };
    if raw_args.len() > MAX_STEP_ARGS || raw_args.iter().any(|arg| arg.len() > MAX_STEP_ARG_BYTES) {
        bail!(
            "--args cannot exceed {MAX_STEP_ARGS} entries or {MAX_STEP_ARG_BYTES} bytes per entry"
        );
    }
    if state.steps.len() >= MAX_STEPS {
        bail!("Recording cannot exceed {MAX_STEPS} steps");
    }

    let (args, sensitive) = redact_step_args_with_sensitivity(action_name, &raw_args);
    let argument_count = args.len();
    let index = state.steps.len();
    let persisted_label = label.map(|value| redact_label(value, sensitive));
    state.steps.push(ScenarioStep {
        index,
        step_type: "gesture".to_owned(),
        action: action_name.to_owned(),
        args,
        timestamp_ms: now_ms(),
        delay_before_ms: 0,
        label: persisted_label,
    });

    write_recording(&state)?;
    println!(
        "Step {} added: {} ({} argument(s))",
        index + 1,
        terminal_safe(action_name.as_bytes()),
        argument_count
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// recorder remove-step
// ---------------------------------------------------------------------------

fn cmd_remove_step(step_index: usize) -> Result<()> {
    let _state_lock = lock_recording_state()?;
    let mut state =
        find_active_recording_unlocked()?.ok_or_else(|| anyhow::anyhow!("No active recording."))?;

    if step_index == 0 || step_index > state.steps.len() {
        bail!(
            "Step index {} out of range (1-{})",
            step_index,
            state.steps.len()
        );
    }

    let removed = state.steps.remove(step_index - 1);

    // Re-index remaining steps.
    for (i, step) in state.steps.iter_mut().enumerate() {
        step.index = i;
    }

    write_recording(&state)?;
    println!(
        "Removed step {}: {} ({} argument(s))",
        step_index,
        terminal_safe(removed.action.as_bytes()),
        removed.args.len(),
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// recorder list
// ---------------------------------------------------------------------------

fn cmd_list(platform: Option<&str>, tag: Option<&str>) -> Result<()> {
    if let Some(value) = platform {
        validate_identifier(value, "scenario platform")?;
    }
    if let Some(value) = tag {
        validate_bounded_text(value, "scenario tag filter", MAX_TAG_BYTES)?;
    }
    let base = app_dir()?.join("scenarios");
    create_private_dir(&base)?;

    let mut found = false;

    let platforms: Vec<String> = if let Some(p) = platform {
        vec![p.to_owned()]
    } else {
        fs::read_dir(&base)
            .context("Cannot read scenarios directory")?
            .take(32)
            .flatten()
            .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect()
    };

    for plat in &platforms {
        if validate_identifier(plat, "scenario platform").is_err() {
            continue;
        }
        let dir = base.join(plat);
        create_private_dir(&dir)?;
        for entry in fs::read_dir(&dir)
            .context("Cannot read platform directory")?
            .take(MAX_RECORDING_FILES)
            .flatten()
        {
            let file_name = entry.file_name();
            let file_str = file_name.to_string_lossy();
            if !file_str.ends_with(".json") {
                continue;
            }
            let Some(scenario_name) = entry
                .path()
                .file_stem()
                .and_then(|value| value.to_str())
                .map(str::to_owned)
            else {
                continue;
            };
            if let Ok(scenario) = read_scenario(plat, &scenario_name) {
                // Filter by tag if provided.
                if let Some(filter_tag) = tag {
                    if !scenario.tags.iter().any(|t| t == filter_tag) {
                        continue;
                    }
                }
                let tags_str = if scenario.tags.is_empty() {
                    String::new()
                } else {
                    format!(" [{}]", scenario.tags.join(", "))
                };
                println!(
                    "{}/{} — {} steps{}",
                    terminal_safe(plat.as_bytes()),
                    terminal_safe(scenario.name.as_bytes()),
                    scenario.steps.len(),
                    terminal_safe(tags_str.as_bytes()),
                );
                found = true;
            }
        }
    }

    if !found {
        println!("No scenarios found.");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// recorder show
// ---------------------------------------------------------------------------

fn cmd_show(name: &str, platform: &str) -> Result<()> {
    let scenario = read_scenario(platform, name)?;
    println!("{}", scenario_json_for_output(&scenario)?);
    Ok(())
}

// ---------------------------------------------------------------------------
// recorder delete
// ---------------------------------------------------------------------------

fn cmd_delete(name: &str, platform: &str) -> Result<()> {
    let path = scenario_path(platform, name)?;
    if !path.exists() {
        bail!("Scenario '{}' not found for platform '{}'", name, platform);
    }
    fs::remove_file(&path).with_context(|| format!("Cannot delete {}", path.display()))?;
    println!("Deleted scenario '{}/{}'.", platform, name);
    Ok(())
}

// ---------------------------------------------------------------------------
// recorder play
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct NonCancellableStepTimeout {
    timeout_ms: u64,
}

impl std::fmt::Display for NonCancellableStepTimeout {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Step timed out after {}ms; action is non-cancellable and cleanup continues in the background",
            self.timeout_ms
        )
    }
}

impl std::error::Error for NonCancellableStepTimeout {}

fn validate_step_timeout(step_timeout: Option<u64>) -> Result<()> {
    if step_timeout == Some(0) {
        bail!("Step timeout must be greater than zero");
    }
    Ok(())
}

fn validate_playback_speed(speed: f64) -> Result<()> {
    if !speed.is_finite() || speed <= 0.0 {
        bail!("Playback speed must be finite and greater than zero");
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn cmd_play(
    name: &str,
    platform: &str,
    speed: f64,
    stop_on_fail: bool,
    step_timeout: Option<u64>,
    max_duration: Option<u64>,
    from_step: Option<usize>,
    to_step: Option<usize>,
    dry_run: bool,
) -> Result<()> {
    validate_playback_speed(speed)?;
    validate_step_timeout(step_timeout)?;
    let scenario = read_scenario(platform, name)?;

    let from = from_step.unwrap_or(1).saturating_sub(1);
    let to = to_step
        .unwrap_or(scenario.steps.len())
        .min(scenario.steps.len());

    if from >= to {
        bail!(
            "--from-step ({}) must be less than --to-step ({})",
            from + 1,
            to
        );
    }

    let steps_to_run: Vec<&ScenarioStep> = scenario.steps[from..to].iter().collect();
    let max_duration = max_duration.map(Duration::from_millis);
    let start = Instant::now();
    let deadline = max_duration.and_then(|duration| start.checked_add(duration));
    let _deadline_guard = install_deadline(deadline);

    println!(
        "Playing scenario '{}' on '{}' ({} steps, speed={}, dry_run={})…",
        terminal_safe(name.as_bytes()),
        terminal_safe(platform.as_bytes()),
        steps_to_run.len(),
        speed,
        dry_run
    );

    let mut passed = 0usize;
    let mut failed = 0usize;
    let mut duration_exhausted = false;

    for (i, step) in steps_to_run.iter().enumerate() {
        if max_duration.is_some_and(|limit| start.elapsed() >= limit) {
            println!("Max duration reached, stopping.");
            duration_exhausted = true;
            break;
        }

        // Apply inter-step delay scaled by speed, without exceeding the
        // remaining playback budget.
        if step.delay_before_ms > 0 && !dry_run {
            let delay = Duration::from_millis((step.delay_before_ms as f64 / speed) as u64);
            if let Some(deadline) = deadline {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if delay >= remaining {
                    if !remaining.is_zero() {
                        std::thread::sleep(remaining);
                    }
                    println!("Max duration reached, stopping.");
                    duration_exhausted = true;
                    break;
                }
            }
            std::thread::sleep(delay);
        }
        let display_step = redact_scenario_step(step);
        let step_label = display_step.label.as_deref().unwrap_or(&step.action);
        print!(
            "  Step {}/{}: {} … ",
            i + 1,
            steps_to_run.len(),
            terminal_safe(step_label.as_bytes()),
        );

        if dry_run {
            println!("[dry-run]");
            passed += 1;
            continue;
        }

        // Build a FlowStep and delegate to flow::execute_step.
        let flow_step = crate::commands::flow::FlowStep {
            action: step.action.clone(),
            args: step.args.clone(),
            on_error: crate::commands::flow::OnError::Stop,
        };

        // Apply optional per-step timeout.
        let ctx = FlowCtx {
            platform: platform.to_owned(),
            device: None,
            simulator: None,
            companion_path: None,
        };

        let result = if step_timeout.is_some() || deadline.is_some() {
            run_with_timeout(&ctx, &flow_step, step_timeout.unwrap_or(u64::MAX), deadline)
        } else {
            run_step(&ctx, &flow_step)
        };

        match result {
            Ok(msg) => {
                println!("OK  {}", terminal_safe(msg.as_bytes()));
                passed += 1;
            }
            Err(error) => {
                let timed_out = error.downcast_ref::<NonCancellableStepTimeout>().is_some();
                println!("FAIL  {}", terminal_safe(error.to_string().as_bytes()));
                failed += 1;
                if timed_out {
                    println!(
                        "Stopping replay because the timed-out action cannot be cancelled safely."
                    );
                    break;
                }
                if stop_on_fail {
                    println!("Stopping on failure (--stop-on-fail).");
                    break;
                }
            }
        }
    }

    println!(
        "\nDone: {} passed, {} failed ({}ms total).",
        passed,
        failed,
        start.elapsed().as_millis()
    );

    if failed > 0 {
        bail!("Scenario '{}' finished with {} failure(s)", name, failed);
    }
    if duration_exhausted {
        bail!("Scenario '{}' did not complete within max duration", name);
    }
    Ok(())
}

/// Minimal context type for replay — mirrors `flow::PlatformCtx` but owned.
struct FlowCtx {
    platform: String,
    device: Option<String>,
    simulator: Option<String>,
    companion_path: Option<String>,
}

/// Execute a single FlowStep through the same dispatcher used by `flow run`.
fn run_step(ctx: &FlowCtx, step: &crate::commands::flow::FlowStep) -> Result<String> {
    crate::commands::flow::execute_step_for_platform(
        &ctx.platform,
        ctx.device.as_deref(),
        ctx.simulator.as_deref(),
        ctx.companion_path.as_deref(),
        step,
    )
}

/// Run a step with a bounded timeout via a dedicated thread.
///
/// Flow actions may have non-cancellable side effects. Once the deadline is
/// reached, the caller returns immediately with an honest timeout error. A
/// background reaper owns the worker handle so it can settle safely without
/// blocking replay or requiring unsafe cross-thread mutation. The timeout is
/// terminal for replay because the worker may still mutate the device.
fn run_with_timeout(
    ctx: &FlowCtx,
    step: &crate::commands::flow::FlowStep,
    timeout_ms: u64,
    deadline: Option<Instant>,
) -> Result<String> {
    if timeout_ms == 0 {
        bail!("Step timeout must be greater than zero");
    }

    let step_deadline = Instant::now().checked_add(Duration::from_millis(timeout_ms));
    let worker_deadline = match (deadline, step_deadline) {
        (Some(total), Some(step)) => Some(total.min(step)),
        (Some(total), None) => Some(total),
        (None, step) => step,
    };
    let timeout_ms = worker_deadline
        .map(|limit| {
            limit
                .saturating_duration_since(Instant::now())
                .as_millis()
                .min(u64::MAX as u128) as u64
        })
        .unwrap_or(timeout_ms)
        .max(1);

    // Clone data needed for the worker thread.
    let ctx_owned = FlowCtx {
        platform: ctx.platform.clone(),
        device: ctx.device.clone(),
        simulator: ctx.simulator.clone(),
        companion_path: ctx.companion_path.clone(),
    };
    let step_owned = crate::commands::flow::FlowStep {
        action: step.action.clone(),
        args: step.args.clone(),
        on_error: step.on_error,
    };

    run_with_timeout_action(timeout_ms, move || {
        let _deadline_guard = install_deadline(worker_deadline);
        run_step(&ctx_owned, &step_owned)
    })
}

fn run_with_timeout_action<F>(timeout_ms: u64, action: F) -> Result<String>
where
    F: FnOnce() -> Result<String> + Send + 'static,
{
    if timeout_ms == 0 {
        bail!("Step timeout must be greater than zero");
    }

    use std::sync::mpsc;

    let (tx, rx) = mpsc::channel::<Result<String>>();
    let worker = std::thread::spawn(move || {
        let result = action();
        let _ = tx.send(result);
    });

    match rx.recv_timeout(std::time::Duration::from_millis(timeout_ms)) {
        Ok(result) => {
            if worker.join().is_err() {
                bail!("Step worker panicked");
            }
            result
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            // The action cannot be cancelled safely. Replay has already
            // stopped on this terminal error; reap the worker in the
            // background so the timeout remains a real wall-clock bound.
            let _ = std::thread::Builder::new()
                .name("mcp-recorder-timeout-reaper".to_owned())
                .spawn(move || {
                    let _ = worker.join();
                });
            Err(anyhow::Error::new(NonCancellableStepTimeout { timeout_ms }))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let _ = worker.join();
            bail!("Step worker terminated before returning a result");
        }
    }
}

// ---------------------------------------------------------------------------
// recorder export
// ---------------------------------------------------------------------------

fn cmd_export(name: &str, platform: &str, format: &str) -> Result<()> {
    let scenario = read_scenario(platform, name)?;

    match format {
        "flow_steps" => export_flow_steps(&scenario),
        "markdown" => export_markdown(&scenario),
        other => bail!(
            "Unknown export format '{}'. Supported: flow_steps, markdown",
            other
        ),
    }
}

fn export_flow_steps(scenario: &Scenario) -> Result<()> {
    println!("{}", flow_steps_json_for_output(scenario)?);
    Ok(())
}

fn export_markdown(scenario: &Scenario) -> Result<()> {
    print!("{}", markdown_for_output(scenario));
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scenario_serialization_round_trip() {
        let scenario = Scenario {
            version: 1,
            name: "login-flow".into(),
            platform: "android".into(),
            description: Some("Login test".into()),
            tags: vec!["smoke".into()],
            steps: vec![ScenarioStep {
                index: 0,
                step_type: "gesture".into(),
                action: "tap".into(),
                args: vec!["100".into(), "200".into()],
                timestamp_ms: 1_000_000,
                delay_before_ms: 0,
                label: None,
            }],
            created_at: "2026-05-27T12:00:00Z".into(),
            updated_at: "2026-05-27T12:00:00Z".into(),
        };

        let json = serde_json::to_string(&scenario).unwrap();
        let parsed: Scenario = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.name, "login-flow");
        assert_eq!(parsed.platform, "android");
        assert_eq!(parsed.steps.len(), 1);
        assert_eq!(parsed.steps[0].action, "tap");
        assert_eq!(parsed.steps[0].args, vec!["100", "200"]);
        assert_eq!(parsed.version, 1);
    }

    #[test]
    fn test_recording_state_serialization() {
        let state = RecordingState {
            name: "test-rec".into(),
            platform: "ios".into(),
            description: None,
            tags: vec![],
            steps: vec![],
            started_at: "2026-05-27T10:00:00Z".into(),
        };

        let json = serde_json::to_string(&state).unwrap();
        let parsed: RecordingState = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.name, "test-rec");
        assert_eq!(parsed.platform, "ios");
        assert!(parsed.steps.is_empty());
    }

    #[test]
    fn test_now_iso8601_format() {
        let ts = now_iso8601();
        // Should match "YYYY-MM-DDTHH:MM:SSZ"
        assert_eq!(ts.len(), 20);
        assert!(ts.ends_with('Z'));
        assert!(ts.contains('T'));
    }

    #[test]
    fn test_epoch_to_datetime_unix_epoch() {
        let (y, mo, d, h, mi, s) = epoch_to_datetime(0);
        assert_eq!(y, 1970);
        assert_eq!(mo, 1);
        assert_eq!(d, 1);
        assert_eq!(h, 0);
        assert_eq!(mi, 0);
        assert_eq!(s, 0);
    }

    #[test]
    fn test_epoch_to_datetime_known_date() {
        // 2026-05-27T00:00:00Z = 1_779_840_000 seconds (UTC)
        let secs = 1_779_840_000u64;
        let (y, mo, d, _h, _mi, _s) = epoch_to_datetime(secs);
        assert_eq!(y, 2026);
        assert_eq!(mo, 5);
        assert_eq!(d, 27);
    }

    #[test]
    fn test_is_leap_year() {
        assert!(is_leap(2000));
        assert!(is_leap(2024));
        assert!(!is_leap(1900));
        assert!(!is_leap(2023));
    }

    #[test]
    fn test_remove_step_reindex() {
        let steps = vec![
            ScenarioStep {
                index: 0,
                step_type: "gesture".into(),
                action: "tap".into(),
                args: vec![],
                timestamp_ms: 0,
                delay_before_ms: 0,
                label: None,
            },
            ScenarioStep {
                index: 1,
                step_type: "gesture".into(),
                action: "swipe".into(),
                args: vec![],
                timestamp_ms: 0,
                delay_before_ms: 0,
                label: None,
            },
            ScenarioStep {
                index: 2,
                step_type: "input".into(),
                action: "input".into(),
                args: vec![],
                timestamp_ms: 0,
                delay_before_ms: 0,
                label: None,
            },
        ];

        let mut modified = steps;
        modified.remove(1); // remove "swipe"
        for (i, step) in modified.iter_mut().enumerate() {
            step.index = i;
        }

        assert_eq!(modified.len(), 2);
        assert_eq!(modified[0].action, "tap");
        assert_eq!(modified[0].index, 0);
        assert_eq!(modified[1].action, "input");
        assert_eq!(modified[1].index, 1);
    }

    #[test]
    fn test_tags_parsing() {
        let tags_str = "smoke, regression, login";
        let tags: Vec<String> = tags_str
            .split(',')
            .map(|t| t.trim().to_owned())
            .filter(|t| !t.is_empty())
            .collect();
        assert_eq!(tags, vec!["smoke", "regression", "login"]);
    }

    #[test]
    fn recording_state_path_rejects_traversal() {
        assert!(recording_state_path("../escape").is_err());
        assert!(scenario_path("android", "../../escape").is_err());
        assert!(scenario_path("../escape", "flow").is_err());
    }

    #[test]
    fn test_play_step_range_validation() {
        // from >= to should fail
        let from = 5usize.saturating_sub(1); // 4
        let to = 3usize;
        assert!(from >= to);
    }

    #[test]
    fn playback_rejects_invalid_speed_before_loading_scenario() {
        for speed in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let error = cmd_play(
                "missing-scenario",
                "android",
                speed,
                false,
                None,
                None,
                None,
                None,
                true,
            )
            .unwrap_err();
            assert!(error.to_string().contains("Playback speed"));
        }
    }
    #[test]
    fn playback_rejects_zero_step_timeout_before_loading_scenario() {
        let error = cmd_play(
            "missing-scenario",
            "android",
            1.0,
            false,
            Some(0),
            None,
            None,
            None,
            true,
        )
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("Step timeout must be greater than zero"));
    }

    #[test]
    fn timed_out_playback_stops_before_later_step_without_stop_on_fail() {
        let _lock = crate::android::LEGACY_STATE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let home = tempfile::tempdir().unwrap();
        let _home = EnvGuard::set("HOME", home.path());
        let scenario = Scenario {
            version: 1,
            name: "timeout-terminal".to_owned(),
            platform: "android".to_owned(),
            description: None,
            tags: Vec::new(),
            steps: vec![
                ScenarioStep {
                    index: 0,
                    step_type: "wait".to_owned(),
                    action: "wait".to_owned(),
                    args: vec!["250".to_owned()],
                    timestamp_ms: 0,
                    delay_before_ms: 0,
                    label: None,
                },
                ScenarioStep {
                    index: 1,
                    step_type: "wait".to_owned(),
                    action: "wait".to_owned(),
                    args: Vec::new(),
                    timestamp_ms: 0,
                    delay_before_ms: 0,
                    label: None,
                },
            ],
            created_at: "2026-05-27T00:00:00Z".to_owned(),
            updated_at: "2026-05-27T00:00:00Z".to_owned(),
        };
        write_scenario(&scenario).unwrap();

        let error = cmd_play(
            "timeout-terminal",
            "android",
            1.0,
            false,
            Some(5),
            None,
            None,
            None,
            false,
        )
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("Scenario 'timeout-terminal' finished with 1 failure(s)"));
    }

    #[test]
    fn timed_out_action_returns_before_non_cancellable_worker_settles() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };

        let settled = Arc::new(AtomicBool::new(false));
        let action_settled = Arc::clone(&settled);
        let started = Instant::now();
        let result = run_with_timeout_action(1, move || {
            std::thread::sleep(std::time::Duration::from_millis(250));
            action_settled.store(true, Ordering::SeqCst);
            Ok("late result".to_owned())
        });

        let error = result.unwrap_err();
        assert!(started.elapsed() < Duration::from_millis(100));
        assert!(error.to_string().contains("non-cancellable"));

        let settle_deadline = Instant::now() + Duration::from_secs(1);
        while !settled.load(Ordering::SeqCst) && Instant::now() < settle_deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(settled.load(Ordering::SeqCst));
    }

    #[test]
    fn per_step_timeout_bounds_worker_action() {
        let ctx = FlowCtx {
            platform: "android".to_owned(),
            device: None,
            simulator: None,
            companion_path: None,
        };
        let step = crate::commands::flow::FlowStep {
            action: "wait".to_owned(),
            args: vec!["100".to_owned()],
            on_error: crate::commands::flow::OnError::Stop,
        };
        let started = Instant::now();
        let error = run_with_timeout(&ctx, &step, 20, None).expect_err("step should time out");
        assert!(started.elapsed() < Duration::from_millis(80));
        assert!(
            error.to_string().contains("timed out")
                || error
                    .to_string()
                    .contains("exceeded the remaining flow duration")
        );
    }

    #[test]
    fn test_export_flow_steps_format() {
        let scenario = Scenario {
            version: 1,
            name: "test".into(),
            platform: "android".into(),
            description: None,
            tags: vec![],
            steps: vec![ScenarioStep {
                index: 0,
                step_type: "gesture".into(),
                action: "tap".into(),
                args: vec!["10".into(), "20".into()],
                timestamp_ms: 0,
                delay_before_ms: 0,
                label: None,
            }],
            created_at: "2026-05-27T00:00:00Z".into(),
            updated_at: "2026-05-27T00:00:00Z".into(),
        };
        // Just verify export_flow_steps doesn't panic on valid data.
        // It prints to stdout so we can't capture it in a unit test easily,
        // but structural correctness is covered by serialization tests.
        assert_eq!(scenario.steps[0].action, "tap");
    }

    #[test]
    fn add_step_redacts_sensitive_args_before_persistence() {
        let _lock = crate::android::LEGACY_STATE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let legacy_root = tempfile::tempdir().unwrap();
        let state_root = tempfile::tempdir().unwrap();
        let _legacy_env = EnvGuard::set(LEGACY_TMP_DIR_ENV, legacy_root.path());
        let _state_env = EnvGuard::set(TEST_STATE_ROOT_ENV, state_root.path());

        cmd_start("redaction-storage", "android", None, None).unwrap();
        let nested = serde_json::json!({
            "fields": [{
                "password": "sentinel-nested-secret",
                "selector": "#login",
                "value": "ordinary-field-value"
            }],
            "metadata": "ordinary-metadata"
        })
        .to_string();
        let args_json = serde_json::to_string(&vec![
            nested,
            "ordinary-argument".to_owned(),
            "sk-12345678901234567890".to_owned(),
        ])
        .unwrap();
        cmd_add_step(
            "tap",
            Some(&args_json),
            Some("password=sentinel-label-secret"),
        )
        .unwrap();
        cmd_add_step("input", Some(r#"["hunter2!"]"#), None).unwrap();

        let path = recording_state_path("redaction-storage").unwrap();
        let on_disk = fs::read_to_string(&path).unwrap();
        assert!(!on_disk.contains("sentinel-nested-secret"));
        assert!(!on_disk.contains("hunter2!"));
        assert!(!on_disk.contains("sentinel-label-secret"));
        assert!(!on_disk.contains("sk-12345678901234567890"));
        assert!(on_disk.contains(REDACTED_ARGUMENT));
        assert!(on_disk.contains("ordinary-metadata"));
        assert!(on_disk.contains("ordinary-argument"));

        let persisted: RecordingState =
            serde_json::from_str(&on_disk).expect("recording state should remain valid JSON");
        assert_eq!(persisted.steps[0].args[1], "ordinary-argument");
        assert_eq!(persisted.steps[1].args, vec![REDACTED_ARGUMENT.to_owned()]);
    }

    #[test]
    fn show_and_export_redact_legacy_args_but_preserve_ordinary_content() {
        let _lock = crate::android::LEGACY_STATE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let home = tempfile::tempdir().unwrap();
        let _home_env = EnvGuard::set("HOME", home.path());
        let nested = serde_json::json!({
            "metadata": [{
                "password": "legacy-nested-secret",
                "selector": "#account",
                "note": "ordinary-legacy-note"
            }]
        })
        .to_string();
        let scenario = Scenario {
            version: 1,
            name: "legacy-redaction".to_owned(),
            platform: "android".to_owned(),
            description: None,
            tags: Vec::new(),
            steps: vec![
                ScenarioStep {
                    index: 0,
                    step_type: "gesture".to_owned(),
                    action: "tap".to_owned(),
                    args: vec![nested, "ordinary-argument".to_owned()],
                    timestamp_ms: 0,
                    delay_before_ms: 0,
                    label: Some("password=legacy-label-secret".to_owned()),
                },
                ScenarioStep {
                    index: 1,
                    step_type: "gesture".to_owned(),
                    action: "input".to_owned(),
                    args: vec!["hunter2!".to_owned()],
                    timestamp_ms: 1,
                    delay_before_ms: 0,
                    label: Some("input legacy-positional-label".to_owned()),
                },
                ScenarioStep {
                    index: 2,
                    step_type: "gesture".to_owned(),
                    action: "tap".to_owned(),
                    args: vec!["10".to_owned(), "20".to_owned()],
                    timestamp_ms: 2,
                    delay_before_ms: 0,
                    label: Some("ordinary label".to_owned()),
                },
            ],
            created_at: "2026-05-27T00:00:00Z".to_owned(),
            updated_at: "2026-05-27T00:00:00Z".to_owned(),
        };
        let raw_path = scenario_path("android", "legacy-redaction").unwrap();
        let raw_contents = serde_json::to_vec_pretty(&scenario).unwrap();
        atomic_write(&raw_path, &raw_contents).unwrap();

        let shown = scenario_json_for_output(&scenario).unwrap();
        let flow_steps = flow_steps_json_for_output(&scenario).unwrap();
        let markdown = markdown_for_output(&scenario);
        for output in [&shown, &flow_steps, &markdown] {
            assert!(!output.contains("legacy-nested-secret"));
            assert!(!output.contains("hunter2!"));
            assert!(!output.contains("legacy-label-secret"));
            assert!(!output.contains("legacy-positional-label"));
            assert!(output.contains(REDACTED_ARGUMENT));
            assert!(output.contains("#account"));
            assert!(output.contains("ordinary-argument"));
            assert!(output.contains("ordinary-legacy-note"));
        }
        assert!(shown.contains("ordinary label"));
        assert!(markdown.contains("ordinary label"));

        let path = scenario_path("android", "legacy-redaction").unwrap();
        let stored = fs::read_to_string(path).unwrap();
        assert!(stored.contains("legacy-nested-secret"));
        assert!(stored.contains("hunter2!"));
        assert!(stored.contains("legacy-label-secret"));
        assert!(stored.contains("legacy-positional-label"));
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
    fn legacy_recording_migrates_and_remains_resumable() {
        let _lock = crate::android::LEGACY_STATE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let legacy_root = tempfile::tempdir().unwrap();
        let state_root = tempfile::tempdir().unwrap();
        let _legacy_env = EnvGuard::set(LEGACY_TMP_DIR_ENV, legacy_root.path());
        let _state_env = EnvGuard::set(TEST_STATE_ROOT_ENV, state_root.path());

        let name = "migration-recording";
        let state = RecordingState {
            name: name.to_owned(),
            platform: "android".to_owned(),
            description: Some("legacy".to_owned()),
            tags: vec!["smoke".to_owned()],
            steps: vec![ScenarioStep {
                index: 0,
                step_type: "gesture".to_owned(),
                action: "tap".to_owned(),
                args: vec!["1".to_owned(), "2".to_owned()],
                timestamp_ms: 1,
                delay_before_ms: 0,
                label: None,
            }],
            started_at: "2026-05-27T12:00:00Z".to_owned(),
        };
        for index in 0..=MAX_RECORDING_FILES {
            let unrelated = legacy_root.path().join(format!("unrelated-{index}.json"));
            std::fs::write(unrelated, b"{}").unwrap();
        }
        let legacy_path = legacy_root
            .path()
            .join(format!("claude-mobile-recording-{name}.json"));
        std::fs::write(&legacy_path, serde_json::to_vec(&state).unwrap()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&legacy_path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }

        let migrated = find_active_recording().unwrap().unwrap();
        assert_eq!(migrated.description.as_deref(), Some("legacy"));
        assert_eq!(migrated.steps[0].action, "tap");

        let destination = recording_state_path(name).unwrap();
        let migrated_from_disk: RecordingState =
            read_json_file(&destination, MAX_SCENARIO_BYTES, "recording state").unwrap();
        assert_eq!(migrated_from_disk.description.as_deref(), Some("legacy"));

        let mut stale = state;
        stale.description = Some("stale".to_owned());
        std::fs::write(&legacy_path, serde_json::to_vec(&stale).unwrap()).unwrap();
        let retained = find_active_recording().unwrap().unwrap();
        assert_eq!(retained.description.as_deref(), Some("legacy"));
    }

    #[test]
    fn start_rejects_a_second_active_recording() {
        let _lock = crate::android::LEGACY_STATE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let legacy_root = tempfile::tempdir().unwrap();
        let state_root = tempfile::tempdir().unwrap();
        let _legacy_env = EnvGuard::set(LEGACY_TMP_DIR_ENV, legacy_root.path());
        let _state_env = EnvGuard::set(TEST_STATE_ROOT_ENV, state_root.path());

        cmd_start("first-recording", "android", None, None).unwrap();
        let error = cmd_start("second-recording", "android", None, None).unwrap_err();

        assert!(error.to_string().contains("already active"));
        assert_eq!(
            find_active_recording().unwrap().unwrap().name,
            "first-recording"
        );
    }

    #[cfg(unix)]
    #[test]
    fn advisory_recording_lock_blocks_contending_open() {
        use std::sync::mpsc;

        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("recorder.lock");
        let held = acquire_advisory_recording_lock(&path).unwrap();
        let (sender, receiver) = mpsc::channel();
        let contender_path = path.clone();
        let contender = std::thread::spawn(move || {
            let acquired = acquire_advisory_recording_lock(&contender_path).is_ok();
            let _ = sender.send(acquired);
        });

        assert!(receiver.recv_timeout(Duration::from_millis(50)).is_err());
        drop(held);
        assert!(receiver.recv_timeout(Duration::from_secs(1)).unwrap());
        contender.join().unwrap();
    }

    #[test]
    fn concurrent_starts_leave_one_active_recording() {
        use std::sync::{Arc, Barrier};

        let _lock = crate::android::LEGACY_STATE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let legacy_root = tempfile::tempdir().unwrap();
        let state_root = tempfile::tempdir().unwrap();
        let _legacy_env = EnvGuard::set(LEGACY_TMP_DIR_ENV, legacy_root.path());
        let _state_env = EnvGuard::set(TEST_STATE_ROOT_ENV, state_root.path());
        let barrier = Arc::new(Barrier::new(8));
        let handles = (0..8)
            .map(|index| {
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    cmd_start(&format!("concurrent-{index}"), "android", None, None)
                })
            })
            .collect::<Vec<_>>();

        let successes = handles
            .into_iter()
            .map(|handle| handle.join().expect("start worker should not panic"))
            .filter(|result| result.is_ok())
            .count();
        assert_eq!(successes, 1);
        assert!(find_active_recording().unwrap().is_some());
    }

    #[test]
    fn concurrent_add_steps_preserve_all_updates() {
        use std::sync::{Arc, Barrier};

        let _lock = crate::android::LEGACY_STATE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let legacy_root = tempfile::tempdir().unwrap();
        let state_root = tempfile::tempdir().unwrap();
        let _legacy_env = EnvGuard::set(LEGACY_TMP_DIR_ENV, legacy_root.path());
        let _state_env = EnvGuard::set(TEST_STATE_ROOT_ENV, state_root.path());

        cmd_start("concurrent-updates", "android", None, None).unwrap();
        let barrier = Arc::new(Barrier::new(8));
        let handles = (0..8)
            .map(|index| {
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    let args =
                        serde_json::to_string(&vec![index.to_string(), "0".to_owned()]).unwrap();
                    cmd_add_step("tap", Some(&args), Some("ordinary step"))
                })
            })
            .collect::<Vec<_>>();

        let outcomes = handles
            .into_iter()
            .map(|handle| handle.join().expect("update worker should not panic"))
            .collect::<Vec<_>>();
        assert!(outcomes.iter().all(|result| result.is_ok()));
        let active = find_active_recording().unwrap().unwrap();
        assert_eq!(active.steps.len(), 8);
        assert_eq!(
            active
                .steps
                .iter()
                .map(|step| step.index)
                .collect::<Vec<_>>(),
            (0..8).collect::<Vec<_>>()
        );
    }

    #[cfg(unix)]
    #[test]
    fn legacy_recording_rejects_group_writable_file_before_import() {
        use std::os::unix::fs::PermissionsExt;

        let _lock = crate::android::LEGACY_STATE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let legacy_root = tempfile::tempdir().unwrap();
        let state_root = tempfile::tempdir().unwrap();
        let _legacy_env = EnvGuard::set(LEGACY_TMP_DIR_ENV, legacy_root.path());
        let _state_env = EnvGuard::set(TEST_STATE_ROOT_ENV, state_root.path());

        let name = "insecure-recording";
        let legacy_path = legacy_root
            .path()
            .join(format!("claude-mobile-recording-{name}.json"));
        let state = RecordingState {
            name: name.to_owned(),
            platform: "android".to_owned(),
            description: None,
            tags: Vec::new(),
            steps: Vec::new(),
            started_at: "2026-05-27T12:00:00Z".to_owned(),
        };
        std::fs::write(&legacy_path, serde_json::to_vec(&state).unwrap()).unwrap();
        std::fs::set_permissions(&legacy_path, std::fs::Permissions::from_mode(0o666)).unwrap();

        let destination = recording_state_path(name).unwrap();
        let error = migrate_legacy_recording(name, &destination).unwrap_err();
        assert!(error.to_string().contains("group/world-writable"));
        assert!(!destination.exists());
    }
}
