//! Secret redaction for REPL PTY output.
//!
//! Ports the 9 TypeScript token patterns from `src/plugins/repl/redaction.ts`
//! to `regex` 1.10 (no lookbehind/lookahead support), and mirrors its
//! generic assignment/password-prompt matchers. Patterns that rely on
//! zero-width assertions in TS are rewritten to capture surrounding boundary
//! characters and reconstruct the replacement without consuming them.
//!
//! # Pattern order — SYNC ANCHOR
//!
//! EXPECTED_PATTERN_NAMES order MUST match `EXPECTED_PATTERN_NAMES` in
//! `src/plugins/repl/security.test.ts` and the TS `REDACTION_PATTERNS` array.
//! Any divergence causes the parity test to fail.
//!
//! # Fail-closed guarantee
//!
//! [`redact`] wraps the inner logic in `std::panic::catch_unwind`. Any panic
//! or unexpected code path returns `"[REDACTED]"` — the caller NEVER receives
//! a raw secret byte.

use std::sync::{LazyLock, OnceLock};

use regex::{Captures, Regex};

// ---------------------------------------------------------------------------
// Pattern registry
// ---------------------------------------------------------------------------

static REDACTION_PATTERNS: OnceLock<Vec<(&'static str, RedactPattern)>> = OnceLock::new();

const REDACTED_MARKER: &str = "[REDACTED]";
const SENSITIVE_ENV_NAME_PATTERN: &str = r"(?i)(?:^|_)(?:PASSWORD|PASSWD|TOKEN|SECRET|API[_-]?KEY|ACCESS[_-]?(?:KEY|TOKEN)|REFRESH[_-]?TOKEN|CLIENT[_-]?SECRET|AUTH(?:ORIZATION|[_-]?TOKEN)|CREDENTIALS?|PRIVATE[_-]?KEY)(?:_|$)";
const GENERIC_ASSIGNMENT_PATTERN: &str = r#"(^|[^\p{L}\p{N}_-])([A-Za-z][A-Za-z0-9_.-]*)([ \t]*[=:][ \t]*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s\r\n]+)"#;
const GENERIC_ASSIGNMENT_PREFIX_PATTERN: &str = r#"(^|[^\p{L}\p{N}_-])([A-Za-z][A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"\r\n]*|'[^'\r\n]*'|[^\s\r\n]*)$"#;
const PASSWORD_INLINE_PROMPT_PATTERN: &str = r#"(?im)(^|[\r\n])([^\r\n]*\b(?:pass(?:word)?|passwd|passphrase|passcode|secret|token|api[\s_-]*key)[^\r\n]*[:>][ \t]*)([^\r\n]*?\S)([ \t]*)(?:\r?\n|$)"#;
const PASSWORD_PROMPT_PATTERN: &str = r#"(?im)(^|[\r\n])([^\r\n]*\b(?:pass(?:word)?|passwd|passphrase|passcode|secret|token|api[\s_-]*key)[^\r\n]*[:>][ \t]*)(\r?\n)((?:[ \t]*\r?\n)*)([ \t]*)([^\r\n]*?\S)([ \t]*)(?:\r?\n|$)"#;
const ASSIGNMENT_VALUE_PATTERN: &str =
    r#"^([A-Za-z][A-Za-z0-9_.-]*)([ \t]*[=:][ \t]*)("[^"]*"|'[^'\r\n]*'|[^\s\r\n]+)"#;
const PROMPT_HEADER_PATTERN: &str = r#"(?i)^[^\r\n]*\b(?:pass(?:word)?|passwd|passphrase|passcode|secret|token|api[\s_-]*key)[^\r\n]*[:>][ \t]*$"#;

static SENSITIVE_ENV_NAME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(SENSITIVE_ENV_NAME_PATTERN).expect("invalid sensitive-name regex"));
static GENERIC_ASSIGNMENT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(GENERIC_ASSIGNMENT_PATTERN).expect("invalid assignment regex"));
static GENERIC_ASSIGNMENT_PREFIX_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(GENERIC_ASSIGNMENT_PREFIX_PATTERN).expect("invalid assignment-prefix regex")
});
static PASSWORD_INLINE_PROMPT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(PASSWORD_INLINE_PROMPT_PATTERN).expect("invalid inline prompt regex")
});
static PASSWORD_PROMPT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(PASSWORD_PROMPT_PATTERN).expect("invalid prompt regex"));
static PROMPT_HEADER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(PROMPT_HEADER_PATTERN).expect("invalid prompt-header regex"));
static ASSIGNMENT_VALUE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(ASSIGNMENT_VALUE_PATTERN).expect("invalid assignment-value regex"));

