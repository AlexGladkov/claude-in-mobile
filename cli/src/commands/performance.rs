use std::fs::{self, File};
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Output};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::utils::process::{ensure_success, run_with_limits};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

const MAX_TRACE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_HEAP_BYTES: u64 = 128 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

#[allow(clippy::too_many_arguments)]
pub fn trace(
    platform: &str,
    package: Option<&str>,
    bundle_id: Option<&str>,
    preset: &str,
    duration_ms: u64,
    output: &str,
    device: Option<&str>,
    simulator: Option<&str>,
) -> Result<()> {
    validate_duration(duration_ms)?;
    validate_preset(preset)?;
    ensure_output_available(Path::new(output))?;
    let result = match platform {
        "android" => android_trace(
            package.ok_or_else(|| anyhow::anyhow!("--package is required for Android Perfetto capture"))?,
            preset,
            duration_ms,
            Path::new(output),
            device,
        )?,
        "ios" => ios_xctrace(
            bundle_id.ok_or_else(|| anyhow::anyhow!("--bundle-id is required for iOS xctrace capture"))?,
            if preset == "ui-jank" { "Animation Hitches" } else { "Time Profiler" },
            duration_ms,
            "xctrace-zip",
            Path::new(output),
            simulator,
            MAX_TRACE_BYTES,
        )?,
        _ => bail!("Performance tracing supports android and ios in the native CLI; browser tracing is MCP-only"),
    };
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn heap_capture(
    platform: &str,
    package: Option<&str>,
    bundle_id: Option<&str>,
    output: &str,
    device: Option<&str>,
    simulator: Option<&str>,
) -> Result<()> {
    ensure_output_available(Path::new(output))?;
    let result = match platform {
        "android" => android_heap(
            package.ok_or_else(|| anyhow::anyhow!("--package is required for Android HPROF capture"))?,
            Path::new(output),
            device,
        )?,
        "ios" => ios_xctrace(
            bundle_id.ok_or_else(|| anyhow::anyhow!("--bundle-id is required for iOS Allocations capture"))?,
            "Allocations",
            1_000,
            "xctrace-allocations",
            Path::new(output),
            simulator,
            MAX_HEAP_BYTES,
        )?,
        _ => bail!("Heap capture supports android and ios in the native CLI; browser HeapProfiler is MCP-only"),
    };
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

pub fn heap_diff(before: &str, after: &str) -> Result<()> {
    let before_meta = fs::metadata(before)
        .with_context(|| format!("Failed to read before artifact: {before}"))?;
    let after_meta =
        fs::metadata(after).with_context(|| format!("Failed to read after artifact: {after}"))?;
    if !before_meta.is_file() || !after_meta.is_file() {
        bail!("Heap diff inputs must be regular files");
    }
    let before_bytes = before_meta.len();
    let after_bytes = after_meta.len();
    let delta = after_bytes as i128 - before_bytes as i128;
    let delta_percent = if before_bytes == 0 {
        Value::Null
    } else {
        json!((delta as f64 / before_bytes as f64 * 10_000.0).round() / 100.0)
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "before": before,
            "after": after,
            "metric": "artifactSize",
            "beforeBytes": before_bytes,
            "afterBytes": after_bytes,
            "deltaBytes": delta,
            "deltaPercent": delta_percent,
            "note": "Artifact growth is a diagnostic signal, not proof of a memory leak."
        }))?
    );
    Ok(())
}

fn android_trace(
    package: &str,
    preset: &str,
    duration_ms: u64,
    output: &Path,
    device: Option<&str>,
) -> Result<Value> {
    validate_identifier(package, "Android package")?;
    let remote = format!(
        "/data/misc/perfetto-traces/mcp-devices-cli-{}.perfetto-trace",
        unique_suffix()
    );
    let seconds = duration_ms.div_ceil(1_000);
    let mut start = vec![
        "shell".into(),
        "perfetto".into(),
        "--background-wait".into(),
        "--out".into(),
        remote.clone(),
        "--time".into(),
        format!("{seconds}s"),
        "--buffer".into(),
        "8mb".into(),
        "--size".into(),
        "24mb".into(),
        "--app".into(),
        package.into(),
    ];
    let mut categories = vec![
        "sched",
        "freq",
        "idle",
        "am",
        "wm",
        "gfx",
        "view",
        "binder_driver",
    ];
    if preset == "startup" {
        categories.extend(["dalvik", "input", "res"]);
    }
    start.extend(categories.into_iter().map(String::from));
    let reset = strings(["shell", "dumpsys", "gfxinfo", package, "reset"]);
    let _ = adb_checked(device, &reset);
    let capture = (|| -> Result<Value> {
        adb_checked(device, &start)?;
        thread::sleep(Duration::from_millis(seconds * 1_000 + 350));
        let pull = vec!["pull".into(), remote.clone(), path_string(output)?];
        adb_checked(device, &pull)?;
        secure_and_limit(output, MAX_TRACE_BYTES)?;
        let gfx = adb_checked(device, &strings(["shell", "dumpsys", "gfxinfo", package]))?;
        let gfx_text = String::from_utf8_lossy(&gfx.stdout);
        let analysis = analyze_perfetto(output, package);
        Ok(json!({
            "platform": "android",
            "format": "perfetto-proto",
            "path": output,
            "sizeBytes": fs::metadata(output)?.len(),
            "packageName": package,
            "frameStats": {
                "totalFrames": value_after(&gfx_text, "Total frames rendered:"),
                "jankyFrames": value_after(&gfx_text, "Janky frames:"),
            },
            "analysis": analysis,
        }))
    })();
    let remove = vec!["shell".into(), "rm".into(), "-f".into(), remote];
    let _ = adb_checked(device, &remove);
    capture
}

