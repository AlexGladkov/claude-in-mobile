# Modules & Tools Architecture

mcp-devices 4.0 is modular and plugin-based. Three types:

1. **Platform plugins** — Device platforms (Android, iOS, Web, Desktop, Aurora) as separate npm packages
2. **Tool plugins** — Specialized tools (runtime debugging via Debug plugin)
3. **Built-in tools** — 20 core modules bundled in base, hidden/shown via profile or runtime control

---

## Platform Plugins

Extend mcp-devices to support specific device platforms. **By default no platforms are loaded** — install and enable only what you need.

### Installation workflow

1. **Install npm package:**
   ```sh
   npm i -g @mcp-devices/plugin-<name>@dev
   ```

2. **Enable platform (writes to `~/.mcp-devices/config.json`):**
   ```sh
   mcp-devices install <name>
   ```

3. **Verify toolchain (external dependencies):**
   ```sh
   mcp-devices doctor <name>
   ```

4. **Restart MCP server** — platform loads on next start.

### Platform matrix

| Platform | Package | Covers | Prerequisite | Enable |
|----------|---------|--------|------|--------|
| **Android** | `@mcp-devices/plugin-android` | ADB-based device automation, app sandbox access, sensor/network simulation | `adb` (Android platform-tools) | `mcp-devices install android` |
| **iOS** | `@mcp-devices/plugin-ios` | Simulator + physical device (simctl, WebDriverAgent, go-ios) | `xcrun` (Xcode CLT); `go-ios` for physical | `mcp-devices install ios` |
| **Web** | `@mcp-devices/plugin-web` | Chrome/Chromium via Chrome DevTools Protocol (CDP) | Chrome/Chromium (auto-launched) | `mcp-devices install web` |
| **Desktop** | `@mcp-devices/plugin-desktop` | Compose desktop apps, window management, multi-monitor support | Java/JDK | `mcp-devices install desktop` |
| **Aurora** | `@mcp-devices/plugin-aurora` | Aurora OS flutter-based applications (audb transport) | `flutter-aurora` (Aurora Flutter SDK) | `mcp-devices install aurora` |
| **All** | `@mcp-devices/plugin-all` | Meta-package: installs all five platforms | All of above | `mcp-devices install all` |

### Per-run override

Override enabled platforms without reconfiguring:

```sh
# Load only android + web for this run
MCP_DEVICES_PLATFORMS=android,web mcp-devices

# Load all platforms
MCP_DEVICES_PLATFORMS=all mcp-devices

# Load nothing (base only)
MCP_DEVICES_PLATFORMS=none mcp-devices
```

**Resolution order:** `MCP_DEVICES_PLATFORMS` env var → `~/.mcp-devices/config.json` → base only (no platforms).

### Platform documentation

- [Android](./plugin-android.md) — ADB automation, deep linking, sandbox, sensors
- [iOS](./plugin-ios.md) — Simulator + physical device automation
- [Web](./plugin-web.md) — Chrome DevTools Protocol, DOM/JS automation
- [Desktop](./plugin-desktop.md) — Window & app control, performance monitoring
- [Aurora](./plugin-aurora.md) — Flutter-based OS automation

---

## Tool Plugins

Specialized functionality beyond platform support. Currently: runtime debugging (JDWP + LLDB).

### Debug plugin

**Purpose:** White-box debugging of live apps — breakpoints, step execution, variable inspection, expression evaluation.

| Aspect | Details |
|--------|---------|
| **Package** | `@mcp-devices/plugin-debug` |
| **Platforms** | Android (JDWP) + iOS (LLDB) |
| **Tools** | 12 standalone tools: `debug_attach`, `debug_break`, `debug_poll`, `debug_pause_state`, `debug_eval`, `debug_set_var`, `debug_step`, `debug_resume`, `debug_detach`, `debug_sessions`, `debug_threads`, `debug_remove_break` |
| **Requirements** | App must be built with `debuggable=true` |
| **Enable** | `MCP_DEVICES_TOOL_PLUGINS=debug` or config file (not yet in `mcp-devices install`) |

### Installation & enablement

```sh
# Install
npm i -g @mcp-devices/plugin-debug@dev

# Enable via environment variable
MCP_DEVICES_TOOL_PLUGINS=debug mcp-devices

# Or edit ~/.mcp-devices/config.json
# { "tool_plugins": ["debug"] }

# Restart MCP server
```

### Quick example

Attach debugger, set breakpoint, inspect variables:

```
1. Attach to running app:
   debug_attach(platform: 'android', app: 'com.example.myapp')
   → { sessionId: "session-123" }

2. Set breakpoint:
   debug_break(sessionId: "session-123", className: "com.example.MainActivity", line: 45)
   → { id: "bp-1", verified: true }

3. Wait for hit (poll after user interaction):
   debug_poll(sessionId: "session-123", cursor: 0)
   → { events: [{ kind: "BREAKPOINT_HIT", threadId: "1" }], nextCursor: 1 }

4. Inspect paused state:
   debug_pause_state(sessionId: "session-123", threadId: "1")
   → { frames: [...], locals: [{ name: "count", type: "int", value: "42" }] }

5. Evaluate expression:
   debug_eval(sessionId: "session-123", threadId: "1", expr: "count + 1")
   → { value: "43" }

6. Resume:
   debug_resume(sessionId: "session-123")
```

