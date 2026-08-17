# Platform Plugin: Desktop

Automate desktop applications (Compose, Swing, JavaFX). Includes window management, app lifecycle, clipboard, and performance monitoring. Supports multi-monitor setups.

---

## Overview

Desktop app automation via a Java companion. Control app windows, interact with UI, manage clipboard, monitor performance, and handle multi-monitor environments.

## When to use it

- **Desktop app testing:** Automate Compose/Swing/JavaFX app workflows
- **Window management:** Control window focus, size, position across multiple monitors
- **Clipboard testing:** Verify copy/paste functionality
- **Performance monitoring:** Capture CPU/memory snapshots, detect crashes
- **Multi-monitor testing:** Verify app behavior on different monitor configurations
- **UI automation:** Combined with touch/keyboard input for end-to-end testing

---

## Prerequisites

### Java Development Kit (JDK)

Required for the desktop companion and app control.

**Install:**

```sh
# macOS (Homebrew)
brew install openjdk

# Linux (Ubuntu/Debian)
sudo apt-get install openjdk-17-jdk

# Windows (Chocolatey)
choco install openjdk

# Or download from oracle.com / adoptopenjdk.net
```

**Verify:**

```sh
java -version
# Expected: openjdk version "17.x.x" or similar
```

**Check status:**

```sh
mcp-devices doctor desktop
```

This verifies JDK is installed and accessible.

---

## Install & Enable

### 1. Install npm package

```sh
npm i -g @mcp-devices/plugin-desktop@dev
```

### 2. Enable the platform

```sh
mcp-devices install desktop
```

### 3. Restart MCP server

Desktop platform loads on next server start.

### 4. Verify

```sh
mcp-devices platforms
# Output: "desktop: enabled"

mcp-devices doctor desktop
# Checks JDK availability
```

---

## Tools & Actions

Desktop platform uses core modules + `desktop` (desktop-specific):

| Module | Key Actions | Use |
|--------|-------------|-----|
| **desktop** (desktop-specific) | `launch`, `stop`, `windows`, `focus`, `resize`, `clipboard_get/set`, `performance`, `monitors` | Desktop app & window control |
| **input** | `tap` (click), `text`, `key`, `swipe` (scroll) | Mouse/keyboard input |
| **ui** | `tree` (accessibility), `find`, `find_tap`, `assert_visible` | UI element inspection & assertions |
| **screen** | `capture`, `annotate` | Screenshots |
| **system** | `shell`, `clipboard_*`, `metrics` | System-level operations |
| **device** | `list`, `set_target`, `enable_module` | Device/window management |
| **flow** | `batch`, `run`, `parallel` | Multi-step automation |

Optional: `recorder`, `performance`, `visual`, `accessibility`, `autopilot`.

### Example invocations (action syntax)

```json
// Launch desktop app by name or process
desktop(action: 'launch', app: 'MyApp')

// List running windows
desktop(action: 'windows')
→ { windows: [{ id: 'w-1', title: 'MyApp - Main Window', bounds: {...} }] }

// Focus window
desktop(action: 'focus', windowId: 'w-1')

// Resize window
desktop(action: 'resize', windowId: 'w-1', width: 800, height: 600)

// Get clipboard content
desktop(action: 'clipboard_get')
→ { text: 'clipboard content' }

// Set clipboard content
desktop(action: 'clipboard_set', text: 'new text')

// Get monitor configuration
desktop(action: 'monitors')
→ { monitors: [{ index: 0, width: 1920, height: 1080, x: 0, y: 0 }] }

// Click element
input(action: 'tap', x: 400, y: 300)

// Type text
input(action: 'text', text: 'Hello Desktop')

// Take screenshot
screen(action: 'capture')

// Inspect UI tree
ui(action: 'tree')

// Find button by text and click
ui(action: 'find_tap', text: 'OK')
```

---

## Example Workflows

### Workflow 1: Multi-window app testing

```
// 1. Launch desktop app
desktop(action: 'launch', app: 'MyDesktopApp')

// 2. List windows
desktop(action: 'windows')
→ { windows: [
     { id: 'w-1', title: 'Main Window' },
     { id: 'w-2', title: 'Settings' }
   ] }

// 3. Focus main window
desktop(action: 'focus', windowId: 'w-1')

// 4. Interact with focused window
ui(action: 'wait', text: 'Load Data', timeout: 3000)
ui(action: 'find_tap', text: 'Load Data')

// 5. Verify result in different window
desktop(action: 'focus', windowId: 'w-2')
ui(action: 'assert_visible', text: 'Settings Loaded')

// 6. Screenshot both
screen(action: 'capture')
```

