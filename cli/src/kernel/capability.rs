//! Capability enum mirroring `@claude-in-mobile/plugin-api` (v1).
//!
//! Update both sides together — the TypeScript enum lives in
//! `packages/plugin-api/src/index.ts`. The string form on the wire MUST match
//! the camelCase identifiers used by the TS side.

use std::fmt;
use std::str::FromStr;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Capability {
    Screen,
    Input,
    Ui,
    Shell,
    AppLifecycle,
    Permissions,
    Logs,
    Terminal,
    FileTransfer,
    DeviceMgmt,
}

pub const ALL_CAPABILITIES: &[Capability] = &[
    Capability::Screen,
    Capability::Input,
    Capability::Ui,
    Capability::Shell,
    Capability::AppLifecycle,
    Capability::Permissions,
    Capability::Logs,
    Capability::Terminal,
    Capability::FileTransfer,
    Capability::DeviceMgmt,
];

impl Capability {
    /// Wire form — must match the TS string literal exactly.
    pub fn as_str(&self) -> &'static str {
        match self {
            Capability::Screen => "screen",
            Capability::Input => "input",
            Capability::Ui => "ui",
            Capability::Shell => "shell",
            Capability::AppLifecycle => "appLifecycle",
            Capability::Permissions => "permissions",
            Capability::Logs => "logs",
            Capability::Terminal => "terminal",
            Capability::FileTransfer => "fileTransfer",
            Capability::DeviceMgmt => "deviceMgmt",
        }
    }
}

impl FromStr for Capability {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        match s {
            "screen" => Ok(Capability::Screen),
            "input" => Ok(Capability::Input),
            "ui" => Ok(Capability::Ui),
            "shell" => Ok(Capability::Shell),
            "appLifecycle" => Ok(Capability::AppLifecycle),
            "permissions" => Ok(Capability::Permissions),
            "logs" => Ok(Capability::Logs),
            "terminal" => Ok(Capability::Terminal),
            "fileTransfer" => Ok(Capability::FileTransfer),
            "deviceMgmt" => Ok(Capability::DeviceMgmt),
            _ => bail!("unknown capability: {}", s),
        }
    }
}

impl fmt::Display for Capability {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_is_exhaustive_and_unique() {
        let mut seen = std::collections::HashSet::new();
        for c in ALL_CAPABILITIES {
            assert!(seen.insert(c.as_str()), "duplicate capability: {}", c);
        }
        assert_eq!(seen.len(), 10);
    }

    #[test]
    fn round_trip_str() {
        for c in ALL_CAPABILITIES {
            let s = c.as_str();
            let parsed: Capability = s.parse().unwrap();
            assert_eq!(*c, parsed);
        }
    }

    #[test]
    fn serde_emits_camel_case() {
        let json = serde_json::to_string(&Capability::AppLifecycle).unwrap();
        assert_eq!(json, "\"appLifecycle\"");
        let back: Capability = serde_json::from_str(&json).unwrap();
        assert_eq!(back, Capability::AppLifecycle);
    }

    #[test]
    fn unknown_capability_rejected() {
        let r: Result<Capability> = "nope".parse();
        assert!(r.is_err());
    }
}
