# Platform Plugin: Web

Automate web browsers via Chrome DevTools Protocol (CDP). Supports Chrome, Chromium, and Chromium-based browsers.

## What it covers

- Browser navigation and URL control
- JavaScript evaluation in page context
- Page screenshots and element inspection
- Console access and command evaluation
- Network request and response logging
- Tab management
- Cookie and session management
- DOM element search and interaction

## Prerequisites

### Chrome/Chromium

A Chrome, Chromium, or Chromium-based browser must be available on the system. The browser is launched on demand by the plugin; no pre-launch required.

**Supported browsers:**
- Google Chrome
- Chromium
- Brave
- Edge
- Other Chromium-based browsers

**Install (if needed):**
```sh
brew install chromium                     # macOS
apt-get install chromium                  # Linux
choco install chromium                    # Windows
```

**Check status:**
```sh
mcp-devices doctor web
```

This verifies that the browser is discoverable and launchable.

## Install & Enable

```sh
# 1. Install the npm package
npm i -g @mcp-devices/plugin-web@dev

# 2. Enable the web platform
mcp-devices install web

# 3. Restart your MCP client
# The web platform is now loaded on the next MCP server start
```

To verify:
```sh
mcp-devices platforms
# Output includes: "web: enabled"
```

## Built-in Tools

The web platform works with these built-in tool modules:

### Core Tools
- **input** — Keyboard and mouse input
- **ui** — DOM element search, inspection, assertions
- **app** — URL navigation and page control
- **system** — Clipboard, device info
- **screen** — Screenshot (always available)
- **device** — Device/browser management (always available)
- **flow** — Batch and parallel command execution

### Web-specific Tools
- **browser** — Browser automation: navigate, evaluate JS, manage tabs, network, cookies, screenshots

### Optional Tools
- **recorder** — Record and replay interaction sequences
- **performance** — Performance monitoring and baselines
- **visual** — Visual regression testing
- **accessibility** — WCAG accessibility audit
- **autopilot** — AI-driven test generation

## Configuration

Platform resolution via environment variable:
```sh
MCP_DEVICES_PLATFORMS=web mcp-devices
```

Or enable multiple platforms:
```sh
MCP_DEVICES_PLATFORMS=web,android mcp-devices
```

See [Modules & Tools](./README.md) for platform resolution order and startup profiles.
