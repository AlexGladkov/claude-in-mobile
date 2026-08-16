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

mcp-devices 4.0 is organized around three types of modules:

1. **Platform plugins** — Device platforms (Android, iOS, Web, Desktop, Aurora)
   as separate npm packages, installed on demand
2. **Tool plugins** — Specialized tools (e.g., runtime debugging) as separate packages
3. **Built-in tools** — 20 core device-control and testing modules bundled in
   the base package, hidden/shown via startup profile or enabled at runtime

**By default no platforms or tool plugins are loaded.** Install only what you need.

See [docs/modules/README.md](./docs/modules/README.md) for the complete guide.

## Status / caveats (4.0.0)

- Pre-release; published under npm dist-tag `dev` (`npm i -g mcp-devices@dev`).
- All five platforms are physically split into separate packages; the base
  bundle contains none of them.
- `mcp-devices-lite` is temporarily disabled (being migrated to the
  plugin model).
- Tool plugins (e.g., debug) are not yet included in `mcp-devices install` —
  enable them via environment variable or config file.
- Stable production: **3.x** as `claude-in-mobile` (`npm i -g claude-in-mobile`).
