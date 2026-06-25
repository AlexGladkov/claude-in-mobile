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
//! mcp-devices config set turbo true
//!
//! # Check current value
//! mcp-devices config get turbo
//!
//! # List all settings
//! mcp-devices config list
//!
//! # Remove a key
//! mcp-devices config reset turbo
//! ```

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/// Returns `~/.claude-mobile/`, creating the directory if it does not exist.
///
/// Falls back to `$HOME/.claude-mobile/` when `dirs` is unavailable.
pub fn config_dir() -> PathBuf {
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    let dir = home.join(".claude-mobile");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir
}

/// Returns the full path to `~/.claude-mobile/config.json`.
pub fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

/// Load the config file.
///
/// Returns an empty map when the file does not exist or cannot be parsed.
pub fn load_config() -> HashMap<String, serde_json::Value> {
    let path = config_path();
    let Ok(text) = fs::read_to_string(&path) else {
        return HashMap::new();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

/// Serialize `config` to `~/.claude-mobile/config.json` as pretty-printed JSON.
pub fn save_config(config: &HashMap<String, serde_json::Value>) -> Result<()> {
    let path = config_path();
    // Ensure directory exists (created lazily).
    let _ = config_dir();
    let text = serde_json::to_string_pretty(config)
        .context("Failed to serialize config to JSON")?;
    fs::write(&path, text).with_context(|| format!("Failed to write config to {}", path.display()))
}

// ---------------------------------------------------------------------------
// CLI handlers
// ---------------------------------------------------------------------------

/// Print the value of `key`, or `"not set"` when the key is absent.
pub fn get(key: &str) -> Result<()> {
    let config = load_config();
    match config.get(key) {
        Some(value) => println!("{}", value),
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
    let mut config = load_config();
    let parsed = parse_value(value);
    config.insert(key.to_owned(), parsed);
    save_config(&config)?;
    println!("Set {} = {}", key, value);
    Ok(())
}

/// Print every key=value pair in the config file.
pub fn list() -> Result<()> {
    let config = load_config();
    if config.is_empty() {
        println!("(empty)");
    } else {
        // Sort keys for stable output.
        let mut pairs: Vec<_> = config.iter().collect();
        pairs.sort_by_key(|(k, _)| k.as_str());
        for (k, v) in pairs {
            println!("{k}={v}");
        }
    }
    Ok(())
}

/// Remove `key` from the config file.
pub fn reset(key: &str) -> Result<()> {
    let mut config = load_config();
    if config.remove(key).is_some() {
        save_config(&config)?;
        println!("Removed {key}");
    } else {
        println!("{key} was not set");
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
/// let turbo = turbo || config::get_bool("turbo").unwrap_or(false);
/// ```
pub fn get_bool(key: &str) -> Option<bool> {
    load_config()
        .get(key)
        .and_then(|v| v.as_bool())
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
        assert_eq!(
            parse_value("42"),
            serde_json::Value::Number(42_i64.into())
        );
    }

    #[test]
    fn parse_zero_is_number() {
        assert_eq!(
            parse_value("0"),
            serde_json::Value::Number(0_i64.into())
        );
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
        assert_eq!(
            parse_value(""),
            serde_json::Value::String(String::new())
        );
    }

    // ----- config round-trip -------------------------------------------------

    #[test]
    fn config_path_ends_with_config_json() {
        let p = config_path();
        assert!(
            p.to_string_lossy().ends_with("config.json"),
            "unexpected path: {}",
            p.display()
        );
    }

    #[test]
    fn save_and_load_roundtrip() {
        use std::env;
        use tempfile::TempDir;

        // Redirect HOME to a temporary directory so we do not touch real config.
        let tmp = TempDir::new().expect("tempdir");
        let original_home = env::var("HOME").ok();
        // SAFETY: single-threaded test context.
        unsafe { env::set_var("HOME", tmp.path()) };

        let mut cfg = HashMap::new();
        cfg.insert("turbo".to_owned(), serde_json::Value::Bool(true));
        cfg.insert("count".to_owned(), serde_json::Value::Number(7_i64.into()));

        save_config(&cfg).expect("save");
        let loaded = load_config();

        assert_eq!(loaded.get("turbo").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(loaded.get("count").and_then(|v| v.as_i64()), Some(7));

        // Restore HOME.
        unsafe {
            match original_home {
                Some(h) => env::set_var("HOME", h),
                None => env::remove_var("HOME"),
            }
        }
    }

    #[test]
    fn get_bool_returns_none_for_missing_key() {
        // Use a fresh isolated env so existing ~/.claude-mobile/config.json
        // does not interfere.
        use std::env;
        use tempfile::TempDir;

        let tmp = TempDir::new().expect("tempdir");
        let original_home = env::var("HOME").ok();
        unsafe { env::set_var("HOME", tmp.path()) };

        assert_eq!(get_bool("nonexistent"), None);

        unsafe {
            match original_home {
                Some(h) => env::set_var("HOME", h),
                None => env::remove_var("HOME"),
            }
        }
    }
}
