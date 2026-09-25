//! REPL session — one PTY + child process + vt100 emulator + reader thread.
//!
//! Concurrency model: a single reader thread owns the PTY master reader and
//! pushes bytes into shared [`SessionState`] under a Mutex. The supervisor
//! polls `state.buffer` from the consumer side. We deliberately avoid tokio:
//! REPL sessions are few, latency tolerances are in milliseconds, and a
//! blocking thread per session keeps the dependency graph small.
//!
//! # Reader thread ordering (STRICT — do not reorder)
//!
//! 1. Normalize terminal controls, then run `CastRedactor::push` and
//!    cross-read redaction — OUTSIDE the mutex.
//! 2. Write the streaming-redacted payload to asciicast — OUTSIDE the mutex via
//!    local BufWriter.
//! 3. Acquire `SessionState` lock:
//!    a. feed the original PTY bytes to `vt` so terminal controls retain their
//!       screen semantics;
//!    b. expose only redacted rendered screen text and filmstrip frames;
//!    c. append streaming-redacted bytes to `raw` + cap drain;
//!    d. update status / last_activity.
//! 4. At EOF, flush the normalizer and redactor suffix to `raw` and asciicast.
//!    `vt` has already consumed every original byte.

use std::collections::VecDeque;
#[cfg(unix)]
use std::ffi::CString;
use std::io::{self, BufWriter, Read, Write};
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, RawHandle};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::utils::private_state::state_dir;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use crate::utils::process::append_process_descendants;
#[cfg(unix)]
use crate::utils::process::{signal_process, signal_process_group, track_process, TrackedProcess};
use anyhow::{anyhow, bail, Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;

use super::expect::{ExpectOutcome, ExpectRules};
use super::redaction;

/// Called once by the reader thread after it has marked the generation dead.
pub(crate) type ExitCallback = Arc<dyn Fn() + Send + Sync + 'static>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// `portable-pty` uses a fork/exec handshake on Unix that is not safe to run
/// concurrently: overlapping handshakes can exchange malformed child errors.
/// Keep the narrow process-creation section serialized; sessions run
/// concurrently after `spawn_command` returns.
static PTY_SPAWN_LOCK: Mutex<()> = Mutex::new(());

/// Maximum number of filmstrip frames retained per session.
pub const FILMSTRIP_CAP: usize = 50;
/// Maximum total UTF-8 bytes retained by the filmstrip grids.
pub const FILMSTRIP_CAP_BYTES: usize = 4 * 1024 * 1024;

/// Maximum bytes retained in `SessionState.raw`. Older bytes are drained from
/// the front when this limit is exceeded.
pub const RAW_BUFFER_CAP_BYTES: usize = 256 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Starting,
    Ready,
    Busy,
    Dead,
}

/// A single filmstrip frame — the post-`vt.process` screen grid at a moment in
/// time. Captured only in the reader thread, never in send/key dispatch.
pub struct FilmstripFrame {
    pub captured_at: SystemTime,
    pub grid: String,
}

pub struct SessionState {
    /// Redacted PTY byte stream, capped at [`RAW_BUFFER_CAP_BYTES`]. Older
    /// bytes are drained from the front when the cap is exceeded.
    pub raw: String,
    /// vt100 grid emulator — produces canonical screen text.
    vt: vt100::Parser,
    pub status: SessionStatus,
    pub exit_code: Option<i32>,
    pub last_activity: Instant,
    /// PTY width — single source of truth (updated on resize).
    pub cols: u16,
    /// PTY height — single source of truth (updated on resize).
    pub rows: u16,
    /// Bounded ring-buffer of post-render grid captures.
    pub filmstrip: VecDeque<FilmstripFrame>,
    /// Total UTF-8 bytes occupied by [`filmstrip`] grids.
    pub filmstrip_bytes: usize,
}

fn sanitize_terminal_screen(text: &str) -> String {
    let redacted = redaction::redact(text);
    if redacted != text {
        return redacted;
    }

    // VT wrapping can split a token across rows. If removing layout whitespace
    // reveals a credential, fail closed for the entire screen rather than
    // returning any fragments.
    let compact: String = text
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    if redaction::redact(&compact) != compact {
        return "[REDACTED]".to_string();
    }

    text.to_string()
}
impl SessionState {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            raw: String::new(),
            vt: vt100::Parser::new(rows, cols, 1000),
            status: SessionStatus::Starting,
            exit_code: None,
            last_activity: Instant::now(),
            cols,
            rows,
            filmstrip: VecDeque::new(),
            filmstrip_bytes: 0,
        }
    }

    pub fn screen_text(&self) -> String {
        sanitize_terminal_screen(&self.vt.screen().contents())
    }

    /// Append a complete rendered frame, evicting the oldest complete frames
    /// until both filmstrip limits are satisfied.
    pub fn push_filmstrip(&mut self, mut frame: FilmstripFrame) {
        frame.grid = sanitize_terminal_screen(&frame.grid);
        self.filmstrip_bytes = self.filmstrip_bytes.saturating_add(frame.grid.len());
        self.filmstrip.push_back(frame);
        while self.filmstrip.len() > FILMSTRIP_CAP || self.filmstrip_bytes > FILMSTRIP_CAP_BYTES {
            let Some(oldest) = self.filmstrip.pop_front() else {
                self.filmstrip_bytes = 0;
                break;
            };
            self.filmstrip_bytes = self.filmstrip_bytes.saturating_sub(oldest.grid.len());
        }
    }

    fn append_redacted_raw(&mut self, text: &str) {
        self.raw.push_str(text);
        if self.raw.len() > RAW_BUFFER_CAP_BYTES {
            let excess = self.raw.len() - RAW_BUFFER_CAP_BYTES;
            // Drain from the front. We must find a char boundary to avoid
            // splitting UTF-8.
            let drain_at = self
                .raw
                .char_indices()
                .map(|(index, _)| index)
                .find(|&index| index >= excess)
                .unwrap_or(self.raw.len());
            self.raw.drain(..drain_at);
        }
    }
}

// ---------------------------------------------------------------------------
// Asciicast writer helpers
// ---------------------------------------------------------------------------

/// Write an asciicast v2 header to `w`. No `env` or `title` fields — they
/// can carry secrets.
fn write_cast_header(w: &mut impl Write, cols: u16, rows: u16) -> Result<()> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let header =
        format!("{{\"version\":2,\"width\":{cols},\"height\":{rows},\"timestamp\":{timestamp}}}\n");
    w.write_all(header.as_bytes())
        .context("write asciicast header")?;
    Ok(())
}

/// Write one asciicast v2 event line.
fn write_cast_event(w: &mut impl Write, elapsed_secs: f64, data: &str) -> std::io::Result<()> {
    // Escape the data string as JSON.
    let json_data = serde_json::to_string(data).unwrap_or_else(|_| "\"[REDACTED]\"".to_string());
    let line = format!("[{elapsed_secs:.6},\"o\",{json_data}]\n");
    w.write_all(line.as_bytes())
}

const PTY_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const PTY_WRITE_RETRY_INTERVAL: Duration = Duration::from_millis(2);

fn write_all_with_retry(writer: &mut impl Write, data: &[u8]) -> io::Result<()> {
    let deadline = Instant::now() + PTY_WRITE_TIMEOUT;
    let mut written = 0;
    while written < data.len() {
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "PTY write timed out",
            ));
        }
        match writer.write(&data[written..]) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "PTY writer made no progress",
                ));
            }
            Ok(count) => written += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "PTY write timed out",
                    ));
                }
                thread::sleep(remaining.min(PTY_WRITE_RETRY_INTERVAL));
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

/// Streaming normalizer for terminal control sequences.
///
/// PTY programs can insert CSI/OSC (or the equivalent 8-bit C1 controls)
/// between credential characters. Matching the unnormalised stream lets a
/// secret survive redaction while still being visible in a raw export. The
/// reader therefore strips terminal controls and directional formatting
/// controls before any externally visible surface is produced. Newline,
/// carriage return, and tab remain as structural text.
#[derive(Clone, Copy, Default)]
enum TerminalControlState {
    #[default]
    Ground,
    Escape,
    Csi,
    String,
    StringEscape,
}

#[derive(Default)]
struct TerminalNormalizer {
    state: TerminalControlState,
}

impl TerminalNormalizer {
    fn push(&mut self, input: &str) -> String {
        let mut output = String::with_capacity(input.len());
        for character in input.chars() {
            self.consume(character, &mut output);
        }
        output
    }

    fn finish(&mut self) -> String {
        self.state = TerminalControlState::Ground;
        String::new()
    }

    fn consume(&mut self, character: char, output: &mut String) {
        let byte = (character as u32 <= u8::MAX as u32).then_some(character as u8);
        match self.state {
            TerminalControlState::Ground => {
                if character == '\u{1b}' {
                    self.state = TerminalControlState::Escape;
                } else if matches!(byte, Some(0x9b)) {
                    self.state = TerminalControlState::Csi;
                } else if matches!(byte, Some(0x9d | 0x90 | 0x98 | 0x9e | 0x9f)) {
                    self.state = TerminalControlState::String;
                } else if matches!(byte, Some(0x9c))
                    || (character.is_ascii_control() && !matches!(character, '\n' | '\r' | '\t'))
                    || matches!(byte, Some(0x80..=0x9f))
                    || matches!(
                        character,
                        '\u{061c}'
                            | '\u{200e}'
                            | '\u{200f}'
                            | '\u{202a}'..='\u{202e}'
                            | '\u{2066}'..='\u{2069}'
                    )
                {
                    // Drop terminal controls and Unicode directional overrides.
                } else {
                    output.push(character);
                }
            }
            TerminalControlState::Escape => {
                self.state = match character {
                    '[' => TerminalControlState::Csi,
                    ']' | 'P' | '^' | '_' | 'X' => TerminalControlState::String,
                    _ => TerminalControlState::Ground,
                };
            }
            TerminalControlState::Csi => {
                if character == '\u{1b}' {
                    self.state = TerminalControlState::Escape;
                } else if byte.is_some_and(|value| (0x40..=0x7e).contains(&value)) {
                    self.state = TerminalControlState::Ground;
                }
            }
            TerminalControlState::String => {
                if matches!(byte, Some(0x07 | 0x9c)) {
                    self.state = TerminalControlState::Ground;
                } else if character == '\u{1b}' {
                    self.state = TerminalControlState::StringEscape;
                }
            }
            TerminalControlState::StringEscape => {
                self.state = if character == '\\' {
                    TerminalControlState::Ground
                } else if character == '\u{1b}' {
                    TerminalControlState::StringEscape
                } else {
                    TerminalControlState::String
                };
            }
        }
    }
}

/// Maximum ambiguous suffix retained to detect a fixed-length credential
/// split across PTY reads; terminated ordinary output is emitted immediately.
const CAST_REDACTION_OVERLAP_BYTES: usize = 40;
// Fail closed if an undecided credential-like prefix remains open past the
// overlap window. This keeps the retained state bounded even for malformed
// or unbounded token-shaped output.
const CAST_REDACTION_PENDING_CAP_BYTES: usize = 512;
const AWS_ACCESS_KEY_PREFIXES: &[&str] = &[
    "AKIA", "ASIA", "AIDA", "AROA", "AGPA", "AIPA", "ANPA", "ANVA", "ASCA", "ACCA", "ABIA",
];
const AWS_ACCESS_KEY_VARIABLE_PREFIX: &str = "A3T";
const CAST_REDACTION_PREFIXES: &[&str] = &[
    "AKIA",
    "ASIA",
    "AIDA",
    "AROA",
    "AGPA",
    "AIPA",
    "ANPA",
    "ANVA",
    "ASCA",
    "ACCA",
    "ABIA",
    "A3T",
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
    "sk-ant-",
    "sk-proj-",
    "sk-",
    "eyJ",
    "AIza",
    "xoxa-",
    "xoxb-",
    "xoxp-",
    "xoxr-",
    "xoxs-",
];

