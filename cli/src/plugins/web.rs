//! Web plugin (Chrome via CDP). Mirrors `src/plugins/web/` on the TS side.
//!
//! Rust CLI does not currently host a CDP client — the TS MCP server owns the
//! browser session. The plugin exists so the kernel surface is symmetric and
//! capability resolution stays consistent across both runtimes.

use anyhow::{bail, Result};
use serde_json::Value;

use crate::kernel::{Capability, PluginContext, PluginManifest, SourcePlugin};

pub struct WebPlugin {
    manifest: PluginManifest,
}

impl WebPlugin {
    pub fn new() -> Self {
        Self {
            manifest: PluginManifest {
                id: "web".into(),
                name: "Web (Chrome)".into(),
                version: "3.11.0".into(),
                api_version: "1".into(),
                capabilities: vec![Capability::Screen, Capability::Input, Capability::Ui],
                tools: vec![],
                description: Some("Browser automation via Chrome DevTools Protocol".into()),
            },
        }
    }
}

impl Default for WebPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl SourcePlugin for WebPlugin {
    fn manifest(&self) -> &PluginManifest {
        &self.manifest
    }

    fn handle(&self, cmd: &str, _args: &Value, _ctx: &PluginContext) -> Result<Value> {
        bail!("web plugin: command dispatch not yet wired (cmd={cmd})")
    }
}
