# mcp-devices 4.0.0

> **MCP server for device automation.** Automate mobile (Android, iOS), web (Chrome/Chromium), desktop (Compose), and Aurora OS applications + runtime debugging. Modular, plugin-based, on-demand installation.

**New in 4.0:** Rebranded from `claude-in-mobile` (3.x). Slim base + on-demand platforms. Pick only what you need.

---

## Why mcp-devices

Automate across platforms without platform-specific scripts. Single MCP server handles:
- **Mobile:** Android (ADB) + iOS (simctl, WebDriverAgent) — screenshots, gestures, app control, sandbox access
- **Web:** Chrome DevTools Protocol — DOM navigation, JS evaluation, network inspect, cookies
- **Desktop:** Compose apps — window management, performance monitoring
- **Aurora OS:** Flutter-based applications
- **Runtime debugging:** JDWP (Android) + LLDB (iOS) — breakpoints, step, locals, expression eval
- **Testing:** Visual regression, accessibility audit, performance baselines, sensor/network simulation

Single agent can orchestrate multi-platform tests, combine UI automation with white-box debugging, and generate structured test reports.

---

## Quickstart (5 minutes)

### 1. Install base

```sh
npm i -g mcp-devices@dev
```

### 2. Install a platform

Choose one:

```sh
# Android (requires adb)
npm i -g @mcp-devices/plugin-android@dev
mcp-devices install android
mcp-devices doctor android  # verify adb is available

# iOS (requires xcrun)
npm i -g @mcp-devices/plugin-ios@dev
mcp-devices install ios
mcp-devices doctor ios

# Web (requires Chrome/Chromium)
npm i -g @mcp-devices/plugin-web@dev
mcp-devices install web

# All platforms
npm i -g @mcp-devices/plugin-all@dev
mcp-devices install all
```

### 3. Configure MCP client

Point your Claude client or MCP client at mcp-devices:

```jsonc
{
  "mcpServers": {
    "mobile": {
      "command": "mcp-devices"
    }
  }
}
```

Restart your MCP client.

### 4. Try it: capture a screenshot

On Android:

```
Input: device(action: 'list')
→ Returns available devices (e.g., emulator-5554)

Input: device(action: 'set_target', target: 'android')
→ Switches to android platform

Input: screen(action: 'capture')
→ Returns base64 PNG screenshot
```

Or via Claude, ask: _"Take a screenshot of my Android device and highlight the Login button."_

---

## Install & Setup

### Base package

```sh
npm i -g mcp-devices@dev
```

### Platforms (choose what you need)

| Platform | Package | Prerequisite | Enable |
|----------|---------|--------------|--------|
| Android | `@mcp-devices/plugin-android@dev` | `adb` (platform-tools) | `mcp-devices install android` |
| iOS | `@mcp-devices/plugin-ios@dev` | `xcrun` (Xcode CLT); `go-ios` for physical | `mcp-devices install ios` |
| Web | `@mcp-devices/plugin-web@dev` | Chrome/Chromium | `mcp-devices install web` |
| Desktop | `@mcp-devices/plugin-desktop@dev` | Java/JDK | `mcp-devices install desktop` |
| Aurora | `@mcp-devices/plugin-aurora@dev` | `flutter-aurora` (Aurora Flutter SDK) | `mcp-devices install aurora` |
| All | `@mcp-devices/plugin-all@dev` | All of above | `mcp-devices install all` |

### CLI help

```sh
mcp-devices --help                  # overall help
mcp-devices platforms               # list enabled/available
mcp-devices doctor [platform...]    # check prerequisites
mcp-devices install <name|all>      # enable platform(s)
mcp-devices uninstall <name>        # disable platform(s)
```

Configuration saves to `~/.mcp-devices/config.json`; override per-run with `MCP_DEVICES_PLATFORMS=ios,web`.

---

## Modules & Tools (three types)

Full reference: [docs/modules/](./docs/modules/README.md)

### 1. Platform plugins

5 platform packages (Android, iOS, Web, Desktop, Aurora). Install and enable on demand.

Example (Android):

```
input(action: 'tap', x: 540, y: 1200)        # tap screen at x,y
ui(action: 'find_tap', text: 'Login')        # find and tap element by text
app(action: 'launch', package: 'com.example.app')  # launch app
```

### 2. Tool plugins

Debug plugin for runtime inspection (12 tools, JDWP + LLDB):

```
debug_attach(platform: 'android', app: 'com.example.myapp')
# → { sessionId: "session-123" }

debug_break(sessionId: "session-123", className: "com.example.MainActivity", line: 45)
# → { id: "bp-1", verified: true }

debug_poll(sessionId: "session-123", cursor: 0)
# → { events: [{ kind: "BREAKPOINT_HIT", threadId: "1" }], nextCursor: 1 }

debug_eval(sessionId: "session-123", threadId: "1", expr: "count + 1")
# → { value: "43" }
```

Enable via `MCP_DEVICES_TOOL_PLUGINS=debug` or config file.

### 3. Built-in tools (20 modules, bundled)

Core modules (always available):
- `device` — target switching, module loading
- `screen` — screenshots, annotation, diff
- `input` — tap, swipe, text, key press
- `ui` — tree traversal, element search, assertions
- `app` — launch, stop, install, list apps
- `system` — shell, logs, clipboard, permissions, files
- `flow` — batch/parallel command execution

Platform-specific (load on demand or via profile):
- `browser` — navigation, JS eval, tabs, cookies, network
- `desktop` — windows, focus, resize, clipboard
- `intent` — Android deep linking, broadcasts
- `store` — app store metadata (Android/iOS)

