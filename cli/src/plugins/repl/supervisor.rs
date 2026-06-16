//! Supervisor — owns a name → session map.
//!
//! The supervisor is a normal struct; the long-lived JSON-RPC stdio loop that
//! exposes it to the TS MCP server is wired in Phase 9 (REPL TS plugin).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, bail, Result};

use super::expect::{ExpectOutcome, ExpectRules};
use super::prompt_profiles::{compile, pick_profile};
use super::session::{PtySession, SessionState, SessionStatus, SpawnOptions};

/// One live session. `session` is the exclusive lock for mutating ops
/// (send/key/expect/kill); `state` is a shared clone of the session's read
/// state so `list`/`snapshot` can report status/screen WITHOUT blocking on a
/// concurrent long-running `expect` that holds `session`.
struct SessionHandle {
    cmd: String,
    cols: u16,
    rows: u16,
    state: Arc<Mutex<SessionState>>,
    session: Mutex<PtySession>,
}

pub struct Supervisor {
    sessions: Mutex<HashMap<String, Arc<SessionHandle>>>,
}

#[derive(Debug, Clone)]
pub struct SpawnRequest {
    pub id: String,
    pub cmd: String,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
    pub prompt_regex: Option<String>,
    /// Run `cmd` via `/bin/sh -c` instead of direct argv exec. See
    /// [`SpawnOptions::shell`].
    pub shell: bool,
}

impl Default for Supervisor {
    fn default() -> Self {
        Self::new()
    }
}

impl Supervisor {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Brief map lookup returning a cloned handle. The map lock is released
    /// immediately — callers then lock the per-session mutex (or its shared
    /// state), so one session's blocking op never freezes the whole map.
    fn handle(&self, id: &str) -> Result<Arc<SessionHandle>> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("no session: {id}"))
    }

    pub fn spawn(&self, req: SpawnRequest) -> Result<()> {
        {
            let map = self.sessions.lock().unwrap();
            if let Some(existing) = map.get(&req.id) {
                if existing.session.lock().unwrap().status() != SessionStatus::Dead {
                    bail!("session already exists: {}", req.id);
                }
            }
        }
        let env: Vec<(String, String)> = req.env.clone();
        // Spawn outside the map lock — openpty/fork must not block other ops.
        let session = PtySession::spawn(SpawnOptions {
            id: req.id.clone(),
            cmd: &req.cmd,
            cwd: req.cwd.as_deref(),
            env: &env,
            cols: req.cols,
            rows: req.rows,
            shell: req.shell,
        })?;
        let handle = Arc::new(SessionHandle {
            cmd: session.cmd.clone(),
            cols: session.cols(),
            rows: session.rows(),
            state: session.state(),
            session: Mutex::new(session),
        });
        self.sessions.lock().unwrap().insert(req.id, handle);
        Ok(())
    }

    pub fn send(&self, id: &str, text: &str, with_newline: bool) -> Result<()> {
        let h = self.handle(id)?;
        let mut s = h.session.lock().unwrap();
        if with_newline {
            s.write_line(text)
        } else {
            s.write_bytes(text.as_bytes())
        }
    }

    pub fn send_key(&self, id: &str, key: &str) -> Result<()> {
        // CR (\r) is what curses/readline TUIs treat as Enter when the PTY is
        // in raw mode (ICRNL is off). Cooked-mode REPLs (bash, python) also
        // accept \r because the line discipline normalises it to \n.
        let bytes: &[u8] = match key {
            "enter" => b"\r",
            "ctrl-c" => &[0x03],
            "ctrl-d" => &[0x04],
            "ctrl-z" => &[0x1a],
            "tab" => b"\t",
            "up" => b"\x1b[A",
            "down" => b"\x1b[B",
            "left" => b"\x1b[D",
            "right" => b"\x1b[C",
            _ => bail!("unknown key: {key}"),
        };
        let h = self.handle(id)?;
        let mut s = h.session.lock().unwrap();
        s.write_bytes(bytes)
    }

    pub fn expect(
        &self,
        id: &str,
        regex: Option<&str>,
        idle_ms: u64,
        timeout_ms: u64,
    ) -> Result<ExpectOutcome> {
        let h = self.handle(id)?;
        // Hold ONLY this session's lock across the blocking wait. Other
        // sessions — and lock-free `list`/`snapshot` — stay responsive.
        let mut s = h.session.lock().unwrap();
        let regex_owned = regex
            .map(|r| r.to_string())
            .or_else(|| pick_profile(&s.cmd).map(|p| p.prompt_regex.to_string()));
        let prompt = regex_owned.as_deref().and_then(compile);
        let rules = ExpectRules::new(prompt, idle_ms, timeout_ms);
        s.wait_ready(&rules)
    }

    pub fn snapshot(&self, id: &str, tail_lines: Option<usize>) -> Result<SessionSnapshot> {
        let h = self.handle(id)?;
        // Read the shared state, not the session lock — works even while the
        // session is mid-`expect`.
        let st = h.state.lock().unwrap();
        let full = st.screen_text();
        let screen = match tail_lines {
            Some(n) => tail_lines_of(&full, n),
            None => full,
        };
        Ok(SessionSnapshot {
            id: id.into(),
            status: st.status,
            screen,
            exit_code: st.exit_code,
            cols: h.cols,
            rows: h.rows,
        })
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        // Snapshot the map under a brief lock, then read each session's shared
        // state — never the (possibly busy) per-session lock.
        let handles: Vec<(String, Arc<SessionHandle>)> = {
            let map = self.sessions.lock().unwrap();
            map.iter().map(|(k, v)| (k.clone(), Arc::clone(v))).collect()
        };
        handles
            .iter()
            .map(|(id, h)| {
                let st = h.state.lock().unwrap();
                SessionInfo {
                    id: id.clone(),
                    cmd: h.cmd.clone(),
                    status: st.status,
                    exit_code: st.exit_code,
                }
            })
            .collect()
    }

    pub fn kill(&self, id: &str) -> Result<()> {
        let h = self.handle(id)?;
        let mut s = h.session.lock().unwrap();
        s.kill()
    }

    pub fn drop_session(&self, id: &str) -> Result<()> {
        self.sessions
            .lock()
            .unwrap()
            .remove(id)
            .ok_or_else(|| anyhow!("no session: {id}"))?;
        Ok(())
    }
}

