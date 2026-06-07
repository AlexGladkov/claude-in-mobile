//! Default prompt regexes for common interactive REPLs.
//!
//! Picked per `--cmd` substring at `spawn` time; user can override with
//! `--prompt-regex`. Patterns anchor to end-of-line so a stale prompt embedded
//! mid-output does not falsely satisfy `expect`.

use regex::Regex;

pub struct PromptProfile {
    pub name: &'static str,
    /// Substring that, if present in the spawn command, selects this profile.
    pub cmd_hint: &'static str,
    pub prompt_regex: &'static str,
}

pub const DEFAULT_PROFILES: &[PromptProfile] = &[
    PromptProfile {
        name: "python",
        cmd_hint: "python",
        prompt_regex: r">>> $",
    },
    PromptProfile {
        name: "ipython",
        cmd_hint: "ipython",
        prompt_regex: r"In \[\d+\]: $",
    },
    PromptProfile {
        name: "node",
        cmd_hint: "node",
        prompt_regex: r"^> $",
    },
    PromptProfile {
        name: "ghci",
        cmd_hint: "ghci",
        prompt_regex: r"ghci> $",
    },
    PromptProfile {
        name: "psql",
        cmd_hint: "psql",
        prompt_regex: r"=[#>] $",
    },
    PromptProfile {
        name: "bash",
        cmd_hint: "bash",
        prompt_regex: r"\$ $",
    },
    PromptProfile {
        name: "zsh",
        cmd_hint: "zsh",
        prompt_regex: r"% $",
    },
    PromptProfile {
        name: "sh",
        cmd_hint: "sh",
        prompt_regex: r"\$ $",
    },
];

/// Pick the first profile whose `cmd_hint` is a substring of `cmd`.
pub fn pick_profile(cmd: &str) -> Option<&'static PromptProfile> {
    DEFAULT_PROFILES.iter().find(|p| cmd.contains(p.cmd_hint))
}

/// Compile prompt regex with multi-line mode so `$` matches end-of-line, not
/// end-of-input. Returns None if the supplied pattern fails to compile — the
/// caller decides whether to fall back to idle-timeout detection.
pub fn compile(pattern: &str) -> Option<Regex> {
    Regex::new(&format!("(?m){pattern}")).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_python_for_python3() {
        let p = pick_profile("/usr/bin/python3 -i").unwrap();
        assert_eq!(p.name, "python");
    }

    #[test]
    fn picks_bash_for_bash_norc() {
        let p = pick_profile("bash --norc --noprofile").unwrap();
        assert_eq!(p.name, "bash");
    }

    #[test]
    fn unknown_cmd_has_no_profile() {
        assert!(pick_profile("/usr/local/bin/my-custom-repl").is_none());
    }

    #[test]
    fn all_default_patterns_compile() {
        for p in DEFAULT_PROFILES {
            assert!(
                compile(p.prompt_regex).is_some(),
                "pattern failed to compile: {} -> {}",
                p.name,
                p.prompt_regex
            );
        }
    }
}
