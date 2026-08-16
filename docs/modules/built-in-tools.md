# Built-in Tools Reference

The base `mcp-devices` package includes **20 built-in tool modules** for device control and testing. Two are always visible (`device`, `screen`); the other 18 can be hidden/shown via startup profile or enabled at runtime.

## Module Visibility

**Always visible (2 modules):**
- device
- screen

**Hideable (18 modules):**
- Core: input, ui, app, system, flow
- Platform: browser, desktop, store, intent
- Testing: visual, accessibility, performance, sandbox, sensor, network
- Automation: recorder, sync, autopilot

### Control Module Visibility

**At startup:** Set the `MOBILE_PROFILE` environment variable:
```sh
MOBILE_PROFILE=full mcp-devices         # all 20 modules
MOBILE_PROFILE=web mcp-devices          # web profile: core + browser
MOBILE_PROFILE=minimal mcp-devices      # only device + screen
```

**At runtime:** Use the `device` tool:
```
device(action:'enable_module', module:'visual')
device(action:'disable_module', module:'recorder')
device(action:'list_modules')           # check status of all modules
```

## Module Catalog

### Always Visible

#### device
**Device management, module loading, target switching**

| Category | Actions |
|----------|---------|
| core | list, set, set_target, get_target, enable_module, disable_module, list_modules |

Manages the current device target, loads/unloads modules at runtime, and lists available modules and their visibility status.

---

#### screen
**Screenshot capture, annotation, diff comparison**

| Category | Actions |
|----------|---------|
| core | capture, annotate |

Captures high-fidelity screenshots, annotates them with visual markers, and compares screenshots to detect visual regressions.

---

### Core Modules

#### input
**Tap, swipe, type, key press — all input actions**

| Category | Actions |
|----------|---------|
| core | tap, double_tap, long_press, swipe, text, key |

Simulates user input: touch gestures (tap, swipe, long press), text entry, and keyboard key presses.

---

#### ui
**Accessibility tree, element search, assertions, waits**

| Category | Actions |
|----------|---------|
| core | tree, find, find_tap, tap_text, analyze, wait, assert_visible, assert_gone |

Inspects the UI accessibility tree, searches for elements, performs assertions, and waits for element state changes. Essential for reliable element location and interaction.

---

#### app
**Launch, stop, install, list applications**

| Category | Actions |
|----------|---------|
| core | launch, stop, install, list |

Controls application lifecycle: launch with parameters, stop gracefully, install/uninstall packages, and list installed applications.

---

#### system
**Shell, logs, clipboard, permissions, URL, device info**

| Category | Actions |
|----------|---------|
| core | activity, shell, wait, open_url, logs, clear_logs, info, webview, clipboard_select, clipboard_copy, clipboard_paste, clipboard_get, permission_grant, permission_revoke, permission_reset, file_push, file_pull, metrics, reset_metrics |

Low-level device control: execute shell commands, view system logs, manage clipboard, control permissions, open URLs, push/pull files, and monitor device metrics.

---

#### flow
**Batch commands, multi-step automation, parallel execution**

| Category | Actions |
|----------|---------|
| automation | batch, run, parallel |

Execute sequences of commands efficiently: batch (atomic transaction-like execution), run (sequential with error handling), and parallel (concurrent execution of independent commands).

---

### Platform Modules

#### browser
**Browser automation — navigate, evaluate JS, manage tabs**

| Category | Actions |
|----------|---------|
| platform | navigate, evaluate, console, network, tabs, cookies, screenshot |

Controls the browser: navigate to URLs, evaluate JavaScript in page context, access console, inspect network requests, manage tabs and cookies, take screenshots.

**Applies to:** Web platform.

---

#### desktop
**Desktop app control — windows, clipboard, performance**

| Category | Actions |
|----------|---------|
| platform | launch, stop, windows, focus, resize, clipboard_get, clipboard_set, performance, monitors |

Controls desktop applications: launch/stop, manage windows (list, focus, resize), clipboard, and monitor performance and multi-monitor setup.

**Applies to:** Desktop platform.

---

#### store
**App store metadata — ratings, reviews, versions**

| Category | Actions |
|----------|---------|
| platform | search, details, reviews, similar |

