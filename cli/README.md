# mcp-devices native CLI

Fast native Rust CLI for mobile device automation. Standalone binary alternative to MCP server — no Node.js required, instant startup.

## Install

### Homebrew (macOS)

```bash
brew install AlexGladkov/tap/mcp-devices
```

### From release binary

Download from [Releases](https://github.com/AlexGladkov/claude-in-mobile/releases):

```bash
# macOS ARM64 (Apple Silicon)
tar -xzf claude-in-mobile-VERSION-darwin-arm64.tar.gz
cp mcp-devices-cli /usr/local/bin/

# macOS x86_64 (Intel)
tar -xzf claude-in-mobile-VERSION-darwin-x86_64.tar.gz
cp mcp-devices-cli /usr/local/bin/

# Linux x86_64 (GNU/glibc)
tar -xzf claude-in-mobile-VERSION-linux-x86_64.tar.gz
sudo install -m 755 mcp-devices-cli /usr/local/bin/mcp-devices-cli
```

Release binaries currently support Linux x86_64 (GNU/glibc). Build from source
for other Linux architectures.

### From source

```bash
cd cli
cargo build --release
install -m 755 target/release/mcp-devices /usr/local/bin/mcp-devices-cli
```

Verify:

```bash
mcp-devices-cli --version
mcp-devices-cli --help
```

---

## Claude Code Plugin Setup

The `plugin/` directory contains a Claude Code skill that enables natural language control of mobile devices.

### Installation

```bash
# Install plugin globally
claude plugin add /path/to/cli/plugin

# Or link to specific project
ln -s /path/to/cli/plugin ~/.claude/plugins/mcp-devices
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

- `mcp-devices-cli` binary in PATH
- Platform tools:
  - **Android**: `adb` in PATH
  - **iOS**: Xcode with `simctl`
  - **Aurora**: `audb` in PATH
  - **Desktop**: companion app configured

---

## Grok Build Plugin Setup

Install from the GitHub marketplace so Grok gets the CLI skill **and** the MCP server `mobile`:

```bash
grok plugin marketplace add AlexGladkov/claude-in-mobile
grok plugin install mcp-devices --trust
```

Or copy the plugin tree into the current project / your home directory (no marketplace):

```bash
mcp-devices-cli setup grok           # .grok/plugins/mcp-devices
mcp-devices-cli setup grok --global  # ~/.grok/plugins/mcp-devices
```

Restart Grok. Project-local installs are not auto-trusted (MCP stays off until trust):

```bash
grok plugin install ./.grok/plugins/mcp-devices --trust
grok plugin enable mcp-devices
```

`--global` writes to `~/.grok/plugins/` (auto-trusted). If `mcp-devices` still does not appear, run `grok plugin enable mcp-devices`. Use `--force` to replace files that already exist and differ.

The slim `mcp-devices` package loads no platforms by default — run `mcp-devices install android` (or `all`) after install. All-in-one users can swap the MCP command to `claude-in-mobile`.

---

## Agent Skill Setup

OpenCode, Pi, Qwen Code, Gemini CLI, Codex, and Cursor can use the same `SKILL.md` command documentation without the Claude Code plugin manifest. Install the CLI first and make sure `mcp-devices-cli` is in `PATH`.

### OpenCode

Install into the current project:

```bash
mcp-devices-cli setup opencode
```

This writes:

```text
.opencode/skills/mcp-devices/SKILL.md
.opencode/skills/mcp-devices/references/platform-support.md
```

Install globally for the current user:

```bash
mcp-devices-cli setup opencode --global
```

This writes under:

```text
~/.config/opencode/skills/mcp-devices
```

If files already exist and differ, the command refuses to overwrite them. Use `--force` to replace existing skill files:

```bash
mcp-devices-cli setup opencode --global --force
```

Restart OpenCode after installation, then ask it to use the `mcp-devices` skill.

### Pi

Install into the current project:

```bash
mcp-devices-cli setup pi
```

This writes:

```text
.pi/skills/mcp-devices/SKILL.md
.pi/skills/mcp-devices/references/platform-support.md
```

Install globally for the current user:

```bash
mcp-devices-cli setup pi --global
```

This writes under:

```text
~/.pi/agent/skills/mcp-devices
```

If files already exist and differ, the command refuses to overwrite them. Use `--force` to replace existing skill files:

```bash
mcp-devices-cli setup pi --global --force
```

Restart Pi after installation, then ask it to use the `mcp-devices` skill.

### Qwen Code

```bash
mcp-devices-cli setup qwen          # .qwen/skills/mcp-devices
mcp-devices-cli setup qwen --global # ~/.qwen/skills/mcp-devices
```

Restart Qwen Code after installation, then ask it to use the `mcp-devices` skill.

### Gemini CLI

```bash
mcp-devices-cli setup gemini          # .gemini/skills/mcp-devices
mcp-devices-cli setup gemini --global # ~/.gemini/skills/mcp-devices
```

Restart Gemini CLI after installation, then ask it to use the `mcp-devices` skill.

### Codex

```bash
mcp-devices-cli setup codex          # .agents/skills/mcp-devices
mcp-devices-cli setup codex --global # ~/.agents/skills/mcp-devices
```

Restart Codex after installation, then ask it to use the `mcp-devices` skill.

### Cursor

```bash
mcp-devices-cli setup cursor          # .cursor/skills/mcp-devices
mcp-devices-cli setup cursor --global # ~/.cursor/skills/mcp-devices
```

Restart Cursor after installation, then ask Agent to use the `mcp-devices` skill.

For every setup command, if files already exist and differ, the command refuses to overwrite them. Use `--force` to replace existing skill files.

---

## MCP Setup

Use MCP when you want the Node.js MCP server and native tool calls instead of the standalone CLI skill.

### Claude Code

```bash
claude mcp add --transport stdio mobile -- npx claude-in-mobile@latest
```

### Qwen Code

Add to `.qwen/settings.json` or `~/.qwen/settings.json`:

```json
{
  "mcpServers": {
    "mobile": {
      "command": "npx",
      "args": ["-y", "claude-in-mobile"]
    }
  }
}
```

### Gemini CLI

Add to `.gemini/settings.json` or `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "mobile": {
      "command": "npx",
      "args": ["-y", "claude-in-mobile"]
    }
  }
}
```

### Codex

```bash
codex mcp add mobile -- npx -y claude-in-mobile
```

### Grok

```bash
grok mcp add mobile -- npx -y mcp-devices
```

Or add to `~/.grok/config.toml` / `.grok/config.toml`:

```toml
[mcp_servers.mobile]
command = "npx"
args = ["-y", "mcp-devices"]
```

Slim `mcp-devices` needs `mcp-devices install android` (or `all`). All-in-one users may use `claude-in-mobile` instead of `mcp-devices` in `args`.

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "mobile": {
      "command": "npx",
      "args": ["-y", "claude-in-mobile"]
    }
  }
}
```

