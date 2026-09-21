//! HarmonyOS device automation through the HDC command-line client.

use std::collections::BTreeSet;
use std::env;
use std::ffi::OsStr;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::time::Duration;

use crate::utils::device_shell::DeviceShellCmd;
use crate::utils::private_state::{private_temp_dir, read_bounded_file};
use crate::utils::process::{run_with_limits, terminal_safe};
use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Debug, Clone, Serialize)]
pub struct HarmonyDevice {
    pub serial: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HarmonyElement {
    pub class: String,
    pub text: String,
    pub resource_id: String,
    pub content_desc: String,
    pub bounds: (i32, i32, i32, i32),
    pub clickable: bool,
}

impl HarmonyElement {
    pub fn center(&self) -> (i32, i32) {
        (
            (self.bounds.0 + self.bounds.2) / 2,
            (self.bounds.1 + self.bounds.3) / 2,
        )
    }

    pub fn label(&self) -> &str {
        if !self.text.is_empty() {
            &self.text
        } else if !self.content_desc.is_empty() {
            &self.content_desc
        } else if !self.resource_id.is_empty() {
            &self.resource_id
        } else {
            &self.class
        }
    }
}

fn hdc_binary() -> PathBuf {
    env::var_os("HDC_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("hdc"))
}

fn hdc_command(device: Option<&str>) -> Command {
    let mut command = Command::new(hdc_binary());
    if let Some(serial) = device.filter(|value| !value.is_empty()) {
        command.arg("-t").arg(serial);
    }
    command
}

fn checked_output(action: &str, output: Output) -> Result<String> {
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    bail!("HDC {action} failed")
}

fn execute<I, S>(device: Option<&str>, args: I, action: &str) -> Result<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = hdc_command(device);
    command.args(args);
    let output = run_with_limits(
        &mut command,
        Duration::from_secs(120),
        64 * 1024 * 1024,
        "HDC command",
    )?;
    checked_output(action, output)
}

fn execute_shell<I, S>(device: Option<&str>, args: I, action: &str) -> Result<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut command = DeviceShellCmd::new();
    for arg in args {
        command = command.user_input(arg.as_ref());
    }
    let rendered = command.render();
    execute(device, ["shell", rendered.as_str()], action)
}

fn execute_sandbox_shell(
    device: Option<&str>,
    bundle: &str,
    args: &[&str],
    action: &str,
) -> Result<String> {
    let mut command = DeviceShellCmd::new();
    for arg in args {
        command = command.user_input(arg);
    }
    let rendered = command.render();
    execute(device, ["shell", "-b", bundle, rendered.as_str()], action)
}

fn transfer_generated_file(
    device: Option<&str>,
    kind: &str,
    extension: &str,
    create_args: &[&str],
) -> Result<Vec<u8>> {
    let temp_dir = private_temp_dir(kind)?;
    let nonce = temp_dir
        .path()
        .file_name()
        .and_then(|value| value.to_str())
        .context("temporary HDC directory name is not valid UTF-8")?;
    let name = format!("mcp-devices-cli-{kind}-{nonce}.{extension}");
    let remote = format!("/data/local/tmp/{name}");
    let local = temp_dir.path().join(&name);
    let local_text = local.to_string_lossy().into_owned();

    let result = (|| -> Result<Vec<u8>> {
        let mut args = create_args
            .iter()
            .map(|value| (*value).to_owned())
            .collect::<Vec<_>>();
        args.push(remote.clone());
        execute_shell(device, args, kind)?;
        execute(
            device,
            ["file", "recv", remote.as_str(), local_text.as_str()],
            &format!("receive {kind}"),
        )?;
        read_bounded_file(&local, 50 * 1024 * 1024, "generated HDC file")
            .with_context(|| format!("failed to read {}", local.display()))
    })();

    let _ = execute_shell(
        device,
        ["rm", "-f", remote.as_str()],
        "remove temporary file",
    );
    result
}