#[derive(Clone, Copy)]
enum CredentialRun {
    AwsAccess,
    AwsSecret,
    Github,
    Anthropic,
    OpenAi,
    Bearer,
    BearerWait,
    Jwt,
    Google,
    Slack,
    Conservative,
}

impl CredentialRun {
    fn allows(self, byte: u8) -> bool {
        match self {
            Self::AwsAccess => byte.is_ascii_uppercase() || byte.is_ascii_digit(),
            Self::AwsSecret => is_aws_secret_byte(byte),
            Self::Github => byte.is_ascii_alphanumeric() || byte == b'_',
            Self::Anthropic => byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'),
            Self::OpenAi => byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'),
            Self::Bearer => byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'),
            Self::BearerWait => byte.is_ascii_whitespace(),
            Self::Jwt => byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'),
            Self::Google => byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'),
            Self::Slack => byte.is_ascii_alphanumeric() || byte == b'-',
            Self::Conservative => is_credential_byte(byte),
        }
    }
}

#[derive(Default)]
struct CastRedactor {
    pending: String,
    run: Option<CredentialRun>,
    terminal_normalizer: TerminalNormalizer,
}

impl CastRedactor {
    fn push(&mut self, chunk: &str) -> String {
        let normalized = self.terminal_normalizer.push(chunk);
        self.push_normalized(&normalized)
    }

    fn push_normalized(&mut self, chunk: &str) -> String {
        let mut output = String::new();
        let mut remaining = chunk;

        loop {
            if let Some(run) = self.run {
                if matches!(run, CredentialRun::BearerWait) {
                    let Some(token_start) = first_non_whitespace(remaining) else {
                        return output;
                    };
                    if CredentialRun::Bearer.allows(remaining.as_bytes()[token_start]) {
                        self.run = Some(CredentialRun::Bearer);
                    } else {
                        self.run = None;
                    }
                    remaining = &remaining[token_start..];
                    continue;
                }

                let Some(boundary) = first_disallowed(remaining, run) else {
                    // Credential bytes are deliberately discarded instead of
                    // being retained in `pending`, so an unterminated token
                    // cannot grow memory without bound.
                    return output;
                };
                self.run = None;
                remaining = &remaining[boundary..];
            }

            self.pending.push_str(remaining);

            loop {
                let Some((start, body_start, run)) = find_credential_run(&self.pending) else {
                    if let Some((start, body_start)) = find_bearer_pending(&self.pending) {
                        let safe_before = redaction_safe_prefix_len(&self.pending[..start]);
                        if safe_before > 0 {
                            let pending = std::mem::take(&mut self.pending);
                            output.push_str(&redaction::redact(&pending[..safe_before]));
                            self.pending = pending[safe_before..].to_string();
                            continue;
                        }
                        if self.pending.len() > CAST_REDACTION_PENDING_CAP_BYTES {
                            output.push_str("[REDACTED]");
                            self.pending.clear();
                            self.run = Some(CredentialRun::Conservative);
                            return output;
                        }

                        let pending = std::mem::take(&mut self.pending);
                        output.push_str(&redaction::redact(&pending[..start]));
                        let whitespace_len = pending.len() - body_start;
                        if whitespace_len >= CAST_REDACTION_PENDING_CAP_BYTES {
                            output.push_str("[REDACTED]");
                            self.run = Some(CredentialRun::BearerWait);
                            return output;
                        }
                        self.pending = pending[start..].to_string();
                        return output;
                    }

                    let split_at = redaction_safe_prefix_len(&self.pending);
                    if split_at == 0 {
                        if self.pending.len() > CAST_REDACTION_PENDING_CAP_BYTES {
                            output.push_str("[REDACTED]");
                            self.pending.clear();
                            self.run = Some(CredentialRun::Conservative);
                        }
                        return output;
                    }
                    let pending = std::mem::take(&mut self.pending);
                    let (stable, carry) = pending.split_at(split_at);
                    self.pending = carry.to_string();
                    output.push_str(&redaction::redact(stable));
                    continue;
                };

                let pending = std::mem::take(&mut self.pending);
                output.push_str(&redaction::redact(&pending[..start]));
                output.push_str("[REDACTED]");

                let tail = &pending[body_start..];
                if let Some(exact_len) = exact_credential_len(run) {
                    self.run = None;
                    self.pending.push_str(&tail[exact_len..]);
                    continue;
                }
                if let Some(boundary) = first_disallowed(tail, run) {
                    self.run = None;
                    self.pending.push_str(&tail[boundary..]);
                    continue;
                }

                self.run = Some(run);
                return output;
            }
        }
    }

    fn finish(mut self) -> String {
        let normalized = self.terminal_normalizer.finish();
        let mut output = self.push_normalized(&normalized);
        if self.run.is_some() {
            // The marker was emitted when the credential run was recognized;
            // all subsequent credential bytes were discarded while streaming.
            return output;
        }
        output.push_str(&redaction::redact(&self.pending));
        output
    }
}

fn first_disallowed(input: &str, run: CredentialRun) -> Option<usize> {
    input.bytes().position(|byte| !run.allows(byte))
}

fn first_non_whitespace(input: &str) -> Option<usize> {
    input
        .char_indices()
        .find_map(|(index, character)| (!character.is_whitespace()).then_some(index))
}

fn exact_credential_len(run: CredentialRun) -> Option<usize> {
    match run {
        CredentialRun::AwsAccess => Some(16),
        CredentialRun::AwsSecret => Some(40),
        CredentialRun::Google => Some(35),
        CredentialRun::Github
        | CredentialRun::Anthropic
        | CredentialRun::OpenAi
        | CredentialRun::Bearer
        | CredentialRun::BearerWait
        | CredentialRun::Jwt
        | CredentialRun::Slack
        | CredentialRun::Conservative => None,
    }
}

fn find_credential_run(input: &str) -> Option<(usize, usize, CredentialRun)> {
    for (start, _) in input.char_indices() {
        let rest = &input[start..];

        for prefix in AWS_ACCESS_KEY_PREFIXES.iter().copied() {
            if rest.starts_with(prefix) {
                let body_start = start + prefix.len();
                let (_, body_len) = credential_run_end(input, body_start, CredentialRun::AwsAccess);
                if body_len >= 16 {
                    return Some((start, body_start, CredentialRun::AwsAccess));
                }
            }
        }

        if rest.starts_with(AWS_ACCESS_KEY_VARIABLE_PREFIX) {
            let selector_start = start + AWS_ACCESS_KEY_VARIABLE_PREFIX.len();
            if let Some(&selector) = input.as_bytes().get(selector_start) {
                if is_aws_access_selector(selector) {
                    let body_start = selector_start + 1;
                    let (_, body_len) =
                        credential_run_end(input, body_start, CredentialRun::AwsAccess);
                    if body_len >= 16 {
                        return Some((start, body_start, CredentialRun::AwsAccess));
                    }
                }
            }
        }

        if rest.starts_with("github_pat_") {
            let body_start = start + "github_pat_".len();
            let (_, body_len) = credential_run_end(input, body_start, CredentialRun::Github);
            if body_len >= 36 {
                return Some((start, body_start, CredentialRun::Github));
            }
        }

        for prefix in ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"] {
            if rest.starts_with(prefix) {
                let body_start = start + prefix.len();
                let (_, body_len) = credential_run_end(input, body_start, CredentialRun::Github);
                if body_len >= 36 {
                    return Some((start, body_start, CredentialRun::Github));
                }
            }
        }

        if rest.starts_with("sk-ant-") {
            let body_start = start + "sk-ant-".len();
            let (_, body_len) = credential_run_end(input, body_start, CredentialRun::Anthropic);
            if body_len >= 20 {
                return Some((start, body_start, CredentialRun::Anthropic));
            }
        }

        if rest.starts_with("sk-") {
            let body_start = start + "sk-".len();
            let (_, body_len) = credential_run_end(input, body_start, CredentialRun::OpenAi);
            if body_len >= 20 {
                return Some((start, body_start, CredentialRun::OpenAi));
            }
        }

        if rest.len() >= 6
            && rest.as_bytes()[..6].eq_ignore_ascii_case(b"Bearer")
            && (start == 0 || !is_word_byte(input.as_bytes()[start - 1]))
        {
            let body_start = bearer_body_start(input, start);
            let (_, body_len) = credential_run_end(input, body_start, CredentialRun::Bearer);
            if body_start > start + 6 && body_len > 0 {
                return Some((start, body_start, CredentialRun::Bearer));
            }
        }

        if rest.starts_with("eyJ") && jwt_body_end(input, start + 3).is_some() {
            return Some((start, start + 3, CredentialRun::Jwt));
        }

        if rest.starts_with("AIza") {
            let body_start = start + "AIza".len();
            let (_, body_len) = credential_run_end(input, body_start, CredentialRun::Google);
            if body_len >= 35 {
                return Some((start, body_start, CredentialRun::Google));
            }
        }

        for prefix in ["xoxa-", "xoxb-", "xoxp-", "xoxr-", "xoxs-"] {
            if rest.starts_with(prefix) {
                let body_start = start + prefix.len();
                let (_, body_len) = credential_run_end(input, body_start, CredentialRun::Slack);
                if body_len > 0 {
                    return Some((start, body_start, CredentialRun::Slack));
                }
            }
        }

        if is_aws_secret_start(input, start) {
            let (end, body_len) = credential_run_end(input, start, CredentialRun::AwsSecret);
            if body_len == 40
                && matches!(
                    input.as_bytes().get(end),
                    Some(byte) if !is_aws_secret_byte(*byte) && *byte != b'_'
                )
            {
                return Some((start, start, CredentialRun::AwsSecret));
            }
        }
    }

    None
}

fn find_bearer_pending(input: &str) -> Option<(usize, usize)> {
    for (start, _) in input.char_indices() {
        let rest = &input[start..];
        if rest.len() < 6
            || !rest.as_bytes()[..6].eq_ignore_ascii_case(b"Bearer")
            || (start > 0 && is_word_byte(input.as_bytes()[start - 1]))
        {
            continue;
        }

        let whitespace_start = start + 6;
        let mut end = whitespace_start;
        for (offset, character) in input[whitespace_start..].char_indices() {
            if !character.is_whitespace() {
                break;
            }
            end = whitespace_start + offset + character.len_utf8();
        }
        if end > whitespace_start && end == input.len() {
            return Some((start, whitespace_start));
        }
    }
    None
}

fn credential_run_end(input: &str, start: usize, run: CredentialRun) -> (usize, usize) {
    let mut end = start;
    for (offset, byte) in input[start..].bytes().enumerate() {
        if !run.allows(byte) {
            break;
        }
        end = start + offset + 1;
    }
    (end, end - start)
}

