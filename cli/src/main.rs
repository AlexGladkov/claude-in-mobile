//! mcp-devices command-line entry point.
//!
//! Supports Android (via ADB), iOS (via simctl), HarmonyOS (via HDC), Aurora (via audb), and Desktop (via companion app).
//! Also supports Google Play, Huawei AppGallery, and RuStore store management.

use std::process::ExitCode;

use clap::Parser;
use mcp_devices::utils::process::terminal_safe;
use mcp_devices::{cli, commands};

fn main() -> ExitCode {
    let parsed = cli::Cli::parse();

    match commands::run(parsed.command) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("Error: {}", terminal_safe(e.to_string().as_bytes()));
            ExitCode::FAILURE
        }
    }
}
