//! Aurora Emulator automation through the stable `audb >= 0.2.0` JSON contract.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::Value;
use std::process::Command;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

static VERSION_CHECK: OnceLock<std::result::Result<(), String>> = OnceLock::new();

fn binary() -> String {
    std::env::var("AUDB_PATH").unwrap_or_else(|_| "audb".into())
}

fn ensure_supported_version() -> Result<()> {
    let check = VERSION_CHECK.get_or_init(|| {
        let bin = binary();
        let output = Command::new(&bin)
            .arg("--version")
            .output()
            .map_err(|error| {
                format!(
                    "Failed to execute {bin}: {error}. Install: cargo install audb-client --version 0.2.0, or set AUDB_PATH"
                )
            })?;
        if !output.status.success() {
            return Err(format!(
                "{bin} --version failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let version_output = String::from_utf8_lossy(&output.stdout);
        let version = version_output
            .split_whitespace()
            .find(|part| part.chars().next().is_some_and(|ch| ch.is_ascii_digit()))
            .ok_or_else(|| format!("Could not parse audb version from: {}", version_output.trim()))?;
        let mut components = version.split('.').map(|part| {
            part.trim_end_matches(|ch: char| !ch.is_ascii_digit())
                .parse::<u64>()
                .unwrap_or(0)
        });
        let major = components.next().unwrap_or(0);
        let minor = components.next().unwrap_or(0);
        if (major, minor) < (0, 2) {
            return Err(format!(
                "audb >=0.2.0 is required, found {version}. Install: cargo install audb-client --version 0.2.0"
            ));
        }
        Ok(())
    });
    check.clone().map_err(anyhow::Error::msg)
}

fn command(device: Option<&str>, args: &[String]) -> Result<Value> {
    ensure_supported_version()?;
    if let Some(id) = device {
        if id != "emulator" {
            bail!("Aurora audb >=0.2.0 is emulator-only; expected --device emulator, got {id}");
        }
    }
    let bin = binary();
    let mut process = Command::new(&bin);
    process.arg("--json");
    if let Some(id) = device {
        process.arg("--device").arg(id);
    }
    process.args(args);
    let output = process
        .output()
        .with_context(|| format!("Failed to execute {bin}. Install: cargo install audb-client --version 0.2.0, or set AUDB_PATH"))?;
    let raw = String::from_utf8_lossy(&output.stdout);
    let envelope: Value = serde_json::from_str(raw.trim()).with_context(|| {
        format!(
            "audb returned invalid JSON (stderr: {})",
            String::from_utf8_lossy(&output.stderr).trim()
        )
    })?;
    if envelope["ok"] != true {
        let code = envelope["error"]["code"].as_str().unwrap_or("AUDB_ERROR");
        let message = envelope["error"]["message"]
            .as_str()
            .unwrap_or("audb command failed");
        bail!("{code}: {message}");
    }
    Ok(envelope.get("data").cloned().unwrap_or(Value::Null))
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

pub fn passthrough(args: &[String]) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(&command(None, args)?)?);
    Ok(())
}

pub fn screenshot(device: Option<&str>) -> Result<Vec<u8>> {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let path = std::env::temp_dir().join(format!("cim-aurora-{}-{nonce}.png", std::process::id()));
    let args = vec!["screenshot".into(), "--output".into(), path.to_string_lossy().into_owned()];
    command(device, &args)?;
    let result = std::fs::read(&path).with_context(|| format!("audb did not create {}", path.display()));
    let _ = std::fs::remove_file(path);
    result
}

pub fn get_screen_size(device: Option<&str>) -> Result<(u32, u32)> {
    let value = command(
        device,
        &["shell".into(), "cat /sys/class/graphics/fb0/virtual_size".into()],
    )?;
    let output = output_text(value);
    let (width, height) = output
        .trim()
        .split_once(',')
        .context("Aurora framebuffer returned an invalid virtual_size")?;
    Ok((
        width.trim().parse().context("Invalid Aurora framebuffer width")?,
        height.trim().parse().context("Invalid Aurora framebuffer height")?,
    ))
}

pub fn tap(x: i32, y: i32, device: Option<&str>) -> Result<()> {
    command(device, &["tap".into(), x.to_string(), y.to_string()])?;
    println!("Tapped at ({x}, {y})");
    Ok(())
}

pub fn long_press(x: i32, y: i32, duration: u32, device: Option<&str>) -> Result<()> {
    command(device, &["tap".into(), x.to_string(), y.to_string(), "--duration".into(), duration.to_string()])?;
    println!("Long pressed at ({x}, {y}) for {duration}ms");
    Ok(())
}

pub fn swipe(x1: i32, y1: i32, x2: i32, y2: i32, duration: u32, device: Option<&str>) -> Result<()> {
    command(device, &["swipe".into(), x1.to_string(), y1.to_string(), x2.to_string(), y2.to_string(), "--duration".into(), duration.to_string()])?;
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
    command(device, &["text".into(), text.into()])?;
    println!("Input text: {text}");
    Ok(())
}

pub fn press_key(key: &str, device: Option<&str>) -> Result<()> {
    command(device, &["key".into(), key.into()])?;
    println!("Pressed key: {key}");
    Ok(())
}

pub fn shell(shell_command: &str, root: bool, device: Option<&str>) -> Result<String> {
    let mut args = vec!["shell".into()];
    if root {
        args.push("--root".into());
    }
    args.push(shell_command.into());
    let value = command(device, &args)?;
    let text = output_text(value);
    print!("{text}");
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
    command(device, &owned(&["package", "install", path]))?;
    println!("Installed: {path}");
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
    println!("{}", serde_json::to_string_pretty(&command(device, &owned(&["info"]))?)?);
    Ok(())
}

pub fn list_apps(filter: Option<&str>, device: Option<&str>) -> Result<()> {
    let mut args = owned(&["package", "list"]);
    if let Some(filter) = filter {
        args.extend(["--filter".into(), filter.into()]);
    }
    println!("{}", serde_json::to_string_pretty(&command(device, &args)?)?);
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
    Ok(value.as_array().into_iter().flatten().map(|item| Device {
        serial: item["id"].as_str().unwrap_or("emulator").into(),
        state: item["state"].as_str().unwrap_or("offline").into(),
    }).collect())
}

pub fn print_devices() -> Result<()> {
    println!("Aurora OS devices:\n{}", serde_json::to_string_pretty(&list_devices()?)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_text_unwraps_audb_text_shape() {
        assert_eq!(output_text(serde_json::json!({"output":"hello"})), "hello");
    }
}
