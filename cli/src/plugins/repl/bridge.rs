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
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;

use anyhow::Result;
use serde::Deserialize;
use serde_json::{json, Value};

use super::expect::{
    validate_expect_durations, ExpectOutcome, DEFAULT_EXPECT_IDLE_MS, DEFAULT_EXPECT_TIMEOUT_MS,
};
use super::supervisor::{
    validate_byte_limit, validate_env_entry, validate_environment, validate_session_id,
    SnapshotMode, SpawnRequest, Supervisor, MAX_CAST_PATH_BYTES, MAX_CMD_BYTES, MAX_CWD_BYTES,
    MAX_ENV_ENTRIES, MAX_ENV_TOTAL_BYTES, MAX_KEY_BYTES, MAX_PROMPT_REGEX_BYTES, MAX_SEND_BYTES,
    MAX_TERMINAL_DIMENSION, MIN_TERMINAL_DIMENSION,
};
use crate::utils::private_state::state_file;
const MAX_REQUEST_LINE_BYTES: usize = 1024 * 1024;
const MAX_IN_FLIGHT_REQUESTS: usize = 32;

struct RequestPermit(Arc<AtomicUsize>);

impl Drop for RequestPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Release);
    }
}

fn try_acquire_request_permit(in_flight: &Arc<AtomicUsize>) -> Option<RequestPermit> {
    in_flight
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
            (count < MAX_IN_FLIGHT_REQUESTS).then_some(count + 1)
        })
        .ok()
        .map(|_| RequestPermit(Arc::clone(in_flight)))
}

#[derive(Debug, PartialEq, Eq)]
enum RequestLine {
    Line,
    TooLong,
    Eof,
}

fn read_request_line<R: BufRead>(reader: &mut R, buffer: &mut Vec<u8>) -> io::Result<RequestLine> {
    buffer.clear();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(if buffer.is_empty() {
                RequestLine::Eof
            } else {
                RequestLine::Line
            });
        }

        let newline = available.iter().position(|byte| *byte == b'\n');
        let content_len = newline.unwrap_or(available.len());
        if buffer.len().saturating_add(content_len) > MAX_REQUEST_LINE_BYTES {
            let consumed = newline.map_or(available.len(), |index| index + 1);
            reader.consume(consumed);
            if newline.is_none() {
                discard_request_line(reader)?;
            }
            buffer.clear();
            return Ok(RequestLine::TooLong);
        }

        buffer.extend_from_slice(&available[..content_len]);
        let consumed = newline.map_or(available.len(), |index| index + 1);
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(RequestLine::Line);
        }
    }
}

fn discard_request_line<R: BufRead>(reader: &mut R) -> io::Result<()> {
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(());
        }
        let consumed = match available.iter().position(|byte| *byte == b'\n') {
            Some(index) => index + 1,
            None => available.len(),
        };
        let complete = consumed < available.len() || available[consumed - 1] == b'\n';
        reader.consume(consumed);
        if complete {
            return Ok(());
        }
    }
}