fn parse_devices(output: &str) -> Vec<HarmonyDevice> {
    let mut devices = Vec::new();
    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        let Some(serial) = fields.first() else {
            continue;
        };
        if serial.eq_ignore_ascii_case("connect") || serial.eq_ignore_ascii_case("empty") {
            continue;
        }
        let state = fields
            .iter()
            .skip(1)
            .find(|field| matches!(**field, "Connected" | "Offline" | "Unauthorized"))
            .copied()
            .unwrap_or("Connected");
        devices.push(HarmonyDevice {
            serial: (*serial).to_owned(),
            state: state.to_ascii_lowercase(),
        });
    }
    devices
}

fn json_string(object: &Map<String, Value>, keys: &[&str]) -> String {
    for key in keys {
        let Some(value) = object.get(*key) else {
            continue;
        };
        match value {
            Value::String(value) if !value.is_empty() => return value.clone(),
            Value::Number(value) => return value.to_string(),
            Value::Bool(value) => return value.to_string(),
            _ => {}
        }
    }
    String::new()
}

fn json_bool(object: &Map<String, Value>, key: &str) -> bool {
    match object.get(key) {
        Some(Value::Bool(value)) => *value,
        Some(Value::String(value)) => value == "true" || value == "1",
        Some(Value::Number(value)) => value.as_u64() == Some(1),
        _ => false,
    }
}

fn json_i32(value: Option<&Value>) -> Option<i32> {
    match value {
        Some(Value::Number(value)) => value.as_i64().and_then(|value| i32::try_from(value).ok()),
        Some(Value::String(value)) => value.parse().ok(),
        _ => None,
    }
}

fn parse_bounds(value: Option<&Value>) -> Option<(i32, i32, i32, i32)> {
    match value {
        Some(Value::String(value)) => {
            let numbers = value
                .split(|character: char| !character.is_ascii_digit() && character != '-')
                .filter(|part| !part.is_empty())
                .filter_map(|part| part.parse::<i32>().ok())
                .collect::<Vec<_>>();
            (numbers.len() == 4).then(|| (numbers[0], numbers[1], numbers[2], numbers[3]))
        }
        Some(Value::Object(object)) => {
            let x1 = json_i32(
                object
                    .get("left")
                    .or_else(|| object.get("x1"))
                    .or_else(|| object.get("x")),
            )?;
            let y1 = json_i32(
                object
                    .get("top")
                    .or_else(|| object.get("y1"))
                    .or_else(|| object.get("y")),
            )?;
            let x2 = json_i32(object.get("right").or_else(|| object.get("x2")))
                .or_else(|| json_i32(object.get("width")).map(|width| x1 + width))?;
            let y2 = json_i32(object.get("bottom").or_else(|| object.get("y2")))
                .or_else(|| json_i32(object.get("height")).map(|height| y1 + height))?;
            Some((x1, y1, x2, y2))
        }
        _ => None,
    }
}

fn collect_ui_elements(value: &Value, elements: &mut Vec<HarmonyElement>) {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_ui_elements(value, elements);
            }
        }
        Value::Object(object) => {
            let attributes = object
                .get("attributes")
                .and_then(Value::as_object)
                .unwrap_or(object);
            let is_node = object
                .get("attributes")
                .and_then(Value::as_object)
                .is_some()
                || attributes.contains_key("bounds")
                || attributes.contains_key("type")
                || attributes.contains_key("id");
            if is_node {
                if let Some(bounds) =
                    parse_bounds(attributes.get("bounds").or_else(|| object.get("bounds")))
                {
                    let element = HarmonyElement {
                        class: json_string(attributes, &["type", "className", "role"]),
                        text: json_string(attributes, &["text", "content", "value"]),
                        resource_id: json_string(
                            attributes,
                            &["id", "resourceId", "accessibilityId"],
                        ),
                        content_desc: json_string(
                            attributes,
                            &["description", "hint", "accessibilityText"],
                        ),
                        bounds,
                        clickable: json_bool(attributes, "clickable"),
                    };
                    if bounds.2 > bounds.0 && bounds.3 > bounds.1 {
                        elements.push(element);
                    }
                }
            }

            let mut found_children = false;
            for key in ["children", "child", "nodes", "windows"] {
                if let Some(child) = object.get(key) {
                    found_children = true;
                    collect_ui_elements(child, elements);
                }
            }
            if !is_node && !found_children {
                for child in object.values() {
                    collect_ui_elements(child, elements);
                }
            }
        }
        _ => {}
    }
}

