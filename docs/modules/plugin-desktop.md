# Platform Plugin: Desktop

Automate desktop applications built with Compose or other frameworks. Includes window management, clipboard control, and performance monitoring.

## What it covers

- Desktop app launch and lifecycle control
- Window management (list, focus, resize)
- Clipboard operations
- Performance monitoring and metrics
- Multiple monitor support

## Prerequisites

### Java Development Kit (JDK)

Required for the desktop companion and app control.

**Install:**
```sh
brew install openjdk                      # macOS
apt-get install openjdk-17-jdk            # Linux (version may vary)
choco install openjdk                     # Windows
```

**Verify:**
```sh
java -version
```

**Check status:**
```sh
mcp-devices doctor desktop
```

This verifies that the JDK is installed and accessible.

## Install & Enable

```sh
# 1. Install the npm package
npm i -g @mcp-devices/plugin-desktop@dev

# 2. Enable the desktop platform
mcp-devices install desktop

# 3. Restart your MCP client
# The desktop platform is now loaded on the next MCP server start
```

To verify:
```sh
mcp-devices platforms
# Output includes: "desktop: enabled"
```

## Built-in Tools

The desktop platform works with these built-in tool modules:

### Core Tools
- **input** — Keyboard and mouse input
- **ui** — Element search and inspection
- **app** — Application launch and control
- **system** — Clipboard, device/monitor info, metrics
- **screen** — Screenshot (always available)
- **device** — Device management (always available)
- **flow** — Batch and parallel command execution

### Desktop-specific Tools
- **desktop** — Desktop app control: launch, stop, window management, focus, resize, clipboard, performance, multi-monitor support

### Optional Tools
- **recorder** — Record and replay interaction sequences
- **performance** — Performance monitoring and baselines
- **visual** — Visual regression testing
- **accessibility** — WCAG accessibility audit
- **autopilot** — AI-driven test generation

## Configuration

Platform resolution via environment variable:
```sh
MCP_DEVICES_PLATFORMS=desktop mcp-devices
```

Or enable multiple platforms:
```sh
MCP_DEVICES_PLATFORMS=desktop,web mcp-devices
```

See [Modules & Tools](./README.md) for platform resolution order and startup profiles.