#[derive(Deserialize)]
struct Request {
    id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

pub fn run_supervisor_loop() -> Result<()> {
    let supervisor = Arc::new(Supervisor::new());
    let in_flight = Arc::new(AtomicUsize::new(0));
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
    let mut reader = stdin.lock();
    let mut line = Vec::with_capacity(1024);
    loop {
        match read_request_line(&mut reader, &mut line)? {
            RequestLine::Eof => break,
            RequestLine::TooLong => {
                let _ = tx.send(
                    json!({
                        "id": "",
                        "error": format!(
                            "request line exceeds the {MAX_REQUEST_LINE_BYTES}-byte limit"
                        )
                    })
                    .to_string(),
                );
                continue;
            }
            RequestLine::Line => {}
        }
        if line.iter().all(|byte| byte.is_ascii_whitespace()) {
            continue;
        }
        let req: Request = match serde_json::from_slice(&line) {
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
        // session does not stall the read loop or other sessions. Admission is
        // capped so a client cannot exhaust resources with queued long waits.
        let Some(permit) = try_acquire_request_permit(&in_flight) else {
            let _ = tx.send(
                json!({
                    "id": req.id,
                    "error": format!(
                        "too many in-flight requests (maximum {MAX_IN_FLIGHT_REQUESTS})"
                    )
                })
                .to_string(),
            );
            continue;
        };
        let request_id = req.id.clone();
        let sup = Arc::clone(&supervisor);
        let thread_tx = tx.clone();
        let spawned = thread::Builder::new()
            .name("repl-bridge-request".into())
            .spawn(move || {
                let _permit = permit;
                let envelope = match dispatch(&sup, &req.method, &req.params) {
                    Ok(value) => json!({"id":req.id,"result":value}),
                    Err(e) => json!({"id":req.id,"error":format!("{e}")}),
                };
                let _ = thread_tx.send(envelope.to_string());
            });
        if spawned.is_err() {
            let _ = tx.send(
                json!({"id":request_id,"error":"unable to start request worker"}).to_string(),
            );
        }
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
            let id_value = required_session_id(params)?;
            let cmd_value = bounded_required_string(params, "cmd", MAX_CMD_BYTES)?;
            let cwd = optional_bounded_string(params, "cwd", MAX_CWD_BYTES)?.map(String::from);
            // Clamp cols/rows to 1..=1000 using as_u64() BEFORE casting to u16.
            let cols = params
                .get("cols")
                .and_then(|v| v.as_u64())
                .unwrap_or(120)
                .clamp(MIN_TERMINAL_DIMENSION as u64, MAX_TERMINAL_DIMENSION as u64)
                as u16;
            let rows = params
                .get("rows")
                .and_then(|v| v.as_u64())
                .unwrap_or(40)
                .clamp(MIN_TERMINAL_DIMENSION as u64, MAX_TERMINAL_DIMENSION as u64)
                as u16;
            let prompt_regex =
                optional_bounded_string(params, "promptRegex", MAX_PROMPT_REGEX_BYTES)?
                    .map(String::from);
            let shell = params
                .get("shell")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let env = parse_env(params)?;
            let cast_path = parse_cast_path(params, id_value)?;

            let result = sup.spawn(SpawnRequest {
                id: id_value.to_owned(),
                cmd: cmd_value.to_owned(),
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
            let id = required_session_id(params)?;
            let text = bounded_required_string(params, "text", MAX_SEND_BYTES)?;
            let with_newline = params
                .get("newline")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            sup.send(id, text, with_newline)?;
            Ok(json!({"ok": true}))
        }
        "key" => {
            let id = required_session_id(params)?;
            let key = bounded_required_string(params, "key", MAX_KEY_BYTES)?;
            sup.send_key(id, key)?;
            Ok(json!({"ok": true}))
        }
        "expect" => {
            let id = required_session_id(params)?;
            let regex = optional_bounded_string(params, "regex", MAX_PROMPT_REGEX_BYTES)?;
            // Hard caps prevent a caller from blocking the server for hours.
            //
            // Live / animated TUI programs (monet tui, top, htop, watch …) emit
            // output continuously — the idle-based readiness heuristic never
            // fires because `last_activity` is reset on every redraw chunk. For
            // such programs use `repl_snapshot` instead (instantaneous, never
            // blocks). Idle-based `expect` will always run to full `timeout` on
            // a non-stopping TUI, so keep `timeoutMs` small or use `snapshot`.
            let idle = parse_expect_idle(params)?;
            let timeout = parse_expect_timeout(params)?;
            let outcome = sup.expect(id, regex, idle, timeout)?;
            Ok(serialize_outcome(&outcome))
        }
        "snapshot" => {
            let id = required_session_id(params)?;

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
            let snap = sup.snapshot(id, mode, history, tail)?;
            Ok(serde_json::to_value(&snap)?)
        }
        "list" => Ok(serde_json::to_value(sup.list())?),
        "kill" => {
            let id = required_session_id(params)?;
            sup.kill(id)?;
            Ok(json!({"ok": true}))
        }
        "resize" => {
            let id = required_session_id(params)?;
            // Clamp cols/rows to 1..=1000 using as_u64() BEFORE casting to u16 (R11, S19).
            let cols = params
                .get("cols")
                .and_then(|v| v.as_u64())
                .unwrap_or(80)
                .clamp(MIN_TERMINAL_DIMENSION as u64, MAX_TERMINAL_DIMENSION as u64)
                as u16;
            let rows = params
                .get("rows")
                .and_then(|v| v.as_u64())
                .unwrap_or(24)
                .clamp(MIN_TERMINAL_DIMENSION as u64, MAX_TERMINAL_DIMENSION as u64)
                as u16;
            sup.resize(id, cols, rows)?;
            Ok(json!({"ok": true}))
        }
        other => anyhow::bail!("unknown method: {other}"),
    }
}

// ---------------------------------------------------------------------------
fn required_string<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing required string param: {key}"))
}

fn required_session_id(params: &Value) -> Result<&str> {
    let id = required_string(params, "id")?;
    validate_session_id(id)?;
    Ok(id)
}

fn bounded_required_string<'a>(params: &'a Value, key: &str, max_bytes: usize) -> Result<&'a str> {
    let value = required_string(params, key)?;
    validate_byte_limit(key, value, max_bytes)?;
    Ok(value)
}

