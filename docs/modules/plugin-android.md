# Platform Plugin: Android

Automate Android devices and emulators via ADB (Android Debug Bridge).

---

## Overview

Enables full-stack Android automation: screenshot, touch, text input, app lifecycle, UI traversal, shell access, sandbox introspection, and sensor/network simulation. Works with both emulators and physical devices.

## When to use it

- **UI automation:** Automate login flows, form filling, multi-screen navigation
- **App testing:** Install, launch, stop, verify app behavior across device states
- **Data inspection:** Query app preferences (SharedPreferences), SQLite databases, files
- **System simulation:** Inject GPS location, battery level, connectivity changes, notifications
- **Debugging without debugger:** Access app data and logs to troubleshoot issues
- **Performance monitoring:** Capture memory/CPU snapshots, detect crashes, measure frame rate
- **Accessibility testing:** Audit UI for WCAG violations

---

## Prerequisites

### ADB (required)

Android Debug Bridge must be installed and in `PATH`.

**Install:**

```sh
# macOS (Homebrew)
brew install android-platform-tools

# Linux (Ubuntu/Debian)
sudo apt-get install adb

# Windows (Chocolatey)
choco install adb

# Or download from Google: https://developer.android.com/studio/releases/platform-tools
```

**Verify:**

```sh
adb version
# Expected output: Android Debug Bridge version X.X.X
```

**Check status:**

```sh
mcp-devices doctor android
```

This probes for `adb`, lists connected/emulated devices, and detects issues.

### Devices

- **Emulator:** Any Android emulator (Android Studio, command-line emulator, or third-party)
- **Physical device:** USB debugging enabled (Settings → Developer Options → USB Debugging)

---

## Install & Enable

### 1. Install npm package

```sh
npm i -g @mcp-devices/plugin-android
```

### 2. Enable the platform

```sh
mcp-devices install android
```

This writes platform config to `~/.mcp-devices/config.json`.

### 3. Restart MCP server

Android platform loads on next server start.

### 4. Verify

```sh
mcp-devices platforms
# Output: "android: enabled"

mcp-devices doctor android
# Lists connected devices & checks adb
```

---

## Tools & Actions

### Core & platform-specific modules

| Module | Key Actions | Use |
|--------|-------------|-----|
| **input** | `tap` (coords), `double_tap`, `long_press`, `swipe` (direction/coords), `text`, `key` | Touch gestures, text entry, key presses |
| **ui** | `tree` (accessibility), `find` (element search), `find_tap`, `tap_text`, `wait` (element appear), `assert_visible`, `assert_gone` | Element location, assertions, waits |
| **app** | `launch` (bundleId), `stop`, `install`, `list` | App lifecycle |
| **system** | `shell` (execute command), `logs` (filter), `clipboard_*`, `permission_grant/revoke/reset`, `file_push/pull`, `metrics` | Low-level control, data access |
| **screen** | `capture` (screenshot), `annotate` (bounding boxes) | Visual inspection |
| **device** | `list`, `set_target`, `enable_module`, `disable_module` | Target management |
| **flow** | `batch` (atomic), `run` (sequential), `parallel` | Multi-step orchestration |
| **intent** (Android only) | `start` (Intent), `broadcast`, `deeplink`, `services` | Deep linking, broadcasts, typed extras |
| **sandbox** (Android only) | `prefs_read` (SharedPrefs), `prefs_write`, `sqlite_query`, `file_list`, `file_read` | App data access via run-as |
| **sensor** (Android only) | `location` (GPS), `battery`, `notifications`, `thermal` | Environment simulation |
| **network** (Android only) | `traffic` (stats), `connectivity`, `proxy`, `airplane` | Network control & monitoring |

Optional: `recorder`, `autopilot`, `performance`, `visual`, `accessibility`.

### Example invocations (action syntax)

```json
// Tap at screen coordinates
input(action: 'tap', x: 540, y: 1200)

// Tap button by text
ui(action: 'find_tap', text: 'Login')

// Type text into focused field
input(action: 'text', text: 'user@example.com')

// Press back key
input(action: 'key', key: 'BACK')

// Swipe up
input(action: 'swipe', direction: 'up')

// Launch app by bundle ID
app(action: 'launch', package: 'com.example.myapp')

// Take screenshot
screen(action: 'capture', preset: 'low')

// Get UI tree
ui(action: 'tree')

// Execute shell command
system(action: 'shell', command: 'pm list packages')

// Check if element is visible
ui(action: 'assert_visible', text: 'Welcome')

// Deep link with extras
intent(action: 'start', action: 'android.intent.action.VIEW', uri: 'myapp://home?id=123')

// Query SQLite
sandbox(action: 'sqlite_query', package: 'com.example.myapp', db: 'mydata.db', query: 'SELECT * FROM users LIMIT 5')

// Set GPS location
sensor(action: 'location', latitude: 37.7749, longitude: -122.4194)

// Enable airplane mode
network(action: 'airplane', enable: true)
```