/// Internal pattern — a simple whole-match replacement or an AWS secret with
/// a captured leading boundary.
enum RedactPattern {
    /// Replace the entire match with `[REDACTED]`.
    Simple(Regex),
    /// Group 1 is the optional leading boundary and group 2 is the secret.
    /// The trailing boundary is checked by the replacement callback so it
    /// remains available to the next non-overlapping match.
    Boundary(Regex),
}

fn init_patterns() -> Vec<(&'static str, RedactPattern)> {
    // Helper that panics at startup if a pattern is invalid — compile-time
    // equivalent (patterns are static strings, not runtime input).
    let simple = |pat: &str| RedactPattern::Simple(Regex::new(pat).expect("invalid regex"));
    let boundary = |pat: &str| RedactPattern::Boundary(Regex::new(pat).expect("invalid regex"));

    vec![
        // 1. AWS access key families: PREFIX[0-9A-Z]{16}
        (
            "aws-access-key",
            simple(
                r"(?:AKIA|ASIA|AIDA|AROA|AGPA|AIPA|ANPA|ANVA|ASCA|ACCA|ABIA|A3T[A-Z0-9])[0-9A-Z]{16}",
            ),
        ),
        // 2. aws-secret: 40-char base64-range string.
        //    TS uses lookbehind/lookahead to assert token boundaries without
        //    consuming them. Rust regex 1.10 captures adjacent non-token
        //    boundary chars (including `_`) and preserves them.
        //    Group layout: (pre)(token)(post)
        (
            "aws-secret",
            boundary(r"(?:^|([^A-Za-z0-9_/+=]))([A-Za-z0-9/+=]{40})"),
        ),
        // 3. github-pat: classic gh[pousr]_ and fine-grained github_pat_
        (
            "github-pat",
            simple(r"(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{36,}"),
        ),
        // 4. anthropic-key: sk-ant-[A-Za-z0-9\-_]{20,}
        ("anthropic-key", simple(r"sk-ant-[A-Za-z0-9\-_]{20,}")),
        // 5. openai-key: sk-[A-Za-z0-9\-_]{20,}
        //    NOTE: must come AFTER anthropic-key so sk-ant- is caught first.
        ("openai-key", simple(r"sk-[A-Za-z0-9\-_]{20,}")),
        // 6. bearer-token: case-insensitive Bearer header value.
        //    TS uses \b (word boundary). Rust regex 1.10 supports \b.
        ("bearer-token", simple(r"(?i)\bBearer\s+[A-Za-z0-9._\-]+")),
        // 7. jwt: eyJ header.eyJ payload.signature
        (
            "jwt",
            simple(r"eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+"),
        ),
        // 8. google-api-key: AIza[0-9A-Za-z\-_]{35}
        ("google-api-key", simple(r"AIza[0-9A-Za-z\-_]{35}")),
        // 9. slack-token: xox[abprs]-[A-Za-z0-9\-]+
        ("slack-token", simple(r"xox[abprs]-[A-Za-z0-9\-]+")),
    ]
}

