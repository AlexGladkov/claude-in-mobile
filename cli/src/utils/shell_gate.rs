//! Opt-in gate for the `shell` subcommand (CLI-arbitrary-command sink).
//!
//! The `shell` family of subcommands (`mcp-devices shell …`) executes
//! arbitrary device-side commands. While the on-device shell string itself is
//! quoted via [`crate::utils::device_shell::DeviceShellCmd`] (see #42), the
//! semantic of the command — "run whatever the caller passed, verbatim" —
//! makes it a high-value target for supply-chain / CI misuse: a malicious
//! callsite inside a CI pipeline can pivot from "automate my emulator" to
//! "exfiltrate device data" with a single line.
//!
//! Per issue [#41](https://github.com/AlexGladkov/claude-in-mobile/issues/41)
//! this gate disables the subcommand in non-interactive contexts unless the
//! caller explicitly opts in. The gate is intentionally permissive in
//! interactive shells (developer at a TTY) and strict everywhere else (CI,
//! piped invocations, MCP server callers).
//!
//! # Bypass rules — gate passes if ANY of:
//!
//! 1. The per-invocation flag `--i-know-what-im-doing` is set.
//! 2. The environment variable `MCP_DEVICES_ALLOW_SHELL=1` is set.
//! 3. Both stdin and stderr are connected to a TTY (interactive use).
//!
//! Otherwise the gate returns an error documenting the three opt-ins, and
//! callers are expected to surface that error (the top-level `main` already
//! prints `anyhow::Error` and exits with status `1`).
//!
//! # Why both stdin AND stderr?
//!
//! Many CI runners attach a TTY-like stdin while still capturing stderr to a
//! log file (or vice-versa). Requiring *both* sides to be a TTY is a tight
//! proxy for "a human is actually typing this command and reading the output"
//! without requiring the caller to fork an external `tty`-detection tool.

use std::env;
use std::io::{stderr, stdin, IsTerminal};

use anyhow::{bail, Result};

/// Environment variable that bypasses the gate when set to `1`.
pub const ALLOW_SHELL_ENV: &str = "MCP_DEVICES_ALLOW_SHELL";

/// Warning emitted to stderr before running `shell` in any non-interactive
/// path that has explicitly opted in (flag or env-var). Suppressed when the
/// invocation is interactive — the operator is already at their keyboard.
pub const NON_INTERACTIVE_WARNING: &str =
    "WARNING: shell subcommand grants arbitrary device-side command execution.\n\
     Do not expose this binary to untrusted callers.";

/// Detect whether the current process is running interactively.
///
/// Interactive = both stdin AND stderr are TTYs. See module docs for the
/// rationale on requiring both.
fn detect_interactive() -> bool {
    stdin().is_terminal() && stderr().is_terminal()
}

/// Check whether `MCP_DEVICES_ALLOW_SHELL` is set to a truthy value.
///
/// "Truthy" here is strictly the literal `1` — matching the documented
/// contract in user-facing error messages. Avoid leniency (`yes`, `true`,
/// etc.) so the gate's semantics can never silently broaden.
fn env_allows_shell() -> bool {
    env::var(ALLOW_SHELL_ENV)
        .map(|v| v == "1")
        .unwrap_or(false)
}

/// Gate the `shell` subcommand against unintended non-interactive use.
///
/// Pure wrapper around [`check_shell_allowed_with`] that auto-detects the
/// TTY status and the `MCP_DEVICES_ALLOW_SHELL` env-var. Production
/// call-sites should use this function; the `_with` variant exists for
/// testability (no global state in tests).
///
/// Returns `Ok(())` if the gate passes; the caller MUST also check
/// [`should_emit_warning`] (or call [`emit_warning_if_needed`]) to decide
/// whether to print the non-interactive opt-in warning to stderr before
/// running the actual shell command.
pub fn check_shell_allowed(flag: bool) -> Result<()> {
    check_shell_allowed_with(flag, env_allows_shell(), detect_interactive())
}

/// Testable variant of [`check_shell_allowed`].
///
/// Takes the three gate inputs explicitly so unit tests don't need to
/// manipulate the global env or fake a TTY. Production code uses
/// [`check_shell_allowed`].
pub fn check_shell_allowed_with(flag: bool, env_allow: bool, interactive: bool) -> Result<()> {
    if flag || env_allow || interactive {
        return Ok(());
    }

    bail!(
        "The `shell` subcommand executes arbitrary device-side commands and is\n\
         disabled by default in non-interactive contexts.\n\
         \n\
         To enable, set one of:\n  \
           --i-know-what-im-doing             (per-invocation flag)\n  \
           {ALLOW_SHELL_ENV}=1     (environment variable)\n\
         \n\
         Run interactively from a terminal to bypass this check automatically.\n\
         \n\
         Refs: https://github.com/AlexGladkov/claude-in-mobile/issues/41"
    );
}

/// Whether a warning should be emitted before running the gated command.
///
/// We warn whenever the caller bypassed via flag/env (i.e. consciously opted
/// in from a non-interactive context). We do NOT warn when the bypass was
/// implicit (interactive TTY) — the operator obviously knows what they ran.
pub fn should_emit_warning(interactive: bool) -> bool {
    !interactive
}

/// Print the non-interactive warning to stderr if appropriate.
///
/// Convenience wrapper used at the dispatch site after a successful gate
/// check, so callers don't have to plumb the interactive bool through
/// themselves twice.
pub fn emit_warning_if_needed() {
    if should_emit_warning(detect_interactive()) {
        eprintln!("{NON_INTERACTIVE_WARNING}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flag_bypass_allows_in_non_interactive_no_env() {
        // The `--i-know-what-im-doing` flag short-circuits everything else.
        assert!(check_shell_allowed_with(true, false, false).is_ok());
    }

    #[test]
    fn env_bypass_allows_in_non_interactive_no_flag() {
        // MCP_DEVICES_ALLOW_SHELL=1 alone is enough.
        assert!(check_shell_allowed_with(false, true, false).is_ok());
    }

    #[test]
    fn interactive_allows_without_flag_or_env() {
        // Developer at a terminal: no opt-in needed.
        assert!(check_shell_allowed_with(false, false, true).is_ok());
    }

    #[test]
    fn all_bypasses_combined_allows() {
        // Belt-and-braces: any combination still passes.
        assert!(check_shell_allowed_with(true, true, true).is_ok());
    }

    #[test]
    fn blocked_in_non_interactive_without_opt_in() {
        // The canonical CI / supply-chain case.
        let err = check_shell_allowed_with(false, false, false).unwrap_err();
        let msg = err.to_string();

        // The error MUST advertise all three opt-in mechanisms so the
        // operator knows how to unblock without leaving the terminal.
        assert!(
            msg.contains("--i-know-what-im-doing"),
            "missing flag hint in error: {msg}"
        );
        assert!(
            msg.contains(ALLOW_SHELL_ENV),
            "missing env hint in error: {msg}"
        );
        assert!(
            msg.contains("interactively"),
            "missing TTY hint in error: {msg}"
        );
        assert!(
            msg.contains("issues/41"),
            "missing issue ref in error: {msg}"
        );
    }

    #[test]
    fn warning_suppressed_in_interactive_mode() {
        // Developer at a TTY already knows what they're running.
        assert!(!should_emit_warning(true));
    }

    #[test]
    fn warning_emitted_in_non_interactive_mode() {
        // Whether the bypass came from flag or env, we still warn.
        assert!(should_emit_warning(false));
    }
}