fn android_heap(package: &str, output: &Path, device: Option<&str>) -> Result<Value> {
    validate_identifier(package, "Android package")?;
    let package_info = adb_checked(device, &strings(["shell", "dumpsys", "package", package]))?;
    if !String::from_utf8_lossy(&package_info.stdout).contains("DEBUGGABLE") {
        bail!("Android package {package} is not debuggable; HPROF capture requires a debug build");
    }
    let remote = format!("/data/local/tmp/mcp-devices-cli-{}.hprof", unique_suffix());
    let capture = (|| -> Result<Value> {
        let dump = vec![
            "shell".into(),
            "am".into(),
            "dumpheap".into(),
            package.into(),
            remote.clone(),
        ];
        adb_checked(device, &dump)?;
        let pull = vec!["pull".into(), remote.clone(), path_string(output)?];
        adb_checked(device, &pull)?;
        secure_and_limit(output, MAX_HEAP_BYTES)?;
        validate_hprof(output)?;
        let meminfo = adb_checked(device, &strings(["shell", "dumpsys", "meminfo", package]))?;
        let text = String::from_utf8_lossy(&meminfo.stdout);
        Ok(json!({
            "platform": "android",
            "format": "android-hprof",
            "path": output,
            "sizeBytes": fs::metadata(output)?.len(),
            "packageName": package,
            "summary": {
                "totalPssMb": memory_row_mb(&text, "TOTAL"),
                "nativeHeapMb": memory_row_mb(&text, "Native Heap"),
                "dalvikHeapMb": memory_row_mb(&text, "Dalvik Heap"),
            }
        }))
    })();
    let remove = vec!["shell".into(), "rm".into(), "-f".into(), remote];
    let _ = adb_checked(device, &remove);
    capture
}

fn ios_xctrace(
    bundle_id: &str,
    template: &str,
    duration_ms: u64,
    format: &str,
    output: &Path,
    simulator: Option<&str>,
    max_bytes: u64,
) -> Result<Value> {
    validate_identifier(bundle_id, "iOS bundle ID")?;
    let udid = resolve_booted_simulator(simulator)?;
    let pid = running_ios_pid(&udid, bundle_id)?;
    let root = std::env::temp_dir().join(format!("mcp-devices-cli-xctrace-{}", unique_suffix()));
    fs::create_dir(&root).context("Failed to create private xctrace temporary directory")?;
    set_mode(&root, 0o700)?;
    let trace_path = root.join("capture.trace");
    let capture = (|| -> Result<Value> {
        // Animation Hitches is listed by xctrace but cannot record against
        // Simulator runtimes. This CLI only targets booted Simulators, so use
        // Time Profiler rather than returning a valid-looking empty archive.
        let (effective_template, record_warning) = if template == "Animation Hitches" {
            (
                "Time Profiler",
                Some("Animation Hitches is unavailable on Simulator; captured Time Profiler instead."),
            )
        } else {
            (template, None)
        };
        let record = strings([
            "xctrace",
            "record",
            "--template",
            effective_template,
            "--device",
            &udid,
            "--time-limit",
            &format!("{duration_ms}ms"),
            "--output",
            trace_path
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("Invalid xctrace temporary path"))?,
            "--attach",
            &pid.to_string(),
            "--no-prompt",
        ]);
        xcrun_checked(&record)?;
        let export = strings([
            "xctrace",
            "export",
            "--input",
            trace_path
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("Invalid xctrace temporary path"))?,
            "--toc",
        ]);
        let toc = xcrun_checked(&export)?;
        let toc_text = String::from_utf8_lossy(&toc.stdout);
        let ditto = strings([
            "-c",
            "-k",
            "--sequesterRsrc",
            "--keepParent",
            trace_path
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("Invalid xctrace temporary path"))?,
            output
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("Invalid output path"))?,
        ]);
        let mut ditto_command = Command::new("/usr/bin/ditto");
        ditto_command.args(&ditto);
        checked(&mut ditto_command, "ditto")?;
        secure_and_limit(output, max_bytes)?;
        Ok(json!({
            "platform": "ios",
            "format": format,
            "path": output,
            "sizeBytes": fs::metadata(output)?.len(),
            "bundleId": bundle_id,
            "producer": tag_value(&toc_text, "instruments-version")
                .map(|version| format!("Apple Instruments xctrace {version}"))
                .unwrap_or_else(|| "Apple Instruments xctrace".into()),
            "instrumentCount": toc_text.matches("<table ").count(),
            "warnings": record_warning.into_iter().collect::<Vec<_>>(),
        }))
    })();
    let _ = fs::remove_dir_all(&root);
    capture
}

