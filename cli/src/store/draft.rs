//! Persistent draft state for store upload flows.
//!
//! The MCP server keeps state in memory between tool calls.
//! The CLI persists draft state to disk so `upload → set-notes → submit`
//! work across separate invocations.

use std::path::PathBuf;

use crate::utils::private_state::{atomic_write, read_json_file, state_file};
use anyhow::{bail, Context, Result};
use serde::de::DeserializeOwned;
use serde::Serialize;

fn draft_path(store: &str, package: &str) -> Result<PathBuf> {
    state_file("store-drafts", &format!("{store}-{package}"), "json")
}

pub fn load<T: DeserializeOwned>(store: &str, package: &str) -> Result<T> {
    let path = draft_path(store, package)?;
    read_json_file(&path, 1024 * 1024, "store draft").with_context(|| {
        format!(
            "No valid active draft for '{}'. Run '{} upload' first.",
            package, store
        )
    })
}

pub fn save<T: Serialize>(store: &str, package: &str, draft: &T) -> Result<()> {
    let path = draft_path(store, package)?;
    let content = serde_json::to_vec_pretty(draft).context("Failed to serialize draft state")?;
    if content.len() > 1024 * 1024 {
        bail!("Store draft exceeds 1048576 bytes");
    }
    atomic_write(&path, &content).context("Failed to write draft state")?;
    Ok(())
}

pub fn delete(store: &str, package: &str) -> Result<()> {
    let path = draft_path(store, package)?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).context("Failed to delete draft state"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draft_path_rejects_traversal() {
        assert!(draft_path("google-play", "../../escape").is_err());
        assert!(draft_path("google-play", r"..\\..\\escape").is_err());
    }
}
