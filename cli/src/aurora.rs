//! Aurora OS device automation via audb.
//!
//! # Shell-injection invariant (CWE-78)
//!
//! Any string handed to `audb shell <string>` is re-parsed by `sh` on the
//! device. Every dynamic segment of such a string MUST go through
//! [`crate::utils::device_shell::DeviceShellCmd`] — never `format!`. See
//! the matching note at the top of `android.rs` for the audit checklist.

use anyhow::{bail, Result};
use serde::Serialize;
use std::process::Command;
use std::time::Duration;

use crate::utils::device_shell::DeviceShellCmd;
use crate::utils::process::{ensure_success, run_with_limits, terminal_safe};

/// Build audb command with optional device serial
fn audb_cmd(device: Option<&str>) -> Command {
    let mut cmd = Command::new("audb");
    if let Some(serial) = device {
        cmd.arg("-s").arg(serial);
    }
    cmd
}

/// Execute audb command with bounded output and a hard deadline.
fn audb_exec(device: Option<&str>, args: &[&str]) -> Result<std::process::Output> {
    let mut command = audb_cmd(device);
    command.args(args);
    run_with_limits(
        &mut command,
        Duration::from_secs(120),
        64 * 1024 * 1024,
        "AUDB command",
    )
}

fn audb_shell(device: Option<&str>, args: &[&str]) -> Result<std::process::Output> {
    let mut command = DeviceShellCmd::new();
    for arg in args {
        command = command.user_input(arg);
    }
    let rendered = command.render();
    audb_exec(device, &["shell", &rendered])
}

/// Take screenshot and return PNG bytes
pub fn screenshot(device: Option<&str>) -> Result<Vec<u8>> {
    let output = audb_exec(device, &["exec-out", "screencap", "-p"])?;

    if !output.status.success() {
        bail!("audb screencap failed: {}", terminal_safe(&output.stderr));
    }

    Ok(output.stdout)
}

/// Tap at coordinates
pub fn tap(x: i32, y: i32, device: Option<&str>) -> Result<()> {
    let output = audb_shell(device, &["input", "tap", &x.to_string(), &y.to_string()])?;

    if !output.status.success() {
        bail!("audb tap failed: {}", terminal_safe(&output.stderr));
    }

    println!("Tapped at ({}, {})", x, y);
    Ok(())
}

/// Long press at coordinates
pub fn long_press(x: i32, y: i32, duration: u32, device: Option<&str>) -> Result<()> {
    let output = audb_shell(
        device,
        &[
            "input",
            "swipe",
            &x.to_string(),
            &y.to_string(),
            &x.to_string(),
            &y.to_string(),
            &duration.to_string(),
        ],
    )?;

    if !output.status.success() {
        bail!("audb long press failed: {}", terminal_safe(&output.stderr));
    }

    println!("Long pressed at ({}, {}) for {}ms", x, y, duration);
    Ok(())
}

/// Swipe gesture
pub fn swipe(
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
    duration: u32,
    device: Option<&str>,
) -> Result<()> {
    let output = audb_shell(
        device,
        &[
            "input",
            "swipe",
            &x1.to_string(),
            &y1.to_string(),
            &x2.to_string(),
            &y2.to_string(),
            &duration.to_string(),
        ],
    )?;

    if !output.status.success() {
        bail!("audb swipe failed: {}", terminal_safe(&output.stderr));
    }

    println!("Swiped from ({}, {}) to ({}, {})", x1, y1, x2, y2);
    Ok(())
}

/// Input text via `audb shell input text <string>`.
///
/// Same shape as the Android equivalent: spaces are mapped to the `%s`
/// sentinel expected by Android's `input text`, then the whole payload is
/// POSIX single-quoted by [`DeviceShellCmd`].
pub fn input_text(text: &str, device: Option<&str>) -> Result<()> {
    let with_space_sentinel = text.replace(' ', "%s");
    let shell_cmd = DeviceShellCmd::new()
        .literal("input")
        .literal("text")
        .user_input(&with_space_sentinel)
        .render();
    let output = audb_exec(device, &["shell", &shell_cmd])?;

    if !output.status.success() {
        bail!("audb input text failed");
    }

    println!("Input accepted ({} characters)", text.chars().count());
    Ok(())
}

