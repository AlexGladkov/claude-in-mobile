# Claude Mobile

MCP server for mobile and desktop automation — Android (via ADB), iOS Simulator (via simctl), Desktop (Compose Multiplatform), and Aurora OS (via audb). Like [Claude in Chrome](https://www.anthropic.com/news/claude-for-chrome) but for mobile devices and desktop apps.

Control your Android phone, emulator, iOS Simulator, Desktop applications, or Aurora OS device with natural language through Claude.

## Features

- **Unified API** — Same commands work for Android, iOS, Desktop, and Aurora OS
- **Smart screenshots** — Auto-compressed for optimal LLM processing (no more oversized images!)
- **Device logs** — Read logcat/system logs with filters for debugging
- **UI interactions** — Tap, long press, swipe by coordinates or element text
- **Text input** — Type into focused fields
- **App control** — Launch, stop, and install apps
- **Platform selection** — Explicitly target Android, iOS, Desktop, or Aurora OS
- **Desktop support** — Test Compose Multiplatform desktop apps with window management, clipboard, and performance metrics

## Installation

### Claude Code CLI (recommended)

```bash
claude mcp add --transport stdio mobile -- npx -y claude-in-mobile
```

To add globally (available in all projects):

```bash
claude mcp add --scope user --transport stdio mobile -- npx -y claude-in-android
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
claude mcp add --transport stdio mobile -- cmd /c npx -y claude-in-android
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

### Core Tools (All Platforms)

| Tool | Android | iOS | Desktop | Aurora | Description |
|------|---------|-----|---------|--------|-------------|
| `list_devices` | ✅ | ✅ | ✅ | ✅ | List all connected devices |
| `set_device` | ✅ | ✅ | ✅ | ✅ | Select active device |
| `screenshot` | ✅ | ✅ | ✅ | ✅ | Take screenshot |
| `tap` | ✅ | ✅ | ✅ | ⚠️ | Tap at coordinates or by text/label (iOS: WDA required for element tap) |
| `long_press` | ✅ | ✅ | ✅ | ✅ | Long press gesture |
| `swipe` | ✅ | ✅ | ✅ | ⚠️ | Swipe in direction or coordinates (requires Python on Aurora) |
| `input_text` | ✅ | ✅ | ✅ | ❌ | Type text |
| `press_key` | ✅ | ✅ | ✅ | ✅ | Press hardware buttons |
| `launch_app` | ✅ | ✅ | ❌ | ✅ | Launch app |
| `stop_app` | ✅ | ✅ | ❌ | ✅ | Stop app |
| `install_app` | ✅ | ✅ | ❌ | ✅ | Install APK/.app/.rpm |
| `list_apps` | ❌ | ❌ | ❌ | ✅ | List installed apps (Aurora only) |
| `get_ui` | ✅ | ✅ | ✅ | ❌ | Get UI hierarchy (iOS: requires WebDriverAgent) |
| `find_element` | ✅ | ✅ | ✅ | ❌ | Find elements by text/id/label (iOS: requires WebDriverAgent) |
| `get_current_activity` | ✅ | ❌ | ❌ | ❌ | Get foreground activity |
| `open_url` | ✅ | ✅ | ❌ | ❌ | Open URL in browser (not yet implemented on Aurora) |
| `shell` | ✅ | ✅ | ❌ | ✅ | Run shell command |
| `wait` | ✅ | ✅ | ✅ | ✅ | Wait for duration |
| `get_logs` | ✅ | ✅ | ❌ | ✅ | Get device logs (logcat/system log) |
| `clear_logs` | ✅ | ⚠️ | ❌ | ✅ | Clear log buffer |
| `get_system_info` | ✅ | ❌ | ❌ | ✅ | Battery, memory info |
| `push_file` | ❌ | ❌ | ❌ | ✅ | Upload file (Aurora only) |
| `pull_file` | ❌ | ❌ | ❌ | ✅ | Download file (Aurora only) |

### Desktop-Specific Tools

| Tool | Description |
|------|-------------|
| `set_target` | Set target platform (android/ios/desktop) |
| `get_target` | Get current target platform |
| `launch_desktop_app` | Launch a Compose Desktop application |
| `stop_desktop_app` | Stop the running desktop application |
| `get_window_info` | Get desktop window position and size |
| `focus_window` | Bring desktop window to front |
| `resize_window` | Resize desktop window |
| `get_clipboard` | Get system clipboard content |
| `set_clipboard` | Set system clipboard content |
| `get_performance_metrics` | Get CPU/memory usage of desktop app |

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
- **Token-efficient** — skill documentation loads only when used; MCP loads all tool schemas into every request, which adds up fast over a session
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
claude plugin install claude-in-mobile@AlexGladkov-claude-in-mobile
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
│   Claude    │────▶│  Claude Mobile   │────▶│  Android (ADB)  │
│             │     │   MCP Server     │     └─────────────────┘
│             │     │                  │     ┌─────────────────┐
│             │     │                  │────▶│ iOS (simctl+WDA)│
│             │     │                  │     └─────────────────┘
│             │     │                  │     ┌─────────────────┐
│             │     │                  │────▶│ Desktop (Compose)│
│             │     │                  │     └─────────────────┘
│             │     │                  │     ┌─────────────────┐
│             │     │                  │────▶│ Aurora (audb)   │
└─────────────┘     └──────────────────┘     └─────────────────┘
```

1. Claude sends commands through MCP protocol
2. Server routes to appropriate platform (ADB, simctl+WDA, Desktop companion, or audb)
3. Commands execute on your device or desktop app
4. Results (screenshots, UI data, metrics) return to Claude

## License

MIT
