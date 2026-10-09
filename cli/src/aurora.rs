//! Aurora phone/emulator automation through the audb ^0.3.0 JSON contract.
use crate::utils::process::{run_with_limits, run_with_protocol_limits, terminal_safe};
use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

const MAX_OUTPUT: usize = 64 * 1024 * 1024;
const INSTALL: &str = "cargo install audb-client --version 0.3.0 --locked";

pub fn binary() -> Result<PathBuf> {
    let name = if cfg!(windows) { "audb.exe" } else { "audb" };
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(name);
            if !candidate.is_file() {
                continue;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if candidate.metadata()?.permissions().mode() & 0o111 == 0 {
                    continue;
                }
            }
            return Ok(candidate);
        }
    }
    if let Some(path) = std::env::var_os("AUDB_PATH") {
        return Ok(PathBuf::from(path));
    }
    bail!("AUDB_NOT_INSTALLED: audb not found in PATH; install: {INSTALL}, or set AUDB_PATH")
}

pub fn ensure_supported_version() -> Result<PathBuf> {
    let bin = binary()?;
    let output = run_with_limits(
        Command::new(&bin).arg("--version"),
        Duration::from_secs(5),
        4096,
        "audb version",
    )?;
    if !output.status.success() {
        bail!("AUDB_VERSION_CHECK_FAILED: update audb in PATH: {INSTALL}");
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let re = regex::Regex::new(r"^audb (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")?;
    let parts = re
        .captures(text.trim())
        .context("AUDB_VERSION_UNSUPPORTED: invalid audb version")?;
    let major: u64 = parts[1].parse()?;
    let minor: u64 = parts[2].parse()?;
    let patch: u64 = parts[3]
        .parse()
        .context("AUDB_VERSION_UNSUPPORTED: invalid patch version")?;
    if major != 0 || minor != 3 || patch > 9_007_199_254_740_991 {
        bail!(
            "AUDB_VERSION_UNSUPPORTED: audb ^0.3.0 required; update PATH binary: {INSTALL} --force"
        );
    }
    Ok(bin)
}

#[derive(Debug)]
pub struct AudbError {
    pub code: String,
    pub message: String,
    pub device_id: Option<String>,
    pub data: Option<Value>,
    pub exit_status: Option<i32>,
}
impl std::fmt::Display for AudbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut value = serde_json::json!({"code":self.code,"message":self.message,"deviceId":self.device_id,"exitStatus":self.exit_status});
        if let Some(data) = &self.data {
            value["data"] = data.clone();
        }
        write!(f, "{}", terminal_safe(value.to_string().as_bytes()))
    }
}
impl std::error::Error for AudbError {}

fn parse_envelope(bytes: &[u8], status: Option<i32>, expected: Option<&str>) -> Result<Value> {
    let envelope: Value = serde_json::from_slice(bytes)
        .context("AUDB_INVALID_RESPONSE: invalid JSON; command not repeated")?;
    if envelope["schemaVersion"] != 1
        || !envelope["ok"].is_boolean()
        || !(envelope
            .get("deviceId")
            .is_some_and(|v| v.is_null() || v.is_string()))
    {
        bail!("AUDB_INVALID_RESPONSE: expected audb schemaVersion 1");
    }
    if envelope["ok"] == false {
        return Err(AudbError {
            code: envelope["error"]["code"]
                .as_str()
                .context("AUDB_INVALID_RESPONSE: missing error code")?
                .into(),
            message: envelope["error"]["message"]
                .as_str()
                .context("AUDB_INVALID_RESPONSE: missing error message")?
                .into(),
            device_id: envelope["deviceId"].as_str().map(str::to_owned),
            data: envelope.get("data").cloned(),
            exit_status: status,
        }
        .into());
    }
    if status != Some(0) || expected.is_some_and(|id| envelope["deviceId"].as_str() != Some(id)) {
        bail!("AUDB_INVALID_RESPONSE: inconsistent success metadata; command not repeated");
    }
    envelope
        .get("data")
        .cloned()
        .context("AUDB_INVALID_RESPONSE: missing data")
}
fn command(device: Option<&str>, args: &[String]) -> Result<Value> {
    command_input(device, args, None)
}
fn command_input(device: Option<&str>, args: &[String], input: Option<Vec<u8>>) -> Result<Value> {
    let bin = ensure_supported_version()?;
    let target = if args.first().is_some_and(|a| a == "device") {
        None
    } else {
        Some(match device {
            Some(id) => id.to_owned(),
            None => command(None, &owned(&["device", "current"]))?["id"]
                .as_str()
                .context("AUDB_INVALID_RESPONSE: missing default device ID")?
                .to_owned(),
        })
    };
    let seconds = if args.first().is_some_and(|a| a == "package")
        && args.get(1).is_some_and(|a| a == "install")
    {
        300
    } else {
        120
    };
    let mut process = Command::new(bin);
    process.args(["--json", "--command-timeout", &seconds.to_string()]);
    if let Some(id) = &target {
        process.args(["--device", id]);
    }
    process.args(args);
    let output = run_with_protocol_limits(
        &mut process,
        input,
        Duration::from_secs(seconds + 5),
        MAX_OUTPUT,
        "audb",
    )
    .context("OUTCOME_UNKNOWN: audb response lost; command not repeated")?;
    if output.stdout.is_empty() {
        bail!("OUTCOME_UNKNOWN: audb response lost; command not repeated");
    }
    parse_envelope(&output.stdout, output.status.code(), target.as_deref())
}

