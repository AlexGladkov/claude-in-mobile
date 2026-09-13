use std::io::Read as _;
use std::sync::LazyLock;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use reqwest::blocking::Client;
use reqwest::blocking::Response;
use serde::de::DeserializeOwned;

static CLIENT: LazyLock<Client> = LazyLock::new(|| {
    Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(10 * 60))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("build store HTTP client")
});

const MAX_JSON_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;

pub fn parse_json_response<T: DeserializeOwned>(mut response: Response, label: &str) -> Result<T> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_JSON_RESPONSE_BYTES)
    {
        bail!("{label} exceeds {MAX_JSON_RESPONSE_BYTES} bytes");
    }
    let mut body = Vec::new();
    (&mut response)
        .take(MAX_JSON_RESPONSE_BYTES + 1)
        .read_to_end(&mut body)
        .with_context(|| format!("Failed to read {label}"))?;
    if body.len() as u64 > MAX_JSON_RESPONSE_BYTES {
        bail!("{label} exceeds {MAX_JSON_RESPONSE_BYTES} bytes");
    }
    serde_json::from_slice(&body).with_context(|| format!("Failed to parse {label}"))
}

pub fn client() -> &'static Client {
    &CLIENT
}
