use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Serialize, Deserialize)]
pub struct TestCase {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub priority: String,
    pub tags: Vec<String>,
    pub author: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linked_feature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_status: Option<String>,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preconditions: Option<Vec<String>>,
    pub steps: Vec<Step>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Step {
    pub action: String,
    pub expected: String,
}

fn parse_testcase(content: &str) -> Result<TestCase> {
    let tc: TestCase =
        serde_yaml::from_str(content).context("Failed to parse YAML test case")?;
    validate_testcase(&tc)?;
    Ok(tc)
}

fn validate_testcase(tc: &TestCase) -> Result<()> {
    if tc.id.trim().is_empty() {
        bail!("id must not be empty");
    }
    if tc.name.trim().is_empty() {
        bail!("name must not be empty");
    }
    if tc.platform.trim().is_empty() {
        bail!("platform must not be empty");
    }
    if tc.description.trim().is_empty() {
        bail!("description must not be empty");
    }
    let valid = ["critical", "high", "medium", "low"];
    if !valid.contains(&tc.priority.to_lowercase().as_str()) {
        bail!(
            "priority must be one of: {}",
            valid.join(", ")
        );
    }
    if tc.steps.is_empty() {
        bail!("steps must not be empty");
    }
    for (i, step) in tc.steps.iter().enumerate() {
        if step.action.trim().is_empty() {
            bail!("Step {}: action must not be empty", i + 1);
        }
        if step.expected.trim().is_empty() {
            bail!("Step {}: expected must not be empty", i + 1);
        }
    }
    Ok(())
}

pub fn save_testcase(dir: &str, filename: &str, content: &str) -> Result<()> {
    let _ = parse_testcase(content)?;

    let dir_path = Path::new(dir);
    if !dir_path.exists() {
        fs::create_dir_all(dir_path).context("Failed to create directory")?;
    }

    let safe_name = if filename.ends_with(".yaml") || filename.ends_with(".yml") {
        filename.to_string()
    } else {
        format!("{}.yaml", filename)
    };

    let full_path = dir_path.join(&safe_name);
    fs::write(&full_path, content).context("Failed to write test case file")?;

    println!("Saved: {}", full_path.display());
    Ok(())
}

pub fn list_testcases(dir: &str, platform: Option<&str>) -> Result<()> {
    let dir_path = Path::new(dir);
    if !dir_path.exists() {
        println!("No test cases found.");
        return Ok(());
    }

    let mut count = 0u32;
    let mut entries: Vec<_> = fs::read_dir(dir_path)
        .context("Failed to read directory")?
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.ends_with(".yaml") || name.ends_with(".yml")
        })
        .collect();

    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let content = match fs::read_to_string(entry.path()) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let tc = match parse_testcase(&content) {
            Ok(tc) => tc,
            Err(_) => continue,
        };

        if let Some(pf) = platform {
            if tc.platform.to_lowercase() != pf.to_lowercase() {
                continue;
            }
        }

        println!(
            "  {} | {} | {} | {} | [{}]",
            tc.id,
            tc.name,
            tc.platform,
            tc.priority,
            tc.tags.join(", ")
        );
        count += 1;
    }

    if count == 0 {
        println!("No test cases found.");
    } else {
        eprintln!("Total: {} test case(s)", count);
    }
    Ok(())
}

pub fn get_testcase(path: &str) -> Result<()> {
    let content = fs::read_to_string(path)
        .with_context(|| format!("File not found: {}", path))?;
    let tc = parse_testcase(&content)?;

    println!("--- Metadata ---");
    println!("ID: {}", tc.id);
    println!("Name: {}", tc.name);
    println!("Platform: {}", tc.platform);
    println!("Priority: {}", tc.priority);
    println!("Steps: {}", tc.steps.len());
    println!();
    println!("--- YAML ---");
    print!("{}", content);
    Ok(())
}

pub fn delete_testcase(path: &str) -> Result<()> {
    if !Path::new(path).exists() {
        bail!("File not found: {}", path);
    }
    fs::remove_file(path).with_context(|| format!("Failed to delete: {}", path))?;
    println!("Deleted: {}", path);
    Ok(())
}

pub fn run_testcase(path: &str) -> Result<()> {
    let content = fs::read_to_string(path)
        .with_context(|| format!("File not found: {}", path))?;
    let tc = parse_testcase(&content)?;

    println!(
        "Execute test case: {} — {}\nPlatform: {}\nSteps: {}\n",
        tc.id, tc.name, tc.platform, tc.steps.len()
    );
    print!("{}", content);
    Ok(())
}

pub fn run_suite(dir: &str, ids: &[String], report_path: Option<&str>) -> Result<()> {
    let dir_path = Path::new(dir);
    if !dir_path.exists() {
        bail!("Directory not found: {}", dir);
    }

    let mut entries: Vec<_> = fs::read_dir(dir_path)
        .context("Failed to read directory")?
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.ends_with(".yaml") || name.ends_with(".yml")
        })
        .collect();

    entries.sort_by_key(|e| e.file_name());

    #[derive(Serialize)]
    struct SuiteEntry {
        id: String,
        name: String,
        content: String,
    }

    let mut suite: Vec<SuiteEntry> = Vec::new();

    for id in ids {
        for entry in &entries {
            let content = match fs::read_to_string(entry.path()) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let tc = match parse_testcase(&content) {
                Ok(tc) => tc,
                Err(_) => continue,
            };
            if tc.id == *id {
                suite.push(SuiteEntry {
                    id: tc.id,
                    name: entry.file_name().to_string_lossy().to_string(),
                    content,
                });
                break;
            }
        }
    }

    if suite.is_empty() {
        println!("No test cases matched IDs: {}", ids.join(", "));
        return Ok(());
    }

    let json = serde_json::to_string_pretty(&suite)?;

    if let Some(rp) = report_path {
        println!(
            "Suite loaded ({} test cases). Report will be saved to: {}",
            suite.len(),
            rp
        );
    } else {
        println!("Suite loaded ({} test cases):", suite.len());
    }
    println!();
    println!("{}", json);

    Ok(())
}