/// Trailing `max_lines` of `full` joined by `\n` — pure string op, no session
/// state involved.
fn tail_lines_of(full: &str, max_lines: usize) -> String {
    let lines: Vec<&str> = full.lines().collect();
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].join("\n")
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub cmd: String,
    pub status: SessionStatus,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub id: String,
    pub status: SessionStatus,
    pub screen: String,
    pub exit_code: Option<i32>,
    pub cols: u16,
    pub rows: u16,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;
    use std::thread::sleep;
    use std::time::{Duration, Instant};

    fn spawn_bash(sup: &Supervisor, id: &str) {
        sup.spawn(SpawnRequest {
            id: id.into(),
            cmd: "bash --norc --noprofile".into(),
            cwd: None,
            env: vec![
                ("PATH".into(), std::env::var("PATH").unwrap_or_default()),
                ("HOME".into(), std::env::var("HOME").unwrap_or_default()),
                ("PS1".into(), "$ ".into()),
            ],
            cols: 80,
            rows: 24,
            prompt_regex: None,
            shell: false,
        })
        .expect("spawn bash failed");
    }

    #[test]
    fn spawn_send_expect_bash_roundtrip() {
        let sup = Supervisor::new();
        spawn_bash(&sup, "b1");
        // wait for first prompt
        let outcome = sup
            .expect("b1", Some(r"\$ $"), 300, 5_000)
            .expect("expect prompt failed");
        assert!(matches!(
            outcome,
            ExpectOutcome::PromptMatched | ExpectOutcome::Idle
        ));
        sup.send("b1", "echo claude-in-mobile", true).unwrap();
        let after = sup
            .expect("b1", Some(r"\$ $"), 300, 5_000)
            .expect("expect after echo failed");
        assert!(matches!(after, ExpectOutcome::PromptMatched | ExpectOutcome::Idle));
        let snap = sup.snapshot("b1", None).unwrap();
        assert!(snap.screen.contains("claude-in-mobile"), "snapshot: {}", snap.screen);
        sup.kill("b1").unwrap();
    }

    #[test]
    fn duplicate_spawn_rejected_while_alive() {
        let sup = Supervisor::new();
        spawn_bash(&sup, "b2");
        let err = sup.spawn(SpawnRequest {
            id: "b2".into(),
            cmd: "bash --norc --noprofile".into(),
            cwd: None,
            env: vec![],
            cols: 80,
            rows: 24,
            prompt_regex: None,
            shell: false,
        });
        assert!(err.is_err());
        sup.kill("b2").unwrap();
    }

    #[test]
    fn list_reports_active_session() {
        let sup = Supervisor::new();
        spawn_bash(&sup, "b3");
        sleep(Duration::from_millis(150));
        let infos = sup.list();
        assert_eq!(infos.len(), 1);
        assert_eq!(infos[0].id, "b3");
        sup.kill("b3").unwrap();
    }

    #[test]
    fn kill_marks_session_dead() {
        let sup = Supervisor::new();
        spawn_bash(&sup, "b4");
        sup.kill("b4").unwrap();
        sleep(Duration::from_millis(100));
        let snap = sup.snapshot("b4", None).unwrap();
        assert_eq!(snap.status, SessionStatus::Dead);
    }

    #[test]
    fn unknown_session_errors() {
        let sup = Supervisor::new();
        assert!(sup.snapshot("nope", None).is_err());
        assert!(sup.send("nope", "x", true).is_err());
        assert!(sup.kill("nope").is_err());
    }

    #[test]
    fn long_expect_does_not_block_other_sessions() {
        // The core P1 guarantee: a blocking `expect` on session A must not
        // freeze `list`/`snapshot` or any op on session B.
        let sup = Arc::new(Supervisor::new());
        spawn_bash(&sup, "la");
        spawn_bash(&sup, "lb");
        sleep(Duration::from_millis(100)); // let both reach a prompt

        let sup2 = Arc::clone(&sup);
        let blocker = thread::spawn(move || {
            // Unmatchable prompt + long idle => blocks for the full timeout,
            // holding ONLY la's session lock.
            let _ = sup2.expect("la", Some("NEVER_MATCH_XYZ_QWE$"), 5_000, 1_500);
        });
        sleep(Duration::from_millis(150)); // ensure expect is in-flight

        let t = Instant::now();
        let infos = sup.list();
        let snap = sup.snapshot("lb", None).unwrap();
        let elapsed = t.elapsed();

        assert_eq!(infos.len(), 2);
        assert_eq!(snap.id, "lb");
        assert!(
            elapsed < Duration::from_millis(800),
            "list/snapshot blocked behind expect: {elapsed:?}"
        );

        blocker.join().unwrap();
        sup.kill("la").ok();
        sup.kill("lb").ok();
    }

    #[test]
    fn send_key_known_and_unknown() {
        let sup = Supervisor::new();
        spawn_bash(&sup, "b5");
        sleep(Duration::from_millis(100));
        sup.send_key("b5", "enter").unwrap();
        assert!(sup.send_key("b5", "rocket-launch").is_err());
        sup.kill("b5").unwrap();
    }

    #[test]
    fn expect_timeout_when_no_match() {
        let sup = Supervisor::new();
        spawn_bash(&sup, "b6");
        let outcome = sup
            .expect("b6", Some(r"NEVER_GONNA_MATCH$"), 50, 500)
            .unwrap();
        assert_eq!(outcome, ExpectOutcome::TimedOut);
        sup.kill("b6").unwrap();
    }
}
