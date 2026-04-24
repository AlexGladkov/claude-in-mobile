//! Integration setup commands.

use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

use crate::cli::SetupCommands;

const SKILL_NAME: &str = "claude-in-mobile";
const SKILL_MD: &str = include_str!("../../plugin/skills/claude-in-mobile/SKILL.md");
const PLATFORM_SUPPORT_MD: &str =
    include_str!("../../plugin/skills/claude-in-mobile/references/platform-support.md");

pub fn run(command: SetupCommands) -> Result<()> {
    match command {
        SetupCommands::Opencode {
            local,
            global,
            force,
        } => opencode(local, global, force),
    }
}

fn opencode(local: bool, global: bool, force: bool) -> Result<()> {
    let scope = if global {
        InstallScope::Global
    } else {
        // Default to project-local install. The `local` flag exists for explicitness.
        let _ = local;
        InstallScope::Local
    };

    let target_dir = match scope {
        InstallScope::Local => project_root()?
            .join(".opencode")
            .join("skills")
            .join(SKILL_NAME),
        InstallScope::Global => home_dir()?
            .join(".config")
            .join("opencode")
            .join("skills")
            .join(SKILL_NAME),
    };

    install_skill(&target_dir, force)?;

    let scope_label = match scope {
        InstallScope::Local => "project-local",
        InstallScope::Global => "global",
    };

    println!(
        "Installed OpenCode skill ({}) at {}\nRestart OpenCode, then ask it to use the claude-in-mobile skill.",
        scope_label,
        target_dir.display()
    );
    Ok(())
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
    if let Ok(existing) = fs::read_to_string(path) {
        if existing == content {
            return Ok(());
        }
        if !force {
            bail!(
                "Refusing to overwrite existing file: {}. Re-run with --force to replace it.",
                path.display()
            );
        }
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create directory: {}", parent.display()))?;
    }

    fs::write(path, content)
        .with_context(|| format!("Failed to write file: {}", path.display()))?;
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
