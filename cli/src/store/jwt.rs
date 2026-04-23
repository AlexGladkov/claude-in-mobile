//! RS256 JWT builder for Google Play service accounts and RuStore auth.

use anyhow::{Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rsa::pkcs1::DecodeRsaPrivateKey;
use rsa::pkcs8::DecodePrivateKey;
use rsa::pkcs1v15::SigningKey;
use rsa::sha2::Sha256;
use rsa::signature::{Signer, SignatureEncoding};
use rsa::RsaPrivateKey;

/// Create a signed RS256 JWT.
/// Returns `<header>.<payload>.<signature>` (all base64url, no padding).
pub fn create_rs256(key_pem: &str, payload: &serde_json::Value) -> Result<String> {
    let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"RS256","typ":"JWT"}"#);
    let payload_b64 =
        URL_SAFE_NO_PAD.encode(serde_json::to_string(payload).context("Failed to serialize JWT payload")?);

    let signing_input = format!("{}.{}", header, payload_b64);

    // Try PKCS8 (Google service accounts) then PKCS1 (legacy/RuStore keys)
    let private_key = RsaPrivateKey::from_pkcs8_pem(key_pem)
        .or_else(|_| RsaPrivateKey::from_pkcs1_pem(key_pem))
        .context(
            "Failed to parse RSA private key. Ensure it is valid PKCS8 or PKCS1 PEM format.",
        )?;

    let signing_key = SigningKey::<Sha256>::new(private_key);
    let signature = signing_key.sign(signing_input.as_bytes());
    let sig_b64 = URL_SAFE_NO_PAD.encode(signature.to_bytes().as_ref());

    Ok(format!("{}.{}", signing_input, sig_b64))
}

/// Current Unix timestamp in seconds.
pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Current Unix timestamp in milliseconds.
pub fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
