//! REPL plugin — first non-platform plugin and proof of the microkernel
//! contract for stateful, non-UI sources.
//!
//! Capabilities: `terminal` + `input`. Owns a [`Supervisor`] that holds named
//! PTY sessions. JSON-RPC command dispatch over stdio is added in Phase 9 by
//! the TypeScript-side plugin (`src/plugins/repl/`).

pub mod bridge;
pub mod expect;
pub mod prompt_profiles;
pub mod session;
pub mod supervisor;

use anyhow::{bail, Result};
use serde_json::Value;

use crate::kernel::{Capability, PluginContext, PluginManifest, SourcePlugin};
use supervisor::Supervisor;

pub struct ReplPlugin {
    manifest: PluginManifest,
    supervisor: Supervisor,
}

impl ReplPlugin {
    pub fn new() -> Self {
        Self {
            manifest: PluginManifest {
                id: "repl".into(),
                name: "REPL".into(),
                version: "3.11.0".into(),
                api_version: "1".into(),
                capabilities: vec![Capability::Terminal, Capability::Input],
                tools: vec![
                    "repl_spawn".into(),
                    "repl_send".into(),
                    "repl_key".into(),
                    "repl_expect".into(),
                    "repl_snapshot".into(),
                    "repl_list".into(),
                    "repl_kill".into(),
                ],
                description: Some(
                    "Interactive REPL automation (python/node/bash/...) via PTY + vt100 emulator"
                        .into(),
                ),
            },
            supervisor: Supervisor::new(),
        }
    }

    pub fn supervisor(&self) -> &Supervisor {
        &self.supervisor
    }
}

impl Default for ReplPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl SourcePlugin for ReplPlugin {
    fn manifest(&self) -> &PluginManifest {
        &self.manifest
    }

    fn handle(&self, cmd: &str, _args: &Value, _ctx: &PluginContext) -> Result<Value> {
        // Real dispatch is wired in Phase 9 alongside the JSON-RPC bridge — see
        // src/plugins/repl/ on the TS side. The supervisor is already accessible
        // via `supervisor()`; the bridge layer is what calls into it.
        bail!("repl plugin: command dispatch arrives with the Phase 9 bridge (cmd={cmd})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::Registry;
    use std::sync::Arc;

    #[test]
    fn manifest_advertises_terminal_capability() {
        let p = ReplPlugin::new();
        assert!(p.manifest().has_capability(Capability::Terminal));
        assert!(p.manifest().has_capability(Capability::Input));
        assert!(!p.manifest().has_capability(Capability::Screen));
    }

    #[test]
    fn registers_alongside_first_party_plugins() {
        let mut r = Registry::new();
        let p: Arc<dyn SourcePlugin> = Arc::new(ReplPlugin::new());
        r.register(p).unwrap();
        let terminal_providers = r.find_by_capability(Capability::Terminal);
        assert_eq!(terminal_providers.len(), 1);
        assert_eq!(terminal_providers[0].manifest().id, "repl");
    }
}
