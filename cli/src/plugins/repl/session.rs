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
//! 1. `redaction::redact(&chunk_str)` — OUTSIDE the mutex
//! 2. Asciicast write (`redacted` payload) — OUTSIDE the mutex via local BufWriter
//! 3. Acquire `SessionState` lock:
//!    a. `vt.process(&raw_bytes)`
//!    b. capture filmstrip frame AFTER vt.process
//!    c. `raw.push_str(&redacted)` + cap drain
//!    d. update status / last_activity

use std::collections::VecDeque;
use std::io::{BufWriter, Write};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::utils::private_state::state_dir;
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
    pub vt: vt100::Parser,
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
        self.vt.screen().contents()
    }

    /// Append a complete rendered frame, evicting the oldest complete frames
    /// until both filmstrip limits are satisfied.
    pub fn push_filmstrip(&mut self, frame: FilmstripFrame) {
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

// ---------------------------------------------------------------------------
// castPath validation
// ---------------------------------------------------------------------------

/// Validate and open a `.cast` file path, confining it to the system temp
/// directory or the private per-user REPL cast directory.
fn open_cast_file(path: &PathBuf) -> Result<std::fs::File> {
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

    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .with_context(|| format!("open cast file {}", path.display()))
}

// ---------------------------------------------------------------------------
// Spawn options / PtySession
// ---------------------------------------------------------------------------

pub struct SpawnOptions<'a> {
    pub id: String,
    pub cmd: &'a str,
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
    #[cfg(unix)]
    process_group_leader: Option<i32>,
    terminated: bool,
    /// Path to the `.cast` file if recording is active; used for best-effort
    /// removal on kill/Drop.
    cast_path: Option<PathBuf>,
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
        // Validate cast_path BEFORE opening any PTY (fail fast, no side effects).
        let cast_file_opt: Option<(PathBuf, std::fs::File)> = if let Some(ref p) = opts.cast_path {
            let f = open_cast_file(p)?;
            Some((p.clone(), f))
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
        let mut builder = CommandBuilder::new(program);
        for a in args {
            builder.arg(a);
        }
        if let Some(cwd) = opts.cwd {
            builder.cwd(cwd);
        }
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

        // portable-pty's Unix backend establishes a fresh session with
        // setsid() in its pre-exec hook. Capture the foreground process group
        // while the master is still alive so teardown can also terminate
        // descendants that inherited the PTY.
        #[cfg(unix)]
        let process_group_leader = pair.master.process_group_leader().map(|pid| pid as i32);

        let mut reader = pair
            .master
            .try_clone_reader()
            .context("try_clone_reader failed")?;
        let writer = pair.master.take_writer().context("take_writer failed")?;

        let state = Arc::new(Mutex::new(SessionState::new(opts.cols, opts.rows)));
        let cast_path_for_drop = opts.cast_path.clone();

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

                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let raw_bytes = &buf[..n];
                            let chunk_str = String::from_utf8_lossy(raw_bytes);

                            // Step 1: redact OUTSIDE mutex.
                            let redacted = redaction::redact(&chunk_str);

                            // Step 2: write to asciicast OUTSIDE mutex.
                            if let Some(ref mut cw) = cast_writer {
                                let elapsed = spawn_instant.elapsed().as_secs_f64();
                                let _ = write_cast_event(cw, elapsed, &redacted);
                                // Don't flush every chunk — BufWriter batches.
                            }

                            // Step 3: lock, then update vt/filmstrip/raw.
                            let mut s = reader_state.lock().expect("session state poisoned");

                            // 3a. Process raw bytes through vt100.
                            s.vt.process(raw_bytes);

                            // 3b. Capture a complete frame AFTER vt.process.
                            let grid = s.vt.screen().contents();
                            s.push_filmstrip(FilmstripFrame {
                                captured_at: SystemTime::now(),
                                grid,
                            });

                            // 3c. Append redacted bytes to raw buffer + cap drain.
                            s.raw.push_str(&redacted);
                            if s.raw.len() > RAW_BUFFER_CAP_BYTES {
                                let excess = s.raw.len() - RAW_BUFFER_CAP_BYTES;
                                // Drain from the front.  We must find a char
                                // boundary to avoid splitting UTF-8.
                                let drain_at = s
                                    .raw
                                    .char_indices()
                                    .map(|(i, _)| i)
                                    .find(|&i| i >= excess)
                                    .unwrap_or(s.raw.len());
                                s.raw.drain(..drain_at);
                            }

                            // 3d. Update status / activity.
                            s.last_activity = Instant::now();
                            if s.status == SessionStatus::Starting {
                                s.status = SessionStatus::Ready;
                            }
                        }
                        Err(_) => break,
                    }
                }

                // Mark the generation before taking the state lock. The
                // supervisor can therefore detect a fast exit even when this
                // reader reaches EOF before spawn() inserts its handle.
                generation_exited_for_reader.store(true, Ordering::Release);

                // EOF — flush/close the cast writer cleanly.
                if let Some(mut cw) = cast_writer {
                    let _ = cw.flush();
                }

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

        Ok(Self {
            id: opts.id,
            cmd: opts.cmd.into(),
            state,
            writer,
            master: pair.master,
            child,
            #[cfg(unix)]
            process_group_leader,
            terminated: false,
            cast_path: cast_path_for_drop,
        })
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
        self.writer.write_all(data).context("pty write failed")?;
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

    fn try_wait_child(&mut self) -> Option<Option<i32>> {
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

    pub fn kill(&mut self) -> Result<()> {
        self.terminate();
        {
            let mut s = self.state.lock().expect("session state poisoned");
            s.status = SessionStatus::Dead;
        }
        if let Some(p) = &self.cast_path {
            let _ = std::fs::remove_file(p);
        }
        Ok(())
    }

    fn terminate(&mut self) {
        if self.terminated {
            return;
        }
        self.terminated = true;
        #[cfg(unix)]
        if let Some(group) = self.process_group_leader.filter(|pid| *pid > 1) {
            let _ = Command::new("/bin/kill")
                .args(["-TERM", "--", &format!("-{group}")])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        #[cfg(unix)]
        if let Some(group) = self.process_group_leader.filter(|pid| *pid > 1) {
            let _ = Command::new("/bin/kill")
                .args(["-KILL", "--", &format!("-{group}")])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
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
        if let Some(p) = &self.cast_path {
            let _ = std::fs::remove_file(p);
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

    use super::ExpectRules;
    use std::time::Duration;
}