/// Press a key
pub fn press_key(key: &str, device: Option<&str>) -> Result<()> {
    let keycode = match key.to_lowercase().as_str() {
        "home" => "KEYCODE_HOME",
        "back" => "KEYCODE_BACK",
        "enter" | "return" => "KEYCODE_ENTER",
        "tab" => "KEYCODE_TAB",
        "delete" | "backspace" => "KEYCODE_DEL",
        "menu" => "KEYCODE_MENU",
        "power" => "KEYCODE_POWER",
        "volume_up" => "KEYCODE_VOLUME_UP",
        "volume_down" => "KEYCODE_VOLUME_DOWN",
        "space" => "KEYCODE_SPACE",
        "escape" | "esc" => "KEYCODE_ESCAPE",
        "up" => "KEYCODE_DPAD_UP",
        "down" => "KEYCODE_DPAD_DOWN",
        "left" => "KEYCODE_DPAD_LEFT",
        "right" => "KEYCODE_DPAD_RIGHT",
        _ => key,
    };

    let output = audb_shell(device, &["input", "keyevent", keycode])?;

    if !output.status.success() {
        bail!("audb keyevent failed: {}", terminal_safe(&output.stderr));
    }

    println!(
        "Pressed key: {} ({})",
        terminal_safe(key.as_bytes()),
        terminal_safe(keycode.as_bytes()),
    );
    Ok(())
}

/// Execute shell command on device
pub fn shell(command: &str, device: Option<&str>) -> Result<String> {
    let output = audb_exec(device, &["shell", command])?;

    let stdout = terminal_safe(&output.stdout);
    if !output.status.success() && !output.stderr.is_empty() {
        eprintln!("{}", terminal_safe(&output.stderr));
    }
    print!("{stdout}");
    Ok(stdout)
}

/// Launch an app using Silica invoker
pub fn launch_app(package: &str, device: Option<&str>) -> Result<()> {
    let output = audb_shell(device, &["invoker", "--type=silica-qt5", package])?;

    if !output.status.success() {
        bail!("Failed to launch app");
    }

    println!("Launched: {}", terminal_safe(package.as_bytes()));
    Ok(())
}

/// Stop an app
pub fn stop_app(package: &str, device: Option<&str>) -> Result<()> {
    let output = audb_shell(device, &["pkill", "-f", package])?;

    if !output.status.success() {
        bail!("Failed to stop app");
    }

    println!("Stopped: {}", terminal_safe(package.as_bytes()));
    Ok(())
}

/// Install an RPM package
pub fn install_app(path: &str, device: Option<&str>) -> Result<()> {
    println!("Installing {}...", terminal_safe(path.as_bytes()));

    let output = audb_exec(device, &["install", path])?;

    if !output.status.success() {
        bail!("Failed to install: {}", terminal_safe(&output.stderr));
    }

    println!("Installed: {}", terminal_safe(path.as_bytes()));
    Ok(())
}

/// Uninstall an app via rpm
pub fn uninstall_app(package: &str, device: Option<&str>) -> Result<()> {
    println!("Uninstalling {}...", terminal_safe(package.as_bytes()));

    let output = audb_shell(device, &["rpm", "-e", package])?;

    if !output.status.success() {
        bail!("Failed to uninstall app");
    }

    println!("Uninstalled: {}", terminal_safe(package.as_bytes()));
    Ok(())
}

/// Push file to device
pub fn push_file(local: &str, remote: &str, device: Option<&str>) -> Result<()> {
    let output = audb_exec(device, &["push", local, remote])?;

    if !output.status.success() {
        bail!("audb push failed: {}", terminal_safe(&output.stderr));
    }

    println!(
        "Pushed {} -> {}",
        terminal_safe(local.as_bytes()),
        terminal_safe(remote.as_bytes())
    );
    Ok(())
}

/// Pull file from device
pub fn pull_file(remote: &str, local: &str, device: Option<&str>) -> Result<()> {
    let output = audb_exec(device, &["pull", remote, local])?;

    if !output.status.success() {
        bail!("audb pull failed: {}", terminal_safe(&output.stderr));
    }

    println!(
        "Pulled {} -> {}",
        terminal_safe(remote.as_bytes()),
        terminal_safe(local.as_bytes())
    );
    Ok(())
}

