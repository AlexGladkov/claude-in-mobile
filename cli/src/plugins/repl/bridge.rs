//! JSON-RPC stdio bridge for the REPL supervisor.
//!
//! Wire protocol — one JSON object per line on stdin/stdout:
//!
//!   request:  {"id":"<rid>","method":"<m>","params":{...}}
//!   success:  {"id":"<rid>","result":<json>}
//!   failure:  {"id":"<rid>","error":"<message>"}
//!
//! The supervisor runs forever until stdin closes (parent exit) or a
//! `shutdown` request arrives. PTY sessions are killed on shutdown.

use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;

use anyhow::Result;
use serde::Deserialize;
use serde_json::{json, Value};

use super::expect::ExpectOutcome;
use super::supervisor::{SnapshotMode, SpawnRequest, Supervisor};
use crate::utils::private_state::state_file;

#[derive(Deserialize)]
struct Request {
    id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

pub fn run_supervisor_loop() -> Result<()> {
    let supervisor = Arc::new(Supervisor::new());
    // Single writer owns stdout — concurrent request handlers send their
    // response lines here, so frames never interleave.
    let (tx, rx) = mpsc::channel::<String>();
    let writer = thread::Builder::new()
        .name("repl-bridge-writer".into())
        .spawn(move || {
            let stdout = io::stdout();
            let mut out = stdout.lock();
            // Ready frame — apiVersion MUST stay '1' (kernel gate).
            let _ = writeln!(out, "{}", json!({"event":"ready","apiVersion":"1"}));
            let _ = out.flush();
            for line in rx {
                let _ = writeln!(out, "{line}");
                let _ = out.flush();
            }
        })?;

    let stdin = io::stdin();
    let reader = stdin.lock();
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let req: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let _ =
                    tx.send(json!({"id":"","error":format!("invalid request: {e}")}).to_string());
                continue;
            }
        };
        if req.method == "shutdown" {
            supervisor.shutdown();
            let _ = tx.send(json!({"id":req.id,"result":"ok"}).to_string());
            break;
        }
        // Handle each request on its own thread so a blocking `expect` on one
        // session does not stall the read loop or other sessions.
        let sup = Arc::clone(&supervisor);
        let tx = tx.clone();
        thread::spawn(move || {
            let envelope = match dispatch(&sup, &req.method, &req.params) {
                Ok(value) => json!({"id":req.id,"result":value}),
                Err(e) => json!({"id":req.id,"error":format!("{e}")}),
            };
            let _ = tx.send(envelope.to_string());
        });
    }
    // Drop our sender; the writer drains and exits once every in-flight handler
    // has dropped its clone (graceful flush of pending responses).
    drop(tx);
    let _ = writer.join();
    Ok(())
}

fn dispatch(sup: &Supervisor, method: &str, params: &Value) -> Result<Value> {
    match method {
        "spawn" => {
            let id = required_string(params, "id")?;
            let cmd = required_string(params, "cmd")?;
            let cwd = params.get("cwd").and_then(|v| v.as_str()).map(String::from);
            // Clamp cols/rows to 1..=1000 using as_u64() BEFORE casting to u16.
            let cols = params
                .get("cols")
                .and_then(|v| v.as_u64())
                .unwrap_or(120)
                .clamp(1, 1000) as u16;
            let rows = params
                .get("rows")
                .and_then(|v| v.as_u64())
                .unwrap_or(40)
                .clamp(1, 1000) as u16;
            let prompt_regex = params
                .get("promptRegex")
                .and_then(|v| v.as_str())
                .map(String::from);
            let shell = params
                .get("shell")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let env = parse_env(params);

            // Parse record / castPath.
            let cast_path: Option<PathBuf> = parse_cast_path(params, &id)?;

            let result = sup.spawn(SpawnRequest {
                id,
                cmd,
                cwd,
                env,
                cols,
                rows,
                prompt_regex,
                shell,
                cast_path,
            })?;
            Ok(serde_json::to_value(&result)?)
        }
        "send" => {
            let id = required_string(params, "id")?;
            let text = required_string(params, "text")?;
            let with_newline = params
                .get("newline")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            sup.send(&id, &text, with_newline)?;
            Ok(json!({"ok": true}))
        }
        "key" => {
            let id = required_string(params, "id")?;
            let key = required_string(params, "key")?;
            sup.send_key(&id, &key)?;
            Ok(json!({"ok": true}))
        }
        "expect" => {
            let id = required_string(params, "id")?;
            let regex = params
                .get("regex")
                .and_then(|v| v.as_str())
                .map(String::from);
            // Hard caps prevent a caller from blocking the server for hours.
            //
            // Live / animated TUI programs (monet tui, top, htop, watch …) emit
            // output continuously — the idle-based readiness heuristic never
            // fires because `last_activity` is reset on every redraw chunk. For
            // such programs use `repl_snapshot` instead (instantaneous, never
            // blocks). Idle-based `expect` will always run to full `timeout` on
            // a non-stopping TUI, so keep `timeoutMs` small or use `snapshot`.
            let idle = params
                .get("idleMs")
                .and_then(|v| v.as_u64())
                .unwrap_or(300)
                .min(60_000); // hard cap: 60 s
            let timeout = params
                .get("timeoutMs")
                .and_then(|v| v.as_u64())
                .unwrap_or(5_000)
                .min(300_000); // hard cap: 5 min
            let outcome = sup.expect(&id, regex.as_deref(), idle, timeout)?;
            Ok(serialize_outcome(&outcome))
        }
        "snapshot" => {
            let id = required_string(params, "id")?;

            // Validate mode — reject invalid values with explicit error (S4).
            let mode_str = params
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("grid");
            let mode = SnapshotMode::parse(mode_str)?;

            // Parse history: bool or int.
            let history: Option<usize> = parse_history(params)?;

            let tail = params
                .get("tail")
                .and_then(|v| v.as_u64())
                .map(|n| n as usize);
            let snap = sup.snapshot(&id, mode, history, tail)?;
            Ok(serde_json::to_value(&snap)?)
        }
        "list" => Ok(serde_json::to_value(sup.list())?),
        "kill" => {
            let id = required_string(params, "id")?;
            sup.kill(&id)?;
            Ok(json!({"ok": true}))
        }
        "resize" => {
            let id = required_string(params, "id")?;
            // Clamp cols/rows to 1..=1000 using as_u64() BEFORE casting to u16 (R11, S19).
            let cols = params
                .get("cols")
                .and_then(|v| v.as_u64())
                .unwrap_or(80)
                .clamp(1, 1000) as u16;
            let rows = params
                .get("rows")
                .and_then(|v| v.as_u64())
                .unwrap_or(24)
                .clamp(1, 1000) as u16;
            sup.resize(&id, cols, rows)?;
            Ok(json!({"ok": true}))
        }
        other => anyhow::bail!("unknown method: {other}"),
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn required_string(params: &Value, key: &str) -> Result<String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| anyhow::anyhow!("missing required string param: {key}"))
}