fn optional_bounded_string<'a>(
    params: &'a Value,
    key: &str,
    max_bytes: usize,
) -> Result<Option<&'a str>> {
    let Some(value) = params.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let value = value
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("param {key} must be a string"))?;
    validate_byte_limit(key, value, max_bytes)?;
    Ok(Some(value))
}

fn parse_expect_idle(params: &Value) -> Result<u64> {
    let Some(value) = params.get("idleMs") else {
        return Ok(DEFAULT_EXPECT_IDLE_MS);
    };
    let idle = value
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("idleMs must be a non-negative integer"))?;
    validate_expect_durations(idle, DEFAULT_EXPECT_TIMEOUT_MS)?;
    Ok(idle)
}

fn parse_expect_timeout(params: &Value) -> Result<u64> {
    let Some(value) = params.get("timeoutMs") else {
        return Ok(DEFAULT_EXPECT_TIMEOUT_MS);
    };
    let timeout = value
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("timeoutMs must be a non-negative integer"))?;
    validate_expect_durations(DEFAULT_EXPECT_IDLE_MS, timeout)?;
    Ok(timeout)
}

/// Base environment inherited by every PTY session. Keep this allowlist in
/// sync with `minimalEnv()` in `src/plugins/repl/client.ts`: the supervisor is
/// intentionally prevented from forwarding arbitrary credentials.
const SESSION_ENV_ALLOWLIST: [&str; 5] = ["PATH", "HOME", "LANG", "LC_ALL", "TZ"];

