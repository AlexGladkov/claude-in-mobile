//! mcp-devices library - shared types and utilities

pub mod android;
pub mod aurora;
pub mod desktop;
pub mod ios;
pub mod kernel;
pub mod plugins;
pub mod screenshot;
pub mod platform;
pub mod utils;

pub use platform::Platform;
