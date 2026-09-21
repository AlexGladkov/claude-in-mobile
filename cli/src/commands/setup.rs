//! Integration setup commands.

use std::env;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

use crate::cli::SetupCommands;
use crate::utils::private_state::read_bounded_file;

const SKILL_NAME: &str = "mcp-devices";
const SKILL_MD: &str = include_str!("../../plugin/skills/mcp-devices/SKILL.md");
const PLATFORM_SUPPORT_MD: &str =
    include_str!("../../plugin/skills/mcp-devices/references/platform-support.md");
const CORE_MD: &str = include_str!("../../plugin/skills/mcp-devices/references/core.md");
const ANDROID_ONLY_MD: &str =
    include_str!("../../plugin/skills/mcp-devices/references/android-only.md");
const DESKTOP_MD: &str = include_str!("../../plugin/skills/mcp-devices/references/desktop.md");
const MCP_JSON: &str = include_str!("../../plugin/.mcp.json");
const GROK_PLUGIN_JSON: &str = include_str!("../../plugin/.grok-plugin/plugin.json");
const CLAUDE_PLUGIN_JSON: &str = include_str!("../../plugin/.claude-plugin/plugin.json");

pub fn run(command: SetupCommands) -> Result<()> {
    match command {
        SetupCommands::Opencode {
            local,
            global,
            force,
        } => opencode(local, global, force),
        SetupCommands::Pi {
            local,
            global,
            force,
        } => pi(local, global, force),
        SetupCommands::Qwen {
            local,
            global,
            force,
        } => qwen(local, global, force),
        SetupCommands::Gemini {
            local,
            global,
            force,
        } => gemini(local, global, force),
        SetupCommands::Codex {
            local,
            global,
            force,
        } => codex(local, global, force),
        SetupCommands::Cursor {
            local,
            global,
            force,
        } => cursor(local, global, force),
        SetupCommands::Grok {
            local,
            global,
            force,
        } => grok(local, global, force),
    }
}

fn opencode(local: bool, global: bool, force: bool) -> Result<()> {
    install_agent_skill(
        "OpenCode",
        &[".opencode", "skills"],
        &[".config", "opencode", "skills"],
        local,
        global,
        force,
    )
}

fn pi(local: bool, global: bool, force: bool) -> Result<()> {
    install_agent_skill(
        "Pi",
        &[".pi", "skills"],
        &[".pi", "agent", "skills"],
        local,
        global,
        force,
    )
}

fn qwen(local: bool, global: bool, force: bool) -> Result<()> {
    install_agent_skill(
        "Qwen Code",
        &[".qwen", "skills"],
        &[".qwen", "skills"],
        local,
        global,
        force,
    )
}

fn gemini(local: bool, global: bool, force: bool) -> Result<()> {
    install_agent_skill(
        "Gemini CLI",
        &[".gemini", "skills"],
        &[".gemini", "skills"],
        local,
        global,
        force,
    )
}

fn codex(local: bool, global: bool, force: bool) -> Result<()> {
    install_agent_skill(
        "Codex",
        &[".agents", "skills"],
        &[".agents", "skills"],
        local,
        global,
        force,
    )
}

fn cursor(local: bool, global: bool, force: bool) -> Result<()> {
    install_agent_skill(
        "Cursor",
        &[".cursor", "skills"],
        &[".cursor", "skills"],
        local,
        global,
        force,
    )
}

fn grok(local: bool, global: bool, force: bool) -> Result<()> {
    let scope = install_scope(local, global);
    let target_dir = match scope {
        InstallScope::Local => project_root()?,
        InstallScope::Global => home_dir()?,
    }
    .join(".grok")
    .join("plugins")
    .join(SKILL_NAME);

    install_grok_plugin(&target_dir, force)?;

    println!(
        "Installed Grok plugin ({}) at {}\n{}",
        scope_label(scope),
        target_dir.display(),
        grok_next_steps(scope)
    );
    Ok(())
}

fn install_grok_plugin(target_dir: &Path, force: bool) -> Result<()> {
    let files: [(&[&str], &str); 8] = [
        (&[".mcp.json"], MCP_JSON),
        (&[".grok-plugin", "plugin.json"], GROK_PLUGIN_JSON),
        (&[".claude-plugin", "plugin.json"], CLAUDE_PLUGIN_JSON),
        (&["skills", SKILL_NAME, "SKILL.md"], SKILL_MD),
        (&["skills", SKILL_NAME, "references", "core.md"], CORE_MD),
        (
            &["skills", SKILL_NAME, "references", "android-only.md"],
            ANDROID_ONLY_MD,
        ),
        (
            &["skills", SKILL_NAME, "references", "desktop.md"],
            DESKTOP_MD,
        ),
        (
            &["skills", SKILL_NAME, "references", "platform-support.md"],
            PLATFORM_SUPPORT_MD,
        ),
    ];
    for (parts, content) in files {
        write_file_if_needed(
            &append_parts(target_dir.to_path_buf(), parts),
            content,
            force,
        )?;
    }
    Ok(())
}

