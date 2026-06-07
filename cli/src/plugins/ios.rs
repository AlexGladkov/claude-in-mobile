//! iOS plugin — wraps the simctl handler module (`crate::ios`).

use anyhow::{bail, Result};
use serde_json::Value;

use crate::kernel::{Capability, PluginContext, PluginManifest, SourcePlugin};

pub struct IosPlugin {
    manifest: PluginManifest,
}

impl IosPlugin {
    pub fn new() -> Self {
        Self {
            manifest: PluginManifest {
                id: "ios".into(),
                name: "iOS".into(),
                version: "3.11.0".into(),
                api_version: "1".into(),
                capabilities: vec![
                    Capability::Screen,
                    Capability::Input,
                    Capability::Ui,
                    Capability::Shell,
                    Capability::AppLifecycle,
                    Capability::Permissions,
                    Capability::Logs,
                    Capability::DeviceMgmt,
                ],
                tools: vec![],
                description: Some(
                    "iOS Simulator automation via simctl (screen, input, app lifecycle, shell, logs)"
                        .into(),
                ),
            },
        }
    }
}

impl Default for IosPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl SourcePlugin for IosPlugin {
    fn manifest(&self) -> &PluginManifest {
        &self.manifest
    }

    fn handle(&self, cmd: &str, _args: &Value, _ctx: &PluginContext) -> Result<Value> {
        bail!("ios plugin: command dispatch not yet wired (cmd={cmd})")
    }
}
