# Platform Plugin: Aurora

Automate Aurora OS applications via audb and Aurora Flutter SDK.

---

## Overview

Enables Aurora OS app automation: screenshot, touch, text input, app lifecycle, UI traversal, and shell access. Aurora OS is a Linux-based mobile operating system, and mcp-devices provides an ADB-like interface for automation.

## When to use it

- **Aurora app testing:** Automate workflows on Aurora OS devices/emulators
- **Cross-platform testing:** Test same app codebase on Aurora alongside Android
- **UI automation:** Navigate app screens, fill forms, verify state
- **System access:** Execute commands, read logs, access device info
- **Visual testing:** Capture screenshots for regression detection
- **Accessibility audit:** Verify UI accessibility on Aurora OS

---

## Prerequisites

### Aurora Flutter SDK

Required for Aurora OS automation.

**Install:**

Follow Aurora Linux documentation for SDK installation. Typically:

```sh
# Example (varies by Aurora distribution)
# Via package manager
sudo apt-get install aurora-sdk

# Or download from Aurora Linux developer resources
# https://gitlab.com/auroraos/
```

**Verify:**

`mcp-devices doctor aurora` probes for `flutter-aurora` (the Aurora Flutter SDK).
The plugin talks to devices over `audb` (an ADB-like transport) at runtime.

```sh
flutter-aurora --version    # what `mcp-devices doctor aurora` checks
audb version                # device transport used by the plugin at runtime
```

**Check status:**

```sh
mcp-devices doctor aurora
```

This verifies Aurora SDK is installed and lists connected devices/emulators.

### Aurora Devices

- **Emulator:** Aurora emulator instances created via Aurora Flutter SDK
- **Physical device:** Aurora OS device with USB debugging enabled

---

## Install & Enable

### 1. Install npm package

```sh
npm i -g @mcp-devices/plugin-aurora
```

### 2. Enable the platform

```sh
mcp-devices install aurora
```

### 3. Restart MCP server

Aurora platform loads on next server start.

### 4. Verify

```sh
mcp-devices platforms
# Output: "aurora: enabled"

mcp-devices doctor aurora
# Lists connected devices & emulators
```

---

## Tools & Actions

Aurora uses the same core modules as Android, with ADB-like interface:

| Module | Key Actions | Use |
|--------|-------------|-----|
| **input** | `tap` (coords), `double_tap`, `long_press`, `swipe`, `text`, `key` | Touch gestures, text input, keyboard |
| **ui** | `tree`, `find`, `find_tap`, `tap_text`, `wait`, `assert_visible`, `assert_gone` | Element search, assertions, waits |
| **app** | `launch`, `stop`, `install`, `list` | App lifecycle |
| **system** | `shell`, `logs`, `info` | Low-level control, device info |
| **screen** | `capture`, `annotate` | Screenshots |
| **device** | `list`, `set_target`, `enable_module` | Device management |
| **flow** | `batch`, `run`, `parallel` | Multi-step automation |

Optional: `recorder`, `autopilot`, `performance`, `visual`, `accessibility`.

### Example invocations (action syntax)

```json
// Tap screen
input(action: 'tap', x: 540, y: 1200)

// Find and tap element
ui(action: 'find_tap', text: 'Login')

// Type text
input(action: 'text', text: 'user@example.com')

// Swipe up
input(action: 'swipe', direction: 'up')

// Launch app
app(action: 'launch', package: 'com.example.auroraapp')

// Get UI accessibility tree
ui(action: 'tree')

// Wait for element
ui(action: 'wait', text: 'Welcome', timeout: 5000)

// Take screenshot
screen(action: 'capture')

// Execute command on device
system(action: 'shell', command: 'ls /home')

// List devices
device(action: 'list', platform: 'aurora')
```

---

## Example Workflows

### Workflow 1: Automate Aurora app login + verification

```
// 1. List available Aurora devices
device(action: 'list', platform: 'aurora')
→ { devices: [{ id: 'aurora-emulator-1', name: 'Aurora Emulator' }] }

// 2. Set target to Aurora
device(action: 'set_target', target: 'aurora')

// 3. Launch app
app(action: 'launch', package: 'com.example.myauroraapp')

// 4. Wait for login form
ui(action: 'wait', text: 'Login', timeout: 5000)

// 5. Fill email
ui(action: 'find_tap', text: 'Email')
input(action: 'text', text: 'aurora_user@example.com')

// 6. Fill password
ui(action: 'find_tap', text: 'Password')
input(action: 'text', text: 'AuroraPass123')

// 7. Tap login
ui(action: 'find_tap', text: 'Sign In')

// 8. Verify success
ui(action: 'wait', text: 'Dashboard', timeout: 3000)
screen(action: 'capture')
```

