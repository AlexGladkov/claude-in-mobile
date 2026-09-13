pub mod draft;
pub mod google_play;
mod http;
pub mod huawei;
pub mod jwt;
pub mod rustore;

use anyhow::{bail, Result};

pub(crate) fn validate_package(package: &str) -> Result<()> {
    let segments = package.split('.');
    if segments.clone().count() < 2
        || segments.into_iter().any(|segment| {
            !segment
                .bytes()
                .next()
                .is_some_and(|byte| byte.is_ascii_alphabetic())
                || !segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        })
    {
        bail!("Invalid package name: expected a reverse-domain identifier");
    }
    Ok(())
}

pub(crate) fn validate_locale(locale: &str) -> Result<()> {
    if locale.len() > 35
        || !locale.split('-').all(|part| {
            !part.is_empty() && part.len() <= 8 && part.bytes().all(|b| b.is_ascii_alphanumeric())
        })
    {
        bail!("Invalid release-note locale");
    }
    Ok(())
}

pub(crate) fn validate_track(track: &str) -> Result<()> {
    crate::utils::private_state::validate_identifier(track, "release track")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_identifiers_reject_url_delimiters() {
        assert!(validate_package("com.example.app").is_ok());
        assert!(validate_package("com.example/app?token=secret").is_err());
        assert!(validate_track("production").is_ok());
        assert!(validate_track("production?alt=1").is_err());
        assert!(validate_locale("en-US").is_ok());
        assert!(validate_locale("../secret").is_err());
    }
}
