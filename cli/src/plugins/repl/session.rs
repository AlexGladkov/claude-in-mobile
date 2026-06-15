//! REPL session — one PTY + child process + vt100 emulator + reader thread.
//!
//! Concurrency model: a single reader thread owns the PTY master reader and
//! pushes bytes into shared [`SessionState`] under a Mutex. The supervisor
//! polls `state.buffer` from the consumer side. We deliberately avoid tokio:
//! REPL sessions are few, latency tolerances are in milliseconds, and a
//! blocking thread per session keeps the dependency graph small.

use std::io::Write;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;

use super::expect::{ExpectOutcome, ExpectRules};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Starting,
    Ready,
    Busy,
    Dead,
}

pub struct SessionState {
    /// Raw bytes-as-utf8 accumulator. Cleared only via `take_tail()` / reset.
    pub raw: String,
    /// vt100 grid emulator — produces canonical screen text.
    pub vt: vt100::Parser,
    pub status: SessionStatus,
    pub exit_code: Option<i32>,
    pub last_activity: Instant,
}

impl SessionState {
    fn new(cols: u16, rows: u16) -> Self {
        Self {
            raw: String::new(),
            vt: vt100::Parser::new(rows, cols, 1000),
            status: SessionStatus::Starting,
            exit_code: None,
            last_activity: Instant::now(),
        }
    }

    pub fn screen_text(&self) -> String {
        self.vt.screen().contents()
    }
}

pub struct PtySession {
    pub id: String,
    pub cmd: String,
    state: Arc<Mutex<SessionState>>,
    writer: Box<dyn Write + Send>,
    _master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    cols: u16,
    rows: u16,
}

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
}

impl PtySession {
    pub fn spawn(opts: SpawnOptions<'_>) -> Result<Self> {
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
            // Delegate to a real shell — the only correct way to honour shell
            // syntax. We never reimplement shell parsing.
            ("/bin/sh".to_string(), vec!["-c".to_string(), opts.cmd.to_string()])
        } else {
            // Direct exec. If the caller pasted shell syntax (the common
            // mistake — see issue #46) we'd otherwise spawn a doomed session
            // with a nonsense program name. Fail loud with guidance instead.
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
        // Minimal env — caller passes an explicit allowlist. We add TERM and
        // FORCE_COLOR so REPLs render predictably.
        builder.env_clear();
        builder.env("TERM", "xterm-256color");
        builder.env("FORCE_COLOR", "1");
        for (k, v) in opts.env {
            builder.env(k, v);
        }

        let child = pair
            .slave
            .spawn_command(builder)
            .context("spawn_command failed")?;

        let mut reader = pair
            .master
            .try_clone_reader()
            .context("try_clone_reader failed")?;
        let writer = pair
            .master
            .take_writer()
            .context("take_writer failed")?;

        let state = Arc::new(Mutex::new(SessionState::new(opts.cols, opts.rows)));

        // Reader thread — owns the PTY reader for the lifetime of the session.
        let reader_state = Arc::clone(&state);
        thread::Builder::new()
            .name(format!("repl-reader-{}", opts.id))
            .spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let mut s = reader_state.lock().expect("session state poisoned");
                            s.vt.process(&buf[..n]);
                            s.raw.push_str(&String::from_utf8_lossy(&buf[..n]));
                            s.last_activity = Instant::now();
                            if s.status == SessionStatus::Starting {
                                s.status = SessionStatus::Ready;
                            }
                        }
                        Err(_) => break,
                    }
                }
                let mut s = reader_state.lock().expect("session state poisoned");
                s.status = SessionStatus::Dead;
            })
            .context("spawn reader thread failed")?;

        Ok(Self {
            id: opts.id,
            cmd: opts.cmd.into(),
            state,
            writer,
            _master: pair.master,
            child,
            cols: opts.cols,
            rows: opts.rows,
        })
    }

    pub fn cols(&self) -> u16 {
        self.cols
    }
    pub fn rows(&self) -> u16 {
        self.rows
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
        // Terminate with CR (`\r`) — works for both cooked-mode REPLs (where
        // the line discipline translates it to NL) and raw-mode TUIs (curses,
        // readline) that bind Enter to `\r`. Sending `\n` directly fails for
        // raw-mode consumers and prints `^J` instead of submitting.
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
        self.state.lock().expect("session state poisoned").raw.clone()
    }

    pub fn kill(&mut self) -> Result<()> {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let mut s = self.state.lock().expect("session state poisoned");
        s.status = SessionStatus::Dead;
        Ok(())
    }

    pub fn exit_code(&self) -> Option<i32> {
        self.state
            .lock()
            .expect("session state poisoned")
            .exit_code
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // Best-effort cleanup. Reader thread exits naturally when the PTY
        // master closes via `_master` Drop.
        let _ = self.child.kill();
    }
}

