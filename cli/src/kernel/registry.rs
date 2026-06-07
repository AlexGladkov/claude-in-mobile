//! Runtime registry for `SourcePlugin` instances.
//!
//! Phase 6 ships a hand-rolled map. Phase 7 replaces the explicit `register`
//! calls with compile-time discovery via the `inventory` crate while keeping
//! the same public API.

use anyhow::{bail, Result};
use std::collections::HashMap;
use std::sync::Arc;

use super::{Capability, SourcePlugin};

#[derive(Default)]
pub struct Registry {
    plugins: HashMap<String, Arc<dyn SourcePlugin>>,
    frozen: bool,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, plugin: Arc<dyn SourcePlugin>) -> Result<()> {
        if self.frozen {
            bail!("registry is frozen");
        }
        plugin.manifest().validate()?;
        let id = plugin.manifest().id.clone();
        if self.plugins.contains_key(&id) {
            bail!("plugin id already registered: {}", id);
        }
        self.plugins.insert(id, plugin);
        Ok(())
    }

    pub fn freeze(&mut self) {
        self.frozen = true;
    }

    pub fn is_frozen(&self) -> bool {
        self.frozen
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn SourcePlugin>> {
        self.plugins.get(id).cloned()
    }

    pub fn list(&self) -> Vec<Arc<dyn SourcePlugin>> {
        self.plugins.values().cloned().collect()
    }

    pub fn find_by_capability(&self, cap: Capability) -> Vec<Arc<dyn SourcePlugin>> {
        self.plugins
            .values()
            .filter(|p| p.manifest().has_capability(cap))
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::super::{PluginContext, PluginManifest};
    use super::*;
    use serde_json::Value;

    struct DummyPlugin {
        manifest: PluginManifest,
    }

    impl SourcePlugin for DummyPlugin {
        fn manifest(&self) -> &PluginManifest {
            &self.manifest
        }
        fn handle(&self, _cmd: &str, _args: &Value, _ctx: &PluginContext) -> Result<Value> {
            Ok(Value::Null)
        }
    }

    fn make(id: &str, caps: Vec<Capability>) -> Arc<dyn SourcePlugin> {
        Arc::new(DummyPlugin {
            manifest: PluginManifest {
                id: id.into(),
                name: id.into(),
                version: "0.1.0".into(),
                api_version: "1".into(),
                capabilities: caps,
                tools: vec![],
                description: None,
            },
        })
    }

    #[test]
    fn registers_valid_plugin() {
        let mut r = Registry::new();
        r.register(make("android", vec![Capability::Screen])).unwrap();
        assert!(r.get("android").is_some());
    }

    #[test]
    fn rejects_duplicate_id() {
        let mut r = Registry::new();
        r.register(make("a", vec![Capability::Screen])).unwrap();
        assert!(r.register(make("a", vec![Capability::Screen])).is_err());
    }

    #[test]
    fn rejects_invalid_manifest() {
        let mut r = Registry::new();
        let bad = Arc::new(DummyPlugin {
            manifest: PluginManifest {
                id: "Bad Id".into(),
                name: "x".into(),
                version: "0.1.0".into(),
                api_version: "1".into(),
                capabilities: vec![Capability::Screen],
                tools: vec![],
                description: None,
            },
        }) as Arc<dyn SourcePlugin>;
        assert!(r.register(bad).is_err());
    }

    #[test]
    fn freeze_blocks_registration() {
        let mut r = Registry::new();
        r.freeze();
        assert!(r.register(make("a", vec![Capability::Screen])).is_err());
    }

    #[test]
    fn find_by_capability_returns_matches() {
        let mut r = Registry::new();
        r.register(make("a", vec![Capability::Screen])).unwrap();
        r.register(make("b", vec![Capability::Terminal])).unwrap();
        r.register(make("c", vec![Capability::Screen, Capability::Input]))
            .unwrap();
        let matches = r.find_by_capability(Capability::Screen);
        assert_eq!(matches.len(), 2);
    }
}
