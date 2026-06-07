//! Rust mirror of the claude-in-mobile microkernel.
//!
//! Pair with `src/kernel/` on the TypeScript side. Provides the same
//! [`Capability`] enum, [`PluginManifest`] descriptor, [`SourcePlugin`] trait
//! and an in-memory [`Registry`] / [`Resolver`].
//!
//! Phase 6 deliverable: kernel infrastructure only. Platform handlers are
//! migrated into [`SourcePlugin`] implementations in Phase 7.

pub mod capability;
pub mod manifest;
pub mod plugin;
pub mod registry;
pub mod resolver;

pub use capability::{Capability, ALL_CAPABILITIES};
pub use manifest::{PluginManifest, PLUGIN_API_VERSION};
pub use plugin::{PluginContext, SourcePlugin};
pub use registry::Registry;
pub use resolver::{ResolveQuery, Resolver};
