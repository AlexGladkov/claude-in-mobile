# mcp-devices 4.0.0 — modular / plugin edition

> **New name + pre-release.** This project was `claude-in-mobile` (stable 3.x);
> 4.0 is rebranded to **`mcp-devices`** (no longer Claude-only or mobile-only).
> This 4.0.0 release (published under npm dist-tag `dev`) features a slim base
> with platforms and tools installed on demand. Stable 3.x stays on the old
> name — `npm i -g claude-in-mobile`.

## What changed

In 3.x the single `claude-in-mobile` package bundled every platform
(Android, iOS, Web, Desktop, Aurora). In 4.0 the base is **slim** —
kernel + 20 built-in tools + REPL only — and platforms are delivered as
separate packages, loaded **on demand**:

```
mcp-devices                 # slim base (no platforms)
@mcp-devices/plugin-android # Android (ADB)
@mcp-devices/plugin-ios     # iOS (simctl + WebDriverAgent + go-ios)
@mcp-devices/plugin-web     # Web (Chrome DevTools Protocol)
@mcp-devices/plugin-desktop # Desktop (Compose)
@mcp-devices/plugin-aurora  # Aurora OS (audb)
@mcp-devices/plugin-all     # meta: every platform at once
```

By default **no platforms are loaded** — you enable only what you need.

## Install

```sh
# 1. base (slim) — pre-release, needs the `dev` tag
npm i -g mcp-devices@dev

# 2. add the platform(s) you need
npm i -g @mcp-devices/plugin-ios@dev
mcp-devices install ios

# …or everything at once
npm i -g @mcp-devices/plugin-all@dev
mcp-devices install all
```

`install` records the enabled set in `~/.mcp-devices/config.json`; the
MCP server loads exactly those platforms on its next start. Override per-run
with `MCP_DEVICES_PLATFORMS=ios,web` (csv / `all` / `none`).

## CLI

```sh
mcp-devices platforms          # list enabled + available
mcp-devices install <p|all>    # enable platform(s)
mcp-devices uninstall <p>      # disable platform(s)
mcp-devices doctor [p...]      # check external toolchains (adb/xcrun/…)
```

A platform tool invoked without its plugin installed returns an actionable
"Platform '<p>' is not installed — run `mcp-devices install <p>`" error.

## External toolchains (per platform)

| Platform | Needs |
|----------|-------|
| android  | `adb` (Android platform-tools) |
| ios      | Xcode CLT (`xcrun`); physical devices also need `go-ios` (`npm i -g go-ios`) |
| web      | Chrome/Chromium (launched on demand) |
| desktop  | JDK (desktop companion) |
| aurora   | Aurora Flutter SDK (`audb`) |

Run `mcp-devices doctor` to check them.

## MCP client config

Point your MCP client at the base binary as usual — platforms are resolved
from your enabled set, not from the client config:

```jsonc
{
  "mcpServers": {
    "mobile": { "command": "mcp-devices" }
  }
}
```

## Modules & Tools

mcp-devices 4.0 has three kinds of modules. **By default none of the platforms
or tool plugins are loaded** — install only what you need. Full guide:
[docs/modules/](./docs/modules/README.md).

### 1. Platform plugins (separate npm packages, on-demand)

Enable after install with `mcp-devices install <name>` (writes
`~/.mcp-devices/config.json`), then restart. Check toolchains with
`mcp-devices doctor`.

| Package | Covers | Prerequisites | Docs |
|---------|--------|---------------|------|
| `@mcp-devices/plugin-android` | Android automation via ADB | `adb` (platform-tools) | [android](./docs/modules/plugin-android.md) |
| `@mcp-devices/plugin-ios` | iOS Simulator + physical (simctl, WebDriverAgent, go-ios) | `xcrun` (Xcode CLT); `go-ios` for physical | [ios](./docs/modules/plugin-ios.md) |
| `@mcp-devices/plugin-web` | Browser via Chrome DevTools Protocol | Chrome/Chromium (launched on demand) | [web](./docs/modules/plugin-web.md) |
| `@mcp-devices/plugin-desktop` | Compose desktop apps | JDK (`java`) | [desktop](./docs/modules/plugin-desktop.md) |
| `@mcp-devices/plugin-aurora` | Aurora OS | `flutter-aurora` SDK | [aurora](./docs/modules/plugin-aurora.md) |
| `@mcp-devices/plugin-all` | Meta-package: all five platforms at once | — | — |

### 2. Tool plugins (separate npm packages)

| Package | What it does | Tools | Docs |
|---------|--------------|-------|------|
| `@mcp-devices/plugin-debug` | White-box runtime debugging of a live **debuggable** app — breakpoints, stepping, stack/locals, expression eval, variable mutation (Android JDWP + iOS LLDB) | `debug_attach` · `debug_break` · `debug_remove_break` · `debug_poll` · `debug_pause_state` · `debug_threads` · `debug_eval` · `debug_set_var` · `debug_step` · `debug_resume` · `debug_detach` · `debug_sessions` (12) | [debug](./docs/modules/plugin-debug.md) |

Enable debug via `MCP_DEVICES_TOOL_PLUGINS=debug` or `config.json`
`"tool_plugins": ["debug"]` (not yet part of `mcp-devices install`).

### 3. Built-in tool modules (bundled, toggled at runtime)

20 modules in the base package. `device` and `screen` are always on; the rest are
shown by startup profile (`MOBILE_PROFILE`) or enabled at runtime via
`device(action:'enable_module', module:'<name>')`. Full catalog with every action:
[built-in-tools.md](./docs/modules/built-in-tools.md).

| Category | Modules (key actions) |
|----------|-----------------------|
| **Core** | `device` (list, set_target, enable_module…) · `screen` (capture, annotate) · `input` (tap, swipe, text, key…) · `ui` (tree, find, assert_visible…) · `app` (launch, stop, install…) · `system` (shell, logs, clipboard, permissions, files…) |
| **Platform** | `browser` (navigate, evaluate, tabs, cookies…) · `desktop` (windows, focus, resize…) · `store` (search, details, reviews…) · `intent` (start, broadcast, deeplink…) |
| **Testing** | `visual` (compare, baseline, diff…) · `accessibility` (audit, check, rules…) · `performance` (snapshot, monitor, crashes, framestats…) · `sandbox` (prefs_read, sqlite_query, file_read…) · `sensor` (location, battery, notifications, thermal) · `network` (traffic, connectivity, proxy, airplane) |
| **Automation** | `flow` (batch, run, parallel) · `recorder` (start, play, list…) · `sync` (pair, broadcast, status…) · `autopilot` (explore, generate, heal…) |

## Status / caveats (4.0.0)

- Pre-release; published under npm dist-tag `dev` (`npm i -g mcp-devices@dev`).
- All five platforms are physically split into separate packages; the base
  bundle contains none of them.
- `mcp-devices-lite` is temporarily disabled (being migrated to the
  plugin model).
- Tool plugins (e.g., debug) are not yet included in `mcp-devices install` —
  enable them via environment variable or config file.
- Stable production: **3.x** as `claude-in-mobile` (`npm i -g claude-in-mobile`).
