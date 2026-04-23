# Claude Mobile

MCP server for mobile and desktop automation — Android (via ADB), iOS Simulator (via simctl), Desktop (Compose Multiplatform), and Aurora OS (via audb). Like [Claude in Chrome](https://www.anthropic.com/news/claude-for-chrome) but for mobile devices and desktop apps.

Control your Android phone, emulator, iOS Simulator, Desktop applications, or Aurora OS device with natural language through Claude.

## Features

- **Unified API** — Same commands work for Android, iOS, Desktop, Aurora OS, and Browser
- **Token-optimized** — 8 meta-tools + 3 optional modules instead of 81 separate tools (~85% token reduction per request)
- **Dynamic modules** — Browser, Desktop, and Store modules load on demand, keeping the default tool list lean
- **Browser automation** — Control Chrome/Chromium via CDP: navigate, click, fill forms, evaluate JS, take screenshots
- **Smart screenshots** — Auto-compressed for optimal LLM processing
- **Annotated screenshots** — Screenshots with colored bounding boxes and numbered element labels
- **Security hardened** — Shell injection protection, URL scheme validation, path traversal blocking, input sanitization
- **Structured errors** — Typed error codes (`[CODE] message`) with auto-retry hints for transient failures
- **Telemetry** — Per-tool call metrics (count, avg latency, error rate) via `system(action:'metrics')`
- **Multi-device parallel** — Run the same action on multiple devices simultaneously via `flow_parallel`
- **Flow engine** — `flow_batch` for sequential commands, `flow_run` for conditional loops, `flow_parallel` for fan-out
- **Permission management** — Grant, revoke, and reset app permissions (Android runtime, iOS privacy services)
- **Store management** — Upload builds to Google Play, Huawei AppGallery, and RuStore (optional module)
- **Desktop support** — Test Compose Multiplatform desktop apps with window management, clipboard, and performance metrics

## Installation

### Native CLI via Homebrew (macOS)

```bash
brew tap AlexGladkov/claude-in-mobile https://github.com/AlexGladkov/claude-in-mobile
brew install claude-in-mobile
```

The CLI wraps all device automation tools plus store management (Google Play, Huawei AppGallery, RuStore):

```bash
claude-in-mobile screenshot android
claude-in-mobile tap android 540 960 --from-size 540x960
claude-in-mobile store upload --package com.example.app --file app.aab
claude-in-mobile huawei upload --package com.example.app --file app.aab
claude-in-mobile rustore upload --package com.example.app --file app.apk
```

### One-liner (any client)

Using [add-mcp](https://github.com/neondatabase/add-mcp) — auto-detects installed clients:

```bash
npx add-mcp claude-in-mobile -y
```

Or target a specific client:

```bash
npx add-mcp claude-in-mobile -a claude-code -y
npx add-mcp claude-in-mobile -a opencode -y
npx add-mcp claude-in-mobile -a cursor -y
```

### Claude Code CLI

```bash
claude mcp add --transport stdio mobile -- npx claude-in-mobile@latest
```

To add globally (available in all projects):

```bash
claude mcp add --scope user --transport stdio mobile -- npx claude-in-mobile@latest
```

### OpenCode

Use the interactive setup:

```bash
opencode mcp add
```

Or add manually to `opencode.json` (project root or `~/.config/opencode/opencode.json`):

```json
{
  "mcp": {
    "mobile": {
      "type": "local",
      "command": ["npx", "-y", "claude-in-mobile"],
      "enabled": true
    }
  }
}
```

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

### Any MCP Client

Print a config snippet for your client:

```bash
npx claude-in-mobile --init <client-name>
# Supported: opencode, cursor, claude-code
```

### From npm

```bash
npx claude-in-mobile
```

### From source

```bash
git clone https://github.com/AlexGladkov/claude-in-mobile.git
cd claude-in-mobile
npm install
npm run build:all  # Builds TypeScript + Desktop companion
```

> **Note:** For Desktop support, you need to run `npm run build:desktop` (or `build:all`) to compile the Desktop companion app.

#### Using a local build with MCP clients

After building from source, point your MCP client to the local `dist/index.js` instead of using npx:

```json
{
  "mcpServers": {
    "mobile": {
      "command": "node",
      "args": ["/path/to/claude-in-mobile/dist/index.js"]
    }
  }
}
```

For OpenCode (`opencode.json`):

```json
{
  "mcp": {
    "mobile": {
      "type": "local",
      "command": ["node", "/path/to/claude-in-mobile/dist/index.js"],
      "enabled": true
    }
  }
}
```

### Manual configuration

Add to your Claude Code settings (`~/.claude.json` or project settings):

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

### Windows

```bash
claude mcp add --transport stdio mobile -- cmd /c npx claude-in-mobile@latest
```

## Requirements

### Android
- ADB installed and in PATH
- Connected Android device (USB debugging enabled) or emulator

### iOS
- macOS with Xcode installed
- iOS Simulator (no physical device support yet)
- **WebDriverAgent** for full UI inspection and element-based interaction:
  ```bash
  npm install -g appium
  appium driver install xcuitest
  ```
  Or set `WDA_PATH` environment variable to custom WebDriverAgent location

### Desktop
- macOS (Windows/Linux support planned)
- JDK 17+ for building the Desktop companion
- Compose Multiplatform desktop application to test

### Aurora OS
- audb CLI installed and in PATH (`cargo install audb-client`)
- Connected Aurora OS device with SSH enabled
- Python on device required for tap/swipe: `devel-su pkcon install python`

## Available Tools

v3.4.0 consolidates tools into **8 core meta-tools** + **3 optional modules**. Each meta-tool uses an `action` parameter to select the operation. All v3.0/v3.1 tool names still work as backward-compatible aliases.

### Core Meta-Tools (always loaded)

| Meta-Tool | Actions | Description |
|-----------|---------|-------------|
| `device` | `list`, `set`, `set_target`, `get_target`, `enable_module`, `disable_module`, `list_modules` | Device management and module control |
| `input` | `tap`, `double_tap`, `long_press`, `swipe`, `text`, `key` | Touch/keyboard input |
| `screen` | `capture`, `annotate` | Screenshots and visual annotation |
| `ui` | `tree`, `find`, `find_tap`, `tap_text`, `analyze`, `wait`, `assert_visible`, `assert_gone` | UI hierarchy and element interaction |
| `app` | `launch`, `stop`, `install`, `list` | App lifecycle management |
| `system` | `activity`, `shell`, `wait`, `open_url`, `logs`, `clear_logs`, `info`, `webview`, `clipboard_*`, `permission_*`, `file_*`, `metrics`, `reset_metrics` | System operations, clipboard, permissions, files, telemetry |
| `flow_batch` | — | Execute multiple commands in one round-trip |
| `flow_run` | — | Multi-step automation with conditionals and loops |

### Optional Modules (loaded on demand)

These modules are hidden by default to save tokens. They auto-enable when you call them, or use `device(action:'enable_module', module:'<name>')`.

| Module | Actions | Description |
|--------|---------|-------------|
| `browser` | `open`, `close`, `list_sessions`, `navigate`, `click`, `fill`, `fill_form`, `press_key`, `snapshot`, `screenshot`, `evaluate`, `wait_for_selector`, `clear_session` | Chrome/Chromium automation via CDP |
| `desktop` | `launch`, `stop`, `windows`, `focus`, `resize`, `clipboard_get`, `clipboard_set`, `performance`, `monitors` | Compose Desktop app testing |
| `store` | `upload`, `set_notes`, `submit`, `get_releases`, `discard`, `promote`, `halt_rollout`, `get_versions` | Google Play, Huawei AppGallery, RuStore publishing |

### Flow Tools

| Tool | Description |
|------|-------------|
| `flow_batch` | Sequential execution of multiple commands in one round-trip (max 50) |
| `flow_run` | Multi-step flows with `if_not_found`, `repeat`, `on_error` handling (max 20 steps) |
| `flow_parallel` | Run the same action on multiple devices concurrently via `Promise.allSettled` (max 10 devices) |

### Backward Compatibility

All v3.0/v3.1 tool names work as aliases. For example, `tap` maps to `input(action:'tap')`, `screenshot` maps to `screen(action:'capture')`, `launch_app` maps to `app(action:'launch')`.

> For detailed Desktop API documentation, see [Desktop Specification](docs/SPEC_DESKTOP.md)

## Usage Examples

Just talk to Claude naturally:

```
"Show me all connected devices"
"Take a screenshot of the Android emulator"
"Take a screenshot on iOS"
"Tap on Settings"
"Swipe down to scroll"
"Type 'hello world' in the search field"
"Press the back button on Android"
"Open Safari on iOS"
"Switch to iOS simulator"
"Run the app on both platforms"
```

### Permission Management

```
"Grant camera permission to com.example.app on Android"
"Revoke location access from com.example.app"
"Reset all permissions for com.apple.Maps on iOS"
```

### Annotated Screenshots

```
"Take an annotated screenshot"  → Screenshot with green (clickable) and red (non-clickable) bounding boxes + numbered element index
```

### Platform Selection

You can explicitly specify the platform:

```
"Screenshot on android"     → Uses Android device
"Screenshot on ios"         → Uses iOS simulator
"Screenshot on desktop"     → Uses Desktop app
"Screenshot on aurora"      → Uses Aurora OS device
"Screenshot"                → Uses last active device
```

Or set the active device:

```
"Use the iPhone 15 simulator"
"Switch to the Android emulator"
"Switch to desktop"
"Switch to Aurora device"
```

### Desktop Examples

```
"Launch my desktop app from /path/to/app"
"Take a screenshot of the desktop app"
"Get window info"
"Resize window to 1280x720"
"Tap at coordinates 100, 200"
"Get clipboard content"
"Set clipboard to 'test text'"
"Get performance metrics"
"Stop the desktop app"
```

### Aurora Examples

```
"List all Aurora devices"
"Take a screenshot on Aurora"
"Tap at coordinates 100, 200 on Aurora"
"Launch ru.example.app on Aurora"
"List installed apps on Aurora device"
"Get logs from Aurora device"
"Push file.txt to /home/defaultuser/ on Aurora device"
```

## Native CLI

A 2 MB native Rust binary with all the same commands. No Node.js, no dependencies.

### Install CLI

```bash
brew tap AlexGladkov/claude-in-mobile
brew install claude-in-mobile
```

Or download from [Releases](https://github.com/AlexGladkov/claude-in-mobile/releases).

### Advantages over MCP

- **Easy install** — `brew install` or copy a single 2 MB binary
- **No dependencies** — no Node.js, no npm, nothing
- **Use from terminal** — run commands directly, no Claude Code or MCP client needed
- **Test automation** — write universal `.sh` scripts for any platform without learning platform internals
- **Token-efficient** — skill documentation loads only when used; MCP v3.4.0 reduced schema overhead by ~85% (8 meta-tools vs 81 individual tools)
- **Fast** — ~5ms command startup (Rust) vs ~500ms (Node.js MCP)
- **CI/CD ready** — exit codes, stdout/stderr, runs anywhere

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

### Claude Code Plugin

```bash
claude plugin marketplace add AlexGladkov/claude-in-mobile
claude plugin install claude-in-mobile@claude-in-mobile
```

After installing, Claude Code controls devices with natural language. The skill loads into context only on demand — no token overhead when not in use.

See [cli/README.md](cli/README.md) for full CLI documentation.

## iOS WebDriverAgent Setup

For full iOS UI inspection and element-based interaction, WebDriverAgent is required. It enables:
- `get_ui` - JSON accessibility tree inspection
- `tap` with `label` or `text` parameters - Element-based tapping
- `find_element` - Element discovery and querying
- `swipe` - Improved gesture simulation

### Installation

**Automatic (via Appium):**
```bash
npm install -g appium
appium driver install xcuitest
```

**Manual:**
Set the `WDA_PATH` environment variable to your WebDriverAgent location:
```bash
export WDA_PATH=/path/to/WebDriverAgent
```

### First Use

On first use, WebDriverAgent will be automatically:
1. Discovered from Appium installation or `WDA_PATH`
2. Built with xcodebuild (one-time, ~2 minutes)
3. Launched on the iOS simulator
4. Connected via HTTP on port 8100+

### Troubleshooting

**Build fails:**
```bash
# Install Xcode command line tools
xcode-select --install

# Accept license
sudo xcodebuild -license accept

# Set Xcode path
sudo xcode-select -s /Applications/Xcode.app
```

**Session fails:**
- Ensure simulator is booted: `xcrun simctl list | grep Booted`
- Check port availability: `lsof -i :8100`
- Try restarting the simulator

**Manual test:**
```bash
cd ~/.appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent
xcodebuild test -project WebDriverAgent.xcodeproj \
  -scheme WebDriverAgentRunner \
  -destination 'platform=iOS Simulator,id=<DEVICE_UDID>'
```

## How It Works

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ Claude Code │────▶│                  │────▶│  Android (ADB)  │
├─────────────┤     │  Claude Mobile   │     ├─────────────────┤
│  OpenCode   │────▶│   MCP Server     │────▶│ iOS (simctl+WDA)│
├─────────────┤     │                  │     ├─────────────────┤
│   Cursor    │────▶│  8 meta-tools    │────▶│ Desktop (Compose)│
├─────────────┤     │  + 3 modules     │     ├─────────────────┤
│  Any MCP    │────▶│  (auto-detects   │────▶│ Aurora (audb)   │
│   Client    │     │   client)        │     ├─────────────────┤
└─────────────┘     │                  │────▶│ Browser (CDP)   │
                    └──────────────────┘     └─────────────────┘
```

1. Claude sends commands through MCP protocol (8 meta-tools + 3 optional modules)
2. Server routes to appropriate platform (ADB, simctl+WDA, Desktop, audb, or CDP)
3. Commands execute on your device, desktop app, or browser
4. Results (screenshots, UI data, metrics) return to Claude
5. Dynamic modules auto-enable when first called — no manual setup needed

## License

MIT