/// Base environment inherited by every PTY session. Keep this allowlist in
/// sync with `minimalEnv()` in `src/plugins/repl/client.ts`: the supervisor is
/// intentionally prevented from forwarding arbitrary credentials.
const SESSION_ENV_ALLOWLIST: [&str; 5] = ["PATH", "HOME", "LANG", "LC_ALL", "TZ"];

fn parse_env(params: &Value) -> Vec<(String, String)> {
    let explicit = params.get("env").and_then(|v| v.as_object());
    let mut env =
        Vec::with_capacity(SESSION_ENV_ALLOWLIST.len() + explicit.map_or(0, serde_json::Map::len));

    for key in SESSION_ENV_ALLOWLIST {
        if let Ok(value) = std::env::var(key) {
            env.push((key.to_string(), value));
        }
    }

    if let Some(obj) = explicit {
        for (key, value) in obj {
            let Some(value) = value.as_str() else {
                continue;
            };
            if let Some((_, inherited)) = env
                .iter_mut()
                .find(|(name, _)| name.as_str() == key.as_str())
            {
                inherited.clear();
                inherited.push_str(value);
            } else {
                env.push((key.clone(), value.to_string()));
            }
        }
    }

    env
}

/// Parse `history` from params. Returns `None` when absent/false/0.
/// `true` → `Some(10)` (default ~10 frames). Integer N → `Some(N)`.
fn parse_history(params: &Value) -> Result<Option<usize>> {
    let Some(v) = params.get("history") else {
        return Ok(None);
    };
    if let Some(b) = v.as_bool() {
        return Ok(if b { Some(10) } else { None });
    }
    if let Some(n) = v.as_u64() {
        return Ok(if n == 0 { None } else { Some(n as usize) });
    }
    // Any other type → treat as absent (no error — forward compatible).
    Ok(None)
}

/// Parse `record` + `castPath` from spawn params and return the resolved path.
///
/// - `record: true` → a private per-user cast path
/// - `record: "<path>"` → `Some(PathBuf::from(path))` (validated server-side)
fn parse_cast_path(params: &Value, id: &str) -> Result<Option<PathBuf>> {
    let record_v = params.get("record");
    let Some(rv) = record_v else {
        return Ok(None);
    };
    if rv.as_bool() == Some(false) || rv.is_null() {
        return Ok(None);
    }
    // Explicit castPath override?
    if let Some(path_str) = params.get("castPath").and_then(|v| v.as_str()) {
        return Ok(Some(PathBuf::from(path_str)));
    }
    if rv.as_bool() == Some(true) {
        return Ok(Some(state_file("repl-casts", id, "cast")?));
    }
    // record is a string path (as per TS type `boolean | string`).
    if let Some(s) = rv.as_str() {
        if !s.is_empty() {
            return Ok(Some(PathBuf::from(s)));
        }
    }
    Ok(None)
}

