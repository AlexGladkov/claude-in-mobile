//! Store command dispatchers.
//!
//! Delegates to the store-specific modules (google_play, huawei, rustore).

use anyhow::{bail, Result};

use crate::cli::{HuaweiCommands, RuStoreCommands, StoreCommands};
use crate::store;
use crate::store::{validate_locale, validate_package, validate_track};

/// Handle Google Play Store subcommands.
pub fn google_play(command: StoreCommands) -> Result<()> {
    match command {
        StoreCommands::Upload { package, file } => {
            validate_package(&package)?;
            store::google_play::upload(&package, &file)
        }
        StoreCommands::SetNotes {
            package,
            language,
            text,
        } => {
            validate_package(&package)?;
            validate_locale(&language)?;
            store::google_play::set_notes(&package, &language, &text)
        }
        StoreCommands::Submit {
            package,
            track,
            rollout,
        } => {
            validate_package(&package)?;
            validate_track(&track)?;
            if !rollout.is_finite() || !(0.01..=1.0).contains(&rollout) {
                bail!("Rollout must be between 0.01 and 1.0");
            }
            store::google_play::submit(&package, &track, rollout)
        }
        StoreCommands::Promote {
            package,
            from_track,
            to_track,
        } => {
            validate_package(&package)?;
            validate_track(&from_track)?;
            validate_track(&to_track)?;
            store::google_play::promote(&package, &from_track, &to_track)
        }
        StoreCommands::GetReleases { package, track } => {
            validate_package(&package)?;
            if let Some(track) = track.as_deref() {
                validate_track(track)?;
            }
            store::google_play::get_releases(&package, track.as_deref())
        }
        StoreCommands::HaltRollout { package, track } => {
            validate_package(&package)?;
            validate_track(&track)?;
            store::google_play::halt_rollout(&package, &track)
        }
        StoreCommands::Discard { package } => {
            validate_package(&package)?;
            store::google_play::discard(&package)
        }
    }
}

/// Handle Huawei AppGallery subcommands.
pub fn huawei(command: HuaweiCommands) -> Result<()> {
    match command {
        HuaweiCommands::Upload { package, file } => {
            validate_package(&package)?;
            store::huawei::upload(&package, &file)
        }
        HuaweiCommands::SetNotes {
            package,
            language,
            text,
        } => {
            validate_package(&package)?;
            validate_locale(&language)?;
            store::huawei::set_notes(&package, &language, &text)
        }
        HuaweiCommands::Submit { package } => {
            validate_package(&package)?;
            store::huawei::submit(&package)
        }
        HuaweiCommands::GetReleases { package } => {
            validate_package(&package)?;
            store::huawei::get_releases(&package)
        }
    }
}

/// Handle RuStore subcommands.
pub fn rustore(command: RuStoreCommands) -> Result<()> {
    match command {
        RuStoreCommands::Upload { package, file } => {
            validate_package(&package)?;
            store::rustore::upload(&package, &file)
        }
        RuStoreCommands::SetNotes {
            package,
            language,
            text,
        } => {
            validate_package(&package)?;
            validate_locale(&language)?;
            store::rustore::set_notes(&package, &language, &text)
        }
        RuStoreCommands::Submit { package } => {
            validate_package(&package)?;
            store::rustore::submit(&package)
        }
        RuStoreCommands::GetVersions { package } => {
            validate_package(&package)?;
            store::rustore::get_versions(&package)
        }
        RuStoreCommands::Discard { package } => {
            validate_package(&package)?;
            store::rustore::discard(&package)
        }
    }
}
