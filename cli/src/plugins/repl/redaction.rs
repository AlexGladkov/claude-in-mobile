//! Secret redaction for REPL PTY output.
//!
//! Ports the 9 TypeScript patterns from `src/plugins/repl/redaction.ts` to
//! `regex` 1.10 (no lookbehind/lookahead support). Patterns that rely on zero-
//! width assertions in TS are rewritten to capture surrounding boundary
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

use std::sync::OnceLock;

use regex::{Captures, Regex};

// ---------------------------------------------------------------------------
// Pattern registry
// ---------------------------------------------------------------------------

static REDACTION_PATTERNS: OnceLock<Vec<(&'static str, RedactPattern)>> = OnceLock::new();

/// Internal pattern — either a simple whole-match replacement or a boundary-
/// capture replacement where we reconstruct pre/post boundary characters.
enum RedactPattern {
    /// Replace the entire match with `[REDACTED]`.
    Simple(Regex),
    /// Match has capturing groups: group 1 = pre-boundary char (may be empty),
    /// group 2 = the secret token, group 3 = post-boundary char (may be empty).
    /// We emit `pre + "[REDACTED]" + post` so the boundary chars are preserved.
    Boundary(Regex),
}

fn init_patterns() -> Vec<(&'static str, RedactPattern)> {
    // Helper that panics at startup if a pattern is invalid — compile-time
    // equivalent (patterns are static strings, not runtime input).
    let simple = |pat: &str| RedactPattern::Simple(Regex::new(pat).expect("invalid regex"));
    let boundary = |pat: &str| RedactPattern::Boundary(Regex::new(pat).expect("invalid regex"));

    vec![
        // 1. aws-access-key: AKIA[0-9A-Z]{16}
        ("aws-access-key", simple(r"AKIA[0-9A-Z]{16}")),
        // 2. aws-secret: 40-char base64-range string.
        //    TS uses lookbehind/lookahead to assert word boundaries without
        //    consuming them. Rust regex 1.10 lacks those — we capture the
        //    optional surrounding non-base64 chars (groups 1 and 3) and
        //    reconstruct them around "[REDACTED]".
        //    Group layout: (pre)(token)(post)
        (
            "aws-secret",
            boundary(r"(?:^|([^A-Za-z0-9/+=]))([A-Za-z0-9/+=]{40})(?:([^A-Za-z0-9/+=])|$)"),
        ),
        // 3. github-pat: gh[pousr]_[A-Za-z0-9_]{36,}
        ("github-pat", simple(r"gh[pousr]_[A-Za-z0-9_]{36,}")),
        // 4. anthropic-key: sk-ant-[A-Za-z0-9\-_]{20,}
        ("anthropic-key", simple(r"sk-ant-[A-Za-z0-9\-_]{20,}")),
        // 5. openai-key: sk-[A-Za-z0-9]{20,}
        //    NOTE: must come AFTER anthropic-key so sk-ant- is caught first.
        ("openai-key", simple(r"sk-[A-Za-z0-9]{20,}")),
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
    for (_name, pat) in patterns() {
        current = apply_pattern(&current, pat);
    }
    current
}

fn apply_pattern(s: &str, pat: &RedactPattern) -> String {
    match pat {
        RedactPattern::Simple(re) => re.replace_all(s, "[REDACTED]").into_owned(),
        RedactPattern::Boundary(re) => {
            // replace_all with a closure so we can reconstruct pre/post.
            re.replace_all(s, |caps: &Captures<'_>| {
                // Group 1: optional pre-boundary char (absent at start-of-string)
                let pre = caps.get(1).map_or("", |m| m.as_str());
                // Group 3: optional post-boundary char (absent at end-of-string)
                let post = caps.get(3).map_or("", |m| m.as_str());
                format!("{pre}[REDACTED]{post}")
            })
            .into_owned()
        }
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
    fn slack_token_redacted() {
        let out = redact("token=xoxb-1234567890-fake-slack-token");
        assert!(out.contains("[REDACTED]"), "got: {out}");
        assert!(!out.contains("xoxb"), "got: {out}");
    }
}