Testing (load on demand):
- `visual` — visual regression baseline + compare
- `accessibility` — WCAG audit
- `performance` — memory/CPU snapshots, crash tracking
- `sandbox` — app data access (SharedPrefs, SQLite, files — Android only)
- `sensor` — GPS, battery, notifications, thermal
- `network` — traffic, connectivity, proxy, airplane mode

Automation (load on demand):
- `recorder` — record/replay gesture sequences
- `sync` — multi-device broadcast
- `autopilot` — AI-driven test generation

---

## Usage Examples

### Scenario 1: Android UI Automation

_Task: Automate a login flow on Android._

```
1. Launch app:
   app(action: 'launch', package: 'com.example.myapp')

2. Wait for UI to settle:
   ui(action: 'wait', text: 'Email', timeout: 5000)

3. Tap email field and type:
   ui(action: 'find_tap', text: 'Email')
   input(action: 'text', text: 'user@example.com')

4. Tap password field:
   ui(action: 'find_tap', text: 'Password')
   input(action: 'text', text: 'mypassword')

5. Tap Login button:
   ui(action: 'find_tap', text: 'Login')

6. Verify success (optional — enable visual regression):
   device(action: 'enable_module', module: 'visual')
   screen(action: 'capture')
   visual(action: 'compare', baseline: 'login-success')
```

### Scenario 2: iOS Debug Session

_Task: Debug a crash in a live iOS app — inspect variables at a breakpoint._

```
1. Attach debugger:
   debug_attach(platform: 'ios', app: 'com.mycompany.myapp', launch: true)
   → { sessionId: "session-456" }

2. Set breakpoint at method entry:
   debug_break(sessionId: "session-456", method: "ContentView", line: 42)
   → { id: "bp-1", verified: true }

3. Trigger the crash manually, then poll:
   debug_poll(sessionId: "session-456", cursor: 0)
   → { events: [{ kind: "BREAKPOINT_HIT", threadId: "1" }], nextCursor: 1 }

4. Inspect call stack + locals:
   debug_pause_state(sessionId: "session-456", threadId: "1")
   → { frames: [...], locals: [{ name: "user", type: "User", value: "{id: \"123\", name: \"Alice\"}" }] }

5. Evaluate expression:
   debug_eval(sessionId: "session-456", threadId: "1", expr: "user.name")
   → { value: "Alice" }

6. Resume and continue:
   debug_resume(sessionId: "session-456")
```

### Scenario 3: Web Visual Regression

_Task: Compare a web page screenshot against a baseline._

```
1. Navigate:
   browser(action: 'navigate', url: 'https://myapp.com/pricing')

2. Wait for render:
   system(action: 'wait', seconds: 2)

3. Capture with low quality (faster):
   screen(action: 'capture', preset: 'low')

4. Enable visual module + compare:
   device(action: 'enable_module', module: 'visual')
   visual(action: 'baseline', name: 'pricing-page')
   visual(action: 'compare', baseline: 'pricing-page')
   → { match: true } or { match: false, diff: "..." }
```

---

## Configuration

### Environment Variables

```sh
# Override enabled platforms per-run (comma-separated or 'all' / 'none')
MCP_DEVICES_PLATFORMS=android,ios mcp-devices

# Enable debug plugin
MCP_DEVICES_TOOL_PLUGINS=debug mcp-devices

# Set startup module visibility profile (minimal, core, android, web, full)
MOBILE_PROFILE=full mcp-devices
```

### Config File

`~/.mcp-devices/config.json` (created by `mcp-devices install`):

```json
{
  "platforms": ["android", "web"],
  "tool_plugins": ["debug"],
  "profile": "full"
}
```

---

## Module Visibility & Profiles

By default `device` and `screen` are always visible. Other modules are **hidden** until enabled.

### Startup profiles

```sh
MOBILE_PROFILE=minimal mcp-devices     # device + screen only
MOBILE_PROFILE=core mcp-devices        # + input, ui, app, system, flow (default)
MOBILE_PROFILE=android mcp-devices     # alias for core
MOBILE_PROFILE=web mcp-devices         # core + browser
MOBILE_PROFILE=full mcp-devices        # all 20 modules
```

### Runtime control

Enable/disable modules on-the-fly:

```
device(action: 'enable_module', module: 'visual')
device(action: 'disable_module', module: 'recorder')
device(action: 'list_modules')
```

---

## Status & Caveats (4.0.0)

- **Pre-release** — published under npm dist-tag `dev`
- **Modular** — base is slim; platforms split into separate packages (no bloat)
- **On-demand** — install and enable only what you need
- **Linux/macOS/Windows** — builds for all platforms
- Tool plugins (debug) not yet in `mcp-devices install` — enable via env var or config file
- **Stable production (3.x)** — `npm i -g claude-in-mobile` (single monolithic package)

---

## Documentation

- [Modules & Tools Overview](./docs/modules/README.md) — Architecture, types, profiles
- [Platform: Android](./docs/modules/plugin-android.md) — ADB-based automation, app sandbox access
- [Platform: iOS](./docs/modules/plugin-ios.md) — Simulator + physical device support
- [Platform: Web](./docs/modules/plugin-web.md) — Chrome DevTools Protocol, DOM automation
- [Platform: Desktop](./docs/modules/plugin-desktop.md) — Compose app control, multi-monitor support
- [Platform: Aurora](./docs/modules/plugin-aurora.md) — Flutter-based Aurora OS automation
- [Plugin: Debug](./docs/modules/plugin-debug.md) — Runtime debugging (JDWP + LLDB, 12 tools)
- [Built-in Tools Reference](./docs/modules/built-in-tools.md) — Full action catalog
