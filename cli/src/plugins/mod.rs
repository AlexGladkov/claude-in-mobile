//! Built-in Rust plugins.
//!
//! Each module wraps an existing platform handler (`android.rs`, `ios.rs`, …)
//! in a [`SourcePlugin`](crate::kernel::SourcePlugin) implementation. Phase 7
//! delivers manifests + scaffolding; command dispatch through `handle()` is
//! wired in Phase 9 alongside the REPL JSON-RPC bridge.

pub mod android;
pub mod aurora;
pub mod desktop;
pub mod ios;
pub mod repl;
pub mod web;

use std::sync::Arc;

use anyhow::Result;

use crate::kernel::{Registry, SourcePlugin};

/// Register the canonical set of first-party plugins.
///
/// Order matters only for deterministic listing — capability resolution is
/// order-independent.
pub fn register_builtins(registry: &mut Registry) -> Result<()> {
    let builtins: Vec<Arc<dyn SourcePlugin>> = vec![
        Arc::new(android::AndroidPlugin::new()),
        Arc::new(ios::IosPlugin::new()),
        Arc::new(desktop::DesktopPlugin::new()),
        Arc::new(web::WebPlugin::new()),
        Arc::new(aurora::AuroraPlugin::new()),
        Arc::new(repl::ReplPlugin::new()),
    ];
    for p in builtins {
        registry.register(p)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::Capability;

    #[test]
    fn registers_all_first_party_plugins() {
        let mut r = Registry::new();
        register_builtins(&mut r).unwrap();
        let mut ids: Vec<_> = r.list().iter().map(|p| p.manifest().id.clone()).collect();
        ids.sort();
        assert_eq!(
            ids,
            vec!["android", "aurora", "desktop", "ios", "repl", "web"]
        );
    }

    #[test]
    fn only_android_and_ios_declare_permissions() {
        let mut r = Registry::new();
        register_builtins(&mut r).unwrap();
        let mut ids: Vec<_> = r
            .find_by_capability(Capability::Permissions)
            .iter()
            .map(|p| p.manifest().id.clone())
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["android", "ios"]);
    }

    #[test]
    fn web_has_no_shell_or_app_lifecycle() {
        let mut r = Registry::new();
        register_builtins(&mut r).unwrap();
        let web = r.get("web").unwrap();
        assert!(!web.manifest().has_capability(Capability::Shell));
        assert!(!web.manifest().has_capability(Capability::AppLifecycle));
    }

    #[test]
    fn only_repl_declares_terminal_capability() {
        let mut r = Registry::new();
        register_builtins(&mut r).unwrap();
        let providers: Vec<_> = r
            .find_by_capability(Capability::Terminal)
            .iter()
            .map(|p| p.manifest().id.clone())
            .collect();
        assert_eq!(providers, vec!["repl"]);
    }
}