fn patterns() -> &'static Vec<(&'static str, RedactPattern)> {
    REDACTION_PATTERNS.get_or_init(init_patterns)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Redact all known secret patterns in `input`, returning the sanitised string.
///
/// **Fail-closed**: any panic inside the redaction logic causes this function
/// to return `"[REDACTED]"` — the caller never receives a raw secret byte.
///
/// # Examples
///
/// ```rust
/// use mcp_devices::plugins::repl::redaction::redact;
///
/// assert_eq!(redact(""), "");
/// assert_eq!(redact("no secrets here"), "no secrets here");
/// assert!(redact("AKIAIOSFODNN7EXAMPLEOK").contains("[REDACTED]"));
/// ```
pub fn redact(input: &str) -> String {
    // catch_unwind requires the closure to be UnwindSafe. `input` is `&str`
    // which is fine; we pass it by copying the reference into a captured owned
    // String so the closure owns the data.
    let owned = input.to_string();
    std::panic::catch_unwind(move || redact_inner(&owned))
        .unwrap_or_else(|_| "[REDACTED]".to_string())
}

fn redact_inner(input: &str) -> String {
    let mut current = input.to_string();
    current = apply_inline_prompt_redactions(&current);
    for (_name, pat) in patterns() {
        current = apply_pattern(&current, pat);
    }
    current = apply_generic_assignment_redactions(&current);
    apply_password_prompt_redactions(&current)
}

fn is_sensitive_env_name(name: &str) -> bool {
    SENSITIVE_ENV_NAME_RE.is_match(name)
}

fn value_range(value: &str, value_start: usize) -> Option<(usize, usize)> {
    if value.is_empty() || value == REDACTED_MARKER {
        return None;
    }
    let bytes = value.as_bytes();
    let first = bytes.first().copied();
    let last = bytes.last().copied();
    if matches!(first, Some(b'"' | b'\'')) && last == first {
        (value_start + 1 < value_start + value.len() - 1)
            .then_some((value_start + 1, value_start + value.len() - 1))
    } else {
        Some((value_start, value_start + value.len()))
    }
}

fn prompt_value_range(value: &str, value_start: usize) -> Option<(usize, usize)> {
    if value.is_empty() || value == REDACTED_MARKER {
        return None;
    }

    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(assignment) = ASSIGNMENT_VALUE_RE.captures(trimmed) {
        let Some(key) = assignment.get(1) else {
            return None;
        };
        if is_sensitive_env_name(key.as_str()) {
            let Some(assignment_value) = assignment.get(3) else {
                return None;
            };
            let trimmed_offset = value.find(trimmed).unwrap_or(0);
            return value_range(
                assignment_value.as_str(),
                value_start + trimmed_offset + assignment_value.start(),
            );
        }
    }
    value_range(value, value_start)
}

fn apply_inline_prompt_redactions(input: &str) -> String {
    let mut ranges = Vec::new();
    for captures in PASSWORD_INLINE_PROMPT_RE.captures_iter(input) {
        let Some(value) = captures.get(3) else {
            continue;
        };
        if let Some(range) = prompt_value_range(value.as_str(), value.start()) {
            ranges.push(range);
        }
    }
    apply_ranges(input, ranges)
}

fn apply_generic_assignment_redactions(input: &str) -> String {
    let mut ranges = Vec::new();
    for captures in GENERIC_ASSIGNMENT_RE.captures_iter(input) {
        let Some(key) = captures.get(2) else {
            continue;
        };
        if !is_sensitive_env_name(key.as_str()) {
            continue;
        }
        let Some(value) = captures.get(4) else {
            continue;
        };
        if let Some(range) = value_range(value.as_str(), value.start()) {
            ranges.push(range);
        }
    }
    apply_ranges(input, ranges)
}

fn apply_password_prompt_redactions(input: &str) -> String {
    let mut ranges = Vec::new();
    for captures in PASSWORD_PROMPT_RE.captures_iter(input) {
        let Some(value) = captures.get(6) else {
            continue;
        };
        if let Some(range) = prompt_value_range(value.as_str(), value.start()) {
            ranges.push(range);
        }
    }
    apply_ranges(input, ranges)
}

fn apply_ranges(input: &str, mut ranges: Vec<(usize, usize)>) -> String {
    if ranges.is_empty() {
        return input.to_string();
    }
    ranges.sort_unstable();

    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    for (start, end) in ranges {
        if start < cursor || end <= start {
            continue;
        }
        output.push_str(&input[cursor..start]);
        output.push_str(REDACTED_MARKER);
        cursor = end;
    }
    output.push_str(&input[cursor..]);
    output
}

#[derive(Clone, Copy)]
struct TextLine {
    start: usize,
    end: usize,
    has_newline: bool,
}

fn text_lines(input: &str) -> Vec<TextLine> {
    let mut lines = Vec::new();
    let mut start = 0;
    loop {
        let newline = input[start..].find('\n').map(|offset| start + offset);
        let raw_end = newline.unwrap_or(input.len());
        let end = raw_end
            .checked_sub(1)
            .filter(|&index| input.as_bytes()[index] == b'\r')
            .unwrap_or(raw_end);
        lines.push(TextLine {
            start,
            end,
            has_newline: newline.is_some(),
        });
        let Some(newline) = newline else {
            break;
        };
        start = newline + 1;
        if start == input.len() {
            break;
        }
    }
    lines
}

fn line_is_empty(input: &str, line: TextLine) -> bool {
    input[line.start..line.end].chars().all(char::is_whitespace)
}

fn partial_sensitive_name(name: &str) -> bool {
    if name.is_empty()
        || !name
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphabetic())
    {
        return false;
    }
    if is_sensitive_env_name(name) {
        return true;
    }

    let upper = name.to_ascii_uppercase();
    const SENSITIVE_NAMES: &[&str] = &[
        "PASSWORD",
        "PASSWD",
        "TOKEN",
        "SECRET",
        "API_KEY",
        "API-KEY",
        "ACCESS_KEY",
        "ACCESS-KEY",
        "ACCESS_TOKEN",
        "ACCESS-TOKEN",
        "REFRESH_TOKEN",
        "REFRESH-TOKEN",
        "CLIENT_SECRET",
        "CLIENT-SECRET",
        "AUTHORIZATION",
        "AUTH_TOKEN",
        "AUTH-TOKEN",
        "CREDENTIAL",
        "CREDENTIALS",
        "PRIVATE_KEY",
        "PRIVATE-KEY",
    ];
    if SENSITIVE_NAMES
        .iter()
        .any(|name| name.starts_with(&upper) || upper.starts_with(name))
    {
        return true;
    }
    for (index, character) in upper.char_indices() {
        if matches!(character, '_' | '-') {
            let suffix = &upper[index + character.len_utf8()..];
            if SENSITIVE_NAMES
                .iter()
                .any(|name| name.starts_with(suffix) || suffix.starts_with(name))
            {
                return true;
            }
        }
    }
    false
}

