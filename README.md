# Claude Mobile

MCP server for mobile, desktop, and browser automation — Android (ADB), iOS Simulator (simctl + WDA), Desktop (any macOS app), Aurora OS (audb), and Browser (CDP). Like [Claude in Chrome](https://www.anthropic.com/news/claude-for-chrome) but for devices, apps, and browsers.

Control your Android phone, emulator, iOS Simulator, desktop app, Aurora device, or headless browser with natural language through Claude.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Features at a Glance](#features-at-a-glance)
- [Quality Engineering](#quality-engineering)
- [Installation](#installation)
  - [Homebrew (macOS)](#homebrew-macos)
  - [One-liner (any client)](#one-liner-any-client)
  - [Claude Code](#claude-code)
  - [OpenCode](#opencode)
  - [Other Agents (Pi, Qwen, Gemini, Codex, Cursor)](#other-agents)
  - [From npm / source](#from-npm--source)
  - [Windows](#windows)
- [Platform Guides](#platform-guides)
  - [Android](#android)
  - [iOS](#ios)
  - [Desktop](#desktop)
  - [Browser](#browser)
  - [Aurora OS](#aurora-os)
- [Tools Reference](#tools-reference)
  - [Core Meta-Tools](#core-meta-tools)
  - [Optional Modules](#optional-modules)
  - [Flow Tools](#flow-tools)
- [Native CLI](#native-cli)
- [Architecture](#architecture)
- [License](#license)

---

## Quick Start

```bash
# Install via Homebrew (macOS)
brew tap AlexGladkov/claude-in-mobile https://github.com/AlexGladkov/claude-in-mobile
brew install claude-in-mobile

# Verify dependencies
claude-in-mobile doctor

# Add to Claude Code
claude mcp add --scope user --transport stdio mobile -- npx claude-in-mobile@latest
```

Then talk to Claude naturally:

```
"Take a screenshot of the Android emulator"
"Tap on the Login button"
"Type hello in the search field"
"Switch to iOS simulator"
```

---

## Features at a Glance

| Feature | Description |
|---------|-------------|
| **Unified API** | Same 8 meta-tools work across Android, iOS, Desktop, Aurora, and Browser |
| **Token-optimized** | 8 meta-tools + 3 optional modules instead of 81 tools (~85% token reduction) |
| **Dynamic modules** | Browser, Desktop, Store load on demand — default tool list stays lean |
| **Smart screenshots** | Auto-compressed for optimal LLM processing |
| **Annotated screenshots** | Colored bounding boxes + numbered element labels |
| **Security hardened** | Shell injection protection, URL validation, path traversal blocking |
| **Structured errors** | Typed error codes with auto-recovery hints |
| **Multi-device parallel** | Run actions on multiple devices simultaneously |
| **Flow engine** | Batch, conditional loops, and fan-out flows |
| **Permission management** | Grant/revoke/reset app permissions (Android + iOS) |
| **Store publishing** | Google Play, Huawei AppGallery, RuStore |
| **Telemetry** | Per-tool call metrics via `system(action:'metrics')` |
| **Doctor command** | `claude-in-mobile doctor` — checks all dependencies at once |

---

## Quality Engineering

Advanced testing and monitoring built into Claude Mobile:

| Feature | What it does | How to use |
|---------|-------------|------------|
| **Accessibility Auditing** | WCAG 2.2 checks: missing labels, touch targets < 48px, focus order, duplicates | `accessibility(action:'audit')` |
| **Visual Regression** | Baseline screenshots + pixel-level diff detection | `visual(action:'baseline_save')`, `visual(action:'compare')` |
| **Test Recorder** | Record taps/swipes/input, replay without code | `recorder(action:'start')`, `recorder(action:'play')` |
| **Multi-Device Sync** | Barrier-based coordination for parallel testing | `sync(action:'create')`, `sync(action:'barrier')` |
| **App Autopilot** | Autonomous BFS/DFS exploration with self-healing locators | `autopilot(action:'explore')` |
| **Performance Monitor** | Real-time memory, CPU, FPS tracking with snapshots | `performance(action:'start')`, `performance(action:'snapshot')` |

---

## Installation

### Homebrew (macOS)

```bash
brew tap AlexGladkov/claude-in-mobile https://github.com/AlexGladkov/claude-in-mobile
brew install claude-in-mobile
```

Verify setup:

```bash
claude-in-mobile doctor
```

### One-liner (any client)

Auto-detects installed clients via [add-mcp](https://github.com/neondatabase/add-mcp):

```bash
npx add-mcp claude-in-mobile -y
```

Target a specific client:

```bash
npx add-mcp claude-in-mobile -a claude-code -y
npx add-mcp claude-in-mobile -a opencode -y
npx add-mcp claude-in-mobile -a cursor -y
```

### Claude Code

```bash
# Project-local
claude mcp add --transport stdio mobile -- npx claude-in-mobile@latest

# Global (all projects)
claude mcp add --scope user --transport stdio mobile -- npx claude-in-mobile@latest
```

#### Claude Code Plugin

```bash
claude plugin marketplace add AlexGladkov/claude-in-mobile
claude plugin install claude-in-mobile@claude-in-mobile
```

### OpenCode

Two modes:

**A) MCP server** (Node.js):

```bash
opencode mcp add
# Choose local MCP → npx -y claude-in-mobile
```

Or in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mobile": {
      "type": "local",
      "command": ["npx", "-y", "claude-in-mobile"],
      "enabled": true
    }
  }
}
```

**B) Native CLI + Skill** (no Node.js needed):

```bash
claude-in-mobile setup opencode            # project-local
claude-in-mobile setup opencode --global   # user-wide
```

### Other Agents

Native CLI skill works with any agent that supports Agent Skills:

```bash
claude-in-mobile setup pi --global       # Pi
claude-in-mobile setup qwen --global     # Qwen Code
claude-in-mobile setup gemini --global   # Gemini CLI
claude-in-mobile setup codex --global    # Codex
claude-in-mobile setup cursor --global   # Cursor
```

Drop `--global` for project-local install. Restart the agent after setup.

<details>
<summary>MCP server config for Qwen / Gemini / Codex / Cursor</summary>

**Qwen Code** — `.qwen/settings.json` or `~/.qwen/settings.json`:

```json
{ "mcpServers": { "mobile": { "command": "npx", "args": ["-y", "claude-in-mobile"] } } }
```

**Gemini CLI** — `.gemini/settings.json` or `~/.gemini/settings.json`:

```json
{ "mcpServers": { "mobile": { "command": "npx", "args": ["-y", "claude-in-mobile"] } } }
```

**Codex**:

```bash
codex mcp add mobile -- npx -y claude-in-mobile
```

**Cursor** — `.cursor/mcp.json`:

```json
{ "mcpServers": { "mobile": { "command": "npx", "args": ["-y", "claude-in-mobile"] } } }
```

</details>

### From npm / source

```bash
# npm (no install)
npx claude-in-mobile

# From source
git clone https://github.com/AlexGladkov/claude-in-mobile.git
cd claude-in-mobile
npm install
npm run build:all
```

Using a local build with any MCP client:

```json
{ "mcpServers": { "mobile": { "command": "node", "args": ["/path/to/claude-in-mobile/dist/index.js"] } } }
```

### Windows

```bash
claude mcp add --transport stdio mobile -- cmd /c npx claude-in-mobile@latest
```

---

## Platform Guides

### Android

**Requirements:**
- ADB installed (auto-discovered or set `ADB_PATH`)
- USB debugging enabled on device, or running emulator

**ADB discovery order:**

| Priority | Location |
|----------|----------|
| 1 | `ADB_PATH` env var |
| 2 | `$ANDROID_HOME/platform-tools/adb` |
| 3 | `$ANDROID_SDK_ROOT/platform-tools/adb` |
| 4 | OS default: `~/Library/Android/sdk` (macOS), `%LOCALAPPDATA%\Android\Sdk` (Windows), `~/Android/Sdk` (Linux) |
| 5 | `adb` from `PATH` |

If none found → `[ADB_NOT_INSTALLED]` error with probed paths.

**Examples:**

```
"Show connected devices"
"Take a screenshot on Android"
"Tap on Settings"
"Swipe down to scroll"
"Type 'hello' in the search field"
"Press the back button"
"Grant camera permission to com.example.app"
"Launch com.example.app"
```

**CLI:**

```bash
claude-in-mobile screenshot android
claude-in-mobile tap android 540 960
claude-in-mobile input android "hello world"
claude-in-mobile ui-dump android | grep "Login"
```

#### Coordinate space (raw `x`/`y` in tap / swipe / long_press)

When you call an input tool with raw `x`/`y` (or `x1`/`y1`/`x2`/`y2` for swipe), the values are interpreted in **the most recent screenshot's pixel space** and auto-scaled to device coordinates before dispatch. The scale comes from the last `screen_capture` call: e.g., capture at `preset='low'` (270×480) on a 1080×2400 device sets a 4× factor, so `tap(135, 240)` becomes `tap(540, 960)` on the device.

This is convenient for the common flow `screen_capture → reason about pixel → tap`, but has two gotchas worth knowing:

- **Coordinates from `ui_find` / `ui_tree` are device coordinates**, not screenshot coordinates. They come from `uiautomator` which always reports in device space. If the most recent screenshot was at a low preset, passing those device coords as raw `x`/`y` will over-scale them. Prefer `index`, `text`, or `resourceId` for ui-sourced taps to avoid the issue entirely.
- **No screenshot taken yet?** Then there's no scale stored, and raw `x`/`y` are passed through 1:1 as device coords.

The cleanest mental model: *raw coords match whatever pixel space you're looking at on screen* (your last screenshot). For everything else, use the resolver fields (`index`, `text`, `resourceId`, `label`).

---

### iOS

**Requirements:**
- macOS with Xcode
- iOS Simulator (no physical device support yet)
- WebDriverAgent for full UI inspection (optional but recommended)

**WebDriverAgent setup:**

```bash
# Automatic (via Appium)
npm install -g appium
appium driver install xcuitest

# Or set custom path
export WDA_PATH=/path/to/WebDriverAgent
```

On first use, WDA is auto-built (~2 min one-time), launched on simulator, and connected on port 8100+.

**What WDA enables:**
- `ui(action:'tree')` — full accessibility tree
- `ui(action:'find')` — element discovery by label/text
- `input(action:'tap', label:'...')` — element-based tapping
- Improved swipe and gesture simulation

**Troubleshooting:**

```bash
# Install Xcode CLI tools
xcode-select --install

# Accept license
sudo xcodebuild -license accept

# Check simulator is booted
xcrun simctl list | grep Booted

# Check port
lsof -i :8100
```

<details>
<summary>Manual WDA test</summary>

```bash
cd ~/.appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent
xcodebuild test -project WebDriverAgent.xcodeproj \
  -scheme WebDriverAgentRunner \
  -destination 'platform=iOS Simulator,id=<DEVICE_UDID>'
```

</details>

**Examples:**

```
"Take a screenshot on iOS"
"Open Safari on iOS"
"Tap on the Login button"
"Type my email in the text field"
"Swipe left on the card"
"Reset all permissions for com.apple.Maps"
```

---

### Desktop

**Requirements:**
- macOS (Windows/Linux planned)
- Accessibility permissions: System Settings → Privacy & Security → Accessibility
- JDK 17+ (for building Desktop companion)

**Supported apps:** Any macOS application — SwiftUI, AppKit, Electron, Compose Desktop.

**Launch modes:**

| Mode | Example |
|------|---------|
| By `bundleId` | `desktop(action:'launch', bundleId:'com.apple.Calculator')` |
| By `.app` path | `desktop(action:'launch', appPath:'/Applications/Slack.app')` |
| Attach by PID | `desktop(action:'launch', pid:12345)` |

**Enable the module first:**

```
"Enable desktop module"
```

Or it auto-enables on first `desktop(...)` call.

**Examples:**

```
"Launch Calculator"
"Take a screenshot of the desktop app"
"Get window list"
"Resize window to 1280x720"
"Tap at 100, 200 on desktop"
"Get clipboard content"
"Get performance metrics"
"Stop the desktop app"
```

> Full API documentation: [docs/SPEC_DESKTOP.md](docs/SPEC_DESKTOP.md)

---

### Browser

**Requirements:**
- Chrome or Chromium installed (or set `CHROME_PATH`)

Browser automation via Chrome DevTools Protocol (CDP). The `browser` module loads on demand.

**Examples:**

```
"Open https://example.com in the browser"
"Click the Sign In button"
"Fill the email field with test@example.com"
"Take a browser screenshot"
"Execute JS: document.title"
"Wait for the loading spinner to disappear"
```

**Available actions:**

| Action | Description |
|--------|-------------|
| `open` | Open URL in new session |
| `navigate` | Go to URL in existing session |
| `click` | Click element by ref |
| `fill` | Type into input field |
| `fill_form` | Fill multiple fields at once |
| `press_key` | Keyboard input |
| `snapshot` | DOM snapshot with element refs |
| `screenshot` | Visual screenshot |
| `evaluate` | Run JavaScript |
| `wait_for_selector` | Wait for element to appear |
| `close` | Close session |
| `list_sessions` | Show active sessions |
| `clear_session` | Reset cookies/storage |

---

### Aurora OS

**Requirements:**
- `audb` CLI: `cargo install audb-client`
- SSH-enabled Aurora OS device
- Python on device for tap/swipe: `devel-su pkcon install python`

**Examples:**

```
"List Aurora devices"
"Take a screenshot on Aurora"
"Tap at 100, 200 on Aurora"
"Launch ru.example.app on Aurora"
"List installed apps on Aurora"
"Get logs from Aurora device"
"Push file.txt to /home/defaultuser/"
```

---

## Tools Reference

v3.8.0 provides **8 core meta-tools** + **3 optional modules**. Each meta-tool uses an `action` parameter.

### Core Meta-Tools

| Meta-Tool | Actions | Description |
|-----------|---------|-------------|
| `device` | `list`, `set`, `set_target`, `get_target`, `enable_module`, `disable_module`, `list_modules` | Device management, module control |
| `input` | `tap`, `double_tap`, `long_press`, `swipe`, `text`, `key` | Touch and keyboard input |
| `screen` | `capture`, `annotate` | Screenshots and visual annotation |
| `ui` | `tree`, `find`, `find_tap`, `tap_text`, `analyze`, `wait`, `assert_visible`, `assert_gone` | UI hierarchy, element interaction |
| `app` | `launch`, `stop`, `install`, `list` | App lifecycle |
| `system` | `activity`, `shell`, `wait`, `open_url`, `logs`, `clear_logs`, `info`, `webview`, `clipboard_*`, `permission_*`, `file_*`, `metrics`, `reset_metrics` | System ops, clipboard, permissions, files, telemetry |
| `flow_batch` | — | Execute multiple commands in one round-trip (max 50) |
| `flow_run` | — | Multi-step automation with conditionals and loops (max 20 steps) |

### Optional Modules

Load on demand via `device(action:'enable_module', module:'<name>')` or auto-enable on first call.

| Module | Actions | Description |
|--------|---------|-------------|
| `browser` | `open`, `close`, `list_sessions`, `navigate`, `click`, `fill`, `fill_form`, `press_key`, `snapshot`, `screenshot`, `evaluate`, `wait_for_selector`, `clear_session` | Chrome/Chromium via CDP |
| `desktop` | `launch`, `stop`, `windows`, `focus`, `resize`, `clipboard_get`, `clipboard_set`, `performance`, `monitors` | Any macOS app |
| `store` | `upload`, `set_notes`, `submit`, `get_releases`, `discard`, `promote`, `halt_rollout`, `get_versions` | Google Play, Huawei AppGallery, RuStore |

### Flow Tools

| Tool | Description |
|------|-------------|
| `flow_batch` | Sequential execution, one round-trip (max 50 commands) |
| `flow_run` | Multi-step flows with `if_not_found`, `repeat`, `on_error` (max 20 steps) |
| `flow_parallel` | Same action on multiple devices via `Promise.allSettled` (max 10) |

### Backward Compatibility

All v3.0/v3.1 tool names work as aliases: `tap` → `input(action:'tap')`, `screenshot` → `screen(action:'capture')`, `launch_app` → `app(action:'launch')`, etc.

---

## Native CLI

2 MB Rust binary. No Node.js, no dependencies.

### Install

```bash
brew tap AlexGladkov/claude-in-mobile
brew install claude-in-mobile
```

Or download from [Releases](https://github.com/AlexGladkov/claude-in-mobile/releases).

### Why use the CLI

| | CLI | MCP Server |
|---|---|---|
| **Install** | `brew install` or copy binary | `npx` / npm |
| **Dependencies** | None | Node.js |
| **Startup** | ~5ms | ~500ms |
| **Use from terminal** | Direct commands | Needs MCP client |
| **CI/CD** | Exit codes, stdout/stderr | Not designed for CI |
| **Token cost** | Skill loads on demand | Schema always present |

### Test script example

```bash
#!/bin/bash
claude-in-mobile launch android com.example.app
claude-in-mobile wait 2000
claude-in-mobile tap android 0 0 --text "Login"
claude-in-mobile input android "test@example.com"
claude-in-mobile screenshot android -o result.png
claude-in-mobile ui-dump android | grep "Welcome" && echo "PASS" || echo "FAIL"
```

### Store management (CLI)

```bash
claude-in-mobile store upload --package com.example.app --file app.aab
claude-in-mobile huawei upload --package com.example.app --file app.aab
claude-in-mobile rustore upload --package com.example.app --file app.apk
```

### Doctor

Check all dependencies at once:

```bash
claude-in-mobile doctor
```

Checks: ADB, ANDROID_HOME, Xcode, simctl, Appium, WDA, JDK, audb-client, Chrome. Color-coded output with fix suggestions.

---

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ Claude Code │────▶│                  │────▶│  Android (ADB)  │
├─────────────┤     │  Claude Mobile   │     ├─────────────────┤
│  OpenCode   │────▶│   MCP Server     │────▶│ iOS (simctl+WDA)│
├─────────────┤     │                  │     ├─────────────────┤
│   Cursor    │────▶│  8 meta-tools    │────▶│ Desktop (macOS) │
├─────────────┤     │  + 3 modules     │     ├─────────────────┤
│ Qwen/Gemini │────▶│                  │────▶│ Aurora (audb)   │
├─────────────┤     │  Auto-detects    │     ├─────────────────┤
│  Any MCP    │────▶│  platform        │────▶│ Browser (CDP)   │
└─────────────┘     └──────────────────┘     └─────────────────┘
```

1. Client sends commands via MCP protocol (8 meta-tools + 3 optional modules)
2. Server routes to platform adapter (ADB, simctl+WDA, Desktop, audb, CDP)
3. Commands execute on device/app/browser
4. Results (screenshots, UI trees, metrics) return to client
5. Modules auto-enable on first call — no manual setup needed

---

## License

MIT
