//! Typed builder for device-side shell commands transported via
//! `adb shell <string>` (or `audb shell <string>`).
//!
//! The on-device `sh` re-parses the single string we hand to ADB, which means
//! every caller-controlled `&str` interpolated raw into that string is a
//! command-injection sink (CWE-78). The entry-point validators in
//! [`crate::utils::validate`] are the first line of defence — they reject
//! payloads that contain shell metacharacters at the public CLI surface.
//!
//! This builder is **defence in depth**: it forces every command segment
//! through one of three explicit constructors, and on render it POSIX-quotes
//! the dynamic ones so embedded metacharacters become inert even if a
//! validator forgets to ban one of them. Reviewers can audit every
//! injection-risky site with a single grep for `.user_input(`.
//!
//! # Quoting model
//!
//! - [`DeviceShellArg::Literal`] — a `&'static str` baked into the binary at
//!   compile time. Assumed to be metachar-free by construction; emitted as-is.
//! - [`DeviceShellArg::Validated`] — passed a validator function that returned
//!   `Ok(())`. Defensively single-quoted on render.
//! - [`DeviceShellArg::UserInput`] — arbitrary string. Always single-quoted
//!   using the canonical POSIX trick: `'` becomes `'\''` (close, escape,
//!   reopen). Safe even with `; | & $ \` and newlines inside.
//!
//! # Example
//!
//! ```ignore
//! use crate::utils::device_shell::DeviceShellCmd;
//! use crate::utils::validate::validate_xml_filename;
//!
//! let cmd = DeviceShellCmd::new()
//!     .literal("run-as")
//!     .validated("com.example.app", |s| { /* validate package */ Ok(()) })?
//!     .literal("cat")
//!     .validated("shared_prefs/default_preferences.xml", validate_xml_filename)?;
//!
//! let shell_string = cmd.render();
//! // Hand `shell_string` to `adb_exec(device, &["shell", &shell_string], None)`.
//! ```

use anyhow::Result;

/// One segment of a device-side shell command.
///
/// See the module-level docs for the quoting model.
#[allow(dead_code)]
pub enum DeviceShellArg {
    /// Compile-time static; emitted verbatim.
    Literal(&'static str),
    /// Caller passed a validator that returned `Ok(())`; defensively quoted.
    Validated(String),
    /// Arbitrary user-controlled string; POSIX-quoted on render.
    UserInput(String),
    /// Pre-composed trusted fragment (e.g. a nested builder's `render()` output
    /// joined with ` && `). Emitted verbatim — never accepts user input.
    RawTrusted(String),
}

/// Builder for an `adb shell <string>` / `audb shell <string>` payload.
///
/// All arguments are joined with a single space on [`render`](Self::render).
/// `Literal` segments are emitted as-is; `Validated` and `UserInput` segments
/// are wrapped in single quotes with POSIX-style `'` escaping.
pub struct DeviceShellCmd {
    args: Vec<DeviceShellArg>,
}

impl DeviceShellCmd {
    /// Create an empty builder.
    pub fn new() -> Self {
        Self { args: Vec::new() }
    }

    /// Append a compile-time static literal. Use this for command names,
    /// subcommand keywords, flag names, and any other text known at compile
    /// time. The `'static` lifetime makes "is this trusted?" a type-system
    /// invariant rather than a code-review question.
    pub fn literal(mut self, s: &'static str) -> Self {
        self.args.push(DeviceShellArg::Literal(s));
        self
    }

    /// Append a runtime string that has been validated against a whitelist.
    ///
    /// `validator` runs immediately; if it returns `Err`, the whole builder
    /// short-circuits with that error and no further segments are added. The
    /// validators in [`crate::utils::validate`] are designed for this slot.
    ///
    /// The value is still single-quoted on render — even if the validator
    /// forgets a metachar, the quoting renders it inert.
    pub fn validated<V>(mut self, s: &str, validator: V) -> Result<Self>
    where
        V: FnOnce(&str) -> Result<()>,
    {
        validator(s)?;
        self.args.push(DeviceShellArg::Validated(s.to_string()));
        Ok(self)
    }