fn trailing_name_prefix(input: &str, line: TextLine) -> Option<usize> {
    let mut start = line.end;
    while start > line.start {
        let byte = input.as_bytes()[start - 1];
        if byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-') {
            start -= 1;
        } else {
            break;
        }
    }
    (start < line.end && partial_sensitive_name(&input[start..line.end])).then_some(start)
}

/// Return the earliest suffix that must remain buffered for generic redaction.
///
/// Cast output is redacted incrementally. A generic value at the end of a PTY
/// read is indistinguishable from a complete value until the next delimiter;
/// retaining its line prevents the continuation in the next read from being
/// emitted as ordinary text.
pub(crate) fn generic_redaction_safe_prefix_len(input: &str) -> usize {
    if input.is_empty() {
        return 0;
    }

    let lines = text_lines(input);
    let mut hold_from = input.len();

    for (index, line) in lines.iter().copied().enumerate() {
        let text = &input[line.start..line.end];
        if let Some(captures) = GENERIC_ASSIGNMENT_PREFIX_RE.captures(text) {
            let sensitive = captures
                .get(2)
                .is_some_and(|key| is_sensitive_env_name(key.as_str()));
            let value = captures.get(4).map_or("", |value| value.as_str());
            let value_bytes = value.as_bytes();
            let first = value_bytes.first().copied();
            let last = value_bytes.last().copied();
            let unclosed_quote = matches!(first, Some(b'"' | b'\'')) && last != first;
            if sensitive
                && value != REDACTED_MARKER
                && (!line.has_newline || value.is_empty() || unclosed_quote)
            {
                hold_from = hold_from.min(line.start);
            }
        }
        if !line.has_newline {
            if PROMPT_HEADER_RE.is_match(text)
                || PASSWORD_INLINE_PROMPT_RE.is_match(text)
                || trailing_name_prefix(input, line).is_some()
            {
                hold_from = hold_from.min(line.start);
            }
        } else if PROMPT_HEADER_RE.is_match(text) {
            let mut next_non_empty = None;
            for next in lines.iter().skip(index + 1).copied() {
                if !line_is_empty(input, next) {
                    next_non_empty = Some(next);
                    break;
                }
            }
            if next_non_empty.is_none_or(|next| !next.has_newline) {
                hold_from = hold_from.min(line.start);
            }
        }
    }

    hold_from
}