fn analyze_perfetto(path: &Path, package: &str) -> Value {
    let binary =
        std::env::var("PERFETTO_TRACE_PROCESSOR_PATH").unwrap_or_else(|_| "trace_processor".into());
    let sql = format!(
        "SELECT (SELECT COUNT(*) FROM slice) AS slice_count, (SELECT COUNT(*) FROM sched) AS sched_slice_count, (SELECT ROUND(COALESCE(SUM(s.dur), 0) / 1000000.0, 1) FROM sched s JOIN thread t USING (utid) LEFT JOIN process p USING (upid) WHERE p.name = '{0}' OR p.cmdline LIKE '{0}%') AS cpu_time_ms;",
        package
    );
    let mut command = Command::new(&binary);
    command.arg("query").arg(path).arg(sql);
    match run_with_limits(
        &mut command,
        Duration::from_secs(120),
        MAX_COMMAND_OUTPUT_BYTES,
        "Perfetto trace analysis",
    ) {
        Ok(output) if output.status.success() => {
            let text = String::from_utf8_lossy(&output.stdout);
            let lines: Vec<&str> = text
                .lines()
                .filter(|line| !line.trim().is_empty())
                .collect();
            if lines.len() >= 2 {
                let values: Vec<&str> = lines[lines.len() - 1].split(',').collect();
                return json!({
                    "tool": "Perfetto Trace Processor",
                    "sliceCount": values.first().and_then(|value| value.trim_matches('"').parse::<u64>().ok()),
                    "schedSliceCount": values.get(1).and_then(|value| value.trim_matches('"').parse::<u64>().ok()),
                    "cpuTimeMs": values.get(2).and_then(|value| value.trim_matches('"').parse::<f64>().ok()),
                });
            }
            json!({"tool": "failed", "warning": "Trace Processor returned no query row"})
        }
        Ok(_) => json!({"tool": "failed", "warning": "Trace Processor query failed"}),
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|cause| cause.kind() == std::io::ErrorKind::NotFound) =>
        {
            json!({
                "tool": "unavailable",
                "warning": "Install trace_processor or set PERFETTO_TRACE_PROCESSOR_PATH",
            })
        }
        Err(_) => json!({"tool": "failed", "warning": "Trace Processor query failed"}),
    }
}

fn resolve_booted_simulator(selector: Option<&str>) -> Result<String> {
    let output = xcrun_checked(&strings(["simctl", "list", "devices", "-j"]))?;
    let root: Value =
        serde_json::from_slice(&output.stdout).context("Invalid simctl devices JSON")?;
    for devices in root["devices"]
        .as_object()
        .into_iter()
        .flat_map(|map| map.values())
    {
        for device in devices.as_array().into_iter().flatten() {
            let name = device["name"].as_str().unwrap_or("");
            let udid = device["udid"].as_str().unwrap_or("");
            let booted = device["state"].as_str() == Some("Booted");
            if booted && selector.map_or(true, |value| value == name || value == udid) {
                return Ok(udid.into());
            }
        }
    }
    match selector {
        Some(value) => bail!("Booted iOS Simulator '{value}' was not found"),
        None => bail!("No booted iOS Simulator found"),
    }
}

fn running_ios_pid(udid: &str, bundle_id: &str) -> Result<u32> {
    let output = xcrun_checked(&strings(["simctl", "spawn", udid, "launchctl", "list"]))?;
    let prefix = format!("UIKitApplication:{bundle_id}[");
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let columns: Vec<&str> = line.split_whitespace().collect();
        if columns.len() >= 3 && (columns[2] == bundle_id || columns[2].starts_with(&prefix)) {
            if let Ok(pid) = columns[0].parse::<u32>() {
                return Ok(pid);
            }
        }
    }
    bail!("iOS app {bundle_id} is not running on Simulator {udid}; launch it first")
}

fn adb_checked(device: Option<&str>, args: &[String]) -> Result<Output> {
    let mut command = Command::new("adb");
    if let Some(serial) = device {
        command.arg("-s").arg(serial);
    }
    command.args(args);
    checked(&mut command, "adb")
}