---

## Example Workflows

### Workflow 1: Automate a login + verify success

```
// 1. Launch app
app(action: 'launch', package: 'com.example.banking')
→ App starts

// 2. Wait for login form
ui(action: 'wait', text: 'Email', timeout: 5000)
→ Waits up to 5s for "Email" field

// 3. Tap email field and type
ui(action: 'find_tap', text: 'Email')
input(action: 'text', text: 'alice@example.com')

// 4. Tap password field
ui(action: 'find_tap', text: 'Password')
input(action: 'text', text: 'secretpass')

// 5. Tap Login button
ui(action: 'find_tap', text: 'Login')

// 6. Wait for home screen
ui(action: 'wait', text: 'My Accounts', timeout: 3000)

// 7. Capture screenshot
screen(action: 'capture')

// 8. Verify success (enable visual module first)
device(action: 'enable_module', module: 'visual')
visual(action: 'baseline', name: 'home-screen')
→ Screenshot baseline created
```

### Workflow 2: Inspect and modify app data (SharedPreferences)

```
// 1. Launch app in debuggable mode
app(action: 'launch', package: 'com.example.myapp')

// 2. Read user preferences
sandbox(action: 'prefs_read', package: 'com.example.myapp', file: 'user_prefs.xml')
→ Returns XML content, e.g. { theme: 'dark', notif_enabled: 'true' }

// 3. Modify a preference
sandbox(action: 'prefs_write', package: 'com.example.myapp', file: 'user_prefs.xml', key: 'theme', value: 'light')

// 4. Verify change by reading back
sandbox(action: 'prefs_read', package: 'com.example.myapp', file: 'user_prefs.xml')
→ theme is now 'light'

// 5. Check app reacts (capture screen)
system(action: 'wait', seconds: 1)
screen(action: 'capture')
→ Should show app with light theme
```

### Workflow 3: Test deep linking with location injection

```
// 1. Inject GPS coordinates
sensor(action: 'location', latitude: 40.7128, longitude: -74.0060)
→ Device reports user is in New York

// 2. Deep link into app with location context
intent(action: 'deeplink', uri: 'myapp://locations/nearby')

// 3. Wait for location-specific UI
ui(action: 'wait', text: 'Nearby Restaurants', timeout: 3000)

// 4. Verify location was received (check logs)
system(action: 'logs', filter: 'LocationManager')
→ Logs show location was injected

// 5. Capture result
screen(action: 'capture')
```

### Workflow 4: Network simulation (offline, proxy)

```
// 1. Disable connectivity
network(action: 'connectivity', enabled: false)
→ Device is now offline

// 2. Launch app and observe offline behavior
app(action: 'launch', package: 'com.example.myapp')
ui(action: 'wait', text: 'Offline', timeout: 2000)
screen(action: 'capture')

// 3. Re-enable connectivity
network(action: 'connectivity', enabled: true)

// 4. Trigger sync and observe recovery
system(action: 'shell', command: 'am broadcast -a com.example.SYNC')
ui(action: 'wait', text: 'Synced', timeout: 5000)
screen(action: 'capture')
```

---

## Troubleshooting

| Problem | Cause | Solution |
|---------|-------|----------|
| "adb: command not found" | `adb` not installed or not in PATH | Install Android SDK Platform Tools; add to PATH |
| "no devices attached" | No emulator/device connected or not recognized | `adb devices` to list; enable USB debugging on physical device; start emulator |
| "Permission denied: run-as" | App not debuggable or package name incorrect | Verify `android:debuggable=true` in manifest; check package name |
| "Element not found" | Element text is different or doesn't exist in UI | Use `ui(action: 'tree')` to inspect accessibility tree; check text/id/label |
| "Shell command timeout" | Command takes too long or hangs | Increase timeout or break command into smaller steps |
| "Screenshot blank" | Device locked or in power-saving mode | Unlock device; wake with key press (e.g., `input(action: 'key', key: 'POWER')`) |

---

## Related Documentation

- [Modules & Tools Overview](./README.md) — Architecture, module visibility, profiles
- [Built-in Tools Reference](./built-in-tools.md) — Full action catalog for all 20 modules
- [iOS Platform](./plugin-ios.md) — Similar features for iOS
- [Web Platform](./plugin-web.md) — Browser automation via Chrome DevTools Protocol
- [Debug Plugin](./plugin-debug.md) — White-box runtime debugging (JDWP)
