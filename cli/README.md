# claude-in-mobile CLI

Fast native Rust CLI for mobile device automation. Standalone binary alternative to MCP server — no Node.js required, instant startup.

## Install

### Homebrew (macOS ARM64)

```bash
brew tap AlexGladkov/claude-in-mobile-homebrew https://github.com/AlexGladkov/claude-in-mobile-homebrew
brew install claude-in-mobile
```

### From release binary

Download from [Releases](https://github.com/AlexGladkov/claude-in-mobile/releases):

```bash
# macOS ARM64 (Apple Silicon)
tar -xzf claude-in-mobile-2.9.0-darwin-arm64.tar.gz
cp claude-in-mobile /usr/local/bin/

# macOS x86_64 (Intel)
tar -xzf claude-in-mobile-2.9.0-darwin-x86_64.tar.gz
cp claude-in-mobile /usr/local/bin/

# Linux x86_64
tar -xzf claude-in-mobile-2.9.0-linux-x86_64.tar.gz
sudo cp claude-in-mobile /usr/local/bin/
```

### From source

```bash
cd cli
cargo build --release
cp target/release/claude-in-mobile /usr/local/bin/
```

Verify:

```bash
claude-in-mobile --version
claude-in-mobile --help
```

---

## Claude Code Plugin Setup

The `plugin/` directory contains a Claude Code skill that enables natural language control of mobile devices.

### Installation

```bash
# Install plugin globally
claude plugin add /path/to/cli/plugin

# Or link to specific project
ln -s /path/to/cli/plugin ~/.claude/plugins/claude-in-mobile
```

### What it enables

After installing the plugin, Claude Code can:

- Take screenshots and annotate UI elements
- Tap, swipe, type text on device screens
- Launch/stop apps, install/uninstall packages
- Read logs, get system info, manage clipboard
- Run shell commands on devices

**Example prompts:**

```
"Take a screenshot of the Android emulator"
"Tap the Login button"
"Type 'hello@example.com' into the email field"
"Swipe up to scroll"
"Launch com.example.app on Android"
"Show me the last 50 lines of iOS simulator logs"
```

### Requirements

- `claude-in-mobile` binary in PATH
- Platform tools:
  - **Android**: `adb` in PATH
  - **iOS**: Xcode with `simctl`
  - **Aurora**: `audb` in PATH
  - **Desktop**: companion app configured

---

## What You Get

### Unified CLI for All Platforms

One binary — four platforms. Same commands work across Android, iOS, Aurora OS, and Desktop:

```bash
claude-in-mobile screenshot android -o screen.png
claude-in-mobile screenshot ios -o screen.png
claude-in-mobile tap android 500 800
claude-in-mobile tap ios 500 800
```

### Test Automation with Shell Scripts

Write reusable test scenarios as plain shell scripts — no frameworks, no setup:

```bash
#!/bin/bash
# login-test.sh — smoke test for login flow

APP="com.example.app"
claude-in-mobile launch android "$APP"
claude-in-mobile wait 2000

# Enter credentials
claude-in-mobile tap android 0 0 --text "Email"
claude-in-mobile input android "test@example.com"
claude-in-mobile tap android 0 0 --text "Password"
claude-in-mobile input android "secret123"
claude-in-mobile tap android 0 0 --text "Sign In"
claude-in-mobile wait 3000

# Verify login succeeded
claude-in-mobile screenshot android -o result.png
claude-in-mobile ui-dump android | grep "Welcome"
EXIT_CODE=$?

claude-in-mobile stop android "$APP"
exit $EXIT_CODE
```

Run on CI:

```bash
./login-test.sh && echo "PASS" || echo "FAIL"
```

### Visual Regression Testing

```bash
# Take baseline
claude-in-mobile screenshot android --compress -o baseline.png

# ... run actions ...

# Take current state
claude-in-mobile screenshot android --compress -o current.png

# Compare (with imagemagick or any diff tool)
compare baseline.png current.png diff.png
```

### Annotated Screenshots for Bug Reports

```bash
# Screenshot with bounding boxes around all UI elements
claude-in-mobile annotate android -o annotated.png

# Structured JSON of all interactive elements
claude-in-mobile analyze-screen
```

### Device Farm Scripts

```bash
# Run same test on all connected devices
for device in $(claude-in-mobile devices android | grep -o 'emulator-[0-9]*'); do
  echo "Testing on $device..."
  claude-in-mobile screenshot android --device "$device" -o "screen-$device.png"
  claude-in-mobile tap android 500 800 --device "$device"
done
```

### Log Collection and Debugging

```bash
# Capture logs during test execution
claude-in-mobile clear-logs android
./run-test.sh
claude-in-mobile logs android -l 500 --package com.example.app -o crash-logs.txt
```

### Claude Code Integration

With the plugin installed, Claude Code can control devices using natural language:

```
"Open the app and take a screenshot"
"Find the Submit button and tap it"
"Type the test email and check what happens"
"Scroll down and find the error message"
```

Claude reads SKILL.md only when needed — no token overhead in sessions where you don't use mobile automation.

---

## CLI vs MCP Server

| Feature | CLI (`claude-in-mobile`) | MCP Server |
|---------|--------------------------|------------|
| **Startup time** | ~5ms (native binary) | ~500ms (Node.js spawn) |
| **Dependencies** | None (static binary) | Node.js, npm packages |
| **Installation** | Single file copy | `npm install` |
| **Scriptable** | Yes (stdout/stderr, exit codes) | No (requires MCP client) |
| **CI/CD friendly** | Yes | Limited |
| **Offline use** | Yes | Requires MCP connection |
| **Claude Code integration** | Via plugin/skill | Native MCP tools |

**When to use CLI:**
- Shell scripts, CI/CD pipelines
- Quick one-off commands
- Environments without Node.js
- Maximum performance

**When to use MCP:**
- Already using MCP infrastructure
- Need real-time streaming responses
- Prefer MCP tool discovery

---

## Building Release Binaries

### Prerequisites

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Add cross-compilation targets
rustup target add x86_64-apple-darwin
rustup target add aarch64-apple-darwin
rustup target add x86_64-unknown-linux-musl
```

For Linux cross-compilation on macOS, install musl toolchain:

```bash
brew install filosottile/musl-cross/musl-cross
```

### Build for all platforms

```bash
cd cli

# macOS ARM64 (Apple Silicon)
cargo build --release --target aarch64-apple-darwin
tar -czvf claude-in-mobile-VERSION-darwin-arm64.tar.gz \
  -C target/aarch64-apple-darwin/release claude-in-mobile

# macOS x86_64 (Intel)
cargo build --release --target x86_64-apple-darwin
tar -czvf claude-in-mobile-VERSION-darwin-x86_64.tar.gz \
  -C target/x86_64-apple-darwin/release claude-in-mobile

# Linux x86_64 (static musl)
CC_x86_64_unknown_linux_musl=x86_64-linux-musl-gcc \
cargo build --release --target x86_64-unknown-linux-musl
tar -czvf claude-in-mobile-VERSION-linux-x86_64.tar.gz \
  -C target/x86_64-unknown-linux-musl/release claude-in-mobile
```

### Calculate SHA256 (for Homebrew)

```bash
shasum -a 256 claude-in-mobile-VERSION-darwin-arm64.tar.gz
shasum -a 256 claude-in-mobile-VERSION-darwin-x86_64.tar.gz
shasum -a 256 claude-in-mobile-VERSION-linux-x86_64.tar.gz
```

### Release checklist

1. Update version in `Cargo.toml`
2. Build binaries for all platforms
3. Create GitHub Release with tag `release-VERSION`
4. Upload `.tar.gz` files as release assets
5. Update Homebrew formula with new version and SHA256 hashes

---

## Supported Platforms

| Platform | Backend | Device Selection |
|----------|---------|------------------|
| **Android** | ADB | `--device <serial>` |
| **iOS** | simctl | `--simulator <name>` |
| **Aurora OS** | audb | `--device <serial>` |
| **Desktop** | companion app | `--companion-path <path>` |

---

## Commands (38 total)

Run `claude-in-mobile --help` for full list.

| Category | Commands |
|----------|----------|
| Screenshot | `screenshot`, `annotate`, `analyze-screen` |
| Gestures | `tap`, `long-press`, `swipe`, `find-and-tap` |
| Text | `input`, `key` |
| UI | `ui-dump`, `find`, `tap-text` |
| Apps | `launch`, `stop`, `install`, `uninstall`, `apps` |
| Files | `push-file`, `pull-file` |
| Clipboard | `get-clipboard`, `set-clipboard` |
| System | `logs`, `clear-logs`, `system-info`, `devices`, `reboot`, `screen`, `screen-size` |
| Desktop | `launch-desktop-app`, `stop-desktop-app`, `get-window-info`, `focus-window`, `resize-window`, `get-monitors`, `get-performance-metrics` |
| Other | `shell`, `open-url`, `wait`, `current-activity` |

See `plugin/skills/claude-in-mobile/SKILL.md` for detailed command documentation.