fn parse_ui_elements(json: &str) -> Result<Vec<HarmonyElement>> {
    let root: Value = serde_json::from_str(json).context("HarmonyOS UI dump is not valid JSON")?;
    let mut elements = Vec::new();
    collect_ui_elements(&root, &mut elements);
    Ok(elements)
}

pub fn list_devices() -> Result<Vec<HarmonyDevice>> {
    let output = execute(None, ["list", "targets", "-v"], "list devices")?;
    Ok(parse_devices(&output))
}

pub fn print_devices() -> Result<()> {
    println!("{}", serde_json::to_string_pretty(&list_devices()?)?);
    Ok(())
}

pub fn screenshot(device: Option<&str>) -> Result<Vec<u8>> {
    transfer_generated_file(device, "screenshot", "png", &["uitest", "screenCap", "-p"])
}

pub fn tap(x: i32, y: i32, device: Option<&str>) -> Result<()> {
    execute_shell(
        device,
        ["uitest", "uiInput", "click", &x.to_string(), &y.to_string()],
        "tap screen",
    )?;
    Ok(())
}

pub fn long_press(x: i32, y: i32, duration_ms: u64, device: Option<&str>) -> Result<()> {
    execute_shell(
        device,
        [
            "uitest",
            "uiInput",
            "longClick",
            &x.to_string(),
            &y.to_string(),
            &duration_ms.to_string(),
        ],
        "long-press screen",
    )?;
    Ok(())
}

pub fn swipe(
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
    duration_ms: u64,
    device: Option<&str>,
) -> Result<()> {
    let duration = duration_ms.max(1) as f64;
    let distance = ((x2 - x1) as f64).hypot((y2 - y1) as f64);
    let velocity = (distance * 1000.0 / duration)
        .round()
        .clamp(200.0, 40_000.0) as u64;
    execute_shell(
        device,
        [
            "uitest",
            "uiInput",
            "swipe",
            &x1.to_string(),
            &y1.to_string(),
            &x2.to_string(),
            &y2.to_string(),
            &velocity.to_string(),
        ],
        "swipe screen",
    )?;
    Ok(())
}

pub fn input_text(text: &str, device: Option<&str>) -> Result<()> {
    execute_shell(device, ["uitest", "uiInput", "text", text], "input text")?;
    Ok(())
}

fn key_code(key: &str) -> Result<&str> {
    let code = match key.to_ascii_lowercase().as_str() {
        "back" => "2",
        "home" => "1",
        "power" => "18",
        "enter" => "2054",
        "delete" | "del" | "backspace" => "2055",
        "volumeup" | "volume_up" => "16",
        "volumedown" | "volume_down" => "17",
        "escape" | "esc" => "2070",
        _ if key.chars().all(|character| character.is_ascii_digit()) && !key.is_empty() => key,
        _ => bail!("unsupported HarmonyOS key: {key}"),
    };
    Ok(code)
}

pub fn press_key(key: &str, device: Option<&str>) -> Result<()> {
    execute_shell(
        device,
        ["uitest", "uiInput", "keyEvent", key_code(key)?],
        "press key",
    )?;
    Ok(())
}

