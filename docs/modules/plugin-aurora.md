# Platform Plugin: Aurora

Automate Aurora OS applications via audb and Aurora Flutter SDK.

## What it covers

- Aurora OS app automation via ADB-like interface
- Screen capture and annotation
- Touch input (tap, swipe, long press, double tap)
- Text input and key press
- App lifecycle control
- Accessibility tree traversal and element search
- Shell commands and system information

## Prerequisites

### Aurora Flutter SDK

Required for Aurora OS automation.

**Install:**
```sh
# Follow Aurora Linux documentation for SDK installation
# Typically via audb package manager or direct download
```

**Verify:**
```sh
flutter-aurora --version
```

**Check status:**
```sh
mcp-devices doctor aurora
```

This verifies that the Aurora Flutter SDK is installed and in your PATH.

### Aurora Devices

- Aurora emulator instances created via the Aurora Flutter SDK
- Physical Aurora OS devices with USB debugging enabled

## Install & Enable

```sh
# 1. Install the npm package
npm i -g @mcp-devices/plugin-aurora@dev

# 2. Enable the Aurora platform
mcp-devices install aurora

# 3. Restart your MCP client
# The Aurora platform is now loaded on the next MCP server start
```

To verify:
```sh
mcp-devices platforms
# Output includes: "aurora: enabled"
```

## Built-in Tools

The Aurora platform works with these built-in tool modules:

### Core Tools
- **input** — Tap, swipe, type, key press
- **ui** — Accessibility tree, element search, assertions
- **app** — Launch, stop, install, list applications
- **system** — Shell commands, device info
- **screen** — Screenshot and annotation (always available)
- **device** — Device management (always available)
- **flow** — Batch and parallel command execution

### Optional Tools
- **recorder** — Record and replay interaction sequences
- **autopilot** — AI-driven test generation
- **performance** — Performance monitoring
- **visual** — Visual regression testing
- **accessibility** — WCAG accessibility audit

## Configuration

Platform resolution via environment variable:
```sh
MCP_DEVICES_PLATFORMS=aurora mcp-devices
```

Or enable multiple platforms:
```sh
MCP_DEVICES_PLATFORMS=aurora,android mcp-devices
```

See [Modules & Tools](./README.md) for platform resolution order and startup profiles.