fn owned(args: &[&str]) -> Vec<String> {
    args.iter().map(|v| (*v).to_owned()).collect()
}

fn output_text(value: Value) -> String {
    value
        .get("output")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            if let Some(text) = value.as_str() {
                text.to_owned()
            } else {
                serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string())
            }
        })
}

pub fn passthrough(device: Option<&str>, args: &[String]) -> Result<()> {
    println!(
        "{}",
        terminal_safe(serde_json::to_string_pretty(&command(device, args)?)?.as_bytes())
    );
    Ok(())
}

pub fn screenshot(device: Option<&str>) -> Result<Vec<u8>> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("screen.png");
    command(
        device,
        &[
            "screenshot".into(),
            "--output".into(),
            path.to_string_lossy().into_owned(),
        ],
    )?;
    if std::fs::metadata(&path)?.len() > MAX_OUTPUT as u64 {
        bail!("Aurora screenshot exceeds output limit");
    }
    std::fs::read(&path).context("audb did not create its screenshot")
}
pub fn get_screen_size(device: Option<&str>) -> Result<(u32, u32)> {
    let image = image::load_from_memory(&screenshot(device)?)?;
    Ok((image.width(), image.height()))
}

pub fn tap(x: i32, y: i32, device: Option<&str>) -> Result<()> {
    command(device, &["tap".into(), x.to_string(), y.to_string()])?;
    println!("Tapped at ({x}, {y})");
    Ok(())
}

pub fn long_press(x: i32, y: i32, duration: u32, device: Option<&str>) -> Result<()> {
    command(
        device,
        &[
            "tap".into(),
            x.to_string(),
            y.to_string(),
            "--duration".into(),
            duration.to_string(),
        ],
    )?;
    println!("Long pressed at ({x}, {y}) for {duration}ms");
    Ok(())
}

pub fn swipe(
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
    duration: u32,
    device: Option<&str>,
) -> Result<()> {
    command(
        device,
        &[
            "swipe".into(),
            x1.to_string(),
            y1.to_string(),
            x2.to_string(),
            y2.to_string(),
            "--duration".into(),
            duration.to_string(),
        ],
    )?;
    println!("Swiped from ({x1}, {y1}) to ({x2}, {y2})");
    Ok(())
}

pub fn swipe_direction(direction: &str, duration: u32, device: Option<&str>) -> Result<()> {
    command(
        device,
        &[
            "swipe".into(),
            direction.into(),
            "--duration".into(),
            duration.to_string(),
        ],
    )?;
    println!("Swiped {direction}");
    Ok(())
}

pub fn input_text(text: &str, device: Option<&str>) -> Result<()> {
    command_input(
        device,
        &owned(&["text", "--stdin"]),
        Some(text.as_bytes().to_vec()),
    )?;
    println!("Text submitted");
    Ok(())
}

pub fn press_key(key: &str, device: Option<&str>) -> Result<()> {
    command(device, &["key".into(), key.into()])?;
    println!("Pressed key: {key}");
    Ok(())
}