pub fn ui_dump(format: &str, device: Option<&str>) -> Result<String> {
    if format != "json" {
        bail!("HarmonyOS UI dump supports only json format");
    }
    let bytes = transfer_generated_file(device, "layout", "json", &["uitest", "dumpLayout", "-p"])?;
    String::from_utf8(bytes).context("HarmonyOS UI dump is not valid UTF-8")
}

pub fn get_ui_elements(device: Option<&str>) -> Result<Vec<HarmonyElement>> {
    parse_ui_elements(&ui_dump("json", device)?)
}

pub fn find_element(query: &str, device: Option<&str>) -> Result<Option<(i32, i32)>> {
    let query = query.to_lowercase();
    let found = get_ui_elements(device)?.into_iter().find(|element| {
        element.text.to_lowercase().contains(&query)
            || element.resource_id.to_lowercase().contains(&query)
            || element.content_desc.to_lowercase().contains(&query)
    });
    if let Some(element) = found {
        let center = element.center();
        println!(
            "Found: text=\"{}\" resource_id=\"{}\" content_desc=\"{}\" at ({}, {})",
            terminal_safe(element.text.as_bytes()),
            terminal_safe(element.resource_id.as_bytes()),
            terminal_safe(element.content_desc.as_bytes()),
            center.0,
            center.1,
        );
        Ok(Some(center))
    } else {
        println!(
            "Element with '{}' not found",
            terminal_safe(query.as_bytes())
        );
        Ok(None)
    }
}

pub fn find_ui_element(
    text: Option<&str>,
    resource_id: Option<&str>,
    class_name: Option<&str>,
    device: Option<&str>,
) -> Result<Option<String>> {
    let text = text.map(str::to_lowercase);
    let resource_id = resource_id.map(str::to_lowercase);
    let class_name = class_name.map(str::to_lowercase);

    let found = get_ui_elements(device)?.into_iter().find(|element| {
        text.as_ref().is_none_or(|query| {
            element.text.to_lowercase().contains(query)
                || element.content_desc.to_lowercase().contains(query)
        }) && resource_id
            .as_ref()
            .is_none_or(|query| element.resource_id.to_lowercase().contains(query))
            && class_name
                .as_ref()
                .is_none_or(|query| element.class.to_lowercase().contains(query))
    });

    Ok(found.map(|element| {
        let center = element.center();
        format!(
            "type=\"{}\" label=\"{}\" resource_id=\"{}\" at ({}, {})",
            terminal_safe(element.class.as_bytes()),
            terminal_safe(element.label().as_bytes()),
            terminal_safe(element.resource_id.as_bytes()),
            center.0,
            center.1,
        )
    }))
}

pub fn tap_element(query: &str, device: Option<&str>) -> Result<()> {
    let Some((x, y)) = find_element(query, device)? else {
        bail!("Element '{}' not found", terminal_safe(query.as_bytes()));
    };
    tap(x, y, device)
}

pub fn screen_size(device: Option<&str>) -> Result<(u32, u32)> {
    let data = screenshot(device)?;
    let image =
        image::load_from_memory(&data).context("HarmonyOS screenshot is not a valid image")?;
    Ok((image.width(), image.height()))
}

pub fn shell(command: &str, device: Option<&str>) -> Result<String> {
    let output = execute(device, ["shell", command], "run shell command")?;
    let safe_output = terminal_safe(output.as_bytes());
    print!("{safe_output}");
    Ok(safe_output)
}

pub fn open_url(url: &str, device: Option<&str>) -> Result<()> {
    execute_shell(
        device,
        ["aa", "start", "-A", "ohos.want.action.viewData", "-U", url],
        "open URL",
    )?;
    println!("URL opened");
    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    let mut characters = value.chars();
    matches!(characters.next(), Some(first) if first.is_ascii_alphabetic())
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-')
        })
}

