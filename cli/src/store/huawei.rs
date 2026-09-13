//! Huawei AppGallery Connect management.
//! Auth: OAuth2 client credentials (no JWT needed).
//! Env: HUAWEI_CLIENT_ID, HUAWEI_CLIENT_SECRET

use super::{
    draft,
    http::{client, parse_json_response},
};
use crate::utils::process::terminal_safe;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;

const OAUTH_URL: &str = "https://connect-api.cloud.huawei.com/api/oauth2/v1/token";
const BASE: &str = "https://connect-api.cloud.huawei.com/api/publish/v2";
const UPLOAD_KIT: &str = "https://connect-api.cloud.huawei.com/api/publishingkit/v1";

// ── Types ────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct DraftState {
    app_id: String,
    file_id: String,
    file_name: String,
    file_type: String,
    release_notes: Vec<Note>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Note {
    language: String,
    text: String,
}

// ── Auth ─────────────────────────────────────────────────────────────────────

fn load_creds() -> Result<(String, String)> {
    let id = std::env::var("HUAWEI_CLIENT_ID")
        .context("Huawei AppGallery: missing HUAWEI_CLIENT_ID environment variable")?;
    let secret = std::env::var("HUAWEI_CLIENT_SECRET")
        .context("Huawei AppGallery: missing HUAWEI_CLIENT_SECRET environment variable")?;
    Ok((id, secret))
}

fn get_token() -> Result<String> {
    let (client_id, client_secret) = load_creds()?;
    let response = client()
        .post(OAUTH_URL)
        .form(&[
            ("grant_type", "client_credentials"),
            ("client_id", &client_id),
            ("client_secret", &client_secret),
        ])
        .send()
        .context("Failed to connect to Huawei OAuth endpoint")?
        .error_for_status()
        .context("Huawei OAuth returned error")?;
    let resp: serde_json::Value = parse_json_response(response, "Huawei OAuth response")?;

    resp["access_token"]
        .as_str()
        .map(|s| s.to_string())
        .context("Huawei OAuth: no access_token in response")
}

fn get(url: &str, token: &str) -> Result<serde_json::Value> {
    let response = client()
        .get(url)
        .bearer_auth(token)
        .send()
        .with_context(|| format!("GET {}", url))?
        .error_for_status()
        .with_context(|| format!("GET {} failed", url))?;
    parse_json_response(response, "Huawei API response")
}

fn post(url: &str, token: &str, body: Option<&serde_json::Value>) -> Result<serde_json::Value> {
    let mut req = client()
        .post(url)
        .bearer_auth(token)
        .header("Content-Type", "application/json");
    if let Some(b) = body {
        req = req.json(b);
    }
    let resp = req.send().with_context(|| format!("POST {}", url))?;
    if resp.status().as_u16() == 204 {
        return Ok(json!({}));
    }
    let response = resp
        .error_for_status()
        .with_context(|| format!("POST {} failed", url))?;
    parse_json_response(response, "Huawei API response")
}

fn put(url: &str, token: &str, body: &serde_json::Value) -> Result<serde_json::Value> {
    let response = client()
        .put(url)
        .bearer_auth(token)
        .json(body)
        .send()
        .with_context(|| format!("PUT {}", url))?
        .error_for_status()
        .with_context(|| format!("PUT {} failed", url))?;
    parse_json_response(response, "Huawei API response")
}

fn get_app_id(package: &str, token: &str) -> Result<String> {
    let url = format!("{}/app-id-list?packageName={}", BASE, urlenc(package));
    let data = get(&url, token)?;
    let code = data["ret"]["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!("Huawei failed to resolve the application (code {code})");
    }
    data["appIds"][0]["appId"]
        .as_str()
        .map(|s| s.to_string())
        .with_context(|| format!("Huawei: no appId found for package '{}'", package))
}

fn urlenc(s: &str) -> String {
    // Minimal encoding for package names — dots and underscores are safe
    s.replace('/', "%2F")
}

