//! Expect cascade: prompt-regex → idle → exit.
//!
//! Used by `session.wait_ready()` after every `send`. Cheap struct describing
//! the readiness rules; the session itself owns timing and buffer state.

use std::time::Duration;

use regex::Regex;

#[derive(Debug, Clone)]
pub struct ExpectRules {
    pub prompt: Option<Regex>,
    pub idle: Duration,
    pub timeout: Duration,
}

impl ExpectRules {
    pub fn new(prompt: Option<Regex>, idle_ms: u64, timeout_ms: u64) -> Self {
        Self {
            prompt,
            idle: Duration::from_millis(idle_ms),
            timeout: Duration::from_millis(timeout_ms),
        }
    }

    pub fn defaults() -> Self {
        Self::new(None, 300, 5_000)
    }

    /// True when `buf` ends with a prompt match (we only care about the tail).
    pub fn prompt_matches(&self, buf: &str) -> bool {
        let Some(re) = &self.prompt else {
            return false;
        };
        // Check the last 4KB to avoid false matches deep in scrollback. Walk
        // forward to the next char boundary so multibyte output (cyrillic,
        // emoji, box-drawing) can't trip a slice panic.
        let tail = if buf.len() > 4096 {
            let mut start = buf.len() - 4096;
            while start < buf.len() && !buf.is_char_boundary(start) {
                start += 1;
            }
            &buf[start..]
        } else {
            buf
        };
        re.is_match(tail)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ExpectOutcome {
    PromptMatched,
    Idle,
    Exited(Option<i32>),
    TimedOut,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_python_prompt_at_tail() {
        let rules = ExpectRules::new(
            Some(Regex::new(r"(?m)>>> $").unwrap()),
            300,
            5000,
        );
        assert!(rules.prompt_matches("Python 3.12\n>>> "));
        assert!(!rules.prompt_matches("no prompt here"));
    }

    #[test]
    fn ignores_prompt_in_far_scrollback() {
        let mut buf = String::new();
        buf.push_str(">>> "); // older prompt
        // 5KB filler so the older prompt falls outside the 4KB tail window
        for _ in 0..5000 {
            buf.push('x');
        }
        let rules = ExpectRules::new(
            Some(Regex::new(r"(?m)>>> $").unwrap()),
            300,
            5000,
        );
        assert!(!rules.prompt_matches(&buf));
    }

    #[test]
    fn no_prompt_regex_never_matches() {
        let rules = ExpectRules::defaults();
        assert!(!rules.prompt_matches(">>> "));
    }

    #[test]
    fn multibyte_tail_does_not_panic() {
        // >4KB of multibyte chars so the 4KB cut lands mid-codepoint. Must not
        // panic, and the trailing prompt must still match.
        let mut buf = "ё".repeat(3000); // 2 bytes each => 6000 bytes
        buf.push_str(">>> ");
        let rules = ExpectRules::new(Some(Regex::new(r"(?m)>>> $").unwrap()), 300, 5000);
        assert!(rules.prompt_matches(&buf));
    }
}
