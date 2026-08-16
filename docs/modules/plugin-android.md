# Platform Plugin: Android

Automate Android devices and emulators via ADB (Android Debug Bridge).

## What it covers

- Screen capture and annotation
- Touch input (tap, swipe, long press, double tap)
- Text input and key press
- App lifecycle (launch, stop, install, uninstall)
- Accessibility tree traversal and element search
- Shell commands and system logs
- Clipboard operations
- File push/pull
- Permissions (grant, revoke, reset)
- Deep linking (Intent + am start)
- Sensor simulation (GPS, battery, thermal, notifications)
- Network simulation (traffic stats, connectivity, proxy, airplane mode)
- App sandbox access (SharedPreferences, SQLite, run-as)
- Performance monitoring and metrics

## Prerequisites

### ADB

The Android Debug Bridge (`adb`) must be installed and in your PATH.

**Install:**
```sh
brew install android-platform-tools       # macOS
apt-get install adb                        # Linux
choco install adb                          # Windows
```

**Verify:**
```sh
adb version
```

**Check status:**
```sh
mcp-devices doctor android
```

This will probe for `adb` and verify that connected devices are accessible.

### Devices

- **Emulators:** Any Android emulator running via Android Studio or command line
- **Physical devices:** Device with USB debugging enabled (Developer Options → USB Debugging)

## Install & Enable

```sh
# 1. Install the npm package
npm i -g @mcp-devices/plugin-android@dev

# 2. Enable the Android platform
mcp-devices install android

# 3. Restart your MCP client
# The android platform is now loaded on the next MCP server start
```

To verify:
```sh
mcp-devices platforms
# Output includes: "android: enabled"
```

## Built-in Tools

The Android platform works with these built-in tool modules:

### Core Tools
- **input** — Tap, swipe, type, key press
- **ui** — Accessibility tree, element search, assertions
- **app** — Launch, stop, install, list applications
- **system** — Shell commands, logs, clipboard, permissions, file I/O, device info, metrics
- **screen** — Screenshot and annotation (always available)
- **device** — Device management (always available)
- **flow** — Batch and parallel command execution

### Android-specific Tools
- **intent** — Deep linking, am start/broadcast with typed extras (Android only)
- **sandbox** — App sandbox access: SharedPreferences, SQLite, file operations via run-as (Android only)
- **sensor** — Sensor & environment simulation: GPS, battery, thermal, notifications (Android only)
- **network** — Network layer: traffic stats, connectivity, proxy, airplane mode (Android only)

### Optional Tools
- **recorder** — Record and replay interaction sequences
- **autopilot** — AI-driven test generation
- **performance** — Performance monitoring, baselines, crash tracking
- **visual** — Visual regression testing
- **accessibility** — WCAG accessibility audit

## Configuration

Platform resolution via environment variable:
```sh
MCP_DEVICES_PLATFORMS=android mcp-devices
```

Or enable multiple platforms:
```sh
MCP_DEVICES_PLATFORMS=android,web mcp-devices
```

See [Modules & Tools](./README.md) for platform resolution order and startup profiles.
