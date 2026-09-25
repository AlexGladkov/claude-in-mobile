//! Persistent draft state for store upload flows.
//!
//! The MCP server keeps state in memory between tool calls.
//! The CLI persists draft state to disk so `upload → set-notes → submit`
//! work across separate invocations.

use std::fs;
use std::path::{Path, PathBuf};

use crate::utils::private_state::{
    atomic_write, create_private_file_if_missing, read_bounded_legacy_file, read_json_file,
    state_dir, validate_identifier, validate_legacy_file_security,
};

#[cfg(test)]
use crate::utils::private_state::create_private_dir;
use anyhow::{bail, Context, Result};
use serde::de::DeserializeOwned;
use serde::Serialize;

const MAX_DRAFT_BYTES: u64 = 1024 * 1024;
#[cfg(test)]
const TEST_HOME_ENV: &str = "MCP_DEVICES_TEST_HOME";
#[cfg(test)]
const TEST_STATE_ROOT_ENV: &str = "MCP_DEVICES_TEST_STATE_ROOT";

fn draft_dir() -> Result<PathBuf> {
    #[cfg(test)]
    if let Some(root) = std::env::var_os(TEST_STATE_ROOT_ENV) {
        let directory = PathBuf::from(root).join("store-drafts");
        create_private_dir(&directory)?;
        return Ok(directory);
    }
    state_dir("store-drafts")
}

fn draft_path(store: &str, package: &str) -> Result<PathBuf> {
    let name = format!("{store}-{package}");
    validate_identifier(&name, "store draft name")?;
    Ok(draft_dir()?.join(format!("{name}.json")))
}

fn legacy_home_dir() -> Result<PathBuf> {
    #[cfg(test)]
    if let Some(root) = std::env::var_os(TEST_HOME_ENV) {
        return Ok(PathBuf::from(root));
    }
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .context("Cannot determine the user home directory")
}

fn legacy_draft_path(store: &str, package: &str) -> Result<PathBuf> {
    let name = format!("{store}-{package}");
    validate_identifier(&name, "store draft name")?;
    Ok(legacy_home_dir()?
        .join(".config")
        .join("mcp-devices")
        .join("drafts")
        .join(format!("{name}.json")))
}

fn migrate_legacy_draft(store: &str, package: &str, destination: &Path) -> Result<()> {
    let legacy = legacy_draft_path(store, package)?;
    match fs::symlink_metadata(destination) {
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Cannot inspect draft {}", destination.display()));
        }
    }
    let metadata = match fs::symlink_metadata(&legacy) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Cannot inspect legacy draft {}", legacy.display()));
        }
    };
    validate_legacy_file_security(&legacy, &metadata, "Legacy store draft")?;
    let contents = read_bounded_legacy_file(&legacy, MAX_DRAFT_BYTES, "store draft")?;
    serde_json::from_slice::<serde_json::Value>(&contents)
        .with_context(|| format!("Corrupt legacy store draft at {}", legacy.display()))?;
    if create_private_file_if_missing(destination, &contents, "store draft")? {
        match fs::remove_file(&legacy) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("Cannot remove migrated store draft {}", legacy.display())
                });
            }
        }
    }
    Ok(())
}

pub fn load<T: DeserializeOwned>(store: &str, package: &str) -> Result<T> {
    let path = draft_path(store, package)?;
    migrate_legacy_draft(store, package, &path)?;
    read_json_file(&path, MAX_DRAFT_BYTES, "store draft").with_context(|| {
        format!(
            "No valid active draft for '{}'. Run '{} upload' first.",
            package, store
        )
    })
}

pub fn save<T: Serialize>(store: &str, package: &str, draft: &T) -> Result<()> {
    let path = draft_path(store, package)?;
    let content = serde_json::to_vec_pretty(draft).context("Failed to serialize draft state")?;
    if content.len() as u64 > MAX_DRAFT_BYTES {
        bail!("Store draft exceeds {MAX_DRAFT_BYTES} bytes");
    }
    atomic_write(&path, &content).context("Failed to write draft state")?;
    Ok(())
}

pub fn delete(store: &str, package: &str) -> Result<()> {
    let path = draft_path(store, package)?;
    migrate_legacy_draft(store, package, &path)?;
    match fs::remove_file(path) {
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
    struct EnvGuard {
        key: &'static str,
        previous: Option<std::ffi::OsString>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: &std::path::Path) -> Self {
            let previous = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, previous }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            if let Some(value) = &self.previous {
                std::env::set_var(self.key, value);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    #[test]
    fn legacy_draft_loads_and_does_not_clobber_private_state() {
        let _lock = crate::android::LEGACY_STATE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let legacy_home = tempfile::tempdir().unwrap();
        let state_root = tempfile::tempdir().unwrap();
        let _home_env = EnvGuard::set(TEST_HOME_ENV, legacy_home.path());
        let _state_env = EnvGuard::set(TEST_STATE_ROOT_ENV, state_root.path());

        let store = "google-play";
        let package = "com.example.app";
        let legacy_path = legacy_draft_path(store, package).unwrap();
        std::fs::create_dir_all(legacy_path.parent().unwrap()).unwrap();
        std::fs::write(&legacy_path, br#"{"editId":"legacy"}"#).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&legacy_path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }

        let migrated: serde_json::Value = load(store, package).unwrap();
        assert_eq!(migrated["editId"], "legacy");

        std::fs::write(&legacy_path, br#"{"editId":"stale"}"#).unwrap();
        let retained: serde_json::Value = load(store, package).unwrap();
        assert_eq!(retained["editId"], "legacy");
    }

    #[cfg(unix)]
    #[test]
    fn legacy_draft_rejects_group_writable_file() {
        use std::os::unix::fs::PermissionsExt;

        let _lock = crate::android::LEGACY_STATE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let legacy_home = tempfile::tempdir().unwrap();
        let state_root = tempfile::tempdir().unwrap();
        let _home_env = EnvGuard::set(TEST_HOME_ENV, legacy_home.path());
        let _state_env = EnvGuard::set(TEST_STATE_ROOT_ENV, state_root.path());

        let store = "google-play";
        let package = "com.example.app";
        let legacy_path = legacy_draft_path(store, package).unwrap();
        std::fs::create_dir_all(legacy_path.parent().unwrap()).unwrap();
        std::fs::write(&legacy_path, br#"{"editId":"legacy"}"#).unwrap();
        let mut permissions = std::fs::metadata(&legacy_path).unwrap().permissions();
        permissions.set_mode(0o664);
        std::fs::set_permissions(&legacy_path, permissions).unwrap();

        let error = load::<serde_json::Value>(store, package).unwrap_err();
        assert!(error.to_string().contains("group/world-writable"));
        assert!(!draft_path(store, package).unwrap().exists());
    }
}
