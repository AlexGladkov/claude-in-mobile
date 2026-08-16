# Platform Plugin: iOS

Automate iOS Simulator and physical iOS devices via simctl, WebDriverAgent, and go-ios.

## What it covers

- Screen capture and annotation
- Touch input (tap, swipe, long press, double tap)
- Text input and key press
- App lifecycle (launch, stop, install)
- Accessibility tree traversal and element search
- Shell commands and system logs
- Clipboard operations
- File push/pull
- Permissions
- Performance monitoring and metrics

## Prerequisites

### Xcode Command Line Tools

Required for all iOS automation (Simulator and physical devices).

**Install:**
```sh
xcode-select --install
```

**Verify:**
```sh
xcrun -h
```

**Check status:**
```sh
mcp-devices doctor ios
```

### go-ios (for physical devices only)

If you plan to target physical iOS devices, also install go-ios:

```sh
npm i -g go-ios
```

Not required for Simulator-only automation.

### Devices

- **Simulator:** Any iOS Simulator created in Xcode (must be booted)
- **Physical devices:** Device connected via USB with trust configured. Requires `go-ios` installed.

## Install & Enable

```sh
# 1. Install the npm package
npm i -g @mcp-devices/plugin-ios@dev

# 2. Enable the iOS platform
mcp-devices install ios

# 3. Restart your MCP client
# The ios platform is now loaded on the next MCP server start
```

To verify:
```sh
mcp-devices platforms
# Output includes: "ios: enabled"
```

## Built-in Tools

The iOS platform works with these built-in tool modules:

### Core Tools
- **input** — Tap, swipe, type, key press
- **ui** — Accessibility tree, element search, assertions
- **app** — Launch, stop, install, list applications
- **system** — Shell commands, logs, clipboard, permissions, file I/O, device info, metrics
- **screen** — Screenshot and annotation (always available)
- **device** — Device management (always available)
- **flow** — Batch and parallel command execution

### Optional Tools
- **recorder** — Record and replay interaction sequences
- **autopilot** — AI-driven test generation
- **performance** — Performance monitoring, baselines, crash tracking
- **visual** — Visual regression testing
- **accessibility** — WCAG accessibility audit

## Configuration

Platform resolution via environment variable:
```sh
MCP_DEVICES_PLATFORMS=ios mcp-devices
```

Or enable multiple platforms:
```sh
MCP_DEVICES_PLATFORMS=ios,android mcp-devices
```

See [Modules & Tools](./README.md) for platform resolution order and startup profiles.
