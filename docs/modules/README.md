# Modules & Tools

The mcp-devices 4.0 architecture consists of **three types of modules**:

1. **Platform plugins** — Device platforms (Android, iOS, Web, Desktop, Aurora) as separate npm packages, installed on demand
2. **Tool plugins** — Additional tool functionality (e.g., runtime debugging) as separate packages
3. **Built-in tools** — Core device control and testing modules bundled in the base package, hidden/shown at startup or at runtime

## Platform Plugins (on-demand)

Platform plugins extend mcp-devices to support specific device platforms. By default **no platforms are loaded**.

| Plugin | Package | Covers | Prerequisites |
|--------|---------|--------|---|
| Android | `@mcp-devices/plugin-android` | ADB-based Android automation | `adb` (Android platform-tools) |
| iOS | `@mcp-devices/plugin-ios` | iOS Simulator / physical device via simctl + WebDriverAgent + go-ios | `xcrun` (Xcode CLT); `go-ios` for physical devices |
| Web | `@mcp-devices/plugin-web` | Chrome/Chromium automation via Chrome DevTools Protocol | Chrome/Chromium (launched on demand) |
| Desktop | `@mcp-devices/plugin-desktop` | Desktop app control (Compose) | JDK (desktop companion) |
| Aurora | `@mcp-devices/plugin-aurora` | Aurora OS via audb/Flutter | Aurora Flutter SDK (`audb`) |
| All | `@mcp-devices/plugin-all` | Meta-package: installs all five platforms | All of the above |

### Install & Enable Platforms

```sh
# Install npm package
npm i -g @mcp-devices/plugin-<name>@dev

# Enable platform (writes to ~/.mcp-devices/config.json)
mcp-devices install <android|ios|web|desktop|aurora|all>

# List enabled and available platforms
mcp-devices platforms

# Disable a platform
mcp-devices uninstall <name>

# Check toolchain status
mcp-devices doctor [platform...]
```

Override enabled platforms per invocation:
```sh
MCP_DEVICES_PLATFORMS=ios,web mcp-devices
# or
MCP_DEVICES_PLATFORMS=all mcp-devices
MCP_DEVICES_PLATFORMS=none mcp-devices
```

**Platform resolution order:** `MCP_DEVICES_PLATFORMS` env var → `~/.mcp-devices/config.json` → default (none).

See individual platform docs for capabilities and prerequisites:
- [plugin-android](./plugin-android.md)
- [plugin-ios](./plugin-ios.md)
- [plugin-web](./plugin-web.md)
- [plugin-desktop](./plugin-desktop.md)
- [plugin-aurora](./plugin-aurora.md)

## Tool Plugins (on-demand)

Tool plugins add specialized functionality beyond platform support.

| Plugin | Package | Purpose |
|--------|---------|---------|
| Debug | `@mcp-devices/plugin-debug` | Runtime debugging (JDWP + LLDB) for live inspection and control |

### Install & Enable Tool Plugins

```sh
# Install npm package
npm i -g @mcp-devices/plugin-<name>@dev

# Enable via environment variable
MCP_DEVICES_TOOL_PLUGINS=debug

# Or via config (~/.mcp-devices/config.json)
# { "tool_plugins": ["debug"] }

# Then restart the MCP server
```

**Note:** Tool plugins are not yet included in `mcp-devices install` — enable them via env var or config file.

See:
- [plugin-debug](./plugin-debug.md)

## Built-in Tools (always available)

The base `mcp-devices` package includes **20 built-in tool modules**. Two are always visible; the rest are hidden/shown based on startup profile or enabled at runtime.

### Module Visibility

**Always visible:**
- `device` — Device management, module loading, target switching
- `screen` — Screenshot capture, annotation, diff comparison

**Hideable modules (18 total)** — grouped by category:

| Category | Modules |
|----------|---------|
| Core | input, ui, app, system, flow |
| Platform | browser, desktop, store, intent |
| Testing | visual, accessibility, performance, sandbox, sensor, network |
| Automation | recorder, sync, autopilot |

### Startup Profiles

Control module visibility at MCP server startup via the `MOBILE_PROFILE` environment variable:

| Profile | Visible modules (+ always-visible) |
|---------|-----|
| `minimal` | device, screen only |
| `core` | + input, ui, app, system, flow (default for Android) |
| `android` | + input, ui, app, system, flow (alias for core) |
| `web` | + input, ui, app, system, flow, browser |
| `full` | all 20 modules |

```sh
MOBILE_PROFILE=full mcp-devices
```

### Runtime Module Control

Enable/disable modules at runtime via the `device` tool:

```
device(action:'enable_module', module:'visual')
device(action:'disable_module', module:'recorder')
device(action:'list_modules')  # see status of all modules
```

### Module Catalog

See [built-in-tools.md](./built-in-tools.md) for the complete catalog with all actions per module.

## Quick Links

- Platform plugins: [android](./plugin-android.md) · [ios](./plugin-ios.md) · [web](./plugin-web.md) · [desktop](./plugin-desktop.md) · [aurora](./plugin-aurora.md)
- [Debug tool plugin](./plugin-debug.md) — Runtime debugging with JDWP + LLDB
- [Built-in tools reference](./built-in-tools.md) — Detailed module catalog with all actions
- CLI help: `mcp-devices --help`, `mcp-devices platforms`, `mcp-devices doctor`
- Debug internals: [docs/features/debug-module.md](../features/debug-module.md)