fn checked_identifier<'a>(value: &'a str, label: &str) -> Result<&'a str> {
    if valid_identifier(value) {
        Ok(value)
    } else {
        bail!("invalid HarmonyOS {label}: {value}")
    }
}

pub fn launch_app(
    package: &str,
    ability: Option<&str>,
    module: Option<&str>,
    device: Option<&str>,
) -> Result<()> {
    let (bundle, embedded_ability) = package.split_once('/').unwrap_or((package, "EntryAbility"));
    let ability = ability.unwrap_or(embedded_ability);
    checked_identifier(bundle, "bundle name")?;
    checked_identifier(ability, "Ability name")?;

    let mut args = vec![
        "aa".to_owned(),
        "start".to_owned(),
        "-b".to_owned(),
        bundle.to_owned(),
        "-a".to_owned(),
        ability.to_owned(),
    ];
    if let Some(module) = module {
        args.push("-m".to_owned());
        args.push(checked_identifier(module, "module name")?.to_owned());
    }
    execute_shell(device, args, "launch app")?;
    Ok(())
}

pub fn stop_app(package: &str, device: Option<&str>) -> Result<()> {
    let bundle = package
        .split_once('/')
        .map_or(package, |(bundle, _)| bundle);
    checked_identifier(bundle, "bundle name")?;
    execute_shell(device, ["aa", "force-stop", bundle], "stop app")?;
    Ok(())
}

pub fn install(path: &str, device: Option<&str>) -> Result<()> {
    execute(device, ["install", "-r", path], "install HAP")?;
    Ok(())
}

pub fn uninstall(package: &str, device: Option<&str>) -> Result<()> {
    checked_identifier(package, "bundle name")?;
    execute(device, ["uninstall", package], "uninstall app")?;
    Ok(())
}

pub fn push_file(local: &str, remote: &str, device: Option<&str>) -> Result<()> {
    execute(device, ["file", "send", local, remote], "push file")?;
    Ok(())
}

pub fn pull_file(remote: &str, local: &str, device: Option<&str>) -> Result<()> {
    execute(device, ["file", "recv", remote, local], "pull file")?;
    Ok(())
}

pub fn list_apps(filter: Option<&str>, device: Option<&str>) -> Result<()> {
    let output = execute_shell(device, ["bm", "dump", "-a"], "list apps")?;
    let mut apps = BTreeSet::new();
    for line in output.lines().map(str::trim) {
        let candidate = line
            .strip_prefix("bundleName:")
            .or_else(|| line.strip_prefix("bundleName="))
            .map(str::trim)
            .unwrap_or(line);
        if candidate.contains('.')
            && valid_identifier(candidate)
            && filter.map_or(true, |needle| candidate.contains(needle))
        {
            apps.insert(candidate);
        }
    }
    for app in apps {
        println!("{app}");
    }
    Ok(())
}

pub fn logs(lines: usize, filter: Option<&str>, device: Option<&str>) -> Result<()> {
    let output = terminal_safe(execute(device, ["hilog", "-x"], "read logs")?.as_bytes());
    let selected = output
        .lines()
        .filter(|line| filter.map_or(true, |needle| line.contains(needle)))
        .collect::<Vec<_>>();
    for line in selected.iter().skip(selected.len().saturating_sub(lines)) {
        println!("{line}");
    }
    Ok(())
}

pub fn clear_logs(device: Option<&str>) -> Result<()> {
    execute_shell(device, ["hilog", "-r"], "clear logs")?;
    Ok(())
}

