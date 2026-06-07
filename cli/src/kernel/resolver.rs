//! Capability resolver — find plugins by required capability set.

use std::sync::Arc;

use super::{Capability, Registry, SourcePlugin};

#[derive(Debug, Clone)]
pub struct ResolveQuery {
    pub capabilities: Vec<Capability>,
    pub plugin_id: Option<String>,
}

pub struct Resolver<'a> {
    registry: &'a Registry,
}

impl<'a> Resolver<'a> {
    pub fn new(registry: &'a Registry) -> Self {
        Self { registry }
    }

    pub fn resolve(&self, query: &ResolveQuery) -> Vec<Arc<dyn SourcePlugin>> {
        self.registry
            .list()
            .into_iter()
            .filter(|p| {
                if let Some(ref id) = query.plugin_id {
                    if &p.manifest().id != id {
                        return false;
                    }
                }
                query
                    .capabilities
                    .iter()
                    .all(|c| p.manifest().has_capability(*c))
            })
            .collect()
    }

    pub fn resolve_one(&self, query: &ResolveQuery) -> Option<Arc<dyn SourcePlugin>> {
        self.resolve(query).into_iter().next()
    }
}

#[cfg(test)]
mod tests {
    use super::super::{PluginContext, PluginManifest};
    use super::*;
    use anyhow::Result;
    use serde_json::Value;

    struct DummyPlugin {
        manifest: PluginManifest,
    }
    impl SourcePlugin for DummyPlugin {
        fn manifest(&self) -> &PluginManifest {
            &self.manifest
        }
        fn handle(&self, _: &str, _: &Value, _: &PluginContext) -> Result<Value> {
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
    fn resolves_by_capability_intersection() {
        let mut r = Registry::new();
        r.register(make("a", vec![Capability::Screen])).unwrap();
        r.register(make("b", vec![Capability::Screen, Capability::Input]))
            .unwrap();
        let resolver = Resolver::new(&r);
        let q = ResolveQuery {
            capabilities: vec![Capability::Screen, Capability::Input],
            plugin_id: None,
        };
        let ids: Vec<_> = resolver
            .resolve(&q)
            .into_iter()
            .map(|p| p.manifest().id.clone())
            .collect();
        assert_eq!(ids, vec!["b"]);
    }

    #[test]
    fn filters_by_plugin_id() {
        let mut r = Registry::new();
        r.register(make("a", vec![Capability::Screen])).unwrap();
        r.register(make("b", vec![Capability::Screen])).unwrap();
        let resolver = Resolver::new(&r);
        let q = ResolveQuery {
            capabilities: vec![Capability::Screen],
            plugin_id: Some("b".into()),
        };
        let ids: Vec<_> = resolver
            .resolve(&q)
            .into_iter()
            .map(|p| p.manifest().id.clone())
            .collect();
        assert_eq!(ids, vec!["b"]);
    }

    #[test]
    fn resolve_one_returns_none_when_no_match() {
        let r = Registry::new();
        let resolver = Resolver::new(&r);
        let q = ResolveQuery {
            capabilities: vec![Capability::Terminal],
            plugin_id: None,
        };
        assert!(resolver.resolve_one(&q).is_none());
    }
}