    /// Append an unvalidated runtime string.
    ///
    /// The value will be POSIX single-quoted on render, so shell metacharacters
    /// inside are inert. This is the right choice for free-form inputs (typed
    /// text, SQL queries, clipboard contents, etc.) where the user is trusted
    /// not to attack themselves but the data may legitimately contain `;`,
    /// `|`, `$`, backticks, or newlines.
    pub fn user_input(mut self, s: &str) -> Self {
        self.args.push(DeviceShellArg::UserInput(s.to_string()));
        self
    }

    /// Append a raw, pre-composed sub-command.
    ///
    /// This is an escape hatch for callers that have already assembled a fully
    /// trusted shell fragment (e.g. another `DeviceShellCmd::render()` result
    /// being piped through ` && `). The string is emitted verbatim with no
    /// quoting — DO NOT pass user input through this path.
    #[allow(dead_code)]
    pub fn raw_trusted(mut self, s: String) -> Self {
        // Stored as Literal would require &'static; we leak nothing here —
        // we store as a Validated segment with a no-op validator that already
        // ran. To avoid quoting it, we use a private marker by abusing the
        // render path: we just append it as a raw segment via a separate vec.
        // Simpler: keep it as UserInput-equivalent but DO quote it. The
        // public surface only exposes this for `exec_with_ui_dump` style
        // chaining where quoting would break the composed command. We use a
        // dedicated variant.
        self.args.push(DeviceShellArg::RawTrusted(s));
        self
    }

