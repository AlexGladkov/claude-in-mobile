//! `doctor` command — checks all tool dependencies and prints green/red status.
//!
//! # Example output
//!
//! ```text
//! Claude Mobile Doctor
//! ====================
//!
//! Android:
//!   ✓ adb found: /usr/local/bin/adb (version 34.0.5)
//!   ✗ ANDROID_HOME not set
//! ```

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::Result;

// ── ANSI colour helpers ───────────────────────────────────────────────────────

const GREEN: &str = "\x1b[32m";
const RED: &str = "\x1b[31m";
const BOLD: &str = "\x1b[1m";
const RESET: &str = "\x1b[0m";

fn ok(msg: &str) {
    println!("  {GREEN}✓{RESET} {msg}");
}

fn fail(msg: &str) {
    println!("  {RED}✗{RESET} {msg}");
}

fn section(title: &str) {
    println!("\n{BOLD}{title}:{RESET}");
}

// ── Utility helpers ───────────────────────────────────────────────────────────

/// Run a command and capture its combined stdout, returning `None` on failure.
fn run_output(program: &str, args: &[&str]) -> Option<String> {
    Command::new(program)
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
}

/// Run a command, returning `true` if it exits with status 0.
fn run_ok(program: &str, args: &[&str]) -> bool {
    Command::new(program)
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Locate a binary by trying `which` / `where` (cross-platform).
fn which(binary: &str) -> Option<PathBuf> {
    // Check explicit env-var overrides first.
    let env_candidates: &[&str] = match binary {
        "adb" => &["ADB_PATH"],
        "java" => &["JAVA_HOME"],
        _ => &[],
    };
    for var in env_candidates {
        if let Ok(val) = env::var(var) {
            let p = PathBuf::from(&val);
            // JAVA_HOME points to the JDK root, not the binary.
            let candidate = if binary == "java" && p.is_dir() {
                p.join("bin").join("java")
            } else {
                p.clone()
            };
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    // Standard PATH search.
    #[cfg(target_os = "windows")]
    let finder = run_output("where", &[binary]);
    #[cfg(not(target_os = "windows"))]
    let finder = run_output("which", &[binary]);

    finder.map(|s| PathBuf::from(s.lines().next().unwrap_or("").trim()))
}

/// Resolve a path string and check if it exists (used for env-var path checks).
fn env_path_exists(var: &str) -> Option<PathBuf> {
    env::var(var).ok().map(PathBuf::from).filter(|p| p.exists())
}

// ── Per-platform checks ───────────────────────────────────────────────────────

/// Returns `true` if all *critical* Android checks pass.
fn check_android() -> bool {
    section("Android");
    let mut all_ok = true;

    // adb
    if let Some(adb) = which("adb") {
        let version = run_output(adb.to_str().unwrap_or("adb"), &["version"])
            .unwrap_or_default()
            .lines()
            .next()
            .map(|l| {
                // "Android Debug Bridge version X.Y.Z" → extract version number
                l.split_whitespace().last().unwrap_or("?").to_owned()
            })
            .unwrap_or_else(|| "?".to_owned());
        ok(&format!("adb found: {} (version {})", adb.display(), version));
    } else {
        fail("adb not found — install Android SDK platform-tools");
        all_ok = false;
    }

    // ANDROID_HOME / ANDROID_SDK_ROOT
    if let Some(p) = env_path_exists("ANDROID_HOME").or_else(|| env_path_exists("ANDROID_SDK_ROOT")) {
        ok(&format!("ANDROID_HOME set: {}", p.display()));
    } else {
        fail("ANDROID_HOME not set");
        // Not critical enough to fail the whole run, but flag it.
    }

    all_ok
}

/// Returns `true` if all *critical* iOS checks pass.
#[cfg(target_os = "macos")]
fn check_ios() -> bool {
    section("iOS");
    let mut all_ok = true;

    // Xcode via xcode-select -p
    if let Some(xcode_path) = run_output("xcode-select", &["-p"]) {
        // Extract Xcode version from `xcodebuild -version`
        let version = run_output("xcodebuild", &["-version"])
            .unwrap_or_default()
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().last().map(str::to_owned))
            .unwrap_or_else(|| "?".to_owned());
        ok(&format!(
            "Xcode installed: {} (path: {})",
            version, xcode_path
        ));
    } else {
        fail("Xcode not found — install from App Store or run xcode-select --install");
        all_ok = false;
    }

    // xcrun simctl
    if run_ok("xcrun", &["simctl", "list", "--json"]) {
        ok("xcrun simctl available");
    } else {
        fail("xcrun simctl not available — check Xcode installation");
        all_ok = false;
    }

    // Appium (optional but reported)
    if let Some(appium) = which("appium") {
        let version = run_output(appium.to_str().unwrap_or("appium"), &["--version"])
            .unwrap_or_else(|| "?".to_owned());
        ok(&format!("Appium found: {} ({})", appium.display(), version.trim()));
    } else {
        fail("Appium not found — install: npm install -g appium");
        // Appium is optional for basic screenshot/tap flows; don't set all_ok = false
    }

    // WebDriverAgent (WDA_PATH env or Appium xcuitest driver)
    if let Some(wda) = env_path_exists("WDA_PATH") {
        ok(&format!("WebDriverAgent found: {}", wda.display()));
    } else {
        // Check if xcuitest driver is installed via appium
        let xcuitest_ok = run_output("appium", &["driver", "list", "--installed"])
            .map(|out| out.contains("xcuitest"))
            .unwrap_or(false);
        if xcuitest_ok {
            ok("WebDriverAgent (xcuitest driver) installed via Appium");
        } else {
            fail("WebDriverAgent not found — install: appium driver install xcuitest");
        }
    }

    all_ok
}

#[cfg(not(target_os = "macos"))]
fn check_ios() -> bool {
    section("iOS");
    fail("iOS checks only available on macOS");
    false
}

/// Returns `true` if all *critical* Desktop checks pass.
fn check_desktop() -> bool {
    section("Desktop");
    let mut all_ok = true;

    // JDK — try JAVA_HOME first, then `java` on PATH
    let java_found = if let Ok(java_home) = env::var("JAVA_HOME") {
        let java_bin = Path::new(&java_home).join("bin").join("java");
        if java_bin.exists() {
            let version = run_output(java_bin.to_str().unwrap_or("java"), &["-version"])
                .or_else(|| {
                    // java -version writes to stderr on many JDKs
                    Command::new(&java_bin)
                        .arg("-version")
                        .output()
                        .ok()
                        .map(|o| String::from_utf8_lossy(&o.stderr).trim().to_owned())
                })
                .unwrap_or_default();
            let ver_line = version.lines().next().unwrap_or("?");
            ok(&format!("JDK found: {} ({})", java_home, ver_line));
            true
        } else {
            false
        }
    } else {
        false
    };

    if !java_found {
        // Fall back to `java` on PATH
        if let Some(java) = which("java") {
            let version = Command::new(&java)
                .arg("-version")
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stderr).trim().to_owned())
                .unwrap_or_default();
            let ver_line = version.lines().next().unwrap_or("?");
            ok(&format!("JDK found: {} ({})", java.display(), ver_line));
        } else {
            fail("JDK not found — install JDK 17+ and set JAVA_HOME");
            all_ok = false;
        }
    }

    // Desktop companion binary (desktop-companion or companion JAR)
    let companion_found = which("desktop-companion").is_some()
        || env::var("COMPANION_PATH")
            .map(|p| Path::new(&p).exists())
            .unwrap_or(false);

    if companion_found {
        let path = which("desktop-companion")
            .map(|p| p.display().to_string())
            .or_else(|| env::var("COMPANION_PATH").ok())
            .unwrap_or_else(|| "?".to_owned());
        ok(&format!("Desktop companion built: {}", path));
    } else {
        fail("Desktop companion not found — run: ./gradlew :desktop-companion:installDist");
        all_ok = false;
    }

    all_ok
}