pub fn system_info(device: Option<&str>) -> Result<()> {
    let output = execute_shell(device, ["param", "get"], "read system information")?;
    print!("{}", terminal_safe(output.as_bytes()));
    Ok(())
}
fn token_id(bundle: &str, device: Option<&str>) -> Result<String> {
    checked_identifier(bundle, "bundle name")?;
    let output = execute_shell(
        device,
        ["atm", "dump", "-t", "-b", bundle],
        "query access token",
    )?;
    let marker = output
        .find("\"tokenId\"")
        .or_else(|| output.find("tokenId"))
        .context("ATM response did not contain tokenId")?;
    let token = output[marker..]
        .chars()
        .skip_while(|character| !character.is_ascii_digit())
        .take_while(char::is_ascii_digit)
        .collect::<String>();
    if token.is_empty() {
        bail!("ATM response contained an invalid tokenId");
    }
    Ok(token)
}

pub fn permission_grant(bundle: &str, permission: &str, device: Option<&str>) -> Result<()> {
    checked_identifier(permission, "permission name")?;
    let token = token_id(bundle, device)?;
    execute_shell(
        device,
        ["atm", "perm", "-g", "-i", &token, "-p", permission],
        "grant permission",
    )?;
    println!("Granted {permission} to {bundle}");
    Ok(())
}

pub fn permission_revoke(bundle: &str, permission: &str, device: Option<&str>) -> Result<()> {
    checked_identifier(permission, "permission name")?;
    let token = token_id(bundle, device)?;
    execute_shell(
        device,
        ["atm", "perm", "-c", "-i", &token, "-p", permission],
        "revoke permission",
    )?;
    println!("Revoked {permission} from {bundle}");
    Ok(())
}

fn granted_permissions(output: &str) -> Vec<String> {
    let Ok(root) = serde_json::from_str::<Value>(output) else {
        return Vec::new();
    };
    root.get("permStateList")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter(|permission| json_i32(permission.get("grantStatus")) == Some(0))
        .map(|permission| json_string(permission, &["permissionName"]))
        .filter(|permission| !permission.is_empty())
        .collect()
}

pub fn permission_reset(bundle: &str, device: Option<&str>) -> Result<()> {
    let token = token_id(bundle, device)?;
    let output = execute_shell(
        device,
        ["atm", "dump", "-t", "-i", &token],
        "query granted permissions",
    )?;
    let permissions = granted_permissions(&output);
    let mut failures = Vec::new();
    let mut revoked = 0usize;
    for permission in permissions {
        match execute_shell(
            device,
            ["atm", "perm", "-c", "-i", &token, "-p", &permission],
            "reset permission",
        ) {
            Ok(_) => revoked += 1,
            Err(error) => failures.push(format!("{permission}: {error}")),
        }
    }
    if !failures.is_empty() {
        bail!(
            "Reset permissions for {bundle} revoked {revoked}, but {} failed: {}",
            failures.len(),
            failures.join("; ")
        );
    }
    println!("Reset {revoked} granted permissions for {bundle}");
    Ok(())
}

fn checked_sandbox_path<'a>(path: &'a str, label: &str) -> Result<&'a str> {
    let valid = !path.is_empty()
        && path.split('/').all(|part| {
            part != ".."
                && part.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-')
                })
        });
    if valid {
        Ok(path)
    } else {
        bail!("invalid HarmonyOS sandbox {label}: {path}")
    }
}

pub fn sandbox_file_list(bundle: &str, path: Option<&str>, device: Option<&str>) -> Result<()> {
    checked_identifier(bundle, "bundle name")?;
    let path = checked_sandbox_path(path.unwrap_or("."), "path")?;
    let output = execute_sandbox_shell(device, bundle, &["ls", "-la", path], "list sandbox files")?;
    print!("{}", terminal_safe(output.as_bytes()));
    Ok(())
}

pub fn sandbox_file_read(
    bundle: &str,
    path: &str,
    max_bytes: Option<u64>,
    device: Option<&str>,
) -> Result<()> {
    checked_identifier(bundle, "bundle name")?;
    let path = checked_sandbox_path(path, "path")?;
    let output = execute_sandbox_shell(device, bundle, &["cat", path], "read sandbox file")?;
    let bytes = output.as_bytes();
    let limit = max_bytes
        .and_then(|limit| usize::try_from(limit).ok())
        .map_or(bytes.len(), |limit| limit.min(bytes.len()));
    print!("{}", terminal_safe(&bytes[..limit]));
    Ok(())
}

