//! RuStore management.
//! Auth: RSA RS256 JWT → RuStore token.
//! Env: RUSTORE_KEY_JSON  or  RUSTORE_COMPANY_ID + RUSTORE_KEY_ID + RUSTORE_PRIVATE_KEY

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{draft, jwt};

const BASE: &str = "https://public-api.rustore.ru/public/v1";
const AUTH_URL: &str = "https://public-api.rustore.ru/public/auth";

// ── Types ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct Credentials {
    #[serde(rename = "companyId")]
    company_id: String,
    #[serde(rename = "keyId")]
    key_id: String,
    #[serde(rename = "privateKey")]
    private_key: String,
}

#[derive(Serialize, Deserialize)]
struct DraftState {
    version_id: i64,
    release_notes: Vec<Note>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Note {
    language: String,
    text: String,
}

// ── Auth ─────────────────────────────────────────────────────────────────────

fn load_credentials() -> Result<Credentials> {
    // Prefer JSON bundle
    if let Ok(raw) = std::env::var("RUSTORE_KEY_JSON") {
        return serde_json::from_str(&raw).context("RUSTORE_KEY_JSON is not valid JSON");
    }
    // Fall back to individual vars
    match (
        std::env::var("RUSTORE_COMPANY_ID").ok(),
        std::env::var("RUSTORE_KEY_ID").ok(),
        std::env::var("RUSTORE_PRIVATE_KEY").ok(),
    ) {
        (Some(company_id), Some(key_id), Some(private_key)) => {
            Ok(Credentials { company_id, key_id, private_key })
        }
        _ => anyhow::bail!(
            "RuStore: missing credentials.\n\
             Set RUSTORE_KEY_JSON  or  RUSTORE_COMPANY_ID + RUSTORE_KEY_ID + RUSTORE_PRIVATE_KEY."
        ),
    }
}

fn get_token() -> Result<String> {
    let creds = load_credentials()?;
    let payload = json!({
        "keyId": creds.key_id,
        "timestamp": jwt::now_millis(),
    });
    let jwt_token = jwt::create_rs256(&creds.private_key, &payload)?;

    let resp: serde_json::Value = client()
        .post(AUTH_URL)
        .json(&json!({ "jwtToken": jwt_token }))
        .send()
        .context("Failed to connect to RuStore auth endpoint")?
        .error_for_status()
        .context("RuStore auth returned error")?
        .json()
        .context("Failed to parse RuStore auth response")?;

    if resp["code"].as_str() != Some("OK") {
        let msg = resp["message"]
            .as_str()
            .or_else(|| resp["code"].as_str())
            .unwrap_or("unknown");
        anyhow::bail!("RuStore auth error: {}", msg);
    }

    resp["body"]["jwtToken"]
        .as_str()
        .map(|s| s.to_string())
        .context("RuStore auth: no jwtToken in response body")
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::new()
}

fn api(
    method: &str,
    url: &str,
    token: &str,
    body: Option<&serde_json::Value>,
) -> Result<serde_json::Value> {
    let c = client();
    let mut req = match method {
        "GET" => c.get(url),
        "POST" => c.post(url),
        "PUT" => c.put(url),
        "PATCH" => c.patch(url),
        "DELETE" => c.delete(url),
        other => anyhow::bail!("Unknown HTTP method: {}", other),
    };
    req = req
        .header("Public-Token", token)
        .header("Content-Type", "application/json");
    if let Some(b) = body {
        req = req.json(b);
    }
    let resp = req.send().with_context(|| format!("{} {}", method, url))?;
    if resp.status().as_u16() == 204 {
        return Ok(json!({}));
    }
    resp.error_for_status()
        .with_context(|| format!("{} {} failed", method, url))?
        .json()
        .context("Failed to parse JSON response")
}

fn create_draft_version(package: &str, token: &str) -> Result<i64> {
    let resp = api(
        "POST",
        &format!("{}/application/{}/version", BASE, urlenc(package)),
        token,
        Some(&json!({ "whatsNew": {} })),
    )?;
    check_ok(&resp, "Failed to create draft version")?;
    resp["body"]["versionId"]
        .as_i64()
        .context("RuStore: no versionId in create version response")
}

fn delete_version(package: &str, version_id: i64, token: &str) {
    let url = format!("{}/application/{}/version/{}", BASE, urlenc(package), version_id);
    let _ = client().delete(&url).header("Public-Token", token).send();
}

fn check_ok(resp: &serde_json::Value, context: &str) -> Result<()> {
    if resp["code"].as_str() != Some("OK") {
        let msg = resp["message"]
            .as_str()
            .or_else(|| resp["code"].as_str())
            .unwrap_or("unknown");
        anyhow::bail!("{}: {}", context, msg);
    }
    Ok(())
}

fn urlenc(s: &str) -> String {
    s.replace('/', "%2F")
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn upload(package: &str, file_path: &str) -> Result<()> {
    if !std::path::Path::new(file_path).exists() {
        anyhow::bail!("File not found: {}", file_path);
    }

    let token = get_token()?;
    let version_id = create_draft_version(package, &token)?;

    let is_aab = file_path.to_lowercase().ends_with(".aab");
    let upload_type = if is_aab { "aab" } else { "apk" };
    let file_name = std::path::Path::new(file_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let file_part = reqwest::blocking::multipart::Part::file(file_path)
        .context("Failed to open file for upload")?
        .file_name(file_name)
        .mime_str("application/octet-stream")?;
    let form = reqwest::blocking::multipart::Form::new().part("file", file_part);

    let upload_url = format!(
        "{}/application/{}/version/{}/{}?servicesType=Unknown&isMainApk=true",
        BASE,
        urlenc(package),
        version_id,
        upload_type
    );

    let resp = client()
        .post(&upload_url)
        .header("Public-Token", &token)
        .multipart(form)
        .send()
        .context("Failed to upload to RuStore")?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().unwrap_or_default();
        delete_version(package, version_id, &token);
        anyhow::bail!("RuStore: upload failed {}: {}", status, text);
    }

    let data: serde_json::Value = resp.json().context("Failed to parse RuStore upload response")?;
    if data["code"].as_str() != Some("OK") {
        let msg = data["message"].as_str().unwrap_or("unknown");
        delete_version(package, version_id, &token);
        anyhow::bail!("RuStore: upload error: {}", msg);
    }

    draft::save(
        "rustore",
        package,
        &DraftState { version_id, release_notes: vec![] },
    )?;

    println!(
        "Uploaded to RuStore. Version ID: {}\nDraft open — call 'rustore set-notes' and 'rustore submit' to send for moderation.",
        version_id
    );
    Ok(())
}

pub fn set_notes(package: &str, language: &str, text: &str) -> Result<()> {
    if text.len() > 500 {
        anyhow::bail!("What's new text exceeds 500 characters ({})", text.len());
    }
    let mut state: DraftState = draft::load("rustore", package)?;
    upsert_note(&mut state.release_notes, language, text);
    draft::save("rustore", package, &state)?;
    println!("RuStore what's new set for {} ({}/500 chars)", language, text.len());
    Ok(())
}

pub fn submit(package: &str) -> Result<()> {
    let state: DraftState = draft::load("rustore", package)?;
    let token = get_token()?;

    // Patch release notes if any
    if !state.release_notes.is_empty() {
        let mut whats_new = serde_json::Map::new();
        for note in &state.release_notes {
            whats_new.insert(note.language.clone(), json!(note.text));
        }
        let patch = api(
            "PATCH",
            &format!(
                "{}/application/{}/version/{}/publishing-settings",
                BASE, urlenc(package), state.version_id
            ),
            &token,
            Some(&json!({ "whatsNew": whats_new })),
        )?;
        check_ok(&patch, "Failed to set release notes")?;
    }

    // Submit for moderation
    let submit_data = api(
        "POST",
        &format!(
            "{}/application/{}/version/{}/submit-for-moderation",
            BASE, urlenc(package), state.version_id
        ),
        &token,
        None,
    )?;
    check_ok(&submit_data, "Submit failed")?;

    draft::delete("rustore", package);
    println!(
        "Submitted to RuStore for moderation: {}\nPublication requires moderation approval (typically 1–3 business days).",
        package
    );
    Ok(())
}

pub fn get_versions(package: &str) -> Result<()> {
    let token = get_token()?;
    let data = api(
        "GET",
        &format!("{}/application/{}/version", BASE, urlenc(package)),
        &token,
        None,
    )?;
    check_ok(&data, "getReleases failed")?;

    let versions = data["body"].as_array().map(|v| v.as_slice()).unwrap_or(&[]);
    if versions.is_empty() {
        println!("{}: no versions found", package);
        return Ok(());
    }

    let lines: Vec<String> = versions
        .iter()
        .map(|v| {
            let ver = if let (Some(name), Some(code)) =
                (v["versionName"].as_str(), v["versionCode"].as_i64())
            {
                format!("{} ({})", name, code)
            } else {
                format!("id={}", v["versionId"].as_i64().unwrap_or(0))
            };
            let status = v["appStatus"].as_str().unwrap_or("unknown");
            format!("  v{} — {}", ver, status)
        })
        .collect();
    println!("{}:\n{}", package, lines.join("\n"));
    Ok(())
}

pub fn discard(package: &str) -> Result<()> {
    let state: DraftState = draft::load("rustore", package)?;
    let token = get_token()?;
    delete_version(package, state.version_id, &token);
    draft::delete("rustore", package);
    println!("RuStore draft deleted for {}", package);
    Ok(())
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn upsert_note(notes: &mut Vec<Note>, language: &str, text: &str) {
    if let Some(idx) = notes.iter().position(|n| n.language == language) {
        notes[idx].text = text.to_string();
    } else {
        notes.push(Note { language: language.to_string(), text: text.to_string() });
    }
}
