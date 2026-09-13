//! mcp-devices library - shared types and utilities

pub mod android;
pub mod aurora;
pub mod cli;
pub mod commands;
pub mod desktop;
pub mod harmony;
pub mod ios;
pub mod kernel;
pub mod platform;
pub mod plugins;
pub mod scale;
pub mod screenshot;
pub mod store;
pub mod utils;

pub use platform::Platform;