Queries app store metadata: search for apps, fetch app details and reviews, find similar apps.

**Applies to:** Android (Google Play), iOS (App Store), Huawei AppGallery, RuStore.

---

#### intent
**Intent & deep link engine — am start/broadcast with typed extras**

| Category | Actions |
|----------|---------|
| platform | start, broadcast, deeplink, services |

Android-specific: launch apps via Intent, send broadcasts, deep link with typed extras, and query available services.

**Applies to:** Android only.

---

### Testing Modules

#### visual
**Visual regression testing — compare screenshots**

| Category | Actions |
|----------|---------|
| testing | compare, baseline, diff, report |

Manages visual regression testing: establish baselines, compare current screenshots, generate diff reports, and track visual changes.

---

#### accessibility
**Accessibility audit — WCAG checks, element validation**

| Category | Actions |
|----------|---------|
| testing | audit, check, summary, rules |

Audits app accessibility: perform WCAG checks, validate elements, generate accessibility summaries, and review detailed rules violations.

---

#### performance
**Performance monitoring — snapshots, baselines, crashes, framestats**

| Category | Actions |
|----------|---------|
| testing | snapshot, baseline, compare, monitor, crashes, framestats |

Monitors runtime performance: capture memory/CPU snapshots, establish baselines, detect crashes, measure frame rates, and track performance regressions.

---

#### sandbox
**App sandbox access — SharedPreferences, SQLite, file operations via run-as**

| Category | Actions |
|----------|---------|
| testing | prefs_read, prefs_write, sqlite_query, file_list, file_read |

Android-specific: access app sandbox data without rooting. Query/modify SharedPreferences, execute SQLite queries, list and read files via run-as.

**Applies to:** Android only.

---

#### sensor
**Sensor & environment simulation — GPS, battery, notifications, thermal**

| Category | Actions |
|----------|---------|
| testing | location, battery, notifications, thermal |

Simulates device sensors and environment: inject GPS coordinates, battery level, system notifications, and thermal/thermal events.

---

#### network
**Network layer — traffic stats, connectivity, proxy, airplane mode**

| Category | Actions |
|----------|---------|
| testing | traffic, connectivity, proxy, airplane |

Network control and monitoring: capture traffic stats, control connectivity, set proxies, toggle airplane mode.

---

### Automation Modules

#### recorder
**Record and replay interaction sequences**

| Category | Actions |
|----------|---------|
| automation | start, stop, play, list, delete |

Records user interaction sequences (taps, swipes, text input) and plays them back for test automation and regression testing.

---

#### sync
**Multi-device synchronization and coordination**

| Category | Actions |
|----------|---------|
| automation | pair, unpair, broadcast, status |

Coordinates automation across multiple devices: pair devices for sync, unpair, broadcast commands to multiple devices, and monitor sync status.

---

#### autopilot
**AI-driven test generation and self-healing**

| Category | Actions |
|----------|---------|
| automation | explore, generate, heal, status, tests |

AI-powered test automation: automatically explore the app, generate test cases, self-heal failing tests due to UI changes, and manage test status and inventory.

---

## Startup Profiles

Control which modules are visible at MCP server startup:

| Profile | Visible modules (+ always-visible) | Use case |
|---------|-----|----------|
| `minimal` | device, screen only | Minimal setup; enable modules on demand |
| `core` | device, screen, input, ui, app, system, flow | Android automation (default) |
| `android` | device, screen, input, ui, app, system, flow | Alias for core |
| `web` | device, screen, input, ui, app, system, flow, browser | Web automation |
| `full` | all 20 modules | Full functionality; all modules visible |

**Set at startup:**
```sh
MOBILE_PROFILE=full mcp-devices
```

**Default:** `core` (for Android). No platforms load by default; enable platforms separately via `mcp-devices install`.

## Quick Links

- [Modules & Tools Overview](./README.md) — Module types and architecture
- [Platform Plugins](./plugin-android.md) — Android, iOS, Web, Desktop, Aurora
- [Debug Tool Plugin](./plugin-debug.md) — Runtime debugging with JDWP + LLDB
- [MCP Client Configuration](../README.md) — How to configure your MCP client