pub fn sandbox_file_push(
    bundle: &str,
    local: &str,
    remote: &str,
    device: Option<&str>,
) -> Result<()> {
    checked_identifier(bundle, "bundle name")?;
    let remote = checked_sandbox_path(remote, "destination")?;
    execute(
        device,
        ["file", "send", "-b", bundle, local, remote],
        "push sandbox file",
    )?;
    Ok(())
}

pub fn sandbox_file_pull(
    bundle: &str,
    remote: &str,
    local: &str,
    device: Option<&str>,
) -> Result<()> {
    checked_identifier(bundle, "bundle name")?;
    let remote = checked_sandbox_path(remote, "source")?;
    execute(
        device,
        ["file", "recv", "-b", bundle, remote, local],
        "pull sandbox file",
    )?;
    Ok(())
}

fn checked_arkweb_socket(socket: &str) -> Result<&str> {
    let valid = socket.starts_with("webview_devtools_remote_")
        && socket.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-')
        });
    if valid {
        Ok(socket)
    } else {
        bail!("invalid ArkWeb DevTools socket: {socket}")
    }
}

pub fn arkweb_sockets(device: Option<&str>) -> Result<Vec<String>> {
    let output = execute_shell(
        device,
        ["cat", "/proc/net/unix"],
        "discover ArkWeb DevTools sockets",
    )?;
    let sockets = output
        .lines()
        .filter_map(|line| line.split_whitespace().last())
        .map(|socket| socket.trim_start_matches('@'))
        .filter(|socket| socket.starts_with("webview_devtools_remote_"))
        .filter(|socket| checked_arkweb_socket(socket).is_ok())
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    Ok(sockets.into_iter().collect())
}

pub fn arkweb_inspect(socket: Option<&str>, port: u16, device: Option<&str>) -> Result<()> {
    let socket = match socket {
        Some(socket) => checked_arkweb_socket(socket)?.to_owned(),
        None => arkweb_sockets(device)?
            .into_iter()
            .next()
            .context("No ArkWeb DevTools socket found. Enable setWebDebuggingAccess(true).")?,
    };
    execute(
        device,
        [
            "fport",
            &format!("tcp:{port}"),
            &format!("localabstract:{socket}"),
        ],
        "forward ArkWeb DevTools socket",
    )?;
    let url = format!("http://127.0.0.1:{port}/json/list");
    let targets = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .context("failed to create ArkWeb HTTP client")
        .and_then(|client| {
            client
                .get(&url)
                .send()
                .with_context(|| format!("failed to query ArkWeb DevTools at {url}"))
        })
        .and_then(|response| {
            response
                .error_for_status()
                .with_context(|| format!("ArkWeb DevTools returned an error at {url}"))
        })
        .and_then(|response| {
            response
                .text()
                .context("failed to read ArkWeb DevTools response")
        });
    match targets {
        Ok(targets) => {
            println!("{}", terminal_safe(targets.as_bytes()));
            Ok(())
        }
        Err(error) => {
            if let Err(cleanup_error) = arkweb_close(&socket, port, device) {
                bail!("{error}; additionally failed to remove ArkWeb forwarding: {cleanup_error}");
            }
            Err(error)
        }
    }
}

pub fn arkweb_close(socket: &str, port: u16, device: Option<&str>) -> Result<()> {
    let socket = checked_arkweb_socket(socket)?;
    execute(
        device,
        [
            "fport",
            "rm",
            &format!("tcp:{port}"),
            &format!("localabstract:{socket}"),
        ],
        "remove ArkWeb DevTools forwarding",
    )?;
    Ok(())
}