---

## What You Get

### Unified CLI for All Platforms

One binary — five platforms. The same core commands work across Android, iOS, HarmonyOS, Aurora OS, and Desktop:

```bash
mcp-devices-cli screenshot android -o screen.png
mcp-devices-cli screenshot ios -o screen.png
mcp-devices-cli screenshot --platform harmony -o screen.png
mcp-devices-cli tap android 500 800
mcp-devices-cli tap ios 500 800
mcp-devices-cli tap --platform harmony 500 800
```

### Test Automation with Shell Scripts

Write reusable test scenarios as plain shell scripts — no frameworks, no setup:

```bash
#!/bin/bash
# login-test.sh — smoke test for login flow

APP="com.example.app"
mcp-devices-cli launch android "$APP"
mcp-devices-cli wait 2000

# Enter credentials
mcp-devices-cli tap android 0 0 --text "Email"
mcp-devices-cli input android "test@example.com"
mcp-devices-cli tap android 0 0 --text "Password"
mcp-devices-cli input android "secret123"
mcp-devices-cli tap android 0 0 --text "Sign In"
mcp-devices-cli wait 3000

# Verify login succeeded
mcp-devices-cli screenshot android -o result.png
mcp-devices-cli ui-dump android | grep "Welcome"
EXIT_CODE=$?

mcp-devices-cli stop android "$APP"
exit $EXIT_CODE
```

Run on CI:

```bash
./login-test.sh && echo "PASS" || echo "FAIL"
```

### Visual Regression Testing

```bash
# Take baseline
mcp-devices-cli screenshot android --compress -o baseline.png

# ... run actions ...

# Take current state
mcp-devices-cli screenshot android --compress -o current.png

# Compare (with imagemagick or any diff tool)
compare baseline.png current.png diff.png
```

### Annotated Screenshots for Bug Reports

```bash
# Screenshot with bounding boxes around all UI elements
mcp-devices-cli annotate android -o annotated.png

# Structured JSON of all interactive elements
mcp-devices-cli analyze-screen
```

### Device Farm Scripts

```bash
# Run same test on all connected devices
for device in $(mcp-devices-cli devices android | grep -o 'emulator-[0-9]*'); do
  echo "Testing on $device..."
  mcp-devices-cli screenshot android --device "$device" -o "screen-$device.png"
  mcp-devices-cli tap android 500 800 --device "$device"
done
```

### Log Collection and Debugging