fn jwt_body_end(input: &str, mut cursor: usize) -> Option<usize> {
    for segment in 0..3 {
        let segment_start = cursor;
        while matches!(
            input.as_bytes().get(cursor),
            Some(byte) if byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
        ) {
            cursor += 1;
        }
        if cursor == segment_start {
            return None;
        }
        if segment < 2 {
            if input.as_bytes().get(cursor) != Some(&b'.') {
                return None;
            }
            cursor += 1;
        }
    }
    Some(cursor)
}

fn is_aws_secret_start(input: &str, start: usize) -> bool {
    let Some(&byte) = input.as_bytes().get(start) else {
        return false;
    };
    is_aws_secret_byte(byte)
        && (start == 0
            || (!is_aws_secret_byte(input.as_bytes()[start - 1])
                && input.as_bytes()[start - 1] != b'_'))
}

fn is_aws_secret_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'+' | b'=')
}

fn is_aws_access_selector(byte: u8) -> bool {
    byte.is_ascii_uppercase() || byte.is_ascii_digit()
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn is_credential_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b'/' | b'+' | b'=' | b':')
}

fn bearer_body_start(input: &str, start: usize) -> usize {
    let whitespace_start = start + 6;
    let mut body_start = whitespace_start;
    for (offset, character) in input[whitespace_start..].char_indices() {
        if !character.is_whitespace() {
            break;
        }
        body_start = whitespace_start + offset + character.len_utf8();
    }
    body_start
}

fn redaction_safe_prefix_len(input: &str) -> usize {
    if input.is_empty() {
        return 0;
    }

    let mut hold_from = input.len();

    for prefix in CAST_REDACTION_PREFIXES {
        let mut search_from = 0;
        while search_from < input.len() {
            let Some(relative) = input[search_from..].find(*prefix) else {
                break;
            };
            let start = search_from + relative;
            let suffix_start = start + prefix.len();
            if credential_suffix_may_continue(*prefix, &input[suffix_start..]) {
                hold_from = hold_from.min(start);
            }
            search_from = suffix_start;
        }
    }

    // Hold proper secret-prefix fragments split across PTY reads, not an
    // arbitrary window of otherwise safe output.
    for (start, _) in input.char_indices() {
        let suffix = &input[start..];
        if CAST_REDACTION_PREFIXES
            .iter()
            .any(|prefix| suffix.len() < prefix.len() && prefix.starts_with(suffix))
        {
            hold_from = hold_from.min(start);
        }

        const BEARER: &str = "Bearer";
        if suffix.len() < BEARER.len()
            && BEARER.as_bytes()[..suffix.len()].eq_ignore_ascii_case(suffix.as_bytes())
            && (start == 0 || !is_word_byte(input.as_bytes()[start - 1]))
        {
            hold_from = hold_from.min(start);
        }
    }

    // Bearer is case-insensitive and includes a required whitespace boundary.
    for (start, _) in input.char_indices() {
        let rest = &input[start..];
        let Some(prefix) = rest.get(..6) else {
            continue;
        };
        if prefix.as_bytes().eq_ignore_ascii_case(b"Bearer")
            && (start == 0 || !is_word_byte(input.as_bytes()[start - 1]))
            && bearer_suffix_may_continue(&rest[6..])
        {
            hold_from = hold_from.min(start);
        }
    }

    // AWS secret keys have no fixed prefix. Retain the last 40 base64-like
    // bytes until a delimiter makes the token boundary observable.
    if let Some(start) = aws_secret_tail_start(input) {
        hold_from = hold_from.min(start);
    }
    hold_from = hold_from.min(redaction::generic_redaction_safe_prefix_len(input));
    hold_from
}

fn credential_suffix_may_continue(prefix: &str, suffix: &str) -> bool {
    if prefix == AWS_ACCESS_KEY_VARIABLE_PREFIX {
        let Some(selector) = suffix.as_bytes().first().copied() else {
            return true;
        };
        return is_aws_access_selector(selector)
            && suffix.as_bytes()[1..]
                .iter()
                .copied()
                .all(|byte| CredentialRun::AwsAccess.allows(byte));
    }

    let run = if AWS_ACCESS_KEY_PREFIXES.contains(&prefix) {
        CredentialRun::AwsAccess
    } else if prefix == "github_pat_" || prefix.starts_with("gh") {
        CredentialRun::Github
    } else if prefix == "sk-ant-" {
        CredentialRun::Anthropic
    } else if prefix.starts_with("sk-") {
        CredentialRun::OpenAi
    } else if prefix == "eyJ" {
        CredentialRun::Jwt
    } else if prefix == "AIza" {
        CredentialRun::Google
    } else {
        CredentialRun::Slack
    };
    suffix.bytes().all(|byte| run.allows(byte))
}

fn bearer_suffix_may_continue(suffix: &str) -> bool {
    let Some(index) = suffix
        .char_indices()
        .find_map(|(index, character)| (!character.is_whitespace()).then_some(index))
    else {
        return false;
    };
    index > 0
        && suffix[index..]
            .bytes()
            .all(|byte| CredentialRun::Bearer.allows(byte))
}

fn aws_secret_tail_start(input: &str) -> Option<usize> {
    let mut start = input.len();
    for (index, byte) in input.bytes().enumerate().rev() {
        if is_aws_secret_byte(byte) {
            start = index;
        } else {
            break;
        }
    }
    let run_len = input.len() - start;
    (run_len > 0).then(|| input.len() - run_len.min(CAST_REDACTION_OVERLAP_BYTES))
}

// ---------------------------------------------------------------------------
// castPath validation
// ---------------------------------------------------------------------------

/// Validate and open a `.cast` file path, confining it to the system temp
/// directory or the private per-user REPL cast directory.  Unix opens every
/// parent component through retained no-follow directory handles so a later
/// symlink swap cannot redirect creation or cleanup.
struct OpenedCastFile {
    file: std::fs::File,
    cleanup: CastFileCleanup,
}

#[cfg(unix)]
fn open_cast_file(path: &PathBuf) -> Result<OpenedCastFile> {
    let temp_base = std::env::temp_dir()
        .canonicalize()
        .context("canonicalize system temporary directory")?;
    let state_base = state_dir("repl-casts")?
        .canonicalize()
        .context("canonicalize private REPL cast directory")?;
    let absolute = if path.is_absolute() {
        path.clone()
    } else {
        std::env::current_dir()
            .context("resolve relative castPath")?
            .join(path)
    };
    let parent = absolute
        .parent()
        .context("castPath has no parent directory")?;
    let file_name = absolute.file_name().context("castPath has no file name")?;

    for root in [&temp_base, &state_base] {
        if !parent.starts_with(root) {
            continue;
        }
        let relative_parent = parent
            .strip_prefix(root)
            .expect("starts_with implies strip_prefix succeeds");
        let root_handle = open_cast_directory(root)?;
        let parent_handle = open_cast_parent(root_handle, relative_parent)?;
        let name = CString::new(file_name.as_bytes())
            .with_context(|| format!("castPath contains NUL: {}", path.display()))?;
        let flags =
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW;
        // SAFETY: `parent_handle` is a retained directory descriptor and
        // `name` is a NUL-terminated single path component.  O_EXCL and
        // O_NOFOLLOW prevent following/replacing a pre-existing final link.
        let fd = unsafe { libc::openat(parent_handle.as_raw_fd(), name.as_ptr(), flags, 0o600) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error())
                .with_context(|| format!("open cast file {}", path.display()));
        }
        // SAFETY: `fd` is uniquely owned after a successful openat call.
        let file = unsafe { std::fs::File::from_raw_fd(fd) };
        let cleanup_parent = parent_handle
            .try_clone()
            .context("retain cast parent directory handle")?;
        let cleanup = CastFileCleanup::from_directory(path.clone(), cleanup_parent, name);
        return Ok(OpenedCastFile { file, cleanup });
    }

    bail!(
        "castPath '{}' is outside an allowed private directory",
        path.display(),
    )
}

#[cfg(unix)]
fn open_cast_directory(path: &Path) -> Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .with_context(|| format!("open cast directory {}", path.display()))
}

#[cfg(unix)]
fn open_cast_parent(mut parent: std::fs::File, relative: &Path) -> Result<std::fs::File> {
    for component in relative.components() {
        let std::path::Component::Normal(name) = component else {
            bail!("castPath parent contains a non-normal path component");
        };
        let name = CString::new(name.as_bytes()).context("castPath parent contains NUL")?;
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        // SAFETY: `parent` is a retained directory descriptor and `name` is
        // one normal component. O_NOFOLLOW prevents a swapped symlink.
        let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags, 0) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error())
                .with_context(|| format!("open cast parent component {}", name.to_string_lossy()));
        }
        // SAFETY: `fd` is uniquely owned after a successful openat call.
        parent = unsafe { std::fs::File::from_raw_fd(fd) };
    }
    Ok(parent)
}
#[cfg(windows)]
#[repr(C)]
struct NtUnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *mut u16,
}

#[cfg(windows)]
#[repr(C)]
struct NtObjectAttributes {
    length: u32,
    root_directory: RawHandle,
    object_name: *mut NtUnicodeString,
    attributes: u32,
    security_descriptor: *mut std::ffi::c_void,
    security_quality_of_service: *mut std::ffi::c_void,
}

#[cfg(windows)]
#[repr(C)]
struct NtIoStatusBlock {
    status: i32,
    information: usize,
}

#[cfg(windows)]
#[repr(C)]
struct FileAttributeTagInfo {
    file_attributes: u32,
    reparse_tag: u32,
}

#[cfg(windows)]
#[repr(C)]
struct FileDispositionInfo {
    delete_file: u8,
}

#[cfg(windows)]
const INVALID_HANDLE_VALUE: RawHandle = (-1isize) as RawHandle;
#[cfg(windows)]
const GENERIC_READ: u32 = 0x8000_0000;
#[cfg(windows)]
const GENERIC_WRITE: u32 = 0x4000_0000;
#[cfg(windows)]
const DELETE: u32 = 0x0001_0000;
#[cfg(windows)]
const SYNCHRONIZE: u32 = 0x0010_0000;
#[cfg(windows)]
const FILE_SHARE_READ: u32 = 0x0000_0001;
#[cfg(windows)]
const FILE_SHARE_WRITE: u32 = 0x0000_0002;
#[cfg(windows)]
const FILE_SHARE_DELETE: u32 = 0x0000_0004;
#[cfg(windows)]
const OPEN_EXISTING: u32 = 3;
#[cfg(windows)]
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
#[cfg(windows)]
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
#[cfg(windows)]
const FILE_ATTRIBUTE_NORMAL: u32 = 0x0000_0080;
#[cfg(windows)]
const FILE_DIRECTORY_FILE: u32 = 0x0000_0001;
#[cfg(windows)]
const FILE_NON_DIRECTORY_FILE: u32 = 0x0000_0040;
#[cfg(windows)]
const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x0000_0020;
#[cfg(windows)]
const NT_FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
#[cfg(windows)]
const NT_FILE_OPEN: u32 = 1;
#[cfg(windows)]
const NT_FILE_CREATE: u32 = 2;
#[cfg(windows)]
const OBJ_CASE_INSENSITIVE: u32 = 0x0000_0040;
#[cfg(windows)]
const FILE_ATTRIBUTE_TAG_INFO_CLASS: i32 = 9;
#[cfg(windows)]
const FILE_DISPOSITION_INFO_CLASS: i32 = 4;