    /// Render the builder as a single shell-ready string.
    pub fn render(&self) -> String {
        let mut out = String::new();
        for (i, a) in self.args.iter().enumerate() {
            if i > 0 {
                out.push(' ');
            }
            match a {
                DeviceShellArg::Literal(s) => out.push_str(s),
                DeviceShellArg::Validated(s) | DeviceShellArg::UserInput(s) => {
                    push_single_quoted(&mut out, s);
                }
                DeviceShellArg::RawTrusted(s) => out.push_str(s),
            }
        }
        out
    }
}

impl Default for DeviceShellCmd {
    fn default() -> Self {
        Self::new()
    }
}

/// POSIX single-quote escape: wrap `s` in `'…'`, replacing every embedded `'`
/// with `'\''` (close quote, escape literal apostrophe, reopen quote).
fn push_single_quoted(out: &mut String, s: &str) {
    out.push('\'');
    let mut rest = s;
    while let Some(idx) = rest.find('\'') {
        out.push_str(&rest[..idx]);
        out.push_str("'\\''");
        rest = &rest[idx + 1..];
    }
    out.push_str(rest);
    out.push('\'');
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::bail;

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /// Minimal POSIX shell tokenizer sufficient for unit tests.
    /// Honours single quotes (literal, no escapes inside), double quotes
    /// (with `\` escapes for `" \ $ \``), and backslash escapes outside
    /// quotes. Token boundaries are unquoted whitespace.
    ///
    /// This is NOT a full sh parser — it is a faithful enough model of how
    /// `sh` would split our rendered output to verify the round-trip
    /// invariant: "any byte we put inside `.user_input()` reappears as a
    /// literal byte inside exactly one resulting token".
    fn shell_split(input: &str) -> Vec<String> {
        let mut tokens = Vec::new();
        let mut cur = String::new();
        let mut chars = input.chars().peekable();
        let mut in_token = false;
        while let Some(c) = chars.next() {
            match c {
                ' ' | '\t' | '\n' => {
                    if in_token {
                        tokens.push(std::mem::take(&mut cur));
                        in_token = false;
                    }
                }
                '\'' => {
                    in_token = true;
                    // Read until closing single quote, literally.
                    for sc in chars.by_ref() {
                        if sc == '\'' {
                            break;
                        }
                        cur.push(sc);
                    }
                }
                '"' => {
                    in_token = true;
                    while let Some(dc) = chars.next() {
                        if dc == '"' {
                            break;
                        }
                        if dc == '\\' {
                            if let Some(&nx) = chars.peek() {
                                if matches!(nx, '"' | '\\' | '$' | '`') {
                                    cur.push(nx);
                                    chars.next();
                                    continue;
                                }
                            }
                        }
                        cur.push(dc);
                    }
                }
                '\\' => {
                    if let Some(nx) = chars.next() {
                        cur.push(nx);
                        in_token = true;
                    }
                }
                _ => {
                    cur.push(c);
                    in_token = true;
                }
            }
        }
        if in_token {
            tokens.push(cur);
        }
        tokens
    }

    // ---------------------------------------------------------------------
    // Empty / basic
    // ---------------------------------------------------------------------

    #[test]
    fn empty_builder_renders_empty_string() {
        assert_eq!(DeviceShellCmd::new().render(), "");
    }

    #[test]
    fn literal_only_renders_verbatim() {
        let s = DeviceShellCmd::new().literal("ls").literal("-la").render();
        assert_eq!(s, "ls -la");
    }

    #[test]
    fn user_input_is_single_quoted() {
        let s = DeviceShellCmd::new()
            .literal("echo")
            .user_input("hello world")
            .render();
        assert_eq!(s, "echo 'hello world'");
    }

    #[test]
    fn validated_is_single_quoted_even_on_safe_input() {
        let s = DeviceShellCmd::new()
            .literal("cat")
            .validated("databases/app.db", |_| Ok(()))
            .unwrap()
            .render();
        assert_eq!(s, "cat 'databases/app.db'");
    }

    #[test]
    fn validator_failure_short_circuits() {
        let res = DeviceShellCmd::new()
            .literal("cat")
            .validated("evil; rm -rf /", |s| {
                if s.contains(';') {
                    bail!("nope")
                } else {
                    Ok(())
                }
            });
        assert!(res.is_err());
    }

    #[test]
    fn embedded_single_quote_is_posix_escaped() {
        // "O'Brien" -> 'O'\''Brien'
        let s = DeviceShellCmd::new().user_input("O'Brien").render();
        assert_eq!(s, r#"'O'\''Brien'"#);
        // Round-trip: shell tokenises it back into a single literal token.
        let toks = shell_split(&s);
        assert_eq!(toks, vec!["O'Brien".to_string()]);
    }

    #[test]
    fn raw_trusted_is_emitted_verbatim() {
        let s = DeviceShellCmd::new()
            .raw_trusted("foo && bar".to_string())
            .render();
        assert_eq!(s, "foo && bar");
    }

    // ---------------------------------------------------------------------
    // Metacharacter corpus — every byte that has special meaning in `sh`
    // must come out as a literal in the resulting token, never as an
    // operator/separator.
    // ---------------------------------------------------------------------

    /// Each (label, payload) pair. The payload is wrapped in a fixed prefix
    /// + suffix so we can be sure the tokenizer assembled a single token
    /// containing exactly the payload (with surrounding markers).
    fn metachar_corpus() -> Vec<(&'static str, &'static str)> {
        vec![
            ("semicolon",       ";"),
            ("pipe",            "|"),
            ("ampersand",       "&"),
            ("dollar",          "$"),
            ("backtick",        "`"),
            ("double_quote",    "\""),
            ("single_quote",    "'"),
            ("backslash",       "\\"),
            ("paren_open",      "("),
            ("paren_close",     ")"),
            ("lt",              "<"),
            ("gt",              ">"),
            ("brace_open",      "{"),
            ("brace_close",     "}"),
            ("star",            "*"),
            ("question",        "?"),
            ("bracket_open",    "["),
            ("bracket_close",   "]"),
            ("newline",         "\n"),
            ("tab",             "\t"),
            ("bang",            "!"),
            ("compound",        "$(id); rm -rf / | cat `whoami`"),
        ]
    }

    #[test]
    fn user_input_metachars_survive_as_literals() {
        for (label, payload) in metachar_corpus() {
            let wrapped = format!("BEGIN{}END", payload);
            let rendered = DeviceShellCmd::new()
                .literal("echo")
                .user_input(&wrapped)
                .render();

            // Render contains the payload literally inside the quoted segment.
            // For single quotes, the byte is escaped as `'\''` rather than
            // appearing literally — so for that one case we don't assert
            // "literal substring", we assert the round-trip below.
            if payload != "'" {
                assert!(
                    rendered.contains(payload),
                    "[{label}] rendered={rendered:?} missing literal payload {payload:?}"
                );
            }

            let toks = shell_split(&rendered);
            assert_eq!(
                toks.len(),
                2,
                "[{label}] rendered={rendered:?} split into {toks:?}, expected 2 tokens"
            );
            assert_eq!(toks[0], "echo", "[{label}] command word changed");
            assert_eq!(
                toks[1], wrapped,
                "[{label}] payload mutated during shell-split: rendered={rendered:?}, toks={toks:?}"
            );
        }
    }

    #[test]
    fn validated_metachars_also_survive() {
        // The validator is intentionally permissive here — we are testing the
        // builder's defensive quoting, not the validator.
        for (label, payload) in metachar_corpus() {
            let wrapped = format!("V{}V", payload);
            let rendered = DeviceShellCmd::new()
                .literal("cat")
                .validated(&wrapped, |_| Ok(()))
                .unwrap()
                .render();
            let toks = shell_split(&rendered);
            assert_eq!(toks.len(), 2, "[{label}] split: {toks:?} from {rendered:?}");
            assert_eq!(toks[1], wrapped, "[{label}] payload mutated");
        }
    }

    // ---------------------------------------------------------------------
    // Realistic-shape regression tests modelling the sandbox call sites.
    // ---------------------------------------------------------------------

    #[test]
    fn sandbox_prefs_read_shape() {
        let s = DeviceShellCmd::new()
            .literal("run-as")
            .validated("com.example.app", |_| Ok(()))
            .unwrap()
            .literal("cat")
            .validated("shared_prefs/default_preferences.xml", |_| Ok(()))
            .unwrap()
            .render();
        assert_eq!(
            s,
            "run-as 'com.example.app' cat 'shared_prefs/default_preferences.xml'"
        );
    }

    #[test]
    fn sandbox_sqlite_query_with_metachars_in_query() {
        let query = "SELECT * FROM users WHERE name = 'O''Brien'; -- attack";
        let s = DeviceShellCmd::new()
            .literal("run-as")
            .validated("com.example.app", |_| Ok(()))
            .unwrap()
            .literal("sqlite3")
            .validated("databases/app.db", |_| Ok(()))
            .unwrap()
            .user_input(query)
            .render();

        // The SQL must survive untouched as a single token.
        let toks = shell_split(&s);
        assert_eq!(toks.len(), 5);
        assert_eq!(toks[0], "run-as");
        assert_eq!(toks[1], "com.example.app");
        assert_eq!(toks[2], "sqlite3");
        assert_eq!(toks[3], "databases/app.db");
        assert_eq!(toks[4], query);
    }

    #[test]
    fn injection_attempt_inside_user_input_is_inert() {
        // Classic CWE-78 payload — would be catastrophic without quoting.
        let evil = "x'; rm -rf / #";
        let rendered = DeviceShellCmd::new()
            .literal("echo")
            .user_input(evil)
            .render();
        let toks = shell_split(&rendered);
        assert_eq!(toks.len(), 2);
        assert_eq!(toks[0], "echo");
        assert_eq!(toks[1], evil);
        // The dangerous `rm -rf /` substring exists in the rendered string
        // but only inside the quoted user_input segment.
        assert!(rendered.starts_with("echo '"));
    }

    #[test]
    fn newline_in_user_input_does_not_split_tokens() {
        let payload = "line1\nline2";
        let rendered = DeviceShellCmd::new()
            .literal("printf")
            .user_input(payload)
            .render();
        let toks = shell_split(&rendered);
        assert_eq!(toks.len(), 2);
        assert_eq!(toks[1], payload);
    }
}
