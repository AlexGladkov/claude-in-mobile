# Platform Plugin: iOS

Automate iOS Simulator and physical iOS devices via simctl, WebDriverAgent, and go-ios.

---

## Overview

Full iOS automation: screenshots, touch gestures, text input, app lifecycle, UI accessibility tree, system logs, and performance monitoring. Supports both Simulator and physical devices.

## When to use it

- **UI automation:** Automate app workflows on iOS (signup, login, multi-screen flows)
- **Regression testing:** Run interaction tests across iOS versions & device models
- **Performance profiling:** Capture memory/CPU snapshots, detect crashes, measure frame rates
- **Accessibility audit:** Check app for WCAG compliance on iOS
- **Debug + test:** Combine UI automation with debugger (LLDB) to inspect crashes
- **Physical device testing:** Verify behavior on real devices (not just Simulator)

---

## Prerequisites

### Xcode Command Line Tools (required)

Required for all iOS automation (Simulator and physical devices).

**Install:**

```sh
xcode-select --install
```

**Verify:**

```sh
xcrun -h
# Expected: usage: xcrun [options] <utility name> ...
```

**Check status:**

```sh
mcp-devices doctor ios
```

This verifies Xcode CLT is installed and lists available simulators.

### go-ios (required for physical devices only)

If you plan to automate **physical iOS devices**, also install go-ios:

```sh
npm i -g go-ios
```

Not required for Simulator-only automation.

### Devices

- **Simulator:** Any iOS Simulator (created in Xcode) — must be **booted** before automation
- **Physical device:** Connected via USB with trust configured; requires `go-ios`

---

## Install & Enable

### 1. Install npm package

```sh
npm i -g @mcp-devices/plugin-ios
```

### 2. Enable the platform

```sh
mcp-devices install ios
```

### 3. Restart MCP server

iOS platform loads on next server start.

### 4. Verify

```sh
mcp-devices platforms
# Output: "ios: enabled"

mcp-devices doctor ios
# Lists available simulators & physical devices
```

---

## Tools & Actions

iOS uses the same core modules as Android, plus optional testing modules:

| Module | Key Actions | Use |
|--------|-------------|-----|
| **input** | `tap`, `double_tap`, `long_press`, `swipe`, `text`, `key` | Touch gestures, text input, keyboard |
| **ui** | `tree`, `find`, `find_tap`, `tap_text`, `wait`, `assert_visible`, `assert_gone` | Element location, assertions, waits |
| **app** | `launch` (bundleId), `stop`, `install`, `list` | App lifecycle |
| **system** | `shell`, `logs`, `clipboard_*`, `permission_grant/revoke`, `file_push/pull`, `metrics` | Low-level control, data access |
| **screen** | `capture`, `annotate` | Screenshots |
| **device** | `list`, `set_target`, `enable_module` | Target/device management |
| **flow** | `batch`, `run`, `parallel` | Multi-step automation |

Optional: `recorder`, `autopilot`, `performance`, `visual`, `accessibility`.

### Example invocations (action syntax)

```json
// Tap by coordinates
input(action: 'tap', x: 200, y: 400)

// Find element by label and tap
ui(action: 'find_tap', label: 'Sign In')

// Type text into focused field
input(action: 'text', text: 'alice@icloud.com')

// Swipe up (page scroll)
input(action: 'swipe', direction: 'up')

// Launch app by bundle ID
app(action: 'launch', package: 'com.example.myapp')

// Wait for element
ui(action: 'wait', label: 'Home', timeout: 5000)

// Get accessibility tree
ui(action: 'tree')

// Check element visibility
ui(action: 'assert_visible', label: 'Welcome Message')

// Take screenshot
screen(action: 'capture', preset: 'low')

// Execute shell command on device
system(action: 'shell', command: 'ls /tmp')
```

---

## Example Workflows

### Workflow 1: Test iOS app signup flow

```
// 1. Launch app
app(action: 'launch', package: 'com.example.myapp')

// 2. Wait for signup button
ui(action: 'wait', label: 'Sign Up', timeout: 5000)

// 3. Tap Sign Up
ui(action: 'find_tap', label: 'Sign Up')

// 4. Fill email field
ui(action: 'find_tap', label: 'Email')
input(action: 'text', text: 'test@example.com')

// 5. Fill password field
ui(action: 'find_tap', label: 'Password')
input(action: 'text', text: 'MySecurePass123')

// 6. Fill confirm password
ui(action: 'find_tap', label: 'Confirm Password')
input(action: 'text', text: 'MySecurePass123')

// 7. Tap Sign Up button
ui(action: 'find_tap', label: 'Create Account')

// 8. Verify success page
ui(action: 'wait', label: 'Welcome', timeout: 3000)
screen(action: 'capture')
```