/// Returns `true` if all *critical* Aurora checks pass.
fn check_aurora() -> bool {
    section("Aurora");
    let mut all_ok = true;

    // audb (Aurora debug bridge, analogous to adb)
    if let Some(audb) = which("audb").or_else(|| which("audb-client")) {
        let version = run_output(audb.to_str().unwrap_or("audb"), &["version"])
            .or_else(|| run_output(audb.to_str().unwrap_or("audb"), &["--version"]))
            .unwrap_or_else(|| "?".to_owned());
        ok(&format!(
            "audb found: {} ({})",
            audb.display(),
            version.trim()
        ));
    } else {
        fail("audb-client not found — install: cargo install audb-client");
        all_ok = false;
    }

    all_ok
}

/// Returns `true` if all *critical* Browser checks pass.
fn check_browser() -> bool {
    section("Browser");
    let mut all_ok = true;

    // Chrome — check CHROME_PATH env, common install paths, then `google-chrome` / `chromium`
    let chrome = find_chrome();
    if let Some(path) = chrome {
        ok(&format!("Chrome found: {}", path.display()));
    } else {
        fail("Chrome not found — install Google Chrome or set CHROME_PATH");
        all_ok = false;
    }

    all_ok
}

fn find_chrome() -> Option<PathBuf> {
    // Explicit env override
    if let Ok(p) = env::var("CHROME_PATH") {
        let pb = PathBuf::from(&p);
        if pb.exists() {
            return Some(pb);
        }
    }

    // Well-known macOS locations
    #[cfg(target_os = "macos")]
    {
        let macos_paths = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ];
        for p in &macos_paths {
            let pb = PathBuf::from(p);
            if pb.exists() {
                // Return the .app bundle path for display clarity
                let app = pb
                    .ancestors()
                    .find(|a| a.extension().map(|e| e == "app").unwrap_or(false))
                    .map(Path::to_path_buf)
                    .unwrap_or(pb);
                return Some(app);
            }
        }
    }

    // Linux / Windows binary names
    for bin in &["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"] {
        if let Some(p) = which(bin) {
            return Some(p);
        }
    }

    None
}

// ── Public entry point ────────────────────────────────────────────────────────

/// Run all dependency checks and return exit code 0 on full success, 1 otherwise.
pub fn run() -> Result<()> {
    println!("{BOLD}Claude Mobile Doctor{RESET}");
    println!("====================");

    let android_ok = check_android();
    let ios_ok = check_ios();
    let desktop_ok = check_desktop();
    let aurora_ok = check_aurora();
    let browser_ok = check_browser();

    println!();

    if android_ok && ios_ok && desktop_ok && aurora_ok && browser_ok {
        println!("{GREEN}All critical dependencies found.{RESET}");
        Ok(())
    } else {
        println!("{RED}Some dependencies are missing. See above for details.{RESET}");
        // Use process::exit so that the exit code propagates correctly without
        // wrapping a fabricated error in the anyhow chain.
        std::process::exit(1);
    }
}
