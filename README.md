# Claude in Android

MCP server for Android device automation via ADB. Like [Claude in Chrome](https://github.com/anthropics/claude-chrome-extension) but for Android devices.

Control your Android phone or emulator with natural language through Claude.

## Features

- **Screenshot capture** - See what's on the device screen
- **UI hierarchy parsing** - Get accessibility tree with interactive elements
- **Touch interactions** - Tap, long press, swipe by coordinates or element text
- **Text input** - Type into focused fields
- **App control** - Launch, stop, and install apps
- **Shell access** - Run arbitrary ADB commands

## Installation

### From npm

```bash
npx claude-in-android
```

### From source

```bash
git clone https://github.com/AlexGladkov/claude-in-android.git
cd claude-in-android
npm install
npm run build
```

## Configuration

Add to your Claude Code settings:

### Using npx (recommended)

```json
{
  "mcpServers": {
    "android": {
      "command": "npx",
      "args": ["-y", "claude-in-android"]
    }
  }
}
```

### Using local build

```json
{
  "mcpServers": {
    "android": {
      "command": "node",
      "args": ["/path/to/claude-in-android/dist/index.js"]
    }
  }
}
```

## Requirements

- Node.js 18+
- ADB installed and in PATH
- Connected Android device (USB debugging enabled) or emulator

## Available Tools

| Tool | Description |
|------|-------------|
| `list_devices` | List connected devices and emulators |
| `set_device` | Select active device for commands |
| `screenshot` | Take screenshot (returns image) |
| `get_ui` | Get UI hierarchy (accessibility tree) |
| `tap` | Tap by coordinates, text, resourceId, or index |
| `long_press` | Long press gesture |
| `swipe` | Swipe in direction or custom coordinates |
| `input_text` | Type text into focused field |
| `press_key` | Press BACK, HOME, ENTER, etc. |
| `find_element` | Find elements by text/id/class |
| `launch_app` | Launch app by package name |
| `stop_app` | Force stop app |
| `install_apk` | Install APK file |
| `get_current_activity` | Get foreground activity |
| `shell` | Run ADB shell command |
| `wait` | Wait for specified duration |

## Usage Examples

Just talk to Claude naturally:

```
"Take a screenshot of my phone"
"Tap on Settings"
"Swipe down to scroll"
"Type 'hello world' in the search field"
"Press the back button"
"Open Chrome"
"What app is currently open?"
```

## How It Works

1. Claude sends commands through MCP protocol
2. This server translates them to ADB commands
3. ADB executes on your connected device
4. Results (screenshots, UI data) are returned to Claude

## License

MIT