pub fn shell(shell_command: &str, root: bool, device: Option<&str>) -> Result<String> {
    let mut args = owned(&["shell"]);
    if root {
        args.push("--root".into());
    }
    args.push(shell_command.into());
    let text = output_text(command(device, &args)?);
    print!("{}", terminal_safe(text.as_bytes()));
    Ok(text)
}

pub fn launch_app(package: &str, device: Option<&str>) -> Result<()> {
    command(device, &owned(&["app", "launch", package]))?;
    println!("Launched: {package}");
    Ok(())
}

pub fn stop_app(package: &str, device: Option<&str>) -> Result<()> {
    command(device, &owned(&["app", "stop", package]))?;
    println!("Stopped: {package}");
    Ok(())
}

pub fn install_app(path: &str, device: Option<&str>) -> Result<()> {
    println!(
        "{}",
        output_text(command(device, &owned(&["package", "install", path]))?)
    );
    Ok(())
}

pub fn uninstall_app(package: &str, device: Option<&str>) -> Result<()> {
    command(device, &owned(&["package", "uninstall", package]))?;
    println!("Uninstalled: {package}");
    Ok(())
}

pub fn push_file(local: &str, remote: &str, device: Option<&str>) -> Result<()> {
    command(device, &owned(&["push", local, remote]))?;
    println!("Pushed {local} -> {remote}");
    Ok(())
}

pub fn pull_file(remote: &str, local: &str, device: Option<&str>) -> Result<()> {
    command(device, &owned(&["pull", remote, "--output", local]))?;
    println!("Pulled {remote} -> {local}");
    Ok(())
}

pub fn get_logs(filter: Option<&str>, lines: usize, device: Option<&str>) -> Result<()> {
    let mut args = vec!["logs".into(), "--lines".into(), lines.to_string()];
    if let Some(filter) = filter {
        args.extend(["--grep".into(), filter.into()]);
    }
    print!("{}", output_text(command(device, &args)?));
    Ok(())
}

pub fn clear_logs(device: Option<&str>) -> Result<()> {
    command(device, &owned(&["logs", "--clear", "--force"]))?;
    println!("Logs cleared");
    Ok(())
}

pub fn get_system_info(device: Option<&str>) -> Result<()> {
    println!(
        "{}",
        serde_json::to_string_pretty(&command(device, &owned(&["info"]))?)?
    );
    Ok(())
}

pub fn list_apps(filter: Option<&str>, device: Option<&str>) -> Result<()> {
    let mut args = owned(&["package", "list"]);
    if let Some(filter) = filter {
        args.extend(["--filter".into(), filter.into()]);
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&command(device, &args)?)?
    );
    Ok(())
}

pub fn open_url(url: &str, device: Option<&str>) -> Result<()> {
    command(device, &owned(&["open", url]))?;
    println!("Opened URL: {url}");
    Ok(())
}

#[derive(Serialize)]
pub struct Device {
    pub serial: String,
    pub state: String,
}

pub fn list_devices() -> Result<Vec<Device>> {
    let value = command(None, &owned(&["device", "list"]))?;
    if !value.is_array() {
        bail!("AUDB_INVALID_RESPONSE: device inventory is not an array");
    }
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            Ok(Device {
                serial: item["id"]
                    .as_str()
                    .context("AUDB_INVALID_RESPONSE: missing device ID")?
                    .into(),
                state: item["state"]
                    .as_str()
                    .context("AUDB_INVALID_RESPONSE: missing device state")?
                    .into(),
            })
        })
        .collect()
}

pub fn print_devices() -> Result<()> {
    println!(
        "Aurora OS devices:\n{}",
        serde_json::to_string_pretty(&list_devices()?)?
    );
    Ok(())
}

pub fn permission_grant(
    package: &str,
    permission: &str,
    disable_prompt: bool,
    device: Option<&str>,
) -> Result<()> {
    let mut args = owned(&["permission", "grant", package, permission]);
    if disable_prompt {
        args.push("--disable-prompt".into());
    }
    passthrough(device, &args)
}
pub fn permission_revoke(package: &str, permission: &str, device: Option<&str>) -> Result<()> {
    passthrough(
        device,
        &owned(&["permission", "revoke", package, permission]),
    )
}
pub fn permission_reset(package: &str, device: Option<&str>) -> Result<()> {
    passthrough(device, &owned(&["permission", "reset", package]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_text_unwraps_audb_text_shape() {
        assert_eq!(output_text(serde_json::json!({"output":"hello"})), "hello");
    }
}