### Documentation

See [plugin-debug.md](./plugin-debug.md) for full tool reference, error handling, and security details.

---

## Built-in Tools (20 modules, bundled)

Base `mcp-devices` package includes 20 tool modules for device control and testing. Two are always visible (`device`, `screen`); the other 18 can be hidden/shown.

### Module visibility

**Always visible (2):**
- `device` — Target switching, module loading/unloading
- `screen` — Screenshots, annotation, diff comparison

**Hideable (18)** — grouped by category:

| Category | Modules | Purpose |
|----------|---------|---------|
| **Core** | `input`, `ui`, `app`, `system`, `flow` | Basic device interaction + automation orchestration |
| **Platform** | `browser`, `desktop`, `store`, `intent` | Platform-specific: web, desktop, app stores, Android intents |
| **Testing** | `visual`, `accessibility`, `performance`, `sandbox`, `sensor`, `network` | Testing & analysis: regression, accessibility audit, perf monitoring, sensor simulation, network control |
| **Automation** | `recorder`, `sync`, `autopilot` | Test automation: record/replay, multi-device sync, AI-driven test generation |

### Startup profiles

Control which modules are visible when the MCP server starts:

```sh
MOBILE_PROFILE=minimal mcp-devices      # device + screen only
MOBILE_PROFILE=core mcp-devices         # core modules (default for Android)
MOBILE_PROFILE=android mcp-devices      # alias for core
MOBILE_PROFILE=web mcp-devices          # core + browser
MOBILE_PROFILE=full mcp-devices         # all 20 modules
```

**Default:** `core` (input, ui, app, system, flow + device, screen).

### Runtime control

Enable/disable modules on-the-fly without restarting:

```
# Enable a hidden module
device(action: 'enable_module', module: 'visual')

# Disable a visible module
device(action: 'disable_module', module: 'recorder')

# List status of all modules
device(action: 'list_modules')
```

### Tool categories

**Core (input, ui, app, system, flow):**
- Tap, swipe, type, key press; element search & assertions; app launch/stop; shell commands, logs, clipboard, permissions; batch/parallel execution

**Platform (browser, desktop, store, intent):**
- Navigate & evaluate JS; window/focus management; app store metadata; Android deep linking & broadcasts

**Testing (visual, accessibility, performance, sandbox, sensor, network):**
- Visual regression baselines & comparison; WCAG accessibility audit; memory/CPU snapshots, crash tracking, frame stats; app data access (SharedPrefs, SQLite, files); GPS, battery, notifications, thermal; traffic stats, connectivity, proxy, airplane mode

**Automation (recorder, sync, autopilot):**
- Record & replay gesture sequences; multi-device broadcast; AI-driven test generation & self-healing

### Full reference

See [built-in-tools.md](./built-in-tools.md) for complete action catalog with parameters and examples for all 20 modules.

---

## Configuration

### Environment variables

```sh
# Override enabled platforms per-run
MCP_DEVICES_PLATFORMS=android,ios mcp-devices

# Enable debug plugin
MCP_DEVICES_TOOL_PLUGINS=debug mcp-devices

# Set startup module visibility
MOBILE_PROFILE=full mcp-devices
```

### Config file: `~/.mcp-devices/config.json`

Created by `mcp-devices install <platform>`. Example:

```json
{
  "platforms": ["android", "web"],
  "tool_plugins": ["debug"],
  "profile": "full"
}
```

### CLI commands

```sh
mcp-devices --help                  # help
mcp-devices platforms               # list enabled & available
mcp-devices doctor [platform...]    # check prerequisites
mcp-devices install <name|all>      # enable platform(s)
mcp-devices uninstall <name>        # disable platform(s)
```

---

## Quick Links

**Platform docs:**
- [Android](./plugin-android.md) — ADB automation, app sandbox, intents
- [iOS](./plugin-ios.md) — Simulator & physical device
- [Web](./plugin-web.md) — Chrome DevTools Protocol
- [Desktop](./plugin-desktop.md) — Compose app control
- [Aurora](./plugin-aurora.md) — Flutter-based OS

**Tools:**
- [Debug plugin](./plugin-debug.md) — Runtime debugging (JDWP + LLDB)
- [Built-in tools reference](./built-in-tools.md) — All 20 modules with actions & examples

**Feature docs:**
- [Debug internals](../features/debug-module.md)

---

## Architecture principles

- **Modular:** Platforms and plugins are separate packages; no unwanted dependencies
- **On-demand:** Load only what you need; base is slim
- **Composable:** Mix platforms (e.g., debug Android, test Web, monitor Desktop in same session)
- **Extensible:** Tool plugins follow standard MCP protocol; custom plugins can be added
- **Progressive disclosure:** Hidden modules prevent API bloat; enable on demand or via profile
