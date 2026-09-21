#![cfg(unix)]

use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::thread::{self, JoinHandle};

use image::{Rgba, RgbaImage};
use tempfile::TempDir;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_mcp-devices")
}

struct FakeHdc {
    root: TempDir,
    hdc: PathBuf,
    log: PathBuf,
    layout: PathBuf,
    screenshot: PathBuf,
}

impl FakeHdc {
    fn new() -> Self {
        let root = TempDir::new().expect("fake HDC tempfile");
        let hdc = root.path().join("hdc");
        let log = root.path().join("hdc.log");
        let layout = root.path().join("layout.json");
        let screenshot = root.path().join("screen.png");
        fs::write(
            &layout,
            r#"{"attributes":{"type":"Button","text":"Continue","resourceId":"continue","bounds":"[0,0][100,40]","clickable":true}}"#,
        )
        .expect("write layout fixture");
        RgbaImage::from_pixel(100, 200, Rgba([20, 40, 60, 255]))
            .save(&screenshot)
            .expect("write screenshot fixture");
        fs::write(
            &hdc,
            r#"#!/bin/sh
normalized=$(printf '%s' "$*" | tr -d "'")
printf '%s\n' "$normalized" >> "$HDC_LOG"
case "$normalized" in
  *"atm dump -t -b"*)
    printf '%s\n' '{"tokenId":42}'
    exit 0
    ;;
  *"atm dump -t -i"*)
    printf '%s\n' '{"tokenId":42,"permStateList":[{"permissionName":"ohos.permission.CAMERA","grantStatus":0},{"permissionName":"ohos.permission.MICROPHONE","grantStatus":1}]}'
    exit 0
    ;;
  *"cat /proc/net/unix"*)
    printf '%s\n' '00000000: 00000002 00000000 00010000 0001 01 1 @webview_devtools_remote_123'
    exit 0
    ;;
  *"shell -b "*" cat "*)
    printf '%s' 'sandbox-state'
    exit 0
    ;;
  *"shell -b "*" ls "*)
    printf '%s\n' 'state.json'
    exit 0
    ;;
  *"shell aa test "*)
    printf '%s\n' 'ArkXTest passed'
    exit 0
    ;;
  *"file recv"*)
    destination=''
    for argument in "$@"; do destination="$argument"; done
    case "$*" in
      *".png"*) cp "$HDC_PNG" "$destination" ;;
      *".json"*) cp "$HDC_LAYOUT" "$destination" ;;
      *) printf '%s' 'sandbox-download' > "$destination" ;;
    esac
    exit 0
    ;;
esac
printf '%s\n' 'OK'
"#,
        )
        .expect("write fake HDC");
        let mut permissions = fs::metadata(&hdc).expect("fake HDC metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&hdc, permissions).expect("make fake HDC executable");
        Self {
            root,
            hdc,
            log,
            layout,
            screenshot,
        }
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(bin())
            .args(args)
            .current_dir(self.root.path())
            .env("HOME", self.root.path())
            .env("HDC_PATH", &self.hdc)
            .env("HDC_LOG", &self.log)
            .env("HDC_LAYOUT", &self.layout)
            .env("HDC_PNG", &self.screenshot)
            .output()
            .expect("spawn mcp-devices")
    }

    fn log(&self) -> String {
        fs::read_to_string(&self.log).unwrap_or_default()
    }
}

fn assert_success(output: &Output) {
    if !output.status.success() {
        panic!(
            "command failed ({})\nstdout:\n{}\nstderr:\n{}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }
}

fn arkweb_server() -> (u16, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ArkWeb fixture server");
    let port = listener.local_addr().expect("ArkWeb server address").port();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept ArkWeb request");
        let mut request = [0_u8; 1024];
        let _ = stream.read(&mut request).expect("read ArkWeb request");
        let body = r#"[{"id":"page-1","title":"Demo"}]"#;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body,
        )
        .expect("write ArkWeb response");
    });
    (port, handle)
}

#[test]
fn harmony_flow_elements_screen_size_and_annotations_use_hdc() {
    let fake = FakeHdc::new();
    let flow = fake.root.path().join("flow.json");
    fs::write(
        &flow,
        r#"[
  {"action":"tap","args":["10","20"]},
  {"action":"tap-text","args":["Continue"]},
  {"action":"input","args":["hello"]},
  {"action":"find","args":["Continue"]},
  {"action":"ui-assert-visible","args":["Continue"]},
  {"action":"screenshot","args":[]},
  {"action":"ui-dump","args":[]}
]"#,
    )
    .expect("write flow fixture");
    let flow_path = flow.to_str().expect("UTF-8 flow path");

    let output = fake.run(&[
        "flow", "run", "harmony", "--file", flow_path, "--device", "phone",
    ]);
    assert_success(&output);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("\"passed\": 7"), "stdout: {stdout}");

    let output = fake.run(&["screen-size", "harmony", "--device", "phone"]);
    assert_success(&output);
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "Screen size: 100x200"
    );

    let annotated = fake.root.path().join("annotated.png");
    let annotated_path = annotated.to_str().expect("UTF-8 annotation path");
    assert_success(&fake.run(&[
        "annotate",
        "harmony",
        "--output",
        annotated_path,
        "--device",
        "phone",
    ]));
    assert!(Path::new(annotated_path).is_file());

    let log = fake.log();
    assert!(log.contains("uitest uiInput click 10 20"), "log: {log}");
    assert!(log.contains("uitest uiInput click 50 20"), "log: {log}");
    assert!(log.contains("uitest uiInput text hello"), "log: {log}");
    assert!(log.contains("shell uitest screenCap"), "log: {log}");
    assert!(log.contains("shell uitest dumpLayout"), "log: {log}");
}

