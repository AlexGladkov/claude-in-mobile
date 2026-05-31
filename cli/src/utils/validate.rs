//! Input validators for CLI commands that ultimately invoke device-side shells.
//!
//! Many Android sandbox commands build a single shell string and pipe it to
//! `adb shell <string>` (which is parsed by `sh` on the device), or pass values
//! through `sed`/`sqlite3`/`run-as`. Any caller-controlled `&str` interpolated
//! raw into such a string is a command-injection sink (CWE-78).
//!
//! These validators apply *strict whitelists* and `bail!` hard on rejection.
//! They MUST be called at the top of every public entry point that touches
//! the affected `format!(...)` sinks, BEFORE any `Command::new(...)` runs.
//!
//! Whitelists are intentionally conservative: it is far better to reject a
//! legitimate-but-exotic input than to let a `; rm -rf /` payload through.

use anyhow::{bail, Result};

/// Validate an Android permission name (e.g. `android.permission.CAMERA`).
///
/// Accepts only `[A-Za-z0-9._]`. This is strict on purpose: standard Android
/// permission names match this exactly. Hyphens, slashes, spaces, and shell
/// metacharacters are rejected because the value is interpolated into
/// `pm grant <pkg> <permission>` argv.
pub fn validate_permission_name(s: &str) -> Result<()> {
    if s.is_empty() {
        bail!("Permission name cannot be empty");
    }
    if s.len() > 256 {
        bail!("Permission name too long (max 256 chars)");
    }
    let ok = s
        .bytes()
        .all(|b| matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_'));
    if !ok {
        bail!(
            "Invalid permission name '{}': only alphanumerics, dots, and underscores allowed",
            s
        );
    }
    Ok(())
}

/// Validate a relative path used inside `run-as <pkg> <cmd> <path>`.
///
/// Rules:
///   * Non-empty, max 1024 chars.
///   * No `..` segment (path traversal).
///   * No leading `/` (must be relative — `run-as` cwd is the app sandbox).
///   * No shell metachars, quotes, whitespace, or NUL.
pub fn validate_relative_path(s: &str) -> Result<()> {
    if s.is_empty() {
        bail!("Path cannot be empty");
    }
    if s.len() > 1024 {
        bail!("Path too long (max 1024 chars)");
    }
    if s.starts_with('/') {
        bail!("Path must be relative to the app sandbox (no leading '/'): '{}'", s);
    }
    // Reject `..` as a path segment (allow filenames that merely contain ".." like "a..b" is also rejected
    // for safety — sandbox paths never need this).
    if s.split('/').any(|seg| seg == ".." || seg.contains("..")) {
        bail!("Path traversal ('..') is not allowed: '{}'", s);
    }
    for b in s.bytes() {
        let bad = matches!(
            b,
            b';' | b'&' | b'|' | b'<' | b'>' | b'$' | b'(' | b')' | b'{' | b'}'
            | b'*' | b'?' | b'[' | b']' | b'\\' | b'\'' | b'"' | b'`'
            | b'\n' | b'\r' | b'\t' | 0
        );
        if bad || b == b' ' {
            bail!(
                "Path '{}' contains a disallowed character (0x{:02x})",
                s, b
            );
        }
    }
    Ok(())
}

/// Validate a SharedPreferences key — alphanumerics plus `._-`.
///
/// The key is embedded into a `sed` substitution expression that lives inside
/// single quotes in a `run-as <pkg> sh -c 'sed -i ...'`-style payload. Even
/// though it sits inside single quotes, we still ban regex metacharacters and
/// the `sed` delimiter to keep the substitution semantically clean.
pub fn validate_pref_key(s: &str) -> Result<()> {
    if s.is_empty() {
        bail!("Preference key cannot be empty");
    }
    if s.len() > 256 {
        bail!("Preference key too long (max 256 chars)");
    }
    let ok = s
        .bytes()
        .all(|b| matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-'));
    if !ok {
        bail!(
            "Invalid preference key '{}': only alphanumerics, dots, underscores, and hyphens allowed",
            s
        );
    }
    Ok(())
}

/// Validate a SharedPreferences XML filename (e.g. `com.foo_preferences.xml`).
///
/// Must match `^[A-Za-z0-9._-]+\.xml$`. Used for the `cat shared_prefs/<file>`
/// and `sed -i ... shared_prefs/<file>` payloads. No path separators allowed
/// here — the prefix `shared_prefs/` is already provided by the caller.
pub fn validate_xml_filename(s: &str) -> Result<()> {
    if s.is_empty() {
        bail!("XML filename cannot be empty");
    }
    if s.len() > 255 {
        bail!("XML filename too long (max 255 chars)");
    }
    if !s.ends_with(".xml") {
        bail!("XML filename '{}' must end with '.xml'", s);
    }
    let ok = s
        .bytes()
        .all(|b| matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-'));
    if !ok {
        bail!(
            "Invalid XML filename '{}': only alphanumerics, dots, underscores, and hyphens allowed",
            s
        );
    }
    Ok(())
}

/// Validate a value that will be embedded into a `sed` replacement expression
/// inside single-quoted shell context.
///
/// Single quotes inside the value are also quoted via `'\''` in the caller, but
/// we still reject the worst offenders here as defence-in-depth and to keep the
/// resulting XML well-formed.
pub fn validate_sqlite_value(s: &str) -> Result<()> {
    if s.len() > 4096 {
        bail!("Value too long (max 4096 chars)");
    }
    for b in s.bytes() {
        let bad = matches!(
            b,
            b';' | b'|' | b'&' | b'<' | b'>' | b'$' | b'(' | b')' | b'`'
            | b'\\' | b'\'' | b'"' | b'\n' | b'\r' | b'\t' | 0
        );
        if bad {
            bail!("Value contains a disallowed character (0x{:02x})", b);
        }
    }
    Ok(())
}

/// Validate a key/identifier that will be a `keystroke "<key>"` arg in
/// AppleScript (macOS `osascript`). AppleScript string literals are
/// double-quoted; a `"` inside the value would terminate the literal and let
/// the caller inject further AppleScript. Whitelist `[A-Za-z0-9_]` only.
pub fn validate_osascript_key(s: &str) -> Result<()> {
    if s.is_empty() {
        bail!("Key cannot be empty");
    }
    if s.len() > 64 {
        bail!("Key too long (max 64 chars)");
    }
    let ok = s
        .bytes()
        .all(|b| matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_'));
    if !ok {
        bail!(
            "Invalid key '{}': only alphanumerics and underscores allowed for AppleScript fallback",
            s
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_name_ok() {
        assert!(validate_permission_name("android.permission.CAMERA").is_ok());
        assert!(validate_permission_name("com.example.MY_PERM").is_ok());
    }

    #[test]
    fn permission_name_rejects_injection() {
        assert!(validate_permission_name("").is_err());
        assert!(validate_permission_name("foo; touch /tmp/RCE").is_err());
        assert!(validate_permission_name("foo bar").is_err());
        assert!(validate_permission_name("foo`id`").is_err());
        assert!(validate_permission_name("foo$(id)").is_err());
    }

    #[test]
    fn relative_path_ok() {
        assert!(validate_relative_path("databases/app.db").is_ok());
        assert!(validate_relative_path(".").is_ok());
        assert!(validate_relative_path("files/log-1.txt").is_ok());
    }

    #[test]
    fn relative_path_rejects_traversal_and_metachars() {
        assert!(validate_relative_path("").is_err());
        assert!(validate_relative_path("/etc/passwd").is_err());
        assert!(validate_relative_path("../../etc/passwd").is_err());
        assert!(validate_relative_path("foo/../bar").is_err());
        assert!(validate_relative_path("foo; rm -rf /").is_err());
        assert!(validate_relative_path("foo`id`").is_err());
        assert!(validate_relative_path("foo$(id)").is_err());
        assert!(validate_relative_path("foo bar").is_err());
        assert!(validate_relative_path("foo|bar").is_err());
        assert!(validate_relative_path("foo\nbar").is_err());
    }

    #[test]
    fn pref_key_ok_and_rejects() {
        assert!(validate_pref_key("user.name-v2").is_ok());
        assert!(validate_pref_key("").is_err());
        assert!(validate_pref_key("foo bar").is_err());
        assert!(validate_pref_key("foo;bar").is_err());
        assert!(validate_pref_key("foo/bar").is_err());
    }

    #[test]
    fn xml_filename_ok_and_rejects() {
        assert!(validate_xml_filename("default_preferences.xml").is_ok());
        assert!(validate_xml_filename("foo-bar.v2.xml").is_ok());
        assert!(validate_xml_filename("default_preferences").is_err());
        assert!(validate_xml_filename("../etc/passwd.xml").is_err());
        assert!(validate_xml_filename("foo;bar.xml").is_err());
        assert!(validate_xml_filename("foo bar.xml").is_err());
    }

    #[test]
    fn sqlite_value_ok_and_rejects() {
        assert!(validate_sqlite_value("hello world").is_ok());
        assert!(validate_sqlite_value("123").is_ok());
        assert!(validate_sqlite_value("foo;bar").is_err());
        assert!(validate_sqlite_value("foo`id`").is_err());
        assert!(validate_sqlite_value("foo$(id)").is_err());
        assert!(validate_sqlite_value("foo\nbar").is_err());
    }

    #[test]
    fn osascript_key_ok_and_rejects() {
        assert!(validate_osascript_key("a").is_ok());
        assert!(validate_osascript_key("enter_key_1").is_ok());
        assert!(validate_osascript_key("").is_err());
        assert!(validate_osascript_key("a\" & (do shell script \"id\") & \"").is_err());
        assert!(validate_osascript_key("a b").is_err());
    }
}
