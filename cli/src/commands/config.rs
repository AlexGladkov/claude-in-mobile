//! Config subcommand — persist CLI settings to `~/.claude-mobile/config.json`.
//!
//! The config file is a flat JSON object. Keys map to arbitrary
//! [`serde_json::Value`] values.  The primary use-case is the global `turbo`
//! toggle for flow commands so that callers do not have to pass `--turbo` on
//! every invocation.
//!
//! # Examples
//!
//! ```text
//! # Enable turbo globally
//! mcp-devices-cli config set turbo true
//!
//! # Check current value
//! mcp-devices-cli config get turbo
//!
//! # List all settings
//! mcp-devices-cli config list
//!
//! # Remove a key
//! mcp-devices-cli config reset turbo
//! ```

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

use crate::utils::private_state::read_json_file;
use crate::utils::process::terminal_safe;

const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
const MAX_CONFIG_KEYS: usize = 256;
// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/// Returns the private application configuration directory.
pub fn config_dir() -> Result<PathBuf> {
    crate::utils::private_state::app_dir()
}

/// Returns the full path to `~/.claude-mobile/config.json`.
pub fn config_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("config.json"))
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

/// Load the config file.
///
/// A missing file produces an empty map. Corrupt or unreadable configuration is
/// reported instead of silently resetting user settings.
pub fn load_config() -> Result<HashMap<String, serde_json::Value>> {
    load_config_from(&config_path()?)
}

fn load_config_from(path: &Path) -> Result<HashMap<String, serde_json::Value>> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(HashMap::new());
        }
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Failed to inspect config at {}", path.display()));
        }
        Ok(_) => {}
    }

    let config: HashMap<String, serde_json::Value> =
        read_json_file(path, MAX_CONFIG_BYTES, "CLI config")
            .with_context(|| format!("Invalid config JSON in {}", path.display()))?;
    if config.len() > MAX_CONFIG_KEYS {
        bail!("CLI config exceeds the {MAX_CONFIG_KEYS}-key limit");
    }
    for key in config.keys() {
        validate_config_key(key)?;
    }
    Ok(config)
}

/// Serialize `config` atomically to `~/.claude-mobile/config.json`.
pub fn save_config(config: &HashMap<String, serde_json::Value>) -> Result<()> {
    save_config_to(&config_path()?, config)
}

fn save_config_to(path: &Path, config: &HashMap<String, serde_json::Value>) -> Result<()> {
    if config.len() > MAX_CONFIG_KEYS {
        bail!("CLI config exceeds the {MAX_CONFIG_KEYS}-key limit");
    }
    for key in config.keys() {
        validate_config_key(key)?;
    }
    let text =
        serde_json::to_string_pretty(config).context("Failed to serialize config to JSON")?;
    if text.len() as u64 > MAX_CONFIG_BYTES {
        bail!("CLI config exceeds the {MAX_CONFIG_BYTES}-byte limit");
    }
    crate::utils::private_state::atomic_write(path, text.as_bytes())
}

// ---------------------------------------------------------------------------
// CLI handlers
// ---------------------------------------------------------------------------

/// Print the value of `key`, or `"not set"` when the key is absent.
pub fn get(key: &str) -> Result<()> {
    let config = load_config()?;
    match config.get(key) {
        Some(value) => println!("{}", terminal_safe(value.to_string().as_bytes())),
        None => println!("not set"),
    }
    Ok(())
}

/// Set `key` to `value`.
///
/// Parsing rules (applied in order):
/// - `"true"` / `"false"` → JSON boolean
/// - All-digit string → JSON number (integer)
/// - Anything else → JSON string
pub fn set(key: &str, value: &str) -> Result<()> {
    validate_config_key(key)?;
    let mut config = load_config()?;
    let parsed = parse_value(value);
    config.insert(key.to_owned(), parsed);
    save_config(&config)?;
    println!("Updated {}", terminal_safe(key.as_bytes()));
    Ok(())
}