#[cfg(windows)]
#[allow(non_snake_case)]
#[link(name = "kernel32")]
extern "system" {
    fn CreateFileW(
        file_name: *const u16,
        desired_access: u32,
        share_mode: u32,
        security_attributes: *mut std::ffi::c_void,
        creation_disposition: u32,
        flags_and_attributes: u32,
        template_file: RawHandle,
    ) -> RawHandle;
    fn GetFileInformationByHandleEx(
        file: RawHandle,
        file_information_class: i32,
        file_information: *mut std::ffi::c_void,
        buffer_size: u32,
    ) -> i32;
    fn SetFileInformationByHandle(
        file: RawHandle,
        file_information_class: i32,
        file_information: *mut std::ffi::c_void,
        buffer_size: u32,
    ) -> i32;
}

#[cfg(windows)]
#[allow(non_snake_case)]
#[link(name = "ntdll")]
extern "system" {
    fn NtCreateFile(
        file_handle: *mut RawHandle,
        desired_access: u32,
        object_attributes: *mut NtObjectAttributes,
        io_status_block: *mut NtIoStatusBlock,
        allocation_size: *mut i64,
        file_attributes: u32,
        share_access: u32,
        create_disposition: u32,
        create_options: u32,
        ea_buffer: *mut std::ffi::c_void,
        ea_length: u32,
    ) -> i32;
}

#[cfg(windows)]
fn windows_wide(value: &std::ffi::OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn windows_is_reparse(file: &std::fs::File) -> Result<bool> {
    let mut info = FileAttributeTagInfo {
        file_attributes: 0,
        reparse_tag: 0,
    };
    // SAFETY: the handle is borrowed from a live File and the output buffer
    // is an owned, correctly-sized FILE_ATTRIBUTE_TAG_INFO value.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FILE_ATTRIBUTE_TAG_INFO_CLASS,
            (&mut info as *mut FileAttributeTagInfo).cast(),
            std::mem::size_of::<FileAttributeTagInfo>() as u32,
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error())
            .context("inspect cast directory reparse attributes");
    }
    Ok(info.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0)
}

#[cfg(windows)]
fn windows_open_root(path: &Path) -> Result<std::fs::File> {
    let wide = windows_wide(path.as_os_str());
    // SAFETY: the UTF-16 path is NUL-terminated and remains alive for the
    // duration of this synchronous CreateFileW call.
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ | SYNCHRONIZE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null_mut(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error())
            .with_context(|| format!("open cast directory {}", path.display()));
    }
    // SAFETY: the successful CreateFileW call transfers ownership of handle.
    let root = unsafe { std::fs::File::from_raw_handle(handle) };
    if windows_is_reparse(&root)? {
        bail!("cast root is a reparse point: {}", path.display());
    }
    Ok(root)
}

#[cfg(windows)]
fn windows_open_relative(
    parent: &std::fs::File,
    name: &std::ffi::OsStr,
    desired_access: u32,
    file_attributes: u32,
    create_disposition: u32,
    create_options: u32,
) -> Result<std::fs::File> {
    let mut wide = windows_wide(name);
    let byte_length = wide
        .len()
        .saturating_sub(1)
        .checked_mul(2)
        .and_then(|value| u16::try_from(value).ok())
        .context("cast path component is too long")?;
    let mut unicode = NtUnicodeString {
        length: byte_length,
        maximum_length: byte_length,
        buffer: wide.as_mut_ptr(),
    };
    let mut attributes = NtObjectAttributes {
        length: std::mem::size_of::<NtObjectAttributes>() as u32,
        root_directory: parent.as_raw_handle(),
        object_name: &mut unicode,
        attributes: OBJ_CASE_INSENSITIVE,
        security_descriptor: std::ptr::null_mut(),
        security_quality_of_service: std::ptr::null_mut(),
    };
    let mut io_status = NtIoStatusBlock {
        status: 0,
        information: 0,
    };
    let mut handle = std::ptr::null_mut();
    // SAFETY: all pointers reference owned, live values for this synchronous
    // NtCreateFile call; the parent handle remains borrowed.
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            desired_access,
            &mut attributes,
            &mut io_status,
            std::ptr::null_mut(),
            file_attributes,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            create_disposition,
            create_options,
            std::ptr::null_mut(),
            0,
        )
    };
    if status < 0 || handle.is_null() || handle == INVALID_HANDLE_VALUE {
        bail!("NtCreateFile failed for cast path component (status 0x{status:08x})");
    }
    // SAFETY: the successful NtCreateFile call transfers ownership of handle.
    Ok(unsafe { std::fs::File::from_raw_handle(handle) })
}

#[cfg(windows)]
fn windows_open_parent(mut parent: std::fs::File, relative: &Path) -> Result<std::fs::File> {
    for component in relative.components() {
        let std::path::Component::Normal(name) = component else {
            bail!("castPath parent contains a non-normal path component");
        };
        let next = windows_open_relative(
            &parent,
            name,
            GENERIC_READ | SYNCHRONIZE,
            0,
            NT_FILE_OPEN,
            FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | NT_FILE_OPEN_REPARSE_POINT,
        )?;
        if windows_is_reparse(&next)? {
            bail!("castPath parent contains a reparse point");
        }
        parent = next;
    }
    Ok(parent)
}

#[cfg(windows)]
fn windows_mark_delete(file: &std::fs::File) -> std::io::Result<()> {
    let mut disposition = FileDispositionInfo { delete_file: 1 };
    // SAFETY: the handle is borrowed from a live File and the disposition
    // buffer is an owned value with the exact Win32 ABI layout.
    let ok = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FILE_DISPOSITION_INFO_CLASS,
            (&mut disposition as *mut FileDispositionInfo).cast(),
            std::mem::size_of::<FileDispositionInfo>() as u32,
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

// Win32's high-level path APIs cannot keep each validated directory component
// pinned. Use retained handles and NtCreateFile relative opens instead.
#[cfg(windows)]
fn open_cast_file(path: &PathBuf) -> Result<OpenedCastFile> {
    let temp_base = std::env::temp_dir()
        .canonicalize()
        .context("canonicalize system temporary directory")?;
    let state_base = state_dir("repl-casts")?
        .canonicalize()
        .context("canonicalize private REPL cast directory")?;
    let absolute = if path.is_absolute() {
        path.clone()
    } else {
        std::env::current_dir()
            .context("resolve relative castPath")?
            .join(path)
    };
    let parent = absolute
        .parent()
        .context("castPath has no parent directory")?;
    let file_name = absolute.file_name().context("castPath has no file name")?;

    for root in [&temp_base, &state_base] {
        if !parent.starts_with(root) {
            continue;
        }
        let relative_parent = parent
            .strip_prefix(root)
            .expect("starts_with implies strip_prefix succeeds");
        let root_handle = windows_open_root(root)?;
        let parent_handle = windows_open_parent(root_handle, relative_parent)?;
        let file = windows_open_relative(
            &parent_handle,
            file_name,
            GENERIC_WRITE | DELETE | SYNCHRONIZE,
            FILE_ATTRIBUTE_NORMAL,
            NT_FILE_CREATE,
            FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | NT_FILE_OPEN_REPARSE_POINT,
        )?;
        let cleanup_file = match file.try_clone() {
            Ok(file) => file,
            Err(error) => {
                let _ = windows_mark_delete(&file);
                return Err(error).context("retain cast file cleanup handle");
            }
        };
        let cleanup = CastFileCleanup::from_windows_file(path.clone(), cleanup_file);
        return Ok(OpenedCastFile { file, cleanup });
    }

    bail!(
        "castPath '{}' is outside an allowed private directory",
        path.display(),
    )
}

#[cfg(all(not(unix), not(windows)))]
fn open_cast_file(path: &PathBuf) -> Result<OpenedCastFile> {
    let temp_base = {
        let temp = std::env::temp_dir();
        temp.canonicalize().unwrap_or(temp)
    };
    let state_base = state_dir("repl-casts")?
        .canonicalize()
        .context("canonicalize private REPL cast directory")?;
    let parent = path.parent().unwrap_or(path);
    let canonical_parent = parent
        .canonicalize()
        .with_context(|| format!("canonicalize parent of {}", path.display()))?;

    if !canonical_parent.starts_with(&temp_base) && !canonical_parent.starts_with(&state_base) {
        bail!(
            "castPath '{}' is outside an allowed private directory",
            path.display(),
        );
    }

    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("open cast file {}", path.display()))?;
    Ok(OpenedCastFile {
        file,
        cleanup: CastFileCleanup::new(path.clone()),
    })
}

struct CastFileCleanup {
    path: PathBuf,
    #[cfg(unix)]
    parent: Option<std::fs::File>,
    #[cfg(unix)]
    name: Option<CString>,
    #[cfg(windows)]
    delete_handle: Option<std::fs::File>,
    armed: bool,
}

impl CastFileCleanup {
    #[cfg(unix)]
    fn from_directory(path: PathBuf, parent: std::fs::File, name: CString) -> Self {
        Self {
            path,
            parent: Some(parent),
            name: Some(name),
            armed: true,
        }
    }
    #[cfg(windows)]
    fn from_windows_file(path: PathBuf, delete_handle: std::fs::File) -> Self {
        Self {
            path,
            delete_handle: Some(delete_handle),
            armed: true,
        }
    }

    #[cfg(all(not(unix), not(windows)))]
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    #[cfg(test)]
    fn disarm(&mut self) {
        self.armed = false;
    }

    fn remove_now(&mut self) {
        if !self.armed {
            return;
        }
        #[cfg(unix)]
        if let (Some(parent), Some(name)) = (&self.parent, &self.name) {
            // SAFETY: `parent` is a retained directory descriptor and `name`
            // is the exclusively-created basename, so no swapped parent
            // component can redirect this unlink.
            unsafe {
                let _ = libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0);
            }
        } else {
            let _ = std::fs::remove_file(&self.path);
        }
        #[cfg(windows)]
        if let Some(file) = &self.delete_handle {
            let _ = windows_mark_delete(file);
        }
        #[cfg(all(not(unix), not(windows)))]
        let _ = std::fs::remove_file(&self.path);
        self.armed = false;
    }
}

impl Drop for CastFileCleanup {
    fn drop(&mut self) {
        self.remove_now();
    }
}

type SpawnChild = Box<dyn portable_pty::Child + Send + Sync>;

struct SpawnChildGuard {
    child: Option<SpawnChild>,
    #[cfg(unix)]
    process_group_leader: Option<i32>,
    #[cfg(unix)]
    process_group_member: Option<TrackedProcess>,
    #[cfg(unix)]
    process_group_descendants: Vec<TrackedProcess>,
}

impl SpawnChildGuard {
    #[cfg(unix)]
    fn new(
        child: SpawnChild,
        process_group_leader: Option<i32>,
        process_group_member: Option<TrackedProcess>,
        process_group_descendants: Vec<TrackedProcess>,
    ) -> Self {
        Self {
            child: Some(child),
            process_group_leader,
            process_group_member,
            process_group_descendants,
        }
    }

    #[cfg(not(unix))]
    fn new(child: SpawnChild) -> Self {
        Self { child: Some(child) }
    }

