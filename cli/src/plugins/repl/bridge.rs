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

use anyhow::Result;
use serde::Deserialize;
use serde_json::{json, Value};

use super::expect::ExpectOutcome;
use super::supervisor::{SpawnRequest, Supervisor};

#[derive(Deserialize)]
struct Request {
    id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

pub fn run_supervisor_loop() -> Result<()> {
    let supervisor = Supervisor::new();
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();

    writeln!(out, "{}", json!({"event":"ready","apiVersion":"1"}))?;
    out.flush().ok();

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
                writeln!(
                    out,
                    "{}",
                    json!({"id":"","error":format!("invalid request: {e}")})
                )?;
                out.flush().ok();
                continue;
            }
        };
        if req.method == "shutdown" {
            for info in supervisor.list() {
                let _ = supervisor.kill(&info.id);
            }
            writeln!(out, "{}", json!({"id":req.id,"result":"ok"}))?;
            out.flush().ok();
            break;
        }
        let response = dispatch(&supervisor, &req.method, &req.params);
        let envelope = match response {
            Ok(value) => json!({"id":req.id,"result":value}),
            Err(e) => json!({"id":req.id,"error":format!("{e}")}),
        };
        writeln!(out, "{envelope}")?;
        out.flush().ok();
    }
    Ok(())
}

fn dispatch(sup: &Supervisor, method: &str, params: &Value) -> Result<Value> {
    match method {
        "spawn" => {
            let id = required_string(params, "id")?;
            let cmd = required_string(params, "cmd")?;
            let cwd = params.get("cwd").and_then(|v| v.as_str()).map(String::from);
            let cols = params.get("cols").and_then(|v| v.as_u64()).unwrap_or(120) as u16;
            let rows = params.get("rows").and_then(|v| v.as_u64()).unwrap_or(40) as u16;
            let prompt_regex = params
                .get("promptRegex")
                .and_then(|v| v.as_str())
                .map(String::from);
            let env = parse_env(params);
            sup.spawn(SpawnRequest {
                id: id.clone(),
                cmd,
                cwd,
                env,
                cols,
                rows,
                prompt_regex,
            })?;
            Ok(json!({"id": id}))
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
            let regex = params.get("regex").and_then(|v| v.as_str()).map(String::from);
            let idle = params.get("idleMs").and_then(|v| v.as_u64()).unwrap_or(300);
            let timeout = params
                .get("timeoutMs")
                .and_then(|v| v.as_u64())
                .unwrap_or(5_000);
            let outcome = sup.expect(&id, regex.as_deref(), idle, timeout)?;
            Ok(serialize_outcome(&outcome))
        }
        "snapshot" => {
            let id = required_string(params, "id")?;
            let tail = params
                .get("tail")
                .and_then(|v| v.as_u64())
                .map(|n| n as usize);
            let snap = sup.snapshot(&id, tail)?;
            Ok(serde_json::to_value(&snap)?)
        }
        "list" => Ok(serde_json::to_value(sup.list())?),
        "kill" => {
            let id = required_string(params, "id")?;
            sup.kill(&id)?;
            Ok(json!({"ok": true}))
        }
        other => anyhow::bail!("unknown method: {other}"),
    }
}

fn required_string(params: &Value, key: &str) -> Result<String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| anyhow::anyhow!("missing required string param: {key}"))
}

fn parse_env(params: &Value) -> Vec<(String, String)> {
    let Some(obj) = params.get("env").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    obj.iter()
        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
        .collect()
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
    fn parse_env_handles_missing_and_non_string() {
        let p = json!({});
        assert!(parse_env(&p).is_empty());
        let p2 = json!({"env": {"K": "V", "BAD": 42}});
        let kv = parse_env(&p2);
        assert_eq!(kv, vec![("K".into(), "V".into())]);
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
}
