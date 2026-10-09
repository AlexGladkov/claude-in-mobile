#![cfg(unix)]
use image::{Rgba, RgbaImage};
use serde_json::Value;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    process::{Command, Output},
};
use tempfile::TempDir;
struct Fake {
    root: TempDir,
}
impl Fake {
    fn new() -> Self {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join("audb"), include_bytes!("fixtures/audb.py")).unwrap();
        fs::set_permissions(root.path().join("audb"), fs::Permissions::from_mode(0o755)).unwrap();
        RgbaImage::from_pixel(360, 800, Rgba([10, 20, 30, 255]))
            .save(root.path().join("screen.png"))
            .unwrap();
        Self { root }
    }
    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_mcp-devices"))
            .args(args)
            .env("PATH", self.root.path())
            .env("AUDB_PATH", "/missing/fallback")
            .current_dir(self.root.path())
            .output()
            .unwrap()
    }
    fn mode(&self, mode: &str) {
        fs::write(self.root.path().join("mode"), mode).unwrap();
    }
    fn calls(&self) -> Vec<Value> {
        fs::read_to_string(self.root.path().join("calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}
fn success(output: Output) -> String {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}
#[test]
fn path_priority_minimum_version_and_default_resolution() {
    let fake = Fake::new();
    success(fake.run(&["tap", "--platform", "aurora", "10", "20"]));
    let calls = fake.calls();
    assert!(calls[0]["args"]
        .as_array()
        .unwrap()
        .contains(&Value::from("current")));
    assert!(calls[1]["args"]
        .as_array()
        .unwrap()
        .contains(&Value::from("emulator")));
    fake.mode("old");
    let output = fake.run(&["devices", "--platform", "aurora"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("AUDB_VERSION_UNSUPPORTED"));
    assert_eq!(fake.calls().len(), 2);
}
#[test]
fn unicode_stdin_and_png_scaling_use_explicit_target() {
    use base64::Engine;
    let fake = Fake::new();
    let text = "Привет\n😀 $HOME";
    let out = success(fake.run(&["input", "--platform", "aurora", text, "--device", "phone"]));
    assert!(!out.contains(text));
    success(fake.run(&[
        "tap",
        "--platform",
        "aurora",
        "90",
        "200",
        "--from-size",
        "180x400",
        "--device",
        "emulator",
    ]));
    let calls = fake.calls();
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(calls[0]["stdin"].as_str().unwrap())
            .unwrap(),
        text.as_bytes()
    );
    assert!(!calls[0]["args"]
        .as_array()
        .unwrap()
        .contains(&Value::from(text)));
    let tap = calls.last().unwrap()["args"].as_array().unwrap();
    assert_eq!(
        &tap[tap.len() - 3..],
        &[Value::from("tap"), Value::from("180"), Value::from("400")]
    );
    let screenshot = &calls[1]["args"].as_array().unwrap();
    let path = screenshot[screenshot.iter().position(|v| v == "--output").unwrap() + 1]
        .as_str()
        .unwrap();
    assert!(!std::path::Path::new(path).exists());
    assert!(success(fake.run(&["screen-size", "aurora", "--device", "phone"])).contains("360x800"));
}
#[test]
fn full_permissions_gestures_and_install_deadline() {
    let fake = Fake::new();
    success(fake.run(&[
        "aurora",
        "--device",
        "phone",
        "permission",
        "grant",
        "ru.example.app",
        "--all-requested",
        "--disable-prompt",
    ]));
    success(fake.run(&[
        "permission-grant",
        "aurora",
        "ru.example.app",
        "UserDirs",
        "--device",
        "emulator",
    ]));
    success(fake.run(&[
        "swipe",
        "--platform",
        "aurora",
        "1",
        "2",
        "3",
        "4",
        "--duration",
        "700",
        "--device",
        "phone",
    ]));
    let out = success(fake.run(&[
        "install",
        "--platform",
        "aurora",
        "/tmp/app.rpm",
        "--device",
        "emulator",
    ]));
    assert!(out.contains("\"changed\": false"));
    let calls = fake.calls();
    assert!(calls[0]["args"]
        .as_array()
        .unwrap()
        .contains(&Value::from("--disable-prompt")));
    assert!(!calls[1]["args"]
        .as_array()
        .unwrap()
        .contains(&Value::from("--disable-prompt")));
    assert!(calls[2]["args"]
        .as_array()
        .unwrap()
        .contains(&Value::from("700")));
    assert_eq!(calls[3]["args"][2], "300");
    success(fake.run(&[
        "swipe",
        "--platform",
        "aurora",
        "0",
        "0",
        "0",
        "0",
        "--direction",
        "up",
        "--duration",
        "600",
        "--device",
        "phone",
    ]));
    let direction = fake.calls().last().unwrap()["args"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(
        &direction[direction.len() - 4..],
        &[
            Value::from("swipe"),
            Value::from("up"),
            Value::from("--duration"),
            Value::from("600")
        ]
    );
}
#[test]
fn failed_or_lost_action_is_not_repeated_and_error_data_survives() {
    let fake = Fake::new();
    fake.mode("error");
    let output = fake.run(&["tap", "--platform", "aurora", "1", "2", "--device", "phone"]);
    assert!(!output.status.success());
    let err = String::from_utf8_lossy(&output.stderr);
    assert!(
        err.contains("AGENT_UNAVAILABLE")
            && err.contains("\"partial\":true")
            && err.contains("phone")
    );
    assert_eq!(fake.calls().len(), 1);
    fake.mode("lost");
    let output = fake.run(&["tap", "--platform", "aurora", "1", "2", "--device", "phone"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("OUTCOME_UNKNOWN"));
    assert_eq!(fake.calls().len(), 2);
    fake.mode("schema");
    let output = fake.run(&["tap", "--platform", "aurora", "1", "2", "--device", "phone"]);
    assert!(String::from_utf8_lossy(&output.stderr).contains("AUDB_INVALID_RESPONSE"));
    assert_eq!(fake.calls().len(), 3);
}

#[test]
fn stable_audb_caret_range_matches_typescript() {
    for (version, accepted) in [
        ("audb 0.3.0", true),
        ("audb 0.3.1", true),
        ("audb 0.2.1", false),
        ("audb 0.4.0", false),
        ("audb 1.0.0", false),
        ("audb 0.3.0-rc.1", false),
        ("audb 00.3.0", false),
        ("unknown 0.3.0", false),
    ] {
        let fake = Fake::new();
        fs::write(fake.root.path().join("version"), version).unwrap();
        let output = fake.run(&["tap", "--platform", "aurora", "1", "2", "--device", "phone"]);
        assert_eq!(output.status.success(), accepted, "version: {version}");
        assert_eq!(
            fake.calls().len(),
            usize::from(accepted),
            "version: {version}"
        );
    }
}

#[test]
fn root_shell_matches_mcp_platform_policy() {
    let fake = Fake::new();
    success(fake.run(&[
        "shell",
        "--platform",
        "aurora",
        "id",
        "--root",
        "--device",
        "phone",
        "--i-know-what-im-doing",
    ]));
    success(fake.run(&[
        "shell",
        "--platform",
        "aurora",
        "id",
        "--device",
        "phone",
        "--i-know-what-im-doing",
    ]));
    let calls = fake.calls();
    assert!(calls[0]["args"]
        .as_array()
        .unwrap()
        .contains(&Value::from("--root")));
    assert!(!calls[1]["args"]
        .as_array()
        .unwrap()
        .contains(&Value::from("--root")));
    for platform in ["android", "ios", "harmony"] {
        let out = fake.run(&[
            "shell",
            "--platform",
            platform,
            "id",
            "--root",
            "--i-know-what-im-doing",
        ]);
        assert!(!out.status.success());
        assert!(String::from_utf8_lossy(&out.stderr).contains("root is supported only for Aurora"));
    }
    assert_eq!(fake.calls().len(), 2);
}