fn apply_pattern(s: &str, pat: &RedactPattern) -> String {
    match pat {
        RedactPattern::Simple(re) => re.replace_all(s, "[REDACTED]").into_owned(),
        RedactPattern::Boundary(re) => re
            .replace_all(s, |caps: &Captures<'_>| {
                let whole = caps
                    .get(0)
                    .expect("boundary regex matched without full match");
                let continues = s.as_bytes().get(whole.end()).is_some_and(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(*byte, b'/' | b'+' | b'=' | b'_')
                });
                if continues {
                    return whole.as_str().to_owned();
                }
                let pre = caps.get(1).map_or("", |m| m.as_str());
                format!("{pre}[REDACTED]")
            })
            .into_owned(),
    }
}

// ---------------------------------------------------------------------------
// Pattern name list — exported for parity tests
// ---------------------------------------------------------------------------

/// Canonical ordered list of pattern names.
///
/// SYNC ANCHOR: must match `EXPECTED_PATTERN_NAMES` in
/// `src/plugins/repl/security.test.ts`.
pub const EXPECTED_PATTERN_NAMES: &[&str] = &[
    "aws-access-key",
    "aws-secret",
    "github-pat",
    "anthropic-key",
    "openai-key",
    "bearer-token",
    "jwt",
    "google-api-key",
    "slack-token",
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // Path: redaction.rs lives at cli/src/plugins/repl/redaction.rs
    // Fixture is at tests/fixtures/secret-samples.txt (repo root)
    // 4 levels up: cli/src/plugins/repl  ->  cli/src/plugins  ->  cli/src  ->  cli  ->  (repo root)
    const FIXTURE: &str = include_str!("../../../../tests/fixtures/secret-samples.txt");

    #[test]
    fn pattern_names_parity() {
        let actual: Vec<&str> = patterns().iter().map(|(name, _)| *name).collect();
        assert_eq!(
            actual, EXPECTED_PATTERN_NAMES,
            "REDACTION_PATTERNS names diverged from EXPECTED_PATTERN_NAMES. \
             Update both Rust and TS lists together."
        );
    }

    #[test]
    fn behaviour_parity_fixture() {
        for line in FIXTURE.lines() {
            let trimmed = line.trim();
            // Skip blank lines and comments.
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            let out = redact(trimmed);
            assert!(
                out.contains("[REDACTED]"),
                "Expected [REDACTED] in output for sample: {trimmed:?}\n  got: {out:?}"
            );
            // The original token should not appear literally.
            // Use the trimmed form (strips space-padding used for aws-secret).
            assert!(
                !out.contains(trimmed),
                "Live token still present in output for sample: {trimmed:?}\n  got: {out:?}"
            );
        }
    }

    #[test]
    fn back_to_back_secrets() {
        // Two secrets separated by a single space — both must be redacted.
        let input = "AKIAIOSFODNN7EXAMPLE AKIABBBBBBBBBBBBBBBBB";
        let out = redact(input);
        assert!(out.contains("[REDACTED]"), "first secret missing: {out}");
        // Both occurrences should be gone.
        assert!(
            !out.contains("AKIA"),
            "live AKIA token still present: {out}"
        );
    }

    #[test]
    fn back_to_back_with_delimiter() {
        // Anthropic + OpenAI key back to back.
        let input = "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxx sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
        let out = redact(input);
        assert!(!out.contains("sk-ant"), "anthropic key leaked: {out}");
        assert!(!out.contains("sk-xxx"), "openai key leaked: {out}");
    }

    #[test]
    fn empty_and_clean_inputs() {
        assert_eq!(redact(""), "");
        assert_eq!(redact("no secrets here"), "no secrets here");
        assert_eq!(redact("hello world 123"), "hello world 123");
    }

    #[test]
    fn fail_closed_on_empty_string() {
        // Confirm fail-closed wrapper returns a string, not a panic.
        let result = std::panic::catch_unwind(|| redact(""));
        assert!(result.is_ok());
    }

    #[test]
    fn aws_access_key_redacted() {
        let out = redact("key=AKIAIOSFODNN7EXAMPLE rest");
        assert!(out.contains("[REDACTED]"), "got: {out}");
        assert!(!out.contains("AKIAIOSFODNN7EXAMPLE"), "got: {out}");
    }

    #[test]
    fn aws_access_key_families_redacted() {
        for key in ["ABIA1234567890123456", "A3TZ1234567890123456"] {
            let out = redact(&format!("key={key} rest"));
            assert!(out.contains("[REDACTED]"), "got: {out}");
            assert!(!out.contains(key), "got: {out}");

            let short = &key[..key.len() - 1];
            assert_eq!(redact(short), short, "short key was redacted: {short}");
        }
    }

    #[test]
    fn aws_secret_boundary_redacted() {
        // Space-bounded 40-char base64 string.
        let out = redact(" wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY ");
        assert!(out.contains("[REDACTED]"), "got: {out}");
        assert!(!out.contains("wJalrXUtnFEMI"), "got: {out}");
    }

    #[test]
    fn github_pat_redacted() {
        for prefix in ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"] {
            let token = format!("{prefix}1234567890abcdefghijklmnopqrstuvwxyz");
            let out = redact(&token);
            assert!(
                out.contains("[REDACTED]"),
                "prefix {prefix} not redacted: {out}"
            );
        }

        let token = "github_pat_11AAAAAA00000000000000_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
        let out = redact(token);
        assert!(
            out.contains("[REDACTED]"),
            "fine-grained token not redacted: {out}"
        );
        assert_eq!(
            out, "[REDACTED]",
            "fine-grained token was only partially redacted: {out}"
        );
        assert!(!out.contains(token), "fine-grained token leaked: {out}");
    }

    #[test]
    fn adjacent_aws_secrets_with_single_space_are_both_redacted() {
        let first = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
        let second = "0123456789012345678901234567890123456789";

        assert_eq!(
            redact(&format!("{first} {second}")),
            "[REDACTED] [REDACTED]"
        );
    }

    #[test]
    fn openai_project_key_with_hyphens_redacted() {
        let token = "sk-proj-1234567890-abcdefghijklmnop-qrstuvwxyz";
        let out = redact(token);
        assert!(
            out.contains("[REDACTED]"),
            "project token not redacted: {out}"
        );
        assert!(!out.contains(token), "project token leaked: {out}");
    }

    #[test]
    fn anthropic_key_redacted() {
        let out = redact("sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxx");
        assert!(out.contains("[REDACTED]"), "got: {out}");
        assert!(!out.contains("sk-ant"), "got: {out}");
    }

    #[test]
    fn bearer_token_case_insensitive() {
        let out = redact("Authorization: Bearer abc.def.ghi");
        assert!(out.contains("[REDACTED]"), "got: {out}");
        let out_lower = redact("authorization: bearer abc.def.ghi");
        assert!(out_lower.contains("[REDACTED]"), "got: {out_lower}");
    }

    #[test]
    fn jwt_redacted() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturepart";
        let out = redact(jwt);
        assert!(out.contains("[REDACTED]"), "got: {out}");
        assert!(!out.contains("eyJ"), "got: {out}");
    }

    #[test]
    fn google_api_key_redacted() {
        let out = redact("key=AIzaSyA-FAKE-EXAMPLE-KEY-A1B2C3D4E5F6G7");
        assert!(out.contains("[REDACTED]"), "got: {out}");
    }

    #[test]
    fn generic_assignments_redact_short_values_and_preserve_labels() {
        let input = "PASSWORD=short-secret API_KEY=abc123";
        let output = redact(input);

        assert_eq!(output, "PASSWORD=[REDACTED] API_KEY=[REDACTED]");
        assert!(!output.contains("short-secret"));
        assert!(!output.contains("abc123"));
    }

    #[test]
    fn quoted_generic_assignment_preserves_quotes() {
        assert_eq!(
            redact(r#"PASSWORD="short secret""#),
            r#"PASSWORD="[REDACTED]""#
        );
    }

    #[test]
    fn password_prompt_redacts_inline_and_next_line_values() {
        assert_eq!(redact("Password: hunter2"), "Password: [REDACTED]");
        assert_eq!(
            redact("Password:\n\n  hunter2\n"),
            "Password:\n\n  [REDACTED]\n"
        );
    }
    #[test]
    fn password_prompt_redacts_complete_remainder_and_blank_line_response() {
        let input = "Enter password: hunter two\n\nPassword:\n\nhunter two\n";
        let output = redact(input);

        assert_eq!(
            output,
            "Enter password: [REDACTED]\n\nPassword:\n\n[REDACTED]\n"
        );
        assert!(!output.contains("hunter two"));
    }

    #[test]
    fn slack_token_redacted() {
        let out = redact("token=xoxb-1234567890-fake-slack-token");
        assert!(out.contains("[REDACTED]"), "got: {out}");
        assert!(!out.contains("xoxb"), "got: {out}");
    }
}
