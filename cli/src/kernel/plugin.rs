//! SourcePlugin trait and PluginContext.
//!
//! Plugin handlers receive a `PluginContext` and dispatch commands by name.
//! The wire envelope shared with the TypeScript MCP server is
//! `{ "plugin": "<id>", "cmd": "<name>", "args": <json> }`.

use anyhow::Result;
use serde_json::Value;

use super::PluginManifest;

/// Lightweight context handed to plugins on command dispatch. Phase 6 keeps
/// this minimal; Phase 7+ will add structured logging, config slices, and an
/// event sink mirroring the TS-side EventBus.
#[derive(Debug, Default, Clone)]
pub struct PluginContext {
    pub config: Value,
}

impl PluginContext {
    pub fn new() -> Self {
        Self {
            config: Value::Null,
        }
    }
}

/// Long-lived plugin object. Implementations are typically zero-sized structs
/// registered via [`inventory`] in Phase 7.
pub trait SourcePlugin: Send + Sync {
    fn manifest(&self) -> &PluginManifest;

    /// Dispatch a command to this plugin. `cmd` is the action name; `args` is
    /// the JSON envelope from the TS bridge.
    fn handle(&self, cmd: &str, args: &Value, ctx: &PluginContext) -> Result<Value>;
}