/// Detect shell syntax that direct exec (no shell) cannot honour, so spawn can
/// fail with guidance instead of producing a silently-dead session. Quote-aware
/// — metacharacters inside single/double quotes are treated as literal, so a
/// quoted URL like `"http://h/db?a=1&b=2"` is not flagged. High-confidence
/// operators only (`| ; < > $( ` backtick `) plus a leading `VAR=value`
/// prefix); a lone `&` is intentionally not flagged because `2>&1` is already
/// caught by `>` and bare `&` collides with literal `&` in unquoted args.
fn detect_shell_syntax(cmd: &str) -> Option<String> {
    // 1. Leading `VAR=value` env-assignment prefix (e.g. `JAVA_HOME=/x cmd`).
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
    // 2. Unquoted shell metacharacters.
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
            // `&&` is unambiguous shell; a lone `&` is left unflagged because it
            // collides with literal `&` in unquoted args (and `2>&1` is already
            // caught by `>`).
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
    // Minimal shlex-style splitter: whitespace + single/double quotes.
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
        assert!(detect_shell_syntax("a && b").is_some()); // `&&` flagged; lone `&` is not
        assert!(detect_shell_syntax("a; b").is_some());
        assert!(detect_shell_syntax("echo $(date)").is_some());
        assert!(detect_shell_syntax("echo `date`").is_some());
    }

    #[test]
    fn ignores_quoted_metacharacters() {
        // A quoted URL with `&`/`?` must not be flagged.
        assert!(detect_shell_syntax(r#"psql "postgres://h/db?a=1&b=2""#).is_none());
        assert!(detect_shell_syntax(r#"python -c "print(1)""#).is_none());
        // `--flag=value` is not an env-assignment prefix.
        assert!(detect_shell_syntax("gradlew --foo=bar").is_none());
        // Plain argv is clean.
        assert!(detect_shell_syntax("python3 -i").is_none());
        assert!(detect_shell_syntax("bash --norc --noprofile").is_none());
    }

    #[test]
    fn shell_mode_runs_via_sh_and_honours_redirection() {
        let opts = SpawnOptions {
            id: "sh1".into(),
            cmd: "echo hello 2>&1",
            cwd: None,
            env: &[("PATH".into(), std::env::var("PATH").unwrap_or_default())],
            cols: 80,
            rows: 24,
            shell: true,
        };
        let mut s = PtySession::spawn(opts).expect("shell spawn failed");
        let rules = ExpectRules::new(None, 100, 2_000);
        let _ = s.wait_ready(&rules);
        std::thread::sleep(Duration::from_millis(150));
        assert!(s.snapshot_text().contains("hello"), "screen: {}", s.snapshot_text());
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
        };
        let err = match PtySession::spawn(opts) {
            Ok(_) => panic!("expected shell-syntax rejection"),
            Err(e) => e.to_string(),
        };
        assert!(err.contains("shell"), "unexpected error: {err}");
    }

    use super::ExpectRules;
    use std::time::Duration;
}
