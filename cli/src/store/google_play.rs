//! Google Play Store management.
//! Auth: service account JWT → OAuth2 access token.
//! Env: GOOGLE_PLAY_KEY_FILE or GOOGLE_PLAY_SERVICE_ACCOUNT_JSON

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{draft, jwt};

const BASE: &str = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const UPLOAD_BASE: &str =
    "https://androidpublisher.googleapis.com/upload/androidpublisher/v3";
const GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const SCOPE: &str = "https://www.googleapis.com/auth/androidpublisher";

// ── Types ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ServiceAccount {
    client_email: String,
    private_key: String,
    #[serde(default = "default_token_uri")]
    token_uri: String,
}

fn default_token_uri() -> String {
    "https://oauth2.googleapis.com/token".to_string()
}

#[derive(Serialize, Deserialize)]
struct DraftState {
    edit_id: String,
    version_code: Option<i64>,
    release_notes: Vec<Note>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Note {
    language: String,
    text: String,
}

// ── Auth ─────────────────────────────────────────────────────────────────────

fn load_service_account() -> Result<ServiceAccount> {
    let key_file = std::env::var("GOOGLE_PLAY_KEY_FILE").ok();
    let key_json = std::env::var("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON").ok();

    let content = if let Some(path) = key_file {
        if std::path::Path::new(&path).exists() {
            std::fs::read_to_string(&path)
                .with_context(|| format!("Failed to read key file: {}", path))?
        } else {
            anyhow::bail!("GOOGLE_PLAY_KEY_FILE not found: {}", path);
        }
    } else if let Some(json) = key_json {
        json
    } else {
        anyhow::bail!(
            "Google Play: missing credentials.\n\
             Set GOOGLE_PLAY_KEY_FILE (path to service account JSON)\n\
             or GOOGLE_PLAY_SERVICE_ACCOUNT_JSON (service account JSON contents)."
        );
    };

    serde_json::from_str(&content).context("Failed to parse service account JSON")
}

fn get_token(sa: &ServiceAccount) -> Result<String> {
    let now = jwt::now_secs();
    let payload = json!({
        "iss": sa.client_email,
        "sub": sa.client_email,
        "aud": sa.token_uri,
        "scope": SCOPE,
        "iat": now,
        "exp": now + 3600,
    });

    let assertion = jwt::create_rs256(&sa.private_key, &payload)?;

    let resp: serde_json::Value = client()
        .post(&sa.token_uri)
        .form(&[("grant_type", GRANT_TYPE), ("assertion", &assertion)])
        .send()
        .context("Failed to request Google access token")?
        .error_for_status()
        .context("Google token endpoint returned error")?
        .json()
        .context("Failed to parse access token response")?;

    resp["access_token"]
        .as_str()
        .map(|s| s.to_string())
        .context("Google Play: no access_token in response")
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::new()
}

fn get(url: &str, token: &str) -> Result<serde_json::Value> {
    client()
        .get(url)
        .bearer_auth(token)
        .send()
        .with_context(|| format!("GET {}", url))?
        .error_for_status()
        .with_context(|| format!("GET {} failed", url))?
        .json()
        .context("Failed to parse JSON response")
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
    resp.error_for_status()
        .with_context(|| format!("POST {} failed", url))?
        .json()
        .context("Failed to parse JSON response")
}

fn put(url: &str, token: &str, body: &serde_json::Value) -> Result<serde_json::Value> {
    client()
        .put(url)
        .bearer_auth(token)
        .json(body)
        .send()
        .with_context(|| format!("PUT {}", url))?
        .error_for_status()
        .with_context(|| format!("PUT {} failed", url))?
        .json()
        .context("Failed to parse JSON response")
}

fn delete(url: &str, token: &str) -> Result<()> {
    client()
        .delete(url)
        .bearer_auth(token)
        .send()
        .with_context(|| format!("DELETE {}", url))?
        .error_for_status()
        .with_context(|| format!("DELETE {} failed", url))?;
    Ok(())
}

fn create_edit(package: &str, token: &str) -> Result<String> {
    let resp = post(
        &format!("{}/applications/{}/edits", BASE, package),
        token,
        None,
    )?;
    resp["id"]
        .as_str()
        .map(|s| s.to_string())
        .context("Edit response missing 'id'")
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn upload(package: &str, file_path: &str) -> Result<()> {
    let path = std::path::Path::new(file_path);
    if !path.exists() {
        anyhow::bail!("File not found: {}", file_path);
    }

    let sa = load_service_account()?;
    let token = get_token(&sa)?;
    let edit_id = create_edit(package, &token)?;
    let file_type = if file_path.to_lowercase().ends_with(".aab") {
        "bundles"
    } else {
        "apks"
    };
    let file_size = std::fs::metadata(file_path)?.len();

    // Step 1: initiate resumable upload → get session URI from Location header
    let upload_url = format!(
        "{}/applications/{}/edits/{}/{}?uploadType=resumable",
        UPLOAD_BASE, package, edit_id, file_type
    );
    let init_resp = client()
        .post(&upload_url)
        .bearer_auth(&token)
        .header("X-Upload-Content-Type", "application/octet-stream")
        .header("X-Upload-Content-Length", file_size.to_string())
        .header("Content-Type", "application/json")
        .header("Content-Length", "0")
        .send()
        .context("Failed to initiate resumable upload")?;

    if !init_resp.status().is_success() {
        let status = init_resp.status();
        let text = init_resp.text().unwrap_or_default();
        anyhow::bail!("Upload initiation failed {}: {}", status, text);
    }

    let session_uri = init_resp
        .headers()
        .get("location")
        .context("Upload initiation response missing Location header")?
        .to_str()
        .context("Location header is not valid UTF-8")?
        .to_string();

    // Step 2: upload file content
    let file_bytes = std::fs::read(file_path).context("Failed to read file")?;
    let upload_resp = client()
        .put(&session_uri)
        .header("Content-Type", "application/octet-stream")
        .header("Content-Length", file_size.to_string())
        .body(file_bytes)
        .send()
        .context("Failed to upload file")?;

    if !upload_resp.status().is_success() {
        let status = upload_resp.status();
        let text = upload_resp.text().unwrap_or_default();
        let _ = delete(
            &format!("{}/applications/{}/edits/{}", BASE, package, edit_id),
            &token,
        );
        anyhow::bail!("Upload failed {}: {}", status, text);
    }

    let data: serde_json::Value = upload_resp
        .json()
        .context("Failed to parse upload response")?;
    let version_code = data["versionCode"].as_i64();

    draft::save(
        "google-play",
        package,
        &DraftState {
            edit_id,
            version_code,
            release_notes: vec![],
        },
    )?;

    println!(
        "Uploaded to Google Play. Version code: {}\nDraft open — call 'store set-notes' and 'store submit' to publish.",
        version_code.unwrap_or(0)
    );
    Ok(())
}

pub fn set_notes(package: &str, language: &str, text: &str) -> Result<()> {
    if text.len() > 500 {
        anyhow::bail!("Release notes exceed 500 characters ({})", text.len());
    }
    let mut state: DraftState = draft::load("google-play", package)?;
    upsert_note(&mut state.release_notes, language, text);
    draft::save("google-play", package, &state)?;
    println!("Release notes set for {} ({}/500 chars)", language, text.len());
    Ok(())
}

pub fn submit(package: &str, track: &str, rollout: f64) -> Result<()> {
    let state: DraftState = draft::load("google-play", package)?;
    let version_code = state
        .version_code
        .context("No version code in draft. Run 'store upload' first.")?;

    let sa = load_service_account()?;
    let token = get_token(&sa)?;
    let is_partial = rollout < 1.0;

    let mut release = json!({
        "versionCodes": [version_code.to_string()],
        "status": if is_partial { "inProgress" } else { "completed" },
        "releaseNotes": state.release_notes.iter()
            .map(|n| json!({"language": n.language, "text": n.text}))
            .collect::<Vec<_>>(),
    });
    if is_partial {
        release["userFraction"] = json!(rollout);
    }

    put(
        &format!(
            "{}/applications/{}/edits/{}/tracks/{}",
            BASE, package, state.edit_id, track
        ),
        &token,
        &json!({ "track": track, "releases": [release] }),
    )?;

    post(
        &format!(
            "{}/applications/{}/edits/{}:commit",
            BASE, package, state.edit_id
        ),
        &token,
        None,
    )?;

    draft::delete("google-play", package);
    let pct = if rollout >= 1.0 {
        "100%".to_string()
    } else {
        format!("{:.0}%", rollout * 100.0)
    };
    println!("Published to {} track ({} rollout)", track, pct);
    Ok(())
}

pub fn promote(package: &str, from_track: &str, to_track: &str) -> Result<()> {
    let sa = load_service_account()?;
    let token = get_token(&sa)?;
    let edit_id = create_edit(package, &token)?;

    let result = (|| -> Result<()> {
        let data = get(
            &format!(
                "{}/applications/{}/edits/{}/tracks/{}",
                BASE, package, edit_id, from_track
            ),
            &token,
        )?;

        let releases = data["releases"]
            .as_array()
            .context("No releases field in track response")?;
        let release = releases
            .first()
            .with_context(|| format!("No releases on track '{}'", from_track))?;
        let version_codes = release["versionCodes"]
            .as_array()
            .filter(|v| !v.is_empty())
            .with_context(|| format!("No version codes on track '{}'", from_track))?
            .clone();

        put(
            &format!(
                "{}/applications/{}/edits/{}/tracks/{}",
                BASE, package, edit_id, to_track
            ),
            &token,
            &json!({
                "track": to_track,
                "releases": [{
                    "versionCodes": version_codes,
                    "status": "completed",
                    "releaseNotes": release["releaseNotes"],
                }]
            }),
        )?;

        post(
            &format!(
                "{}/applications/{}/edits/{}:commit",
                BASE, package, edit_id
            ),
            &token,
            None,
        )?;
        Ok(())
    })();

    if result.is_err() {
        let _ = delete(
            &format!("{}/applications/{}/edits/{}", BASE, package, edit_id),
            &token,
        );
    }
    result?;
    println!("Promoted: {} → {}", from_track, to_track);
    Ok(())
}

pub fn get_releases(package: &str, track: Option<&str>) -> Result<()> {
    let sa = load_service_account()?;
    let token = get_token(&sa)?;
    let edit_id = create_edit(package, &token)?;

    let result = (|| -> Result<()> {
        let tracks: Vec<&str> = if let Some(t) = track {
            vec![t]
        } else {
            vec!["internal", "alpha", "beta", "production"]
        };

        let mut lines: Vec<String> = vec![];
        for t in &tracks {
            match get(
                &format!(
                    "{}/applications/{}/edits/{}/tracks/{}",
                    BASE, package, edit_id, t
                ),
                &token,
            ) {
                Ok(data) => {
                    if let Some(r) = data["releases"].as_array().and_then(|v| v.first()) {
                        let versions = r["versionCodes"]
                            .as_array()
                            .map(|v| {
                                v.iter()
                                    .filter_map(|x| x.as_str())
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            })
                            .unwrap_or_else(|| "?".to_string());
                        let status = r["status"].as_str().unwrap_or("unknown");
                        let fraction = r["userFraction"]
                            .as_f64()
                            .map(|f| format!(" ({:.0}% rollout)", f * 100.0))
                            .unwrap_or_default();
                        lines.push(format!("{}: v{} — {}{}", t, versions, status, fraction));
                    }
                }
                Err(_) if track.is_none() => {} // silently skip empty tracks when listing all
                Err(e) => return Err(e),
            }
        }

        if lines.is_empty() {
            println!("No releases found");
        } else {
            println!("{}", lines.join("\n"));
        }
        Ok(())
    })();

    // Always clean up the temporary edit
    let _ = delete(
        &format!("{}/applications/{}/edits/{}", BASE, package, edit_id),
        &token,
    );
    result
}

pub fn halt_rollout(package: &str, track: &str) -> Result<()> {
    let sa = load_service_account()?;
    let token = get_token(&sa)?;
    let edit_id = create_edit(package, &token)?;

    let result = (|| -> Result<()> {
        let data = get(
            &format!(
                "{}/applications/{}/edits/{}/tracks/{}",
                BASE, package, edit_id, track
            ),
            &token,
        )?;

        let release = data["releases"]
            .as_array()
            .and_then(|v| v.first())
            .with_context(|| format!("No active release on track '{}'", track))?;

        if release["status"].as_str() != Some("inProgress") {
            anyhow::bail!(
                "Track '{}' is not in staged rollout (status: {})",
                track,
                release["status"].as_str().unwrap_or("unknown")
            );
        }

        put(
            &format!(
                "{}/applications/{}/edits/{}/tracks/{}",
                BASE, package, edit_id, track
            ),
            &token,
            &json!({
                "track": track,
                "releases": [{ "versionCodes": release["versionCodes"], "status": "halted" }]
            }),
        )?;

        post(
            &format!(
                "{}/applications/{}/edits/{}:commit",
                BASE, package, edit_id
            ),
            &token,
            None,
        )?;
        Ok(())
    })();

    if result.is_err() {
        let _ = delete(
            &format!("{}/applications/{}/edits/{}", BASE, package, edit_id),
            &token,
        );
    }
    result?;
    println!("Rollout halted on {} track", track);
    Ok(())
}

pub fn discard(package: &str) -> Result<()> {
    let state: DraftState = draft::load("google-play", package)?;
    let sa = load_service_account()?;
    let token = get_token(&sa)?;
    let _ = delete(
        &format!("{}/applications/{}/edits/{}", BASE, package, state.edit_id),
        &token,
    );
    draft::delete("google-play", package);
    println!("Release draft discarded for {}", package);
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