fn validate_upload_url(value: &str) -> Result<()> {
    let url = reqwest::Url::parse(value).context("Huawei returned an invalid upload URL")?;
    let host = url
        .host_str()
        .context("Huawei upload URL has no host")?
        .to_ascii_lowercase();
    let trusted = ["huawei.com", "huaweicloud.com", "hicloud.com"]
        .iter()
        .any(|domain| {
            host == *domain
                || host
                    .strip_suffix(domain)
                    .is_some_and(|prefix| prefix.ends_with('.'))
        });
    if url.scheme() != "https" || !trusted {
        anyhow::bail!("Huawei upload URL is outside trusted Huawei domains");
    }
    Ok(())
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn upload(package: &str, file_path: &str) -> Result<()> {
    if !std::path::Path::new(file_path).exists() {
        anyhow::bail!("File not found: {}", file_path);
    }

    let token = get_token()?;
    let app_id = get_app_id(package, &token)?;

    let ext = if file_path.to_lowercase().ends_with(".aab") {
        "AAB"
    } else {
        "APK"
    };
    let file_name = std::path::Path::new(file_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let file_size = std::fs::metadata(file_path)?.len();

    // Step 1: get upload URL + authCode
    let url_data = get(
        &format!(
            "{}/files/uploadUrl?appId={}&fileType={}&releaseType=1",
            UPLOAD_KIT, app_id, ext
        ),
        &token,
    )?;
    let code = url_data["ret"]["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!("Huawei failed to create an upload session (code {code})");
    }
    let upload_url = url_data["uploadUrl"]
        .as_str()
        .context("Huawei: upload URL response missing uploadUrl")?
        .to_string();
    let auth_code = url_data["authCode"]
        .as_str()
        .context("Huawei: upload URL response missing authCode")?
        .to_string();
    validate_upload_url(&upload_url)?;

    // Step 2: multipart upload — fields: file + token (authCode)
    let file_part = reqwest::blocking::multipart::Part::file(file_path)
        .context("Failed to open file for upload")?
        .file_name(file_name.clone())
        .mime_str("application/octet-stream")?;
    let form = reqwest::blocking::multipart::Form::new()
        .part("file", file_part)
        .text("token", auth_code);

    let upload_resp = client()
        .post(&upload_url)
        .multipart(form)
        .send()
        .context("Failed to upload file to Huawei")?;

    if !upload_resp.status().is_success() {
        anyhow::bail!(
            "Huawei file upload failed with HTTP {}",
            upload_resp.status()
        );
    }

    let upload_data: serde_json::Value =
        parse_json_response(upload_resp, "Huawei upload response")?;
    let result_code = upload_data["result"]["resultCode"].as_i64().unwrap_or(-1);
    if result_code != 0 {
        anyhow::bail!("Huawei rejected the uploaded file (code {result_code})");
    }

    let file_id = upload_data["fileInfoList"][0]["fileId"]
        .as_str()
        .context("Huawei: upload response missing fileId")?
        .to_string();

    // Step 3: attach uploaded file to app
    put(
        &format!("{}/app-file-info?appId={}", BASE, app_id),
        &token,
        &json!({
            "fileType": 5,
            "files": [{
                "fileId": file_id,
                "fileName": file_name,
                "fileDestUrl": upload_url,
                "size": file_size,
            }]
        }),
    )?;

    draft::save(
        "huawei",
        package,
        &DraftState {
            app_id,
            file_id: file_id.clone(),
            file_name,
            file_type: ext.to_string(),
            release_notes: vec![],
        },
    )?;

    println!(
        "Uploaded to Huawei AppGallery. File ID: {}\nDraft open — call 'huawei set-notes' and 'huawei submit' to publish.",
        terminal_safe(file_id.as_bytes())
    );
    Ok(())
}

pub fn set_notes(package: &str, language: &str, text: &str) -> Result<()> {
    if text.len() > 500 {
        anyhow::bail!("Release notes exceed 500 characters ({})", text.len());
    }
    let mut state: DraftState = draft::load("huawei", package)?;
    upsert_note(&mut state.release_notes, language, text);
    draft::save("huawei", package, &state)?;
    println!(
        "Huawei release notes set for {} ({}/500 chars)",
        language,
        text.len()
    );
    Ok(())
}

pub fn submit(package: &str) -> Result<()> {
    let state: DraftState = draft::load("huawei", package)?;
    let token = get_token()?;
    let app_id = state.app_id;

    let data = post(
        &format!("{}/app-submit?appId={}", BASE, app_id),
        &token,
        None,
    )?;
    let code = data["ret"]["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!("Huawei submission failed (code {code})");
    }

    draft::delete("huawei", package)?;
    println!("Submitted to Huawei AppGallery for review: {}", package);
    Ok(())
}

pub fn get_releases(package: &str) -> Result<()> {
    let token = get_token()?;
    let app_id = get_app_id(package, &token)?;
    let data = get(&format!("{}/app-info?appId={}", BASE, app_id), &token)?;
    let code = data["ret"]["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        anyhow::bail!("Huawei release lookup failed (code {code})");
    }
    if data["appInfo"].is_null() {
        println!("{}: no release info available", package);
        return Ok(());
    }
    let version_code = data["appInfo"]["versionCode"].as_i64().unwrap_or(0);
    let release_state = data["appInfo"]["releaseState"].as_i64().unwrap_or(0);
    println!(
        "{}: v{} — {}",
        package,
        version_code,
        format_state(release_state)
    );
    Ok(())
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn upsert_note(notes: &mut Vec<Note>, language: &str, text: &str) {
    if let Some(idx) = notes.iter().position(|n| n.language == language) {
        notes[idx].text = text.to_string();
    } else {
        notes.push(Note {
            language: language.to_string(),
            text: text.to_string(),
        });
    }
}

fn format_state(state: i64) -> &'static str {
    match state {
        1 => "Draft",
        2 => "Under review",
        3 => "Published",
        4 => "Rejected",
        5 => "Removed",
        6 => "Update in review",
        7 => "Update published",
        _ => "Unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_huawei_upload_hosts() {
        assert!(validate_upload_url("https://obs.eu.huaweicloud.com/upload").is_ok());
        assert!(validate_upload_url("https://upload.huawei.com/session").is_ok());
        assert!(validate_upload_url("http://localhost/upload").is_err());
        assert!(validate_upload_url("https://huawei.com.attacker.example/upload").is_err());
    }
}