#[test]
fn harmony_permissions_sandbox_arkweb_and_tests_use_official_hdc_forms() {
    let fake = FakeHdc::new();
    assert_success(&fake.run(&[
        "permission-grant",
        "harmony",
        "com.example.demo",
        "ohos.permission.CAMERA",
        "--device",
        "phone",
    ]));
    assert_success(&fake.run(&[
        "permission-revoke",
        "harmony",
        "com.example.demo",
        "ohos.permission.CAMERA",
        "--device",
        "phone",
    ]));
    assert_success(&fake.run(&[
        "permission-reset",
        "harmony",
        "com.example.demo",
        "--device",
        "phone",
    ]));

    let list = fake.run(&[
        "sandbox-file-list",
        "com.example.demo",
        "--platform",
        "harmony",
        "--path",
        "files",
        "--device",
        "phone",
    ]);
    assert_success(&list);
    assert!(String::from_utf8_lossy(&list.stdout).contains("state.json"));
    let read = fake.run(&[
        "sandbox-file-read",
        "com.example.demo",
        "files/state.json",
        "--platform",
        "harmony",
        "--max-bytes",
        "7",
        "--device",
        "phone",
    ]);
    assert_success(&read);
    assert_eq!(String::from_utf8_lossy(&read.stdout), "sandbox");

    let local = fake.root.path().join("input.txt");
    fs::write(&local, "input").expect("write sandbox input");
    let pulled = fake.root.path().join("output.txt");
    let local_path = local.to_str().expect("UTF-8 input path");
    let pulled_path = pulled.to_str().expect("UTF-8 output path");
    assert_success(&fake.run(&[
        "harmony-sandbox-push",
        "com.example.demo",
        local_path,
        "files/input.txt",
        "--device",
        "phone",
    ]));
    assert_success(&fake.run(&[
        "harmony-sandbox-pull",
        "com.example.demo",
        "files/output.txt",
        pulled_path,
        "--device",
        "phone",
    ]));
    assert_eq!(
        fs::read_to_string(&pulled).expect("read pulled file"),
        "sandbox-download"
    );

    let tests = fake.run(&[
        "harmony-test",
        "com.example.demo",
        "entry_test",
        "--class",
        "LoginSuite#opens",
        "--not-class",
        "LoginSuite#flaky",
        "--timeout-ms",
        "30000",
        "--dry-run",
        "--device",
        "phone",
    ]);
    assert_success(&tests);
    assert!(String::from_utf8_lossy(&tests.stdout).contains("ArkXTest passed"));

    let (port, server) = arkweb_server();
    let port_arg = port.to_string();
    let inspect = fake.run(&["harmony-arkweb", "--port", &port_arg, "--device", "phone"]);
    assert_success(&inspect);
    server.join().expect("join ArkWeb fixture server");
    assert!(String::from_utf8_lossy(&inspect.stdout).contains("page-1"));
    assert_success(&fake.run(&[
        "harmony-arkweb",
        "--socket",
        "webview_devtools_remote_123",
        "--port",
        &port_arg,
        "--close",
        "--device",
        "phone",
    ]));

    let log = fake.log();
    assert!(
        log.contains("atm perm -g -i 42 -p ohos.permission.CAMERA"),
        "log: {log}"
    );
    assert!(
        log.contains("atm perm -c -i 42 -p ohos.permission.CAMERA"),
        "log: {log}"
    );
    assert!(
        log.contains("shell -b com.example.demo ls -la files"),
        "log: {log}"
    );
    assert!(log.contains("file send -b com.example.demo"), "log: {log}");
    assert!(log.contains("file recv -b com.example.demo"), "log: {log}");
    assert!(
        log.contains("shell aa test -b com.example.demo -m entry_test"),
        "log: {log}"
    );
    assert!(log.contains("fport tcp:"), "log: {log}");
    assert!(log.contains("fport rm tcp:"), "log: {log}");
}

#[test]
fn harmony_recorder_replays_through_the_shared_flow_dispatcher() {
    let fake = FakeHdc::new();
    let name = format!("harmony-fake-hdc-{}", std::process::id());
    assert_success(&fake.run(&[
        "recorder",
        "start",
        "--name",
        &name,
        "--platform",
        "harmony",
    ]));
    assert_success(&fake.run(&[
        "recorder",
        "add-step",
        "tap-text",
        "--args",
        "[\"Continue\"]",
    ]));
    assert_success(&fake.run(&["recorder", "stop"]));
    let play = fake.run(&[
        "recorder",
        "play",
        &name,
        "--platform",
        "harmony",
        "--stop-on-fail",
    ]);
    assert_success(&play);
    let stdout = String::from_utf8_lossy(&play.stdout);
    assert!(
        stdout.contains("Done: 1 passed, 0 failed"),
        "stdout: {stdout}"
    );
    assert!(fake.log().contains("uitest uiInput click 50 20"));
    assert_success(&fake.run(&["recorder", "delete", &name, "--platform", "harmony"]));
}