/// Get device logs via journalctl.
///
/// `lines` is a `usize` so it is metachar-free by construction; the optional
/// `filter` is user-controlled and is POSIX-quoted by the builder.
pub fn get_logs(filter: Option<&str>, lines: usize, device: Option<&str>) -> Result<()> {
    let lines_str = lines.to_string();
    let mut builder = DeviceShellCmd::new()
        .literal("journalctl")
        .literal("-n")
        .user_input(&lines_str);
    if let Some(f) = filter {
        // `--grep=<pattern>` is one argv token; the prefix is a static
        // literal and the value is quoted by the builder. `format!` only
        // composes a string here — it does not reach the shell on its own.
        let grep_arg = format!("--grep={}", f);
        builder = builder.user_input(&grep_arg);
    }
    let cmd = builder.render();

    let output = audb_exec(device, &["shell", &cmd])?;

    if !output.status.success() {
        bail!("journalctl failed: {}", terminal_safe(&output.stderr));
    }

    print!("{}", terminal_safe(&output.stdout));
    Ok(())
}

/// Clear device logs
pub fn clear_logs(device: Option<&str>) -> Result<()> {
    let output = audb_exec(
        device,
        &[
            "shell",
            "journalctl --rotate && journalctl --vacuum-time=1s",
        ],
    )?;

    if !output.status.success() {
        bail!("Failed to clear logs: {}", terminal_safe(&output.stderr));
    }

    println!("Logs cleared");
    Ok(())
}

/// Get system info (uname, os-release, memory)
pub fn get_system_info(device: Option<&str>) -> Result<()> {
    let uname = audb_exec(device, &["shell", "uname -a"])?;
    let uname_out = terminal_safe(&uname.stdout);

    let os_release = audb_exec(device, &["shell", "cat /etc/os-release"])?;
    let os_release_out = terminal_safe(&os_release.stdout);

    let mem = audb_exec(device, &["shell", "free -m"])?;
    let mem_out = terminal_safe(&mem.stdout);

    println!("System Info:");
    println!("--- Kernel ---");
    print!("{}", uname_out);
    println!("--- OS Release ---");
    print!("{}", os_release_out);
    println!("--- Memory ---");
    print!("{}", mem_out);

    Ok(())
}

/// List installed apps (RPM packages)
pub fn list_apps(filter: Option<&str>, device: Option<&str>) -> Result<()> {
    let output = audb_exec(device, &["shell", "rpm -qa"])?;

    if !output.status.success() {
        bail!("rpm -qa failed: {}", terminal_safe(&output.stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut apps: Vec<&str> = stdout
        .lines()
        .filter(|line| filter.map_or(true, |f| line.to_lowercase().contains(&f.to_lowercase())))
        .collect();

    apps.sort();

    println!("Installed packages ({}):", apps.len());
    for app in &apps {
        println!("  {}", terminal_safe(app.as_bytes()));
    }
    Ok(())
}

/// Open URL via xdg-open
pub fn open_url(url: &str, device: Option<&str>) -> Result<()> {
    let output = audb_shell(device, &["xdg-open", url])?;
    if !output.status.success() {
        bail!("Failed to open URL");
    }
    println!("URL opened");
    Ok(())
}

// ============== Device Management ==============

#[derive(Serialize)]
pub struct Device {
    pub serial: String,
    pub state: String,
}

/// List connected devices
pub fn list_devices() -> Result<Vec<Device>> {
    let mut command = Command::new("audb");
    command.arg("devices");
    let output = run_with_limits(
        &mut command,
        Duration::from_secs(30),
        1024 * 1024,
        "Aurora device listing",
    )?;
    ensure_success(&output, "Aurora device listing")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut devices = Vec::new();

    for line in stdout.lines().skip(1) {
        if line.trim().is_empty() {
            continue;
        }

        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 2 {
            devices.push(Device {
                serial: parts[0].to_string(),
                state: parts[1].to_string(),
            });
        }
    }

    Ok(devices)
}

/// Print devices list
pub fn print_devices() -> Result<()> {
    let devices = list_devices()?;
    println!("Aurora OS devices:");
    println!("{}", serde_json::to_string_pretty(&devices)?);
    Ok(())
}
