use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use tempfile::TempDir;

const PLUGIN_FILES: &[&str] = &[
    ".mcp.json",
    ".grok-plugin/plugin.json",
    ".claude-plugin/plugin.json",
    "skills/mcp-devices/SKILL.md",
    "skills/mcp-devices/references/core.md",
    "skills/mcp-devices/references/android-only.md",
    "skills/mcp-devices/references/desktop.md",
    "skills/mcp-devices/references/platform-support.md",
];

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_mcp-devices")
}

struct Isolated {
    cwd: TempDir,
    home: TempDir,
}

impl Isolated {
    fn new() -> Self {
        let cwd = TempDir::new().expect("cwd tempfile");
        // Stop find_git_root from walking into a parent worktree if TMPDIR is inside one.
        fs::write(cwd.path().join(".git"), "gitdir: /dev/null\n").expect("plant dummy .git");
        Self {
            cwd,
            home: TempDir::new().expect("home tempfile"),
        }
    }

    fn cmd(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new(bin());
        cmd.args(args)
            .current_dir(self.cwd.path())
            .env("HOME", self.home.path())
            .env_remove("USERPROFILE")
            .env_remove("HOMEDRIVE")
            .env_remove("HOMEPATH");
        cmd
    }

    fn run(&self, args: &[&str]) -> Output {
        self.cmd(args).output().expect("spawn mcp-devices")
    }

    fn local_plugin(&self) -> PathBuf {
        self.cwd.path().join(".grok/plugins/mcp-devices")
    }

    fn global_plugin(&self) -> PathBuf {
        self.home.path().join(".grok/plugins/mcp-devices")
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

fn assert_plugin_tree(root: &Path) {
    for rel in PLUGIN_FILES {
        let path = root.join(rel);
        assert!(path.is_file(), "missing {}", path.display());
        let content = fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!("read {}: {e}", path.display());
        });
        assert!(!content.is_empty(), "empty {}", path.display());
    }

    let mcp: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(root.join(".mcp.json")).unwrap()).unwrap();
    assert_eq!(
        mcp,
        serde_json::json!({
            "mobile": { "command": "npx", "args": ["-y", "mcp-devices"] }
        })
    );
    assert_eq!(
        fs::read_to_string(root.join(".grok-plugin/plugin.json")).unwrap(),
        fs::read_to_string(root.join(".claude-plugin/plugin.json")).unwrap()
    );
}

fn assert_not_exists(path: &Path) {
    assert!(!path.exists(), "unexpected path {}", path.display());
}

fn assert_no_other_agent_dirs(iso: &Isolated) {
    for rel in [".opencode", ".cursor"] {
        assert_not_exists(&iso.cwd.path().join(rel));
        assert_not_exists(&iso.home.path().join(rel));
    }
}

#[test]
fn local_install_creates_plugin_tree_in_cwd() {
    let iso = Isolated::new();
    let output = iso.run(&["setup", "grok"]);
    assert_success(&output);

    let stdout = String::from_utf8_lossy(&output.stdout);
    let plugin = iso.local_plugin();
    assert!(stdout.contains(plugin.to_string_lossy().as_ref()));
    assert!(stdout.contains("project-local"));
    assert!(stdout.contains("Restart Grok"));
    assert!(stdout.contains("grok plugin install ./.grok/plugins/mcp-devices --trust"));
    assert!(stdout.contains("grok plugin enable mcp-devices"));

    assert_plugin_tree(&plugin);
    assert_not_exists(&iso.global_plugin());
    assert_no_other_agent_dirs(&iso);
}

#[test]
fn global_install_uses_home() {
    let iso = Isolated::new();
    let output = iso.run(&["setup", "grok", "--global"]);
    assert_success(&output);

    let stdout = String::from_utf8_lossy(&output.stdout);
    let plugin = iso.global_plugin();
    assert!(stdout.contains(plugin.to_string_lossy().as_ref()));
    assert!(stdout.contains("global"));

    assert_plugin_tree(&plugin);
    assert_not_exists(&iso.local_plugin());
    assert_no_other_agent_dirs(&iso);
}

#[test]
fn refuses_overwrite_without_force() {
    let iso = Isolated::new();
    assert_success(&iso.run(&["setup", "grok"]));

    let skill = iso.local_plugin().join("skills/mcp-devices/SKILL.md");
    fs::write(&skill, "stale skill content\n").expect("seed different content");

    let output = iso.run(&["setup", "grok"]);
    assert!(!output.status.success(), "expected refuse without --force");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("Refusing to overwrite"), "stderr: {stderr}");
    assert_eq!(fs::read_to_string(&skill).unwrap(), "stale skill content\n");
}

#[test]
fn force_replaces_existing_files() {
    let iso = Isolated::new();
    assert_success(&iso.run(&["setup", "grok"]));

    let skill = iso.local_plugin().join("skills/mcp-devices/SKILL.md");
    fs::write(&skill, "stale skill content\n").expect("seed different content");

    let output = iso.run(&["setup", "grok", "--force"]);
    assert_success(&output);
    let restored = fs::read_to_string(&skill).unwrap();
    assert_ne!(restored, "stale skill content\n");
    assert!(restored.contains("mcp-devices"));
}

#[test]
fn local_install_does_not_touch_opencode_or_cursor() {
    let iso = Isolated::new();
    fs::create_dir_all(iso.cwd.path().join(".opencode/skills")).unwrap();
    fs::create_dir_all(iso.cwd.path().join(".cursor/skills")).unwrap();
    fs::write(iso.cwd.path().join(".opencode/sentinel"), "keep").unwrap();
    fs::write(iso.cwd.path().join(".cursor/sentinel"), "keep").unwrap();

    assert_success(&iso.run(&["setup", "grok"]));

    assert_eq!(
        fs::read_to_string(iso.cwd.path().join(".opencode/sentinel")).unwrap(),
        "keep"
    );
    assert_eq!(
        fs::read_to_string(iso.cwd.path().join(".cursor/sentinel")).unwrap(),
        "keep"
    );
    assert_not_exists(&iso.cwd.path().join(".opencode/skills/mcp-devices"));
    assert_not_exists(&iso.cwd.path().join(".cursor/skills/mcp-devices"));
}
