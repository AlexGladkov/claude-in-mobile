//! Supervisor — owns a name → session map.
//!
//! The supervisor is a normal struct; the long-lived JSON-RPC stdio loop that
//! exposes it to the TS MCP server is wired in Phase 9 (REPL TS plugin).

use std::collections::HashMap;
use std::sync::Mutex;

use anyhow::{anyhow, bail, Result};

use super::expect::{ExpectOutcome, ExpectRules};
use super::prompt_profiles::{compile, pick_profile};
use super::session::{PtySession, SessionStatus, SpawnOptions};

pub struct Supervisor {
    sessions: Mutex<HashMap<String, PtySession>>,
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

    pub fn spawn(&self, req: SpawnRequest) -> Result<()> {
        let mut map = self.sessions.lock().unwrap();
        if let Some(existing) = map.get(&req.id) {
            if existing.status() != SessionStatus::Dead {
                bail!("session already exists: {}", req.id);
            }
        }
        let env: Vec<(String, String)> = req.env.clone();
        let session = PtySession::spawn(SpawnOptions {
            id: req.id.clone(),
            cmd: &req.cmd,
            cwd: req.cwd.as_deref(),
            env: &env,
            cols: req.cols,
            rows: req.rows,
        })?;
        map.insert(req.id, session);
        Ok(())
    }

    pub fn send(&self, id: &str, text: &str, with_newline: bool) -> Result<()> {
        let mut map = self.sessions.lock().unwrap();
        let s = map.get_mut(id).ok_or_else(|| anyhow!("no session: {id}"))?;
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
        let mut map = self.sessions.lock().unwrap();
        let s = map.get_mut(id).ok_or_else(|| anyhow!("no session: {id}"))?;
        s.write_bytes(bytes)
    }

    pub fn expect(
        &self,
        id: &str,
        regex: Option<&str>,
        idle_ms: u64,
        timeout_ms: u64,
    ) -> Result<ExpectOutcome> {
        let mut map = self.sessions.lock().unwrap();
        let s = map.get_mut(id).ok_or_else(|| anyhow!("no session: {id}"))?;
        let regex_owned = regex.map(|r| r.to_string()).or_else(|| {
            pick_profile(&s.cmd).map(|p| p.prompt_regex.to_string())
        });
        let prompt = regex_owned.as_deref().and_then(compile);
        let rules = ExpectRules::new(prompt, idle_ms, timeout_ms);
        s.wait_ready(&rules)
    }

    pub fn snapshot(&self, id: &str, tail_lines: Option<usize>) -> Result<SessionSnapshot> {
        let map = self.sessions.lock().unwrap();
        let s = map.get(id).ok_or_else(|| anyhow!("no session: {id}"))?;
        let screen = match tail_lines {
            Some(n) => s.snapshot_tail(n),
            None => s.snapshot_text(),
        };
        Ok(SessionSnapshot {
            id: id.into(),
            status: s.status(),
            screen,
            exit_code: s.exit_code(),
            cols: s.cols(),
            rows: s.rows(),
        })
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        let map = self.sessions.lock().unwrap();
        map.values()
            .map(|s| SessionInfo {
                id: s.id.clone(),
                cmd: s.cmd.clone(),
                status: s.status(),
                exit_code: s.exit_code(),
            })
            .collect()
    }

    pub fn kill(&self, id: &str) -> Result<()> {
        let mut map = self.sessions.lock().unwrap();
        let s = map.get_mut(id).ok_or_else(|| anyhow!("no session: {id}"))?;
        s.kill()
    }

    pub fn drop_session(&self, id: &str) -> Result<()> {
        let mut map = self.sessions.lock().unwrap();
        map.remove(id).ok_or_else(|| anyhow!("no session: {id}"))?;
        Ok(())
    }
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
    use std::thread::sleep;
    use std::time::Duration;

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
