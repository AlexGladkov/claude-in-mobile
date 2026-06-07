//! Android plugin — wraps the ADB handler module (`crate::android`).

use anyhow::{bail, Result};
use serde_json::Value;

use crate::kernel::{Capability, PluginContext, PluginManifest, SourcePlugin};

pub struct AndroidPlugin {
    manifest: PluginManifest,
}

impl AndroidPlugin {
    pub fn new() -> Self {
        Self {
            manifest: PluginManifest {
                id: "android".into(),
                name: "Android".into(),
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
                    "Android automation via ADB (screen, input, app lifecycle, shell, logs)"
                        .into(),
                ),
            },
        }
    }
}

impl Default for AndroidPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl SourcePlugin for AndroidPlugin {
    fn manifest(&self) -> &PluginManifest {
        &self.manifest
    }

    fn handle(&self, cmd: &str, _args: &Value, _ctx: &PluginContext) -> Result<Value> {
        // Command dispatch through the SourcePlugin bridge is wired in Phase 9
        // (REPL bridge introduces the JSON envelope). Until then existing Clap
        // subcommands drive the underlying handler functions directly.
        bail!("android plugin: command dispatch not yet wired (cmd={cmd})")
    }
}