fn install_agent_skill(
    agent_name: &str,
    local_parts: &[&str],
    global_parts: &[&str],
    local: bool,
    global: bool,
    force: bool,
) -> Result<()> {
    let scope = install_scope(local, global);

    let target_dir = match scope {
        InstallScope::Local => append_parts(project_root()?, local_parts).join(SKILL_NAME),
        InstallScope::Global => append_parts(home_dir()?, global_parts).join(SKILL_NAME),
    };

    install_skill(&target_dir, force)?;

    println!(
        "Installed {} skill ({}) at {}\nRestart {}, then ask it to use the mcp-devices skill.",
        agent_name,
        scope_label(scope),
        target_dir.display(),
        agent_name
    );
    Ok(())
}

fn append_parts(mut base: PathBuf, parts: &[&str]) -> PathBuf {
    for part in parts {
        base.push(part);
    }
    base
}

fn install_scope(local: bool, global: bool) -> InstallScope {
    if global {
        InstallScope::Global
    } else {
        // Default to project-local install. The `local` flag exists for explicitness.
        let _ = local;
        InstallScope::Local
    }
}

fn scope_label(scope: InstallScope) -> &'static str {
    match scope {
        InstallScope::Local => "project-local",
        InstallScope::Global => "global",
    }
}

fn grok_next_steps(scope: InstallScope) -> &'static str {
    match scope {
        // Project plugins are not auto-trusted; MCP stays inactive until trust.
        InstallScope::Local => {
            "Restart Grok, then trust and enable the plugin:\n  grok plugin install ./.grok/plugins/mcp-devices --trust\n  grok plugin enable mcp-devices"
        }
        // Global plugins land in Grok's auto-trusted area: on restart Grok will
        // launch the bundled MCP server without a separate `--trust` step.
        InstallScope::Global => {
            "Heads up: this installs into Grok's auto-trusted area, so on restart Grok will automatically run the MCP server (npx -y mcp-devices).\nRestart Grok. If mcp-devices does not appear, run: grok plugin enable mcp-devices"
        }
    }
}

#[derive(Clone, Copy)]
enum InstallScope {
    Local,
    Global,
}

fn install_skill(target_dir: &Path, force: bool) -> Result<()> {
    write_file_if_needed(&target_dir.join("SKILL.md"), SKILL_MD, force)?;
    write_file_if_needed(
        &target_dir.join("references").join("platform-support.md"),
        PLATFORM_SUPPORT_MD,
        force,
    )?;
    Ok(())
}

fn write_file_if_needed(path: &Path, content: &str, force: bool) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                bail!("Refusing to overwrite non-regular file: {}", path.display());
            }
            if metadata.len() <= content.len() as u64
                && read_bounded_file(path, content.len() as u64 + 1, "setup target")?
                    == content.as_bytes()
            {
                return Ok(());
            }
            if !force {
                bail!(
                    "Refusing to overwrite existing file: {}. Re-run with --force to replace it.",
                    path.display()
                );
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Failed to inspect file: {}", path.display()));
        }
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create directory: {}", parent.display()))?;
    }
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW).mode(0o644);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        options.custom_flags(0x0020_0000);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("Failed to safely open file: {}", path.display()))?;
    file.write_all(content.as_bytes())
        .with_context(|| format!("Failed to write file: {}", path.display()))?;
    file.sync_all()
        .with_context(|| format!("Failed to persist file: {}", path.display()))?;
    Ok(())
}

fn project_root() -> Result<PathBuf> {
    let cwd = env::current_dir().context("Failed to read current directory")?;
    Ok(find_git_root(&cwd).unwrap_or(cwd))
}

fn find_git_root(start: &Path) -> Option<PathBuf> {
    let mut current = start;
    loop {
        if current.join(".git").exists() {
            return Some(current.to_path_buf());
        }
        current = current.parent()?;
    }
}

fn home_dir() -> Result<PathBuf> {
    if let Some(home) = env_var_path("HOME") {
        return Ok(home);
    }
    if let Some(profile) = env_var_path("USERPROFILE") {
        return Ok(profile);
    }

    let drive = env::var_os("HOMEDRIVE");
    let path = env::var_os("HOMEPATH");
    if let (Some(drive), Some(path)) = (drive, path) {
        let mut combined = OsString::from(drive);
        combined.push(path);
        return Ok(PathBuf::from(combined));
    }

    bail!("Could not determine home directory. Set HOME or USERPROFILE and try again.")
}

fn env_var_path(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn forced_setup_write_refuses_symlink_targets() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target.md");
        let link = directory.path().join("SKILL.md");
        fs::write(&target, "keep").unwrap();
        symlink(&target, &link).unwrap();

        assert!(write_file_if_needed(&link, "replace", true).is_err());
        assert_eq!(fs::read_to_string(target).unwrap(), "keep");
    }
}