fn xcrun_checked(args: &[String]) -> Result<Output> {
    let mut command = Command::new("xcrun");
    command.args(args);
    checked(&mut command, "xcrun")
}

fn checked(command: &mut Command, action: &str) -> Result<Output> {
    let output = run_with_limits(
        command,
        Duration::from_secs(120),
        MAX_COMMAND_OUTPUT_BYTES,
        action,
    )?;
    ensure_success(&output, action)?;
    Ok(output)
}

fn validate_identifier(value: &str, label: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 255
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        bail!("Invalid {label}");
    }
    Ok(())
}

fn validate_duration(duration_ms: u64) -> Result<()> {
    if !(1_000..=15_000).contains(&duration_ms) {
        bail!("--duration-ms must be between 1000 and 15000");
    }
    Ok(())
}

fn validate_preset(preset: &str) -> Result<()> {
    if !matches!(preset, "ui-jank" | "startup") {
        bail!("--preset must be ui-jank or startup");
    }
    Ok(())
}

fn ensure_output_available(path: &Path) -> Result<()> {
    if path.exists() {
        bail!(
            "Refusing to overwrite existing artifact: {}",
            path.display()
        );
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if !parent.is_dir() {
        bail!("Output directory does not exist: {}", parent.display());
    }
    Ok(())
}

fn secure_and_limit(path: &Path, max_bytes: u64) -> Result<()> {
    let metadata =
        fs::metadata(path).with_context(|| format!("Capture did not create {}", path.display()))?;
    if !metadata.is_file() || metadata.len() == 0 {
        bail!("Capture did not produce a non-empty regular file");
    }
    if metadata.len() > max_bytes {
        let _ = fs::remove_file(path);
        bail!(
            "Artifact exceeds the {} MiB limit and was deleted",
            max_bytes / 1024 / 1024
        );
    }
    set_mode(path, 0o600)
}

fn set_mode(path: &Path, mode: u32) -> Result<()> {
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_mode(mode);
        fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

fn validate_hprof(path: &Path) -> Result<()> {
    let mut file = File::open(path)?;
    let mut header = [0u8; 20];
    let read = file.read(&mut header)?;
    if !String::from_utf8_lossy(&header[..read]).starts_with("JAVA PROFILE 1.0.") {
        let _ = fs::remove_file(path);
        bail!("Android dumpheap returned an invalid HPROF artifact");
    }
    Ok(())
}

fn memory_row_mb(input: &str, label: &str) -> Option<f64> {
    input.lines().find_map(|line| {
        let trimmed = line.trim();
        if !trimmed.starts_with(label) {
            return None;
        }
        let rest = trimmed.strip_prefix(label)?.trim_start_matches(':').trim();
        let kb = rest
            .split_whitespace()
            .find_map(|token| token.replace(',', "").parse::<u64>().ok())?;
        Some((kb as f64 / 1024.0 * 100.0).round() / 100.0)
    })
}

fn value_after(input: &str, label: &str) -> Option<u64> {
    input.lines().find_map(|line| {
        let rest = line.trim().strip_prefix(label)?.trim();
        rest.split_whitespace().next()?.parse().ok()
    })
}

fn tag_value(input: &str, tag: &str) -> Option<String> {
    let start_tag = format!("<{tag}>");
    let end_tag = format!("</{tag}>");
    let start = input.find(&start_tag)? + start_tag.len();
    let end = input[start..].find(&end_tag)? + start;
    Some(input[start..end].to_string())
}

fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{}-{nanos}", std::process::id())
}

fn strings<const N: usize>(values: [&str; N]) -> Vec<String> {
    values.into_iter().map(String::from).collect()
}

fn path_string(path: &Path) -> Result<String> {
    path.to_str()
        .map(String::from)
        .ok_or_else(|| anyhow::anyhow!("Path is not valid UTF-8: {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_identifiers() {
        assert!(validate_identifier("com.example.app", "package").is_ok());
        assert!(validate_identifier("com.example;rm", "package").is_err());
    }

    #[test]
    fn parses_android_memory_rows() {
        let input = "Native Heap         2048  1024\nDalvik Heap 4096 2048\nTOTAL 8192 4096";
        assert_eq!(memory_row_mb(input, "Native Heap"), Some(2.0));
        assert_eq!(memory_row_mb(input, "Dalvik Heap"), Some(4.0));
        assert_eq!(memory_row_mb(input, "TOTAL"), Some(8.0));
    }

    #[test]
    fn extracts_xctrace_tag_values() {
        assert_eq!(
            tag_value(
                "<template-name>Allocations</template-name>",
                "template-name"
            ),
            Some("Allocations".into())
        );
    }
}
