//! Plugin manifest — Rust mirror of the v1 TypeScript contract.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use super::Capability;

/// Current plugin-api major version. Plugins targeting a different major are
/// refused at registration time.
pub const PLUGIN_API_VERSION: &str = "1";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(rename = "apiVersion")]
    pub api_version: String,
    pub capabilities: Vec<Capability>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl PluginManifest {
    pub fn validate(&self) -> Result<()> {
        if self.id.is_empty() {
            bail!("manifest.id must be non-empty");
        }
        if !is_valid_id(&self.id) {
            bail!("manifest.id must match /^[a-z0-9][a-z0-9._-]*$/");
        }
        if self.api_version != PLUGIN_API_VERSION {
            bail!(
                "plugin {} requests apiVersion={} but kernel supports {}",
                self.id,
                self.api_version,
                PLUGIN_API_VERSION
            );
        }
        if self.capabilities.is_empty() {
            bail!("plugin {} declares no capabilities", self.id);
        }
        let mut seen = std::collections::HashSet::new();
        for c in &self.capabilities {
            if !seen.insert(c) {
                bail!("plugin {} declares duplicate capability: {}", self.id, c);
            }
        }
        Ok(())
    }

    pub fn has_capability(&self, cap: Capability) -> bool {
        self.capabilities.contains(&cap)
    }
}

fn is_valid_id(s: &str) -> bool {
    let mut chars = s.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return false;
    }
    chars.all(|c| {
        c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_' || c == '-'
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok_manifest() -> PluginManifest {
        PluginManifest {
            id: "android".into(),
            name: "Android".into(),
            version: "3.11.0".into(),
            api_version: "1".into(),
            capabilities: vec![Capability::Screen, Capability::Input],
            tools: vec![],
            description: None,
        }
    }

    #[test]
    fn validates_ok_manifest() {
        ok_manifest().validate().unwrap();
    }

    #[test]
    fn rejects_empty_id() {
        let mut m = ok_manifest();
        m.id = "".into();
        assert!(m.validate().is_err());
    }

    #[test]
    fn rejects_bad_id() {
        let mut m = ok_manifest();
        m.id = "Has Space".into();
        assert!(m.validate().is_err());
    }

    #[test]
    fn rejects_api_version_mismatch() {
        let mut m = ok_manifest();
        m.api_version = "2".into();
        assert!(m.validate().is_err());
    }

    #[test]
    fn rejects_empty_capabilities() {
        let mut m = ok_manifest();
        m.capabilities.clear();
        assert!(m.validate().is_err());
    }

    #[test]
    fn rejects_duplicate_capabilities() {
        let mut m = ok_manifest();
        m.capabilities = vec![Capability::Screen, Capability::Screen];
        assert!(m.validate().is_err());
    }
}