### Workflow 2: Screenshot comparison (visual regression)

```
// 1. Launch app
app(action: 'launch', package: 'com.example.myapp')

// 2. Navigate to screen to test
ui(action: 'find_tap', label: 'Profile')
ui(action: 'wait', label: 'User Info', timeout: 3000)

// 3. Enable visual module
device(action: 'enable_module', module: 'visual')

// 4. Capture and set baseline
screen(action: 'capture', preset: 'medium')
visual(action: 'baseline', name: 'profile-screen-v1')

// 5. Make changes (tap edit, modify something, save)
ui(action: 'find_tap', label: 'Edit')
ui(action: 'find_tap', label: 'Name')
input(action: 'key', key: 'DELETE')  // clear field
input(action: 'text', text: 'New Name')
ui(action: 'find_tap', label: 'Save')

// 6. Capture new screenshot
screen(action: 'capture', preset: 'medium')

// 7. Compare against baseline
visual(action: 'compare', baseline: 'profile-screen-v1')
→ { match: false, diff: 'Name field changed' }  // expected
```

### Workflow 3: Performance profiling on physical device

```
// 1. List devices
device(action: 'list', platform: 'ios')
→ Lists simulators & physical devices

// 2. Set target to physical device (by name)
device(action: 'set_target', target: 'ios', deviceId: 'iPhone-15-Pro')

// 3. Launch app
app(action: 'launch', package: 'com.example.myapp')

// 4. Enable performance module
device(action: 'enable_module', module: 'performance')

// 5. Capture memory snapshot before heavy operation
performance(action: 'snapshot', metric: 'memory')
→ { rss: 120.5, heap: 95.2 }  // in MB

// 6. Interact with app (heavy operation)
ui(action: 'find_tap', label: 'Load Data')
ui(action: 'wait', label: 'Complete', timeout: 10000)

// 7. Capture after snapshot
performance(action: 'snapshot', metric: 'memory')
→ { rss: 185.3, heap: 150.8 }  // memory increased

// 8. Check if crash occurred
system(action: 'logs', filter: 'Exception')
```

### Workflow 4: Combine UI automation + LLDB debugging

```
// 1. Attach debugger (iOS LLDB)
debug_attach(platform: 'ios', app: 'com.example.myapp', launch: true)
→ { sessionId: 'session-ios-1' }

// 2. Set breakpoint at method
debug_break(sessionId: 'session-ios-1', method: 'handleUserTap', file: 'ViewController.swift', line: 42)
→ { id: 'bp-1', verified: true }

// 3. Automate user interaction (in UI)
ui(action: 'find_tap', label: 'Tap Me')

// 4. Breakpoint hits
debug_poll(sessionId: 'session-ios-1', cursor: 0)
→ { events: [{ kind: 'BREAKPOINT_HIT', threadId: '1' }], nextCursor: 1 }

// 5. Inspect state
debug_pause_state(sessionId: 'session-ios-1', threadId: '1')
→ Shows stack frames & locals

// 6. Resume and finish
debug_resume(sessionId: 'session-ios-1')
```

---

## Troubleshooting

| Problem | Cause | Solution |
|---------|-------|----------|
| "Xcode not installed" | `xcrun` not found | Run `xcode-select --install` |
| "No simulators available" | No iOS Simulator created | Open Xcode → Device Manager → Create simulator |
| "Simulator not booted" | Simulator closed | Boot simulator: `open /Applications/Xcode.app/Contents/Developer/Applications/Simulator.app` |
| "go-ios not found" | Required for physical devices, not installed | `npm i -g go-ios` |
| "Device trust not configured" | Physical device doesn't trust computer | Unlock device & tap "Trust" when USB connected |
| "Element not found" | Accessibility label different or element hidden | Use `ui(action: 'tree')` to inspect label text |

---

## Related Documentation

- [Modules & Tools Overview](./README.md) — Architecture, profiles, module visibility
- [Android Platform](./plugin-android.md) — Similar features for Android
- [Debug Plugin](./plugin-debug.md) — LLDB debugging for iOS
- [Built-in Tools Reference](./built-in-tools.md) — Full action catalog