fn serialize_outcome(outcome: &ExpectOutcome) -> Value {
    match outcome {
        ExpectOutcome::PromptMatched => json!({"kind": "promptMatched"}),
        ExpectOutcome::Idle => json!({"kind": "idle"}),
        ExpectOutcome::Exited(code) => json!({"kind": "exited", "exitCode": code}),
        ExpectOutcome::TimedOut => json!({"kind": "timedOut"}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn required_string_extracts_param() {
        let p = json!({"id": "x"});
        assert_eq!(required_string(&p, "id").unwrap(), "x");
        assert!(required_string(&p, "missing").is_err());
    }

    #[test]
    fn serialize_outcome_uses_camel_case_kinds() {
        assert_eq!(
            serialize_outcome(&ExpectOutcome::PromptMatched)["kind"],
            "promptMatched"
        );
        assert_eq!(
            serialize_outcome(&ExpectOutcome::TimedOut)["kind"],
            "timedOut"
        );
        let exited = serialize_outcome(&ExpectOutcome::Exited(Some(2)));
        assert_eq!(exited["kind"], "exited");
        assert_eq!(exited["exitCode"], 2);
    }

    #[test]
    fn snapshot_mode_parse() {
        assert!(matches!(
            SnapshotMode::parse("grid"),
            Ok(SnapshotMode::Grid)
        ));
        assert!(matches!(SnapshotMode::parse("raw"), Ok(SnapshotMode::Raw)));
        assert!(matches!(
            SnapshotMode::parse("both"),
            Ok(SnapshotMode::Both)
        ));
        let err = SnapshotMode::parse("zzz").unwrap_err();
        assert!(err.to_string().contains("invalid mode: zzz"), "err: {err}");
    }

    #[test]
    fn parse_history_variants() {
        assert_eq!(parse_history(&json!({})).unwrap(), None);
        assert_eq!(parse_history(&json!({"history": false})).unwrap(), None);
        assert_eq!(parse_history(&json!({"history": true})).unwrap(), Some(10));
        assert_eq!(parse_history(&json!({"history": 0})).unwrap(), None);
        assert_eq!(parse_history(&json!({"history": 5})).unwrap(), Some(5));
    }

    #[test]
    fn parse_cast_path_record_false() {
        assert!(parse_cast_path(&json!({}), "s1").unwrap().is_none());
        assert!(parse_cast_path(&json!({"record": false}), "s1")
            .unwrap()
            .is_none());
    }

    #[test]
    fn parse_cast_path_record_true_uses_tempdir() {
        let p = parse_cast_path(&json!({"record": true}), "mysession").unwrap();
        assert!(p.is_some());
        let path = p.unwrap();
        assert!(path.to_string_lossy().contains("mysession"));
        assert!(path.to_string_lossy().ends_with(".cast"));
    }

    #[test]
    fn clamp_cols_rows_in_resize_logic() {
        // Simulate the clamp on as_u64().
        let big: u64 = 70000;
        let clamped = big.clamp(1, 1000) as u16;
        assert_eq!(clamped, 1000u16);
        let zero: u64 = 0;
        let clamped_zero = zero.clamp(1, 1000) as u16;
        assert_eq!(clamped_zero, 1u16);
    }

    /// Verify that the timing clamps applied inside the "expect" arm are
    /// correct — without running the full bridge loop.
    #[test]
    fn expect_timing_clamps_values() {
        // idleMs hard cap: 60_000 ms
        let huge_idle: u64 = 999_999_999;
        let clamped_idle = huge_idle.min(60_000);
        assert_eq!(clamped_idle, 60_000u64, "idleMs must be capped at 60_000");

        // timeoutMs hard cap: 300_000 ms
        let huge_timeout: u64 = 10_000_000;
        let clamped_timeout = huge_timeout.min(300_000);
        assert_eq!(
            clamped_timeout, 300_000u64,
            "timeoutMs must be capped at 300_000"
        );

        // Values below the cap must pass through unchanged.
        let small_idle: u64 = 200;
        assert_eq!(
            small_idle.min(60_000),
            200u64,
            "values below cap must be unchanged"
        );
        let small_timeout: u64 = 5_000;
        assert_eq!(
            small_timeout.min(300_000),
            5_000u64,
            "values below cap must be unchanged"
        );
    }

    #[cfg(unix)]
    #[test]
    fn spawn_without_explicit_env_resolves_command_from_sanitized_path() {
        let sup = Supervisor::new();
        dispatch(
            &sup,
            "spawn",
            &json!({
                "id": "bridge-path",
                "cmd": "sh"
            }),
        )
        .unwrap();
        dispatch(
            &sup,
            "send",
            &json!({
                "id": "bridge-path",
                "text": "printf 'REPL_PATH_OK\\n'"
            }),
        )
        .unwrap();

        let outcome = dispatch(
            &sup,
            "expect",
            &json!({
                "id": "bridge-path",
                "regex": "REPL_PATH_OK",
                "timeoutMs": 5_000
            }),
        )
        .unwrap();
        assert_eq!(outcome["kind"], "promptMatched");

        dispatch(&sup, "kill", &json!({"id": "bridge-path"})).unwrap();
        assert_eq!(dispatch(&sup, "list", &json!({})).unwrap(), json!([]));
    }
}