### Workflow 2: Cross-platform testing (Aurora + Android)

```
// 1. Enable both platforms
device(action: 'set_target', target: 'android')

// 2. Test on Android first
app(action: 'launch', package: 'com.example.myapp')
ui(action: 'wait', text: 'Welcome', timeout: 3000)
screen(action: 'capture', preset: 'low')
visual(action: 'baseline', name: 'welcome-android')

// 3. Switch to Aurora platform
device(action: 'set_target', target: 'aurora')

// 4. Run same test on Aurora
app(action: 'launch', package: 'com.example.myapp')
ui(action: 'wait', text: 'Welcome', timeout: 3000)
screen(action: 'capture', preset: 'low')

// 5. Compare visuals
device(action: 'enable_module', module: 'visual')
visual(action: 'compare', baseline: 'welcome-android')
→ { match: true/false, diff: '...' }  // Check platform consistency
```

### Workflow 3: Shell commands + log inspection

```
// 1. Set Aurora as target
device(action: 'set_target', target: 'aurora')

// 2. Execute shell command to get device info
system(action: 'shell', command: 'uname -a')
→ { output: 'Aurora Linux ...' }

// 3. Launch app
app(action: 'launch', package: 'com.example.debugapp')

// 4. Perform operation
ui(action: 'find_tap', text: 'Process Data')

// 5. Check logs for errors
system(action: 'logs', filter: 'Exception')
→ { logs: 'Output from logcat-equivalent' }

// 6. Verify no crashes
system(action: 'shell', command: 'ps aux | grep myapp')
→ Should show process still running
```

### Workflow 4: Multi-screen navigation on Aurora

```
// 1. Launch app
app(action: 'launch', package: 'com.example.navigationapp')

// 2. Navigate through screens
ui(action: 'wait', text: 'Home', timeout: 3000)
ui(action: 'find_tap', text: 'Profile')

ui(action: 'wait', text: 'User Profile', timeout: 3000)
ui(action: 'find_tap', text: 'Settings')

ui(action: 'wait', text: 'Settings', timeout: 3000)
ui(action: 'find_tap', text: 'About')

ui(action: 'wait', text: 'About App', timeout: 3000)

// 3. Verify final screen
screen(action: 'capture')

// 4. Go back
input(action: 'key', key: 'BACK')
ui(action: 'wait', text: 'Settings', timeout: 2000)
```

### Workflow 5: Performance monitoring on Aurora

```
// 1. Enable performance module
device(action: 'enable_module', module: 'performance')

// 2. Launch app and capture baseline
app(action: 'launch', package: 'com.example.myapp')
performance(action: 'snapshot', metric: 'memory')
→ { rss: 180.5, heap: 120.3 }  // MB

// 3. Perform heavy operation
ui(action: 'find_tap', text: 'Load Large Data')
ui(action: 'wait', text: 'Complete', timeout: 10000)

// 4. Capture after
performance(action: 'snapshot', metric: 'memory')
→ { rss: 320.8, heap: 250.5 }  // increased

// 5. Check system info
system(action: 'info')
→ { device: 'Aurora Emulator', os: 'Aurora Linux', ... }
```

---

## Troubleshooting

| Problem | Cause | Solution |
|---------|-------|----------|
| "Aurora SDK not found" | `audb` not installed or not in PATH | Install Aurora Flutter SDK; add to PATH |
| "No devices attached" | No emulator running or device not connected | Start Aurora emulator; check USB connection on physical device |
| "Element not found" | Text doesn't match or element doesn't exist | Use `ui(action: 'tree')` to inspect accessibility tree |
| "App not found" | Package name incorrect or app not installed | Verify package name; install app first with `app(action: 'install', ...)` |
| "Shell command fails" | Command not available or permission denied | Check command syntax; some commands may require elevated permissions |

---

## Related Documentation

- [Modules & Tools Overview](./README.md) — Architecture, profiles, module visibility
- [Android Platform](./plugin-android.md) — Similar features on Android
- [Built-in Tools Reference](./built-in-tools.md) — Full action catalog for all modules
- [Aurora Linux Project](https://gitlab.com/auroraos/) — Aurora OS official resources