```bash
# Capture logs during test execution
mcp-devices-cli clear-logs android
./run-test.sh
mcp-devices-cli logs android -l 500 --package com.example.app -o crash-logs.txt
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

| Feature | CLI (`mcp-devices-cli`) | MCP Server |
|---------|-------------------------|------------|
| **Startup time** | ~5ms (native binary) | ~500ms (Node.js spawn) |
| **Dependencies** | None (static binary) | Node.js, npm packages |
| **Installation** | Single file copy | `npm install` |
| **Scriptable** | Yes (stdout/stderr, exit codes) | No (requires MCP client) |
| **CI/CD friendly** | Yes | Limited |
| **Offline use** | Yes | Requires MCP connection |
| **Claude Code integration** | Via plugin/skill | Native MCP tools |
| **OpenCode integration** | Via `setup opencode` skill | Native MCP tools |
| **Pi integration** | Via `setup pi` skill | Not supported |
| **Qwen Code integration** | Via `setup qwen` skill | Native MCP tools |
| **Gemini CLI integration** | Via `setup gemini` skill | Native MCP tools |
| **Codex integration** | Via `setup codex` skill | Native MCP tools |
| **Cursor integration** | Via `setup cursor` skill | Native MCP tools |

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
BIN_DIR=target/aarch64-apple-darwin/release
ln -sf mcp-devices "$BIN_DIR/mcp-devices-cli"
tar -czvf claude-in-mobile-VERSION-darwin-arm64.tar.gz \
  -C "$BIN_DIR" mcp-devices mcp-devices-cli

# macOS x86_64 (Intel)
cargo build --release --target x86_64-apple-darwin
BIN_DIR=target/x86_64-apple-darwin/release
ln -sf mcp-devices "$BIN_DIR/mcp-devices-cli"
tar -czvf claude-in-mobile-VERSION-darwin-x86_64.tar.gz \
  -C "$BIN_DIR" mcp-devices mcp-devices-cli

# Linux x86_64 (static musl)
CC_x86_64_unknown_linux_musl=x86_64-linux-musl-gcc \
cargo build --release --target x86_64-unknown-linux-musl
BIN_DIR=target/x86_64-unknown-linux-musl/release
ln -sf mcp-devices "$BIN_DIR/mcp-devices-cli"
tar -czvf claude-in-mobile-VERSION-linux-x86_64.tar.gz \
  -C "$BIN_DIR" mcp-devices mcp-devices-cli
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

## Native performance artifacts

The native CLI captures bounded, local performance artifacts without Node.js:

```bash
# Android Perfetto and debuggable-app HPROF
mcp-devices-cli perf-trace --platform android --package com.example.app \
  --duration-ms 5000 --output ./app.perfetto-trace
mcp-devices-cli perf-heap-capture --platform android --package com.example.app \
  --output ./before.hprof

# iOS Simulator Time Profiler and Instruments Allocations
mcp-devices-cli perf-trace --platform ios --bundle-id com.example.app \
  --simulator "iPhone 17 Pro" --output ./app.trace.zip
mcp-devices-cli perf-heap-capture --platform ios --bundle-id com.example.app \
  --output ./before.allocations.trace.zip

# Coarse native artifact comparison
mcp-devices-cli perf-heap-diff ./before.hprof ./after.hprof
```

`perf-trace` accepts the `ui-jank` and `startup` presets and a 1,000–15,000 ms
duration. Simulator does not support xctrace's Animation Hitches instrument, so
the iOS `ui-jank` preset records Time Profiler and reports that fallback.
Artifacts are mode `0600`; traces are limited to 32 MiB and heap artifacts to
128 MiB. Output paths are never overwritten. Native CLI artifacts are
user-owned and have no automatic TTL; delete them when finished.

Browser CDP tracing and HeapProfiler remain MCP-only because the Rust CLI does
not host a browser session.

---

## Supported Platforms

| Platform | Backend | Device Selection |
|----------|---------|------------------|
| **Android** | ADB | `--device <serial>` |
| **iOS** | simctl | `--simulator <name>` |
| **Aurora OS** | audb | `--device <serial>` |
| **Desktop** | companion app | `--companion-path <path>` |

---

## Commands

Run `mcp-devices-cli --help` for the full list.

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
| Performance | `perf-trace`, `perf-heap-capture`, `perf-heap-diff`, `perf-snapshot`, `perf-baseline`, `perf-compare`, `perf-monitor`, `perf-crashes`, `perf-framestats` |
| Desktop | `launch-desktop-app`, `stop-desktop-app`, `get-window-info`, `focus-window`, `resize-window`, `get-monitors`, `get-performance-metrics` |
| Other | `shell`, `open-url`, `wait`, `current-activity` |

See `plugin/skills/mcp-devices/SKILL.md` for detailed command documentation.