    fn take(&mut self) -> SpawnChild {
        self.child
            .take()
            .expect("spawn child guard already consumed")
    }
}

impl Drop for SpawnChildGuard {
    fn drop(&mut self) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        #[cfg(unix)]
        if let Some(group) = self
            .process_group_leader
            .and_then(|value| u32::try_from(value).ok())
        {
            let members = self
                .process_group_member
                .into_iter()
                .chain(self.process_group_descendants.iter().copied());
            signal_process_group(group, members, libc::SIGTERM);
        }
        let _ = child.kill();
        let _ = child.wait();
        #[cfg(unix)]
        if let Some(group) = self
            .process_group_leader
            .and_then(|value| u32::try_from(value).ok())
        {
            let members = self
                .process_group_member
                .into_iter()
                .chain(self.process_group_descendants.iter().copied());
            signal_process_group(group, members, libc::SIGKILL);
        }
    }
}

#[cfg(unix)]
fn configure_nonblocking_pty(master: &dyn MasterPty) -> bool {
    let Some(fd) = master.as_raw_fd() else {
        return false;
    };
    // SAFETY: `fd` is borrowed from the live PTY master and remains valid
    // until the caller drops that master.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return false;
    }
    // SAFETY: this only changes the status flags of the PTY master descriptor.
    unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) == 0 }
}

// ---------------------------------------------------------------------------
// Spawn options / PtySession
// ---------------------------------------------------------------------------

pub struct SpawnOptions<'a> {
    pub id: String,
    pub cmd: &'a str,
    /// Child working directory. Relative paths resolve from the supervisor's
    /// current directory; `None` inherits that directory.
    pub cwd: Option<&'a str>,
    pub env: &'a [(String, String)],
    pub cols: u16,
    pub rows: u16,
    /// When true, run `cmd` through `/bin/sh -c` so shell syntax (env-var
    /// prefixes, redirections, pipes, globs) is honoured. When false (default),
    /// `cmd` is argv-split and exec'd directly — no shell, no injection surface.
    pub shell: bool,
    /// When `Some`, tee redacted PTY output to this path as asciicast v2.
    pub cast_path: Option<PathBuf>,
}

pub struct PtySession {
    pub id: String,
    pub cmd: String,
    state: Arc<Mutex<SessionState>>,
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    reader_cancelled: Arc<AtomicBool>,
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    process_id: Option<u32>,
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    descendant_pids: Vec<TrackedProcess>,
    #[cfg(unix)]
    process_group_leader: Option<i32>,
    #[cfg(unix)]
    process_group_member: Option<TrackedProcess>,
    terminated: bool,
    /// Opened `.cast` file cleanup handle, if recording is active.
    cast_cleanup: Option<CastFileCleanup>,
}

fn resolve_working_directory(cwd: Option<&str>) -> Result<PathBuf> {
    let working_dir = match cwd {
        Some(cwd) => {
            let path = PathBuf::from(cwd);
            if path.is_absolute() {
                path
            } else {
                std::env::current_dir()?.join(path)
            }
        }
        None => std::env::current_dir()?,
    };
    let metadata = std::fs::metadata(&working_dir).map_err(|error| {
        anyhow!(
            "cwd is not a directory: {} ({error})",
            working_dir.display()
        )
    })?;
    if !metadata.is_dir() {
        bail!("cwd is not a directory: {}", working_dir.display());
    }
    Ok(working_dir)
}

fn resolve_program(program: String, working_dir: &Path) -> PathBuf {
    let path = PathBuf::from(program);
    let mut components = path.components();
    let is_bare_name = matches!(components.next(), Some(std::path::Component::Normal(_)))
        && components.next().is_none();
    if is_bare_name {
        path
    } else {
        working_dir.join(path)
    }
}

impl PtySession {
    pub fn spawn(opts: SpawnOptions<'_>) -> Result<Self> {
        Self::spawn_inner(opts, Arc::new(AtomicBool::new(false)), None)
    }

    /// Spawn a session whose reader reports its natural exit to the supervisor.
    ///
    /// The generation flag is set by the reader before it acquires the state
    /// mutex. This ordering lets a fast-exiting process race safely with the
    /// supervisor's insertion of the newly-created handle.
    pub(crate) fn spawn_with_lifecycle(
        opts: SpawnOptions<'_>,
        generation_exited: Arc<AtomicBool>,
        on_exit: Option<ExitCallback>,
    ) -> Result<Self> {
        Self::spawn_inner(opts, generation_exited, on_exit)
    }

