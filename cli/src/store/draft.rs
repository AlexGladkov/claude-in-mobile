//! Persistent draft state for store upload flows.
//!
//! The MCP server keeps state in memory between tool calls.
//! The CLI persists draft state to disk so `upload → set-notes → submit`
//! work across separate invocations.

use std::path::PathBuf;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

fn drafts_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home)
        .join(".config")
        .join("claude-in-mobile")
        .join("drafts")
}

fn draft_path(store: &str, package: &str) -> PathBuf {
    let safe_pkg = package.replace(['/', ':'], "_");
    drafts_dir().join(format!("{}-{}.json", store, safe_pkg))
}

pub fn load<T: for<'de> Deserialize<'de>>(store: &str, package: &str) -> Result<T> {
    let path = draft_path(store, package);
    let content = std::fs::read_to_string(&path).with_context(|| {
        format!(
            "No active draft for '{}'. Run '{} upload' first.",
            package, store
        )
    })?;
    serde_json::from_str(&content)
        .with_context(|| format!("Failed to parse draft state for '{}'", package))
}

pub fn save<T: Serialize>(store: &str, package: &str, draft: &T) -> Result<()> {
    let dir = drafts_dir();
    std::fs::create_dir_all(&dir).context("Failed to create drafts directory")?;
    let path = draft_path(store, package);
    let content =
        serde_json::to_string_pretty(draft).context("Failed to serialize draft state")?;
    std::fs::write(&path, content).context("Failed to write draft state")?;
    Ok(())
}

pub fn delete(store: &str, package: &str) {
    let path = draft_path(store, package);
    let _ = std::fs::remove_file(path);
}
