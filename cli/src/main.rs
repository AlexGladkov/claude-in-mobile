//! claude-in-mobile - Fast CLI for mobile device automation
//!
//! Supports Android (via ADB), iOS (via simctl), Aurora (via audb), Desktop (via companion app)
//! Also supports Google Play, Huawei AppGallery, and RuStore store management.

mod android;
mod aurora;
mod cli;
mod commands;
mod desktop;
mod ios;
mod scale;
mod screenshot;
mod store;

use std::process::ExitCode;

use clap::Parser;

fn main() -> ExitCode {
    let parsed = cli::Cli::parse();

    match commands::run(parsed.command) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("Error: {}", e);
            ExitCode::FAILURE
        }
    }
}