    fn spawn_inner(
        opts: SpawnOptions<'_>,
        generation_exited: Arc<AtomicBool>,
        on_exit: Option<ExitCallback>,
    ) -> Result<Self> {
        let working_dir = resolve_working_directory(opts.cwd)?;
        // Validate cast_path BEFORE opening any PTY (fail fast, no side effects).
        let mut cast_file_cleanup = None;
        let cast_file_opt: Option<(PathBuf, std::fs::File)> = if let Some(p) = &opts.cast_path {
            let opened = open_cast_file(p)?;
            cast_file_cleanup = Some(opened.cleanup);
            Some((p.clone(), opened.file))
        } else {
            None
        };

        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: opts.rows,
                cols: opts.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("openpty failed")?;

        let (program, args) = if opts.shell {
            (
                "/bin/sh".to_string(),
                vec!["-c".to_string(), opts.cmd.to_string()],
            )
        } else {
            if let Some(meta) = detect_shell_syntax(opts.cmd) {
                bail!(
                    "cmd contains shell syntax ({meta}) but repl_spawn execs \
                     directly without a shell. Pass shell:true to run it via \
                     /bin/sh -c, or pass environment via the env param."
                );
            }
            parse_cmd(opts.cmd)?
        };
        let program = resolve_program(program, &working_dir);
        let mut builder = CommandBuilder::new(program);
        for a in args {
            builder.arg(a);
        }
        builder.cwd(&working_dir);
        builder.env_clear();
        builder.env("TERM", "xterm-256color");
        builder.env("FORCE_COLOR", "1");
        for (k, v) in opts.env {
            builder.env(k, v);
        }

        let child = {
            let _spawn_guard = PTY_SPAWN_LOCK
                .lock()
                .map_err(|_| anyhow!("PTY spawn lock poisoned"))?;

            pair.slave
                .spawn_command(builder)
                .context("spawn_command failed")?
        };
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        let process_id = child.process_id();
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        let mut descendant_pids = Vec::new();
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        if let Some(pid) = process_id {
            append_process_descendants(pid, &mut descendant_pids);
        }

        // portable-pty's Unix backend establishes a fresh session with
        // setsid() in its pre-exec hook. Capture the foreground process group
        // while the master is still alive so teardown can also terminate
        // descendants that inherited the PTY.
        #[cfg(unix)]
        let process_group_leader = pair.master.process_group_leader().map(|pid| pid as i32);
        #[cfg(unix)]
        let process_group_member = process_group_leader
            .and_then(|pid| u32::try_from(pid).ok())
            .and_then(track_process);
        #[cfg(unix)]
        let process_group_descendants = {
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            {
                descendant_pids.clone()
            }
            #[cfg(not(any(target_os = "linux", target_os = "macos")))]
            {
                Vec::new()
            }
        };
        #[cfg(unix)]
        let mut child_guard = SpawnChildGuard::new(
            child,
            process_group_leader,
            process_group_member,
            process_group_descendants,
        );
        #[cfg(not(unix))]
        let mut child_guard = SpawnChildGuard::new(child);

        let mut reader = pair
            .master
            .try_clone_reader()
            .context("try_clone_reader failed")?;
        #[cfg(unix)]
        let reader_nonblocking = configure_nonblocking_pty(pair.master.as_ref());
        #[cfg(not(unix))]
        let reader_nonblocking = false;
        let reader_cancelled = Arc::new(AtomicBool::new(false));
        let reader_cancelled_for_reader = Arc::clone(&reader_cancelled);
        let cast_file_cleanup_for_session = cast_file_cleanup;
        let writer = pair.master.take_writer().context("take_writer failed")?;

        let state = Arc::new(Mutex::new(SessionState::new(opts.cols, opts.rows)));

        // Reader thread — owns the PTY reader for the lifetime of the session.
        let reader_state = Arc::clone(&state);
        let generation_exited_for_reader = Arc::clone(&generation_exited);
        let cols = opts.cols;
        let rows = opts.rows;
        thread::Builder::new()
            .name(format!("repl-reader-{}", opts.id))
            .spawn(move || {
                // Set up local BufWriter for asciicast — OUTSIDE the mutex.
                let spawn_instant = Instant::now();
                let mut cast_writer: Option<BufWriter<std::fs::File>> =
                    cast_file_opt.map(|(_, f)| {
                        let mut bw = BufWriter::new(f);
                        // Write header immediately. Ignore errors — we do
                        // best-effort and never panic the reader thread.
                        let _ = write_cast_header(&mut bw, cols, rows);
                        let _ = bw.flush();
                        bw
                    });
                let mut cast_redactor = CastRedactor::default();

                let mut buf = [0u8; 4096];
                loop {
                    if reader_cancelled_for_reader.load(Ordering::Acquire) {
                        break;
                    }
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let raw_bytes = &buf[..n];
                            let chunk_str = String::from_utf8_lossy(raw_bytes);

                            // Step 1: normalize terminal controls and stream
                            // redaction OUTSIDE the mutex for external output.
                            let redacted = cast_redactor.push(chunk_str.as_ref());

                            // Step 2: write to asciicast OUTSIDE mutex.
                            if let Some(cw) = &mut cast_writer {
                                if !redacted.is_empty() {
                                    let elapsed = spawn_instant.elapsed().as_secs_f64();
                                    let _ = write_cast_event(cw, elapsed, &redacted);
                                }
                                // Don't flush every chunk — BufWriter batches.
                            }

                            // Step 3: let the emulator apply the original
                            // control stream; only sanitized screen projections
                            // leave SessionState.
                            let mut s = reader_state.lock().expect("session state poisoned");

                            // 3a. Preserve cursor, erase, and alternate-screen
                            // semantics by processing the unmodified PTY bytes.
                            s.vt.process(raw_bytes);

                            // 3b. Capture a complete, redacted frame.
                            let grid = s.vt.screen().contents();
                            s.push_filmstrip(FilmstripFrame {
                                captured_at: SystemTime::now(),
                                grid,
                            });

                            // 3c. Append streaming-redacted bytes to raw.
                            s.append_redacted_raw(&redacted);

                            // 3d. Update status / activity.
                            s.last_activity = Instant::now();
                            if s.status == SessionStatus::Starting {
                                s.status = SessionStatus::Ready;
                            }
                        }
                        Err(error)
                            if reader_nonblocking && error.kind() == io::ErrorKind::WouldBlock =>
                        {
                            if reader_cancelled_for_reader.load(Ordering::Acquire) {
                                break;
                            }
                            thread::sleep(Duration::from_millis(10));
                        }
                        Err(_) => break,
                    }
                }

                // EOF — flush terminal-control and credential suffixes to
                // raw state and asciicast. The VT parser already saw raw bytes.
                let trailing_redacted = cast_redactor.finish();
                if let Some(cw) = &mut cast_writer {
                    if !trailing_redacted.is_empty() {
                        let elapsed = spawn_instant.elapsed().as_secs_f64();
                        let _ = write_cast_event(cw, elapsed, &trailing_redacted);
                    }
                    let _ = cw.flush();
                }
                if !trailing_redacted.is_empty() {
                    let mut s = reader_state.lock().expect("session state poisoned");
                    s.append_redacted_raw(&trailing_redacted);
                }

                // Mark the generation before taking the state lock. The
                // supervisor can therefore detect a fast exit even when this
                // reader reaches EOF before spawn() inserts its handle.
                generation_exited_for_reader.store(true, Ordering::Release);

                {
                    let mut s = reader_state.lock().expect("session state poisoned");
                    s.status = SessionStatus::Dead;
                }

                // The callback only upgrades a Weak supervisor reference and
                // removes a matching generation. It never owns the session
                // lock, avoiding lock inversion with kill/expect.
                if let Some(callback) = on_exit {
                    callback();
                }
            })
            .context("spawn reader thread failed")?;

        let session = Self {
            id: opts.id,
            cmd: opts.cmd.into(),
            state,
            writer,
            master: pair.master,
            child: child_guard.take(),
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            process_id,
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            descendant_pids,
            reader_cancelled,
            #[cfg(unix)]
            process_group_leader,
            #[cfg(unix)]
            process_group_member,
            terminated: false,
            cast_cleanup: cast_file_cleanup_for_session,
        };
        Ok(session)
    }

    /// Clone of the shared session state. Lets the supervisor read
    /// status/screen/exit without taking the (exclusive) PtySession lock — so
    /// `list`/`snapshot` never block on a session that is mid-`expect`.
    pub fn state(&self) -> Arc<Mutex<SessionState>> {
        Arc::clone(&self.state)
    }

    pub fn status(&self) -> SessionStatus {
        self.state.lock().expect("session state poisoned").status
    }

    pub fn write_bytes(&mut self, data: &[u8]) -> Result<()> {
        {
            let mut s = self.state.lock().expect("session state poisoned");
            s.status = SessionStatus::Busy;
        }
        if let Err(error) = write_all_with_retry(&mut self.writer, data) {
            // A partial write leaves the command line ambiguous. Tear down the
            // session rather than inviting a retry that may duplicate input.
            self.terminate();
            self.state.lock().expect("session state poisoned").status = SessionStatus::Dead;
            return Err(error).context("pty write failed");
        }
        self.writer.flush().ok();
        Ok(())
    }

    pub fn write_line(&mut self, line: &str) -> Result<()> {
        let mut payload = line.as_bytes().to_vec();
        payload.push(b'\r');
        self.write_bytes(&payload)
    }

    /// Block until the cascade fires or `rules.timeout` elapses.
    pub fn wait_ready(&mut self, rules: &ExpectRules) -> Result<ExpectOutcome> {
        let started = Instant::now();
        loop {
            if let Some(status) = self.try_wait_child() {
                let mut s = self.state.lock().expect("session state poisoned");
                s.status = SessionStatus::Dead;
                s.exit_code = status;
                return Ok(ExpectOutcome::Exited(status));
            }
            let snapshot_text;
            let idle_for;
            {
                let s = self.state.lock().expect("session state poisoned");
                snapshot_text = s.screen_text();
                idle_for = s.last_activity.elapsed();
            }
            if rules.prompt_matches(&snapshot_text) {
                let mut s = self.state.lock().expect("session state poisoned");
                s.status = SessionStatus::Ready;
                return Ok(ExpectOutcome::PromptMatched);
            }

            if rules.prompt.is_none() && idle_for >= rules.idle {
                let mut s = self.state.lock().expect("session state poisoned");
                s.status = SessionStatus::Ready;
                return Ok(ExpectOutcome::Idle);
            }
            if started.elapsed() >= rules.timeout {
                return Ok(ExpectOutcome::TimedOut);
            }
            thread::sleep(Duration::from_millis(25));
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn track_descendants(&mut self) {
        if let Some(pid) = self.process_id {
            append_process_descendants(pid, &mut self.descendant_pids);
        }
    }

    fn try_wait_child(&mut self) -> Option<Option<i32>> {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        self.track_descendants();
        match self.child.try_wait() {
            Ok(Some(status)) => Some(status.exit_code().try_into().ok()),
            _ => None,
        }
    }

    pub fn snapshot_text(&self) -> String {
        self.state
            .lock()
            .expect("session state poisoned")
            .screen_text()
    }

    pub fn snapshot_tail(&self, max_lines: usize) -> String {
        let full = self.snapshot_text();
        let lines: Vec<&str> = full.lines().collect();
        let start = lines.len().saturating_sub(max_lines);
        lines[start..].join("\n")
    }

    pub fn raw_buffer(&self) -> String {
        self.state
            .lock()
            .expect("session state poisoned")
            .raw
            .clone()
    }

    #[cfg(unix)]
    fn signal_owned_group(&self, signal: libc::c_int) {
        let Some(group) = self
            .process_group_leader
            .and_then(|value| u32::try_from(value).ok())
        else {
            return;
        };
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        let members = self
            .process_group_member
            .into_iter()
            .chain(self.descendant_pids.iter().copied());
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        let members = self.process_group_member.into_iter();
        signal_process_group(group, members, signal);
    }

    pub fn kill(&mut self) -> Result<()> {
        self.terminate();
        {
            let mut s = self.state.lock().expect("session state poisoned");
            s.status = SessionStatus::Dead;
        }
        if let Some(cleanup) = &mut self.cast_cleanup {
            cleanup.remove_now();
        }
        Ok(())
    }

    fn terminate(&mut self) {
        if self.terminated {
            return;
        }
        self.terminated = true;
        self.reader_cancelled.store(true, Ordering::Release);
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        self.track_descendants();
        #[cfg(unix)]
        self.signal_owned_group(libc::SIGTERM);
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        for process in self.descendant_pids.iter().rev().copied() {
            signal_process(process, libc::SIGTERM);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        #[cfg(unix)]
        self.signal_owned_group(libc::SIGKILL);
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        for process in self.descendant_pids.iter().rev().copied() {
            signal_process(process, libc::SIGKILL);
        }
    }

    pub fn exit_code(&self) -> Option<i32> {
        self.state.lock().expect("session state poisoned").exit_code
    }

    /// Resize the PTY master then update vt100 and SessionState.
    /// Order is STRICT: PTY first, then vt100/state under lock.
    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        // Step 1: resize the PTY master FIRST.
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("pty resize failed")?;

        // Step 2: update vt100 parser and SessionState under lock.
        let mut s = self.state.lock().expect("session state poisoned");
        s.vt.set_size(rows, cols);
        s.cols = cols;
        s.rows = rows;

        Ok(())
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        self.terminate();
        if let Some(cleanup) = &mut self.cast_cleanup {
            cleanup.remove_now();
        }
    }
}

/// Detect shell syntax that direct exec (no shell) cannot honour, so spawn can
/// fail with guidance instead of producing a silently-dead session.
fn detect_shell_syntax(cmd: &str) -> Option<String> {
    let trimmed = cmd.trim_start();
    if let Some(eq) = trimmed.find('=') {
        let name = &trimmed[..eq];
        let is_ident = !name.is_empty()
            && name
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if is_ident {
            return Some(format!("env-assignment prefix `{name}=`"));
        }
    }
    let mut in_single = false;
    let mut in_double = false;
    let mut escape = false;
    let mut chars = cmd.chars().peekable();
    while let Some(ch) = chars.next() {
        if escape {
            escape = false;
            continue;
        }
        match ch {
            '\\' if !in_single => escape = true,
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            '|' | ';' | '<' | '>' | '`' if !in_single && !in_double => {
                return Some(format!("`{ch}`"));
            }
            '&' if !in_single && !in_double && chars.peek() == Some(&'&') => {
                return Some("`&&`".to_string());
            }
            '$' if !in_single && !in_double && chars.peek() == Some(&'(') => {
                return Some("`$(`".to_string());
            }
            _ => {}
        }
    }
    None
}

fn parse_cmd(cmd: &str) -> Result<(String, Vec<String>)> {
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut escape = false;
    for ch in cmd.chars() {
        if escape {
            current.push(ch);
            escape = false;
            continue;
        }
        match ch {
            '\\' if !in_single => escape = true,
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            c if c.is_whitespace() && !in_single && !in_double => {
                if !current.is_empty() {
                    parts.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if in_single || in_double {
        return Err(anyhow!("unterminated quote in cmd: {cmd}"));
    }
    if !current.is_empty() {
        parts.push(current);
    }
    let mut iter = parts.into_iter();
    let program = iter.next().ok_or_else(|| anyhow!("empty cmd"))?;
    Ok((program, iter.collect()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct IntermittentWriter {
        blocked: bool,
        output: Vec<u8>,
    }

    impl Write for IntermittentWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            if !self.blocked {
                self.blocked = true;
                return Err(io::ErrorKind::WouldBlock.into());
            }
            self.output.extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn pty_write_retries_when_nonblocking_master_is_temporarily_full() {
        let mut writer = IntermittentWriter::default();
        write_all_with_retry(&mut writer, b"command input").unwrap();
        assert_eq!(writer.output, b"command input");
    }
    #[test]
    fn terminal_normalizer_removes_split_csi_and_osc_controls() {
        let mut normalizer = TerminalNormalizer::default();
        let mut normalized = normalizer.push("prefix AK\u{1b}[3");
        normalized.push_str(&normalizer.push("1mIA\u{1b}]0;hidden\u{07}IOSFODNN7EXAMPLE\n"));
        normalized.push_str(&normalizer.finish());
        assert_eq!(normalized, "prefix AKIAIOSFODNN7EXAMPLE\n");
    }

    #[test]
    fn terminal_normalizer_removes_unicode_directional_controls() {
        let mut normalizer = TerminalNormalizer::default();
        let output =
            normalizer.push("left\u{061c}\u{200e}\u{200f}\u{202e}right\u{2066}isolated\u{2069}");

        assert_eq!(output, "leftrightisolated");
    }

    #[test]
    fn parses_simple_cmd() {
        let (p, a) = parse_cmd("python3 -i").unwrap();
        assert_eq!(p, "python3");
        assert_eq!(a, vec!["-i"]);
    }

    #[test]
    fn parses_quoted_arg() {
        let (p, a) = parse_cmd(r#"bash -c "echo hi""#).unwrap();
        assert_eq!(p, "bash");
        assert_eq!(a, vec!["-c", "echo hi"]);
    }

    #[test]
    fn rejects_unterminated_quote() {
        assert!(parse_cmd(r#"bash -c "echo"#).is_err());
    }

    #[test]
    fn rejects_empty_cmd() {
        assert!(parse_cmd("   ").is_err());
    }

    #[test]
    fn detects_env_assignment_prefix() {
        assert!(detect_shell_syntax("JAVA_HOME=/x ANDROID_HOME=/y gradlew").is_some());
        assert!(detect_shell_syntax("FOO=bar").is_some());
    }

    #[test]
    fn detects_redirection_and_pipe() {
        assert!(detect_shell_syntax("gradlew installDebug 2>&1").is_some());
        assert!(detect_shell_syntax("cat foo | grep bar").is_some());
        assert!(detect_shell_syntax("echo hi > out.txt").is_some());
        assert!(detect_shell_syntax("a && b").is_some());
        assert!(detect_shell_syntax("a; b").is_some());
        assert!(detect_shell_syntax("echo $(date)").is_some());
        assert!(detect_shell_syntax("echo `date`").is_some());
    }

    #[test]
    fn ignores_quoted_metacharacters() {
        assert!(detect_shell_syntax(r#"psql "postgres://h/db?a=1&b=2""#).is_none());
        assert!(detect_shell_syntax(r#"python -c "print(1)""#).is_none());
        assert!(detect_shell_syntax("gradlew --foo=bar").is_none());
        assert!(detect_shell_syntax("python3 -i").is_none());
        assert!(detect_shell_syntax("bash --norc --noprofile").is_none());
    }

    #[test]
    fn shell_mode_runs_via_sh_and_honours_redirection() {
        let opts = SpawnOptions {
            id: "sh1".into(),
            cmd: "echo hello 2>&1",
            cwd: None,
            env: &[("PATH".into(), "/usr/bin:/bin".into())],
            cols: 80,
            rows: 24,
            shell: true,
            cast_path: None,
        };
        let mut s = PtySession::spawn(opts).expect("shell spawn failed");
        let rules = ExpectRules::new(None, 100, 2_000);
        let _ = s.wait_ready(&rules);
        std::thread::sleep(Duration::from_millis(150));
        assert!(
            s.snapshot_text().contains("hello"),
            "screen: {}",
            s.snapshot_text()
        );
        let _ = s.kill();
    }

    #[cfg(unix)]
    #[test]
    fn redacts_credentials_from_grid_raw_history_and_cast() {
        const SECRET: &str = "AKIAIOSFODNN7EXAMPLE";
        const GITHUB_SECRET: &str =
            "github_pat_11AAAAAA00000000000000_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
        const OPENAI_SECRET: &str = "sk-proj-1234567890-abcdefghijklmnop-qrstuvwxyz";
        let temp = tempfile::tempdir().unwrap();
        let cast_path = temp.path().join("redacted.cast");
        let opts = SpawnOptions {
            id: "redaction_surfaces".into(),
            cmd: "printf 'token AK\\033[31mIAIOSFODNN7EXAMPLE\\033]0;OSC-title\\007 github_pat_11AAAAAA00000000000000_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB sk-proj-1234567890-abcdefghijklmnop-qrstuvwxyz\\n'",
            cwd: None,
            env: &[("PATH".into(), "/usr/bin:/bin".into())],
            cols: 80,
            rows: 24,
            shell: true,
            cast_path: Some(cast_path.clone()),
        };
        let mut session = PtySession::spawn(opts).expect("redaction session spawn failed");
        let _ = session.wait_ready(&ExpectRules::new(None, 100, 2_000));
        std::thread::sleep(Duration::from_millis(150));

        let screen = session.snapshot_text();
        let raw = session.raw_buffer();
        let state = session.state();
        let state = state.lock().expect("session state poisoned");
        for secret in [SECRET, GITHUB_SECRET, OPENAI_SECRET] {
            assert!(!screen.contains(secret), "grid leaked credential: {secret}");
            assert!(!raw.contains(secret), "raw leaked credential: {secret}");
        }
        assert!(
            !raw.contains('\u{1b}'),
            "raw retained ANSI controls: {raw:?}"
        );
        for secret in [SECRET, GITHUB_SECRET, OPENAI_SECRET] {
            assert!(
                state
                    .filmstrip
                    .iter()
                    .all(|frame| !frame.grid.contains(secret)),
                "filmstrip leaked credential: {secret}"
            );
        }
        drop(state);
        let cast = std::fs::read_to_string(&cast_path).expect("cast output missing");
        for secret in [SECRET, GITHUB_SECRET, OPENAI_SECRET] {
            assert!(!cast.contains(secret), "cast leaked credential: {secret}");
        }
        assert!(
            !cast.contains('\u{1b}'),
            "cast retained ANSI controls: {cast:?}"
        );
        session.kill().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn terminal_controls_preserve_clear_and_cursor_screen_behavior() {
        let opts = SpawnOptions {
            id: "terminal_controls".into(),
            cmd: "printf 'stale\\033[2Jfresh\\033[2;1Hbottom'; sleep 5",
            cwd: None,
            env: &[("PATH".into(), "/usr/bin:/bin".into())],
            cols: 80,
            rows: 24,
            shell: true,
            cast_path: None,
        };
        let mut session = PtySession::spawn(opts).expect("terminal-control session spawn failed");
        let _ = session.wait_ready(&ExpectRules::new(None, 100, 2_000));
        std::thread::sleep(Duration::from_millis(150));

        let screen = session.snapshot_text();
        assert!(screen.contains("fresh"), "screen: {screen}");
        assert!(screen.contains("bottom"), "screen: {screen}");
        assert!(!screen.contains("stale"), "screen: {screen}");
        session.kill().unwrap();
    }

    #[test]
    fn wrapped_credentials_are_redacted_from_screen_and_filmstrip() {
        let secret = "ASIAIOSFODNN7EXAMPLE";
        let mut state = SessionState::new(12, 6);
        state.vt.process(secret.as_bytes());

        assert_eq!(state.screen_text(), "[REDACTED]");

        let grid = state.vt.screen().contents();
        state.push_filmstrip(FilmstripFrame {
            captured_at: SystemTime::now(),
            grid,
        });
        assert_eq!(state.filmstrip[0].grid, "[REDACTED]");
        assert!(!state.filmstrip[0].grid.contains(&secret));
    }

    #[test]
    fn project_and_fine_grained_tokens_are_redacted_from_grid_and_filmstrip() {
        for secret in [
            "github_pat_11AAAAAA00000000000000_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
            "sk-proj-1234567890-abcdefghijklmnop-qrstuvwxyz",
        ] {
            let mut state = SessionState::new(80, 6);
            state.vt.process(format!("{secret}\n").as_bytes());

            let screen = state.screen_text();
            assert!(
                !screen.contains(secret),
                "grid leaked credential: {screen:?}"
            );

            let grid = state.vt.screen().contents();
            state.push_filmstrip(FilmstripFrame {
                captured_at: SystemTime::now(),
                grid,
            });
            assert!(
                state
                    .filmstrip
                    .iter()
                    .all(|frame| !frame.grid.contains(secret)),
                "filmstrip leaked credential"
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn kill_terminates_setsid_descendant() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("escaped-repl-descendant-ran");
        let env = [
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("MARKER".into(), marker.to_string_lossy().into_owned()),
        ];
        let opts = SpawnOptions {
            id: "setsid_cleanup".into(),
            cmd: r#"setsid /bin/sh -c 'sleep 1; printf repl-descendant > "$MARKER"' & sleep 30"#,
            cwd: None,
            env: &env,
            cols: 80,
            rows: 24,
            shell: true,
            cast_path: None,
        };
        let mut session = PtySession::spawn(opts).expect("setsid session spawn failed");
        std::thread::sleep(Duration::from_millis(100));
        session.kill().unwrap();
        std::thread::sleep(Duration::from_millis(1_200));
        assert!(
            !marker.exists(),
            "setsid descendant survived explicit PTY teardown"
        );
    }

    #[test]
    fn direct_mode_rejects_shell_syntax() {
        let opts = SpawnOptions {
            id: "bad1".into(),
            cmd: "JAVA_HOME=/x gradlew installDebug 2>&1",
            cwd: None,
            env: &[],
            cols: 80,
            rows: 24,
            shell: false,
            cast_path: None,
        };
        let err = match PtySession::spawn(opts) {
            Ok(_) => panic!("expected shell-syntax rejection"),
            Err(e) => e.to_string(),
        };
        assert!(err.contains("shell"), "unexpected error: {err}");
    }

    #[cfg(unix)]
    #[test]
    fn cwd_defaults_to_supervisor_working_directory() {
        let expected = std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let env = [("PATH".into(), "/usr/bin:/bin".into())];
        let opts = SpawnOptions {
            id: "cwd_default".into(),
            cmd: "pwd; sleep 5",
            cwd: None,
            env: &env,
            cols: 80,
            rows: 24,
            shell: true,
            cast_path: None,
        };
        let mut session = PtySession::spawn(opts).expect("spawn cwd probe");
        let outcome = session
            .wait_ready(&ExpectRules::new(None, 100, 2_000))
            .unwrap();
        assert_eq!(outcome, ExpectOutcome::Idle);
        let screen = session.snapshot_text();
        assert!(screen.contains(&expected), "screen: {screen}");
        session.kill().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn invalid_cwd_is_rejected_before_recording_file_creation() {
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("missing").to_string_lossy().into_owned();
        let cast_path = temp.path().join("must-not-exist.cast");
        let opts = SpawnOptions {
            id: "cwd_invalid".into(),
            cmd: "/bin/true",
            cwd: Some(&cwd),
            env: &[],
            cols: 80,
            rows: 24,
            shell: false,
            cast_path: Some(cast_path.clone()),
        };

        let err = PtySession::spawn(opts)
            .err()
            .expect("invalid cwd must fail");
        assert!(err.to_string().contains("cwd is not a directory"));
        assert!(!cast_path.exists());
    }
    #[cfg(unix)]
    #[test]
    fn cast_file_uses_retained_parent_after_symlink_swap() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let allowed = temp.path().join("allowed");
        let parent = allowed.join("nested");
        let moved = allowed.join("moved");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(&parent).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let path = parent.join("record.cast");

        let mut opened = open_cast_file(&path).expect("open cast file");
        opened.cleanup.disarm();
        std::fs::rename(&parent, &moved).unwrap();
        symlink(&outside, &parent).unwrap();
        opened.file.write_all(b"safe").unwrap();
        drop(opened);

        assert_eq!(std::fs::read(moved.join("record.cast")).unwrap(), b"safe");
        assert!(!outside.join("record.cast").exists());
    }

    #[cfg(windows)]
    #[test]
    fn windows_cast_file_cleanup_uses_retained_handle() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("record.cast");
        let mut opened = open_cast_file(&path).expect("open cast file");
        opened.file.write_all(b"safe").unwrap();
        drop(opened);
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn relative_executable_path_resolves_from_cwd() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let bin_dir = temp.path().join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let executable = bin_dir.join("probe");
        std::fs::write(
            &executable,
            "#!/bin/sh\nprintf 'relative-executable-ok\\n'\nsleep 5\n",
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&executable, permissions).unwrap();

        let cwd = temp.path().to_str().unwrap();
        let env = [("PATH".into(), "/usr/bin:/bin".into())];
        let opts = SpawnOptions {
            id: "relative_program".into(),
            cmd: "bin/probe",
            cwd: Some(cwd),
            env: &env,
            cols: 80,
            rows: 24,
            shell: false,
            cast_path: None,
        };
        let mut session = PtySession::spawn(opts).expect("spawn relative executable");
        let outcome = session
            .wait_ready(&ExpectRules::new(None, 100, 2_000))
            .unwrap();
        assert_eq!(outcome, ExpectOutcome::Idle);
        let screen = session.snapshot_text();
        assert!(
            screen.contains("relative-executable-ok"),
            "screen: {screen}"
        );
        session.kill().unwrap();
    }

    #[test]
    fn session_state_cols_rows_initialized() {
        let s = SessionState::new(100, 30);
        assert_eq!(s.cols, 100);
        assert_eq!(s.rows, 30);
    }

    #[test]
    fn raw_buffer_cap_drain() {
        let mut s = SessionState::new(80, 24);
        // Fill beyond cap.
        let chunk = "x".repeat(1024);
        while s.raw.len() <= RAW_BUFFER_CAP_BYTES + chunk.len() {
            s.raw.push_str(&chunk);
        }
        // Simulate cap drain.
        if s.raw.len() > RAW_BUFFER_CAP_BYTES {
            let excess = s.raw.len() - RAW_BUFFER_CAP_BYTES;
            let drain_at = s
                .raw
                .char_indices()
                .map(|(i, _)| i)
                .filter(|&i| i >= excess)
                .next()
                .unwrap_or(s.raw.len());
            s.raw.drain(..drain_at);
        }
        assert!(s.raw.len() <= RAW_BUFFER_CAP_BYTES);
    }

    #[test]
    fn filmstrip_respects_frame_and_byte_caps() {
        let mut state = SessionState::new(80, 24);
        for index in 0..(FILMSTRIP_CAP + 10) {
            state.push_filmstrip(FilmstripFrame {
                captured_at: SystemTime::now(),
                grid: format!("frame {index}"),
            });
        }
        assert_eq!(state.filmstrip.len(), FILMSTRIP_CAP);
        assert_eq!(state.filmstrip.front().unwrap().grid, "frame 10");

        for _ in 0..5 {
            state.push_filmstrip(FilmstripFrame {
                captured_at: SystemTime::now(),
                grid: "x".repeat(1024 * 1024),
            });
        }
        assert!(state.filmstrip_bytes <= FILMSTRIP_CAP_BYTES);
        assert_eq!(
            state.filmstrip_bytes,
            state
                .filmstrip
                .iter()
                .map(|frame| frame.grid.len())
                .sum::<usize>(),
        );

        state.push_filmstrip(FilmstripFrame {
            captured_at: SystemTime::now(),
            grid: "x".repeat(FILMSTRIP_CAP_BYTES + 1),
        });
        assert!(state.filmstrip.is_empty());
        assert_eq!(state.filmstrip_bytes, 0);
    }

    #[test]
    fn screen_redacts_generic_assignments_and_password_prompts() {
        let mut state = SessionState::new(80, 8);
        state
            .vt
            .process(b"PASSWORD=short-secret API_KEY=abc123\nPassword: hunter2\n");

        let screen = state.screen_text();
        assert!(screen.contains("PASSWORD=[REDACTED]"), "screen: {screen:?}");
        assert!(screen.contains("API_KEY=[REDACTED]"), "screen: {screen:?}");
        assert!(
            screen.contains("Password: [REDACTED]"),
            "screen: {screen:?}"
        );
        assert!(
            !screen.contains("short-secret"),
            "screen leaked assignment: {screen:?}"
        );
        assert!(
            !screen.contains("abc123"),
            "screen leaked API key: {screen:?}"
        );
        assert!(
            !screen.contains("hunter2"),
            "screen leaked prompt value: {screen:?}"
        );
    }

    #[test]
    fn cast_redactor_holds_generic_values_across_chunk_boundaries() {
        let mut redactor = CastRedactor::default();
        let mut output = redactor.push("prefix PASSWORD=short-");
        output.push_str(&redactor.push("secret API_KEY=abc"));
        output.push_str(&redactor.push("123\nPassword:\n\n  hun"));
        output.push_str(&redactor.push("ter2\n"));
        output.push_str(&redactor.finish());

        assert_eq!(
            output,
            "prefix PASSWORD=[REDACTED] API_KEY=[REDACTED]\nPassword:\n\n  [REDACTED]\n"
        );
        assert!(!output.contains("short-secret"));
        assert!(!output.contains("abc123"));
        assert!(!output.contains("hunter2"));
    }

    #[test]
    fn redactor_emits_delimited_non_secret_output_without_waiting_for_more() {
        let mut redactor = CastRedactor::default();
        assert_eq!(redactor.push("mcp-devices$ "), "mcp-devices$ ");
    }
    #[test]
    fn cast_redactor_matches_credentials_across_terminal_controls() {
        const SECRET: &str = "ASIAIOSFODNN7EXAMPLE";
        let mut redactor = CastRedactor::default();
        let mut output = redactor.push("prefix AS\u{1b}[31mIAIOS");
        output.push_str(&redactor.push("FODNN7EXAMPLE\u{1b}]0;title\u{07}\n"));
        output.push_str(&redactor.finish());

        assert!(!output.contains(SECRET), "credential leaked: {output:?}");
        assert!(output.contains("[REDACTED]"));
        assert!(!output.contains('\u{1b}'));
    }

    fn assert_cast_redacts_access_key_at_every_split_boundary(secret: &str) {
        for split in 0..=secret.len() {
            let first_chunk = format!("prefix {}", &secret[..split]);
            let second_chunk = format!("{}\n", &secret[split..]);

            let mut redactor = CastRedactor::default();
            let mut output = redactor.push(&first_chunk);
            output.push_str(&redactor.push(&second_chunk));
            output.push_str(&redactor.finish());

            assert_eq!(
                output, "prefix [REDACTED]\n",
                "split {split} leaked access key {secret:?}: {output:?}"
            );
        }
    }

    #[test]
    fn cast_redactor_redacts_fine_grained_and_project_keys_at_every_split_boundary() {
        for secret in [
            "github_pat_11AAAAAA00000000000000_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
            "sk-proj-1234567890-abcdefghijklmnop-qrstuvwxyz",
        ] {
            for split in 0..=secret.len() {
                let first_chunk = format!("prefix {}", &secret[..split]);
                let second_chunk = format!("{}\n", &secret[split..]);

                let mut redactor = CastRedactor::default();
                let first_output = redactor.push(&first_chunk);
                if secret.starts_with("github_pat_") && split == 35 {
                    assert_eq!(first_output, "prefix ");
                }
                let second_output = redactor.push(&second_chunk);
                let final_output = redactor.finish();
                let output = format!("{first_output}{second_output}{final_output}");

                assert_eq!(
                    output, "prefix [REDACTED]\n",
                    "split {split} leaked credential {secret:?}: first={first_output:?}, second={second_output:?}, final={final_output:?}"
                );
            }
        }
    }

    #[test]
    fn cast_redactor_redacts_abia_access_key_at_every_split_boundary() {
        assert_cast_redacts_access_key_at_every_split_boundary("ABIA1234567890123456");
    }

    #[test]
    fn cast_redactor_redacts_a3t_access_key_at_every_split_boundary() {
        assert_cast_redacts_access_key_at_every_split_boundary("A3TZ1234567890123456");
    }

    #[test]
    fn redaction_holds_partial_credential_prefix_across_reads() {
        let secret = "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxx";
        let mut redactor = CastRedactor::default();
        let mut output = redactor.push("prompt$ \nsk-a");
        assert_eq!(output, "prompt$ \n");
        output.push_str(&redactor.push("nt-api03-xxxxxxxxxxxxxxxxxxxxxx\n"));
        output.push_str(&redactor.finish());

        assert!(
            !output.contains(secret),
            "redactor leaked split prefix: {output:?}"
        );
        assert!(output.contains("[REDACTED]"));
    }

    #[test]
    fn redaction_holds_partial_bearer_prefix_across_reads() {
        let mut redactor = CastRedactor::default();
        let mut output = redactor.push("prompt\nBea");
        assert_eq!(output, "prompt\n");
        output.push_str(&redactor.push("rer sensitive-token\n"));
        output.push_str(&redactor.finish());

        assert_eq!(output, "prompt\n[REDACTED]\n");
    }

    #[test]
    fn cast_redaction_covers_pty_chunk_boundary() {
        let secret = "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxx";
        let token_prefix = "sk-ant-";
        let first_chunk = format!("{}{token_prefix}", "x".repeat(4096 - token_prefix.len()));
        let second_chunk = format!("{}\n", &secret[token_prefix.len()..]);

        let mut redactor = CastRedactor::default();
        let mut output = redactor.push(&first_chunk);
        output.push_str(&redactor.push(&second_chunk));
        output.push_str(&redactor.finish());

        assert!(
            !output.contains(secret),
            "cast output leaked a token split across PTY reads: {output:?}"
        );
        assert!(output.contains("[REDACTED]"));
    }

    #[test]
    fn raw_redaction_covers_pty_chunk_boundary() {
        let secret = "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxx";
        let token_prefix = "sk-ant-";
        let first_chunk = format!("{}{token_prefix}", "x".repeat(4096 - token_prefix.len()));
        let second_chunk = format!("{}\n", &secret[token_prefix.len()..]);

        let mut redactor = CastRedactor::default();
        let mut state = SessionState::new(80, 24);
        let first = redactor.push(&first_chunk);
        state.append_redacted_raw(&first);
        let second = redactor.push(&second_chunk);
        state.append_redacted_raw(&second);
        let trailing = redactor.finish();
        state.append_redacted_raw(&trailing);

        assert!(!state.raw.contains(secret), "raw buffer leaked split token");
        assert!(state.raw.contains("[REDACTED]"));
    }

    #[test]
    fn raw_redaction_covers_fine_grained_and_project_chunk_boundaries() {
        for secret in [
            "github_pat_11AAAAAA00000000000000_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
            "sk-proj-1234567890-abcdefghijklmnop-qrstuvwxyz",
        ] {
            for split in 0..=secret.len() {
                let first_chunk = format!("prefix {}", &secret[..split]);
                let second_chunk = format!("{}\n", &secret[split..]);

                let mut redactor = CastRedactor::default();
                let mut state = SessionState::new(80, 24);
                let first = redactor.push(&first_chunk);
                state.append_redacted_raw(&first);
                let second = redactor.push(&second_chunk);
                state.append_redacted_raw(&second);
                let trailing = redactor.finish();
                state.append_redacted_raw(&trailing);

                assert!(
                    !state.raw.contains(secret),
                    "raw buffer leaked split token {secret:?} at {split}: {:?}",
                    state.raw
                );
                assert!(state.raw.contains("[REDACTED]"));
            }
        }
    }

    #[test]
    fn bearer_whitespace_boundary_is_bounded_and_redacted() {
        let mut redactor = CastRedactor::default();
        let mut output = redactor.push("prefix Bearer ");
        output.push_str(&redactor.push(&" ".repeat(CAST_REDACTION_PENDING_CAP_BYTES + 64)));
        assert!(redactor.pending.len() <= CAST_REDACTION_OVERLAP_BYTES);

        output.push_str(&redactor.push("token-value\nnext"));
        output.push_str(&redactor.finish());

        assert_eq!(output, "prefix [REDACTED]\nnext");
    }

    #[test]
    fn cast_redaction_bounds_unterminated_credential_suffix() {
        let mut redactor = CastRedactor::default();
        let mut output = redactor.push("prefix sk-ant-api03-");
        let long_suffix = "x".repeat(16 * 1024);
        output.push_str(&redactor.push(&long_suffix));

        assert!(
            redactor.pending.len() <= CAST_REDACTION_OVERLAP_BYTES,
            "credential suffix was retained in cast redactor state: {} bytes",
            redactor.pending.len()
        );

        output.push_str(&redactor.push("\nnext"));
        output.push_str(&redactor.finish());

        assert_eq!(output, "prefix [REDACTED]\nnext");
    }

    use super::ExpectRules;
    use std::time::Duration;
}
