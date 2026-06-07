//! Desktop plugin — wraps the Compose companion handler module (`crate::desktop`).

use anyhow::{bail, Result};
use serde_json::Value;

use crate::kernel::{Capability, PluginContext, PluginManifest, SourcePlugin};

pub struct DesktopPlugin {
    manifest: PluginManifest,
}

impl DesktopPlugin {
    pub fn new() -> Self {
        Self {
            manifest: PluginManifest {
                id: "desktop".into(),
                name: "Desktop".into(),
                version: "3.11.0".into(),
                api_version: "1".into(),
                capabilities: vec![
                    Capability::Screen,
                    Capability::Input,
                    Capability::Ui,
                    Capability::Shell,
                    Capability::AppLifecycle,
                    Capability::Logs,
                    Capability::DeviceMgmt,
                ],
                tools: vec![],
                description: Some(
                    "Desktop automation via Compose companion JSON-RPC".into(),
                ),
            },
        }
    }
}

impl Default for DesktopPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl SourcePlugin for DesktopPlugin {
    fn manifest(&self) -> &PluginManifest {
        &self.manifest
    }

    fn handle(&self, cmd: &str, _args: &Value, _ctx: &PluginContext) -> Result<Value> {
        bail!("desktop plugin: command dispatch not yet wired (cmd={cmd})")
    }
}