### Workflow 2: Monitor-aware testing (multi-monitor)

```
// 1. Get monitor configuration
desktop(action: 'monitors')
→ { monitors: [
     { index: 0, width: 1920, height: 1080, x: 0, y: 0 },      // main
     { index: 1, width: 1920, height: 1080, x: 1920, y: 0 }    // secondary
   ] }

// 2. Launch app on primary monitor
desktop(action: 'launch', app: 'MyApp')

// 3. Get window info
desktop(action: 'windows')
→ { windows: [{ id: 'w-1', title: 'MyApp', bounds: { x: 100, y: 100, width: 800, height: 600 } }] }

// 4. Move window to secondary monitor
// Calculate offset (1920 + 100 = 2020 on secondary)
desktop(action: 'move', windowId: 'w-1', x: 2020, y: 100)

// 5. Verify window is on secondary
desktop(action: 'windows')
→ Confirm bounds show x > 1920

// 6. Screenshot to verify display
screen(action: 'capture')
```

### Workflow 3: Clipboard testing

```
// 1. Launch app
desktop(action: 'launch', app: 'TextEditor')

// 2. Set clipboard content
desktop(action: 'clipboard_set', text: 'Hello Clipboard World')

// 3. Paste into app
input(action: 'key', key: 'CTRL+V')

// 4. Wait for paste
system(action: 'wait', seconds: 1)

// 5. Select all and copy
input(action: 'key', key: 'CTRL+A')
input(action: 'key', key: 'CTRL+C')

// 6. Verify clipboard changed
desktop(action: 'clipboard_get')
→ { text: 'Hello Clipboard World' }  // or modified version if app changed it
```

### Workflow 4: Performance monitoring

```
// 1. Enable performance module
device(action: 'enable_module', module: 'performance')

// 2. Launch app
desktop(action: 'launch', app: 'HeavyApp')

// 3. Capture baseline memory
performance(action: 'snapshot', metric: 'memory')
→ { rss: 250.5, heap: 180.3 }  // MB

// 4. Perform heavy operation
ui(action: 'find_tap', text: 'Process Large File')
ui(action: 'wait', text: 'Complete', timeout: 30000)

// 5. Capture after operation
performance(action: 'snapshot', metric: 'memory')
→ { rss: 450.8, heap: 350.2 }  // increased

// 6. Check for crashes
system(action: 'logs', filter: 'Exception')
```

### Workflow 5: Window resize + interaction

```
// 1. Launch app
desktop(action: 'launch', app: 'MyApp')

// 2. Get initial window size
desktop(action: 'windows')
→ { windows: [{ id: 'w-1', bounds: { width: 1024, height: 768 } }] }

// 3. Resize to smaller
desktop(action: 'resize', windowId: 'w-1', width: 640, height: 480)

// 4. Verify responsive UI
screen(action: 'capture')

// 5. Interact in resized window
ui(action: 'find_tap', text: 'Submit')

// 6. Resize larger
desktop(action: 'resize', windowId: 'w-1', width: 1280, height: 960)

// 7. Verify UI adapts
screen(action: 'capture')
```

---

## Troubleshooting

| Problem | Cause | Solution |
|---------|-------|----------|
| "JDK not found" | Java not installed or not in PATH | Install OpenJDK/Oracle JDK; add to PATH |
| "App not found" | Application name incorrect or not installed | Verify app name; use absolute path if needed |
| "Window not found" | Window closed or ID stale | List windows again with `desktop(action: 'windows')` |
| "Click not working" | Window not focused or coordinates outside bounds | Focus window first; verify coordinates are within window bounds |
| "Clipboard operations fail" | Permission denied | May need elevated permissions on some systems |
| "Multi-monitor offset incorrect" | Monitor coordinates not accounted | Use `desktop(action: 'monitors')` to get exact offsets |

---

## Related Documentation

- [Modules & Tools Overview](./README.md) — Architecture, profiles, module visibility
- [Built-in Tools Reference](./built-in-tools.md) — Full action catalog for all modules
- [Web Platform](./plugin-web.md) — For web-based desktop apps
