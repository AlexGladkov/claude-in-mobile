//! Store command dispatchers.
//!
//! Delegates to the store-specific modules (google_play, huawei, rustore).

use anyhow::Result;

use crate::cli::{HuaweiCommands, RuStoreCommands, StoreCommands};
use crate::store;

/// Handle Google Play Store subcommands.
pub fn google_play(command: StoreCommands) -> Result<()> {
    match command {
        StoreCommands::Upload { package, file } => {
            store::google_play::upload(&package, &file)
        }
        StoreCommands::SetNotes { package, language, text } => {
            store::google_play::set_notes(&package, &language, &text)
        }
        StoreCommands::Submit { package, track, rollout } => {
            let rollout = rollout.clamp(0.01, 1.0);
            store::google_play::submit(&package, &track, rollout)
        }
        StoreCommands::Promote { package, from_track, to_track } => {
            store::google_play::promote(&package, &from_track, &to_track)
        }
        StoreCommands::GetReleases { package, track } => {
            store::google_play::get_releases(&package, track.as_deref())
        }
        StoreCommands::HaltRollout { package, track } => {
            store::google_play::halt_rollout(&package, &track)
        }
        StoreCommands::Discard { package } => {
            store::google_play::discard(&package)
        }
    }
}

/// Handle Huawei AppGallery subcommands.
pub fn huawei(command: HuaweiCommands) -> Result<()> {
    match command {
        HuaweiCommands::Upload { package, file } => {
            store::huawei::upload(&package, &file)
        }
        HuaweiCommands::SetNotes { package, language, text } => {
            store::huawei::set_notes(&package, &language, &text)
        }
        HuaweiCommands::Submit { package } => {
            store::huawei::submit(&package)
        }
        HuaweiCommands::GetReleases { package } => {
            store::huawei::get_releases(&package)
        }
    }
}

/// Handle RuStore subcommands.
pub fn rustore(command: RuStoreCommands) -> Result<()> {
    match command {
        RuStoreCommands::Upload { package, file } => {
            store::rustore::upload(&package, &file)
        }
        RuStoreCommands::SetNotes { package, language, text } => {
            store::rustore::set_notes(&package, &language, &text)
        }
        RuStoreCommands::Submit { package } => {
            store::rustore::submit(&package)
        }
        RuStoreCommands::GetVersions { package } => {
            store::rustore::get_versions(&package)
        }
        RuStoreCommands::Discard { package } => {
            store::rustore::discard(&package)
        }
    }
}
