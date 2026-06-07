//! Aurora OS plugin — wraps the audb handler module (`crate::aurora`).

use anyhow::{bail, Result};
use serde_json::Value;

use crate::kernel::{Capability, PluginContext, PluginManifest, SourcePlugin};

pub struct AuroraPlugin {
    manifest: PluginManifest,
}

impl AuroraPlugin {
    pub fn new() -> Self {
        Self {
            manifest: PluginManifest {
                id: "aurora".into(),
                name: "Aurora OS".into(),
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
                    "Aurora OS automation via audb (screen, input, app lifecycle, shell, logs)"
                        .into(),
                ),
            },
        }
    }
}

impl Default for AuroraPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl SourcePlugin for AuroraPlugin {
    fn manifest(&self) -> &PluginManifest {
        &self.manifest
    }

    fn handle(&self, cmd: &str, _args: &Value, _ctx: &PluginContext) -> Result<Value> {
        bail!("aurora plugin: command dispatch not yet wired (cmd={cmd})")
    }
}