fn parse_env(params: &Value) -> Result<Vec<(String, String)>> {
    let explicit = match params.get("env") {
        None | Some(Value::Null) => None,
        Some(Value::Object(obj)) => Some(obj),
        Some(_) => anyhow::bail!("env must be an object of strings"),
    };
    if explicit.is_some_and(|obj| obj.len() > MAX_ENV_ENTRIES) {
        anyhow::bail!("env exceeds the {MAX_ENV_ENTRIES}-entry limit");
    }

    let mut explicit_bytes = 0usize;
    if let Some(obj) = explicit {
        for (key, value) in obj {
            let value = value
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("environment value for {key} must be a string"))?;
            explicit_bytes = explicit_bytes.saturating_add(validate_env_entry(key, value)?);
        }
    }
    if explicit_bytes > MAX_ENV_TOTAL_BYTES {
        anyhow::bail!("env exceeds the {MAX_ENV_TOTAL_BYTES}-byte limit");
    }

    let mut env = Vec::with_capacity(super::supervisor::MAX_ENV_TOTAL_ENTRIES);
    for key in SESSION_ENV_ALLOWLIST {
        if let Ok(value) = std::env::var(key) {
            validate_env_entry(key, &value)?;
            env.push((key.to_string(), value));
        }
    }

    if let Some(obj) = explicit {
        for (key, value) in obj {
            let value = value.as_str().expect("validated above");
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

    validate_environment(&env)?;
    Ok(env)
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
    validate_session_id(id)?;
    let record = params.get("record");
    let Some(record) = record else {
        return Ok(None);
    };
    if record.as_bool() == Some(false) || record.is_null() {
        return Ok(None);
    }

    if let Some(cast_path) = params.get("castPath") {
        if !cast_path.is_null() {
            let path = cast_path
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("castPath must be a string"))?;
            validate_byte_limit("castPath", path, MAX_CAST_PATH_BYTES)?;
            return Ok(Some(PathBuf::from(path)));
        }
    }
    if record.as_bool() == Some(true) {
        return Ok(Some(state_file("repl-casts", id, "cast")?));
    }
    if let Some(path) = record.as_str() {
        validate_byte_limit("record", path, MAX_CAST_PATH_BYTES)?;
        if !path.is_empty() {
            return Ok(Some(PathBuf::from(path)));
        }
        return Ok(None);
    }
    anyhow::bail!("record must be a boolean or string path")
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
    fn dispatch_rejects_oversized_inputs_before_supervisor_state_changes() {
        let sup = Supervisor::new();

        assert!(dispatch(&sup, "spawn", &json!({"id": "bad id", "cmd": "true"}),).is_err());

        let long_command = "x".repeat(MAX_CMD_BYTES + 1);
        assert!(dispatch(
            &sup,
            "spawn",
            &json!({"id": "long-command", "cmd": long_command}),
        )
        .is_err());

        assert!(dispatch(
            &sup,
            "send",
            &json!({"id": "missing", "text": "x".repeat(MAX_SEND_BYTES + 1)}),
        )
        .is_err());

        assert!(dispatch(
            &sup,
            "spawn",
            &json!({"id": "bad-env", "cmd": "true", "env": {"BAD-KEY": "x"}}),
        )
        .is_err());

        let mut oversized_env = serde_json::Map::new();
        for index in 0..=MAX_ENV_ENTRIES {
            oversized_env.insert(format!("VAR_{index}"), json!("x"));
        }
        assert!(dispatch(
            &sup,
            "spawn",
            &json!({"id": "large-env", "cmd": "true", "env": oversized_env}),
        )
        .is_err());

        assert!(dispatch(
            &sup,
            "spawn",
            &json!({
                "id": "large-record-path",
                "cmd": "true",
                "record": "x".repeat(MAX_CAST_PATH_BYTES + 1),
            }),
        )
        .is_err());
        assert!(sup.list().is_empty());
    }

    #[test]
    fn oversized_request_frame_is_discarded_before_the_next_request() {
        let mut input = vec![b'x'; MAX_REQUEST_LINE_BYTES + 1];
        input.extend_from_slice(b"\n{\"id\":\"next\",\"method\":\"list\"}\n");
        let mut reader = io::BufReader::new(input.as_slice());
        let mut buffer = Vec::new();

        assert_eq!(
            read_request_line(&mut reader, &mut buffer).unwrap(),
            RequestLine::TooLong
        );
        assert!(buffer.is_empty());
        assert_eq!(
            read_request_line(&mut reader, &mut buffer).unwrap(),
            RequestLine::Line
        );
        assert_eq!(buffer, br#"{"id":"next","method":"list"}"#);
        assert_eq!(
            read_request_line(&mut reader, &mut buffer).unwrap(),
            RequestLine::Eof
        );
    }

    #[test]
    fn request_admission_caps_concurrency_and_releases_slots() {
        let in_flight = Arc::new(AtomicUsize::new(0));
        let permits: Vec<_> = (0..MAX_IN_FLIGHT_REQUESTS)
            .map(|_| try_acquire_request_permit(&in_flight).expect("slot should be available"))
            .collect();

        assert_eq!(in_flight.load(Ordering::Acquire), MAX_IN_FLIGHT_REQUESTS);
        assert!(try_acquire_request_permit(&in_flight).is_none());

        let mut permits = permits.into_iter();
        drop(permits.next());
        assert_eq!(
            in_flight.load(Ordering::Acquire),
            MAX_IN_FLIGHT_REQUESTS - 1
        );
        let replacement = try_acquire_request_permit(&in_flight).expect("released slot reused");
        assert_eq!(in_flight.load(Ordering::Acquire), MAX_IN_FLIGHT_REQUESTS);

        drop(permits);
        drop(replacement);
        assert_eq!(in_flight.load(Ordering::Acquire), 0);
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

    #[test]
    fn expect_idle_defaults_only_when_omitted() {
        assert_eq!(
            parse_expect_idle(&json!({})).unwrap(),
            DEFAULT_EXPECT_IDLE_MS
        );
        assert!(parse_expect_idle(&json!({"idleMs": null})).is_err());
    }

    #[test]
    fn expect_timeout_defaults_only_when_omitted() {
        assert_eq!(
            parse_expect_timeout(&json!({})).unwrap(),
            DEFAULT_EXPECT_TIMEOUT_MS
        );
        assert!(parse_expect_timeout(&json!({"timeoutMs": null})).is_err());
    }

    #[test]
    fn expect_idle_accepts_values_through_public_maximum() {
        for idle in [0, 300, 60_000] {
            assert_eq!(parse_expect_idle(&json!({"idleMs": idle})).unwrap(), idle);
        }
    }

    #[test]
    fn expect_idle_rejects_invalid_fractional_negative_and_out_of_range_values() {
        for value in [
            json!(-1),
            json!(1.5),
            json!(60_001),
            json!("300"),
            json!(true),
        ] {
            let result = dispatch(
                &Supervisor::new(),
                "expect",
                &json!({"id": "missing", "idleMs": value}),
            );
            let error = result.expect_err("invalid idleMs must be rejected");
            assert!(
                error.to_string().contains("idleMs"),
                "unexpected validation error: {error}"
            );
        }
    }

    #[test]
    fn expect_timeout_accepts_values_through_public_maximum() {
        for timeout in [0, 295_000, 295_001, 300_000] {
            assert_eq!(
                parse_expect_timeout(&json!({"timeoutMs": timeout})).unwrap(),
                timeout
            );
        }
    }

    #[test]
    fn expect_timeout_rejects_invalid_fractional_negative_and_out_of_range_values() {
        for value in [
            json!(-1),
            json!(1.5),
            json!(300_001),
            json!("5000"),
            json!(true),
        ] {
            let result = dispatch(
                &Supervisor::new(),
                "expect",
                &json!({"id": "missing", "timeoutMs": value}),
            );
            let error = result.expect_err("invalid timeoutMs must be rejected");
            assert!(
                error.to_string().contains("timeoutMs"),
                "unexpected validation error: {error}"
            );
        }
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