/// Print every key=value pair in the config file.
pub fn list() -> Result<()> {
    let config = load_config()?;
    if config.is_empty() {
        println!("(empty)");
    } else {
        let mut pairs: Vec<_> = config.iter().collect();
        pairs.sort_by_key(|(key, _)| key.as_str());
        for (key, value) in pairs {
            if is_sensitive_key(key) {
                println!("{}=<redacted>", terminal_safe(key.as_bytes()));
            } else {
                println!(
                    "{}={}",
                    terminal_safe(key.as_bytes()),
                    terminal_safe(value.to_string().as_bytes()),
                );
            }
        }
    }
    Ok(())
}

/// Remove `key` from the config file.
pub fn reset(key: &str) -> Result<()> {
    validate_config_key(key)?;
    let mut config = load_config()?;
    if config.remove(key).is_some() {
        save_config(&config)?;
        println!("Removed {}", terminal_safe(key.as_bytes()));
    } else {
        println!("{} was not set", terminal_safe(key.as_bytes()));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Programmatic accessor (used by other modules)
// ---------------------------------------------------------------------------

/// Return the boolean value of `key`, or `None` when not set / not a boolean.
///
/// Used by flow commands to resolve the global turbo toggle:
/// ```rust,ignore
/// let turbo = turbo || config::get_bool("turbo")?.unwrap_or(false);
/// ```
pub fn get_bool(key: &str) -> Result<Option<bool>> {
    Ok(load_config()?.get(key).and_then(|value| value.as_bool()))
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn validate_config_key(key: &str) -> Result<()> {
    if key.is_empty() || key.len() > 128 || key.chars().any(char::is_control) {
        bail!("Config keys must contain 1-128 non-control characters");
    }
    Ok(())
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    [
        "authorization",
        "cookie",
        "credential",
        "password",
        "secret",
        "token",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

/// Parse a string argument into the most specific JSON value type.
fn parse_value(s: &str) -> serde_json::Value {
    match s {
        "true" => serde_json::Value::Bool(true),
        "false" => serde_json::Value::Bool(false),
        other => {
            // Try integer first, then fall through to string.
            if let Ok(n) = other.parse::<i64>() {
                serde_json::Value::Number(n.into())
            } else if let Ok(f) = other.parse::<f64>() {
                serde_json::json!(f)
            } else {
                serde_json::Value::String(other.to_owned())
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ----- parse_value -------------------------------------------------------

    #[test]
    fn parse_true_is_bool() {
        assert_eq!(parse_value("true"), serde_json::Value::Bool(true));
    }

    #[test]
    fn parse_false_is_bool() {
        assert_eq!(parse_value("false"), serde_json::Value::Bool(false));
    }

    #[test]
    fn parse_integer_is_number() {
        assert_eq!(parse_value("42"), serde_json::Value::Number(42_i64.into()));
    }

    #[test]
    fn parse_zero_is_number() {
        assert_eq!(parse_value("0"), serde_json::Value::Number(0_i64.into()));
    }

    #[test]
    fn parse_string_stays_string() {
        assert_eq!(
            parse_value("hello"),
            serde_json::Value::String("hello".to_owned())
        );
    }

    #[test]
    fn parse_empty_string() {
        assert_eq!(parse_value(""), serde_json::Value::String(String::new()));
    }

    // ----- config round-trip -------------------------------------------------

    #[test]
    fn config_path_ends_with_config_json() {
        let p = config_path().expect("config path");
        assert!(
            p.to_string_lossy().ends_with("config.json"),
            "unexpected path: {}",
            p.display()
        );
    }

    #[test]
    fn save_and_load_roundtrip() {
        use tempfile::TempDir;

        let tmp = TempDir::new().expect("tempdir");
        let path = tmp.path().join("config.json");
        let mut cfg = HashMap::new();
        cfg.insert("turbo".to_owned(), serde_json::Value::Bool(true));
        cfg.insert("count".to_owned(), serde_json::Value::Number(7_i64.into()));

        save_config_to(&path, &cfg).expect("save");
        let loaded = load_config_from(&path).expect("load");

        assert_eq!(loaded.get("turbo").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(loaded.get("count").and_then(|v| v.as_i64()), Some(7));
    }

    #[test]
    fn corrupt_config_is_reported() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let path = tmp.path().join("config.json");
        fs::write(&path, "{broken").expect("write corrupt config");

        let error = load_config_from(&path).expect_err("corruption must fail");

        assert!(error.to_string().contains("Invalid config JSON"));
    }
}