fn checked_test_filter<'a>(filter: &'a str, label: &str) -> Result<&'a str> {
    if !filter.is_empty()
        && filter.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-' | '#' | ',')
        })
    {
        Ok(filter)
    } else {
        bail!("invalid HarmonyOS test {label}: {filter}")
    }
}

#[allow(clippy::too_many_arguments)]
pub fn run_tests(
    bundle: &str,
    module: &str,
    runner: &str,
    class: Option<&str>,
    not_class: Option<&str>,
    timeout_ms: Option<u64>,
    dry_run: bool,
    device: Option<&str>,
) -> Result<()> {
    checked_identifier(bundle, "bundle name")?;
    checked_identifier(module, "module name")?;
    let runner = checked_sandbox_path(runner, "test runner")?;
    let mut args = vec![
        "aa".to_owned(),
        "test".to_owned(),
        "-b".to_owned(),
        bundle.to_owned(),
        "-m".to_owned(),
        module.to_owned(),
        "-s".to_owned(),
        "unittest".to_owned(),
        runner.to_owned(),
    ];
    for (name, value) in [("class", class), ("notClass", not_class)] {
        if let Some(value) = value {
            args.extend([
                "-s".to_owned(),
                name.to_owned(),
                checked_test_filter(value, name)?.to_owned(),
            ]);
        }
    }
    if let Some(timeout_ms) = timeout_ms {
        args.extend([
            "-s".to_owned(),
            "timeout".to_owned(),
            timeout_ms.to_string(),
        ]);
    }
    if dry_run {
        args.extend(["-s".to_owned(), "dryRun".to_owned(), "true".to_owned()]);
    }
    let output = execute_shell(device, args, "run HarmonyOS tests")?;
    print!("{}", terminal_safe(output.as_bytes()));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_verbose_device_list() {
        let devices = parse_devices("ABC123 Connected USB\nDEF456 Offline TCP\n");
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].serial, "ABC123");
        assert_eq!(devices[0].state, "connected");
        assert_eq!(devices[1].state, "offline");
    }

    #[test]
    fn maps_named_and_numeric_keys() {
        assert_eq!(key_code("Back").unwrap(), "2");
        assert_eq!(key_code("2054").unwrap(), "2054");
        assert!(key_code("unknown").is_err());
    }

    #[test]
    fn validates_launch_identifiers() {
        assert!(valid_identifier("com.example.app"));
        assert!(valid_identifier("EntryAbility"));
        assert!(!valid_identifier("com.example;rm"));
        assert!(!valid_identifier("1invalid"));
    }

    #[test]
    fn parses_harmony_layout_and_finds_granted_permissions() {
        let layout = r#"{
          "attributes": {"type":"Column","bounds":"[0,0][100,200]"},
          "children":[{"attributes":{
            "type":"Button","text":"Continue","id":"confirm",
            "description":"Continue setup","clickable":"true",
            "bounds":"[20,40][80,100]"
          }}]
        }"#;
        let elements = parse_ui_elements(layout).unwrap();
        assert_eq!(elements.len(), 2);
        assert_eq!(elements[1].center(), (50, 70));
        assert_eq!(elements[1].label(), "Continue");

        let permissions = granted_permissions(
            r#"{"permStateList":[
              {"permissionName":"ohos.permission.CAMERA","grantStatus":0},
              {"permissionName":"ohos.permission.LOCATION","grantStatus":-1}
            ]}"#,
        );
        assert_eq!(permissions, vec!["ohos.permission.CAMERA"]);
    }

    #[test]
    fn rejects_unsafe_sandbox_paths_and_arkweb_sockets() {
        assert!(checked_sandbox_path("data/storage/el2/base/files", "path").is_ok());
        assert!(checked_sandbox_path("../system", "path").is_err());
        assert!(checked_arkweb_socket("webview_devtools_remote_38532").is_ok());
        assert!(checked_arkweb_socket("webview_devtools_remote_1;rm").is_err());
    }
}
