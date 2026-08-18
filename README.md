# mcp-devices 4.0.0

> **One MCP server to automate devices.** Android, iOS, Web, Desktop, Aurora OS —
> screenshots, taps, app control, and runtime debugging. Slim base; install only
> the platforms you need.

*Pre-release (npm dist-tag `dev`). Rebranded from `claude-in-mobile` (3.x).*

---

## Install in 3 steps

```sh
# 1. base server
npm i -g mcp-devices@dev

# 2. add a platform (example: Android)
npm i -g @mcp-devices/plugin-android@dev
mcp-devices install android

# 3. point your MCP client at it
#    { "mcpServers": { "mobile": { "command": "mcp-devices" } } }
```

Restart your MCP client. Done — ask Claude *"take a screenshot of my Android
device"* and it works.

Check prerequisites any time: `mcp-devices doctor`.

## Pick your platform

Each platform is a separate package. Install the one(s) you need — full guide in
each doc:

| Platform | Install | Needs | Guide |
|----------|---------|-------|-------|
| Android | `npm i -g @mcp-devices/plugin-android@dev` | `adb` | [android »](./docs/modules/plugin-android.md) |
| iOS | `npm i -g @mcp-devices/plugin-ios@dev` | `xcrun` (macOS/Xcode) | [ios »](./docs/modules/plugin-ios.md) |
| Web | `npm i -g @mcp-devices/plugin-web@dev` | Chrome | [web »](./docs/modules/plugin-web.md) |
| Desktop | `npm i -g @mcp-devices/plugin-desktop@dev` | Java/JDK | [desktop »](./docs/modules/plugin-desktop.md) |
| Aurora | `npm i -g @mcp-devices/plugin-aurora@dev` | `flutter-aurora` | [aurora »](./docs/modules/plugin-aurora.md) |
| All | `npm i -g @mcp-devices/plugin-all@dev` | — | — |

After installing a package, enable it: `mcp-devices install <name>` (or `all`),
then restart.

## What it can do

- **Drive apps** — screenshots, taps/swipes/typing, app launch, UI tree, shell,
  logs, permissions, files.
- **Debug live apps** — breakpoints, stepping, inspect variables, evaluate
  expressions (Android JDWP + iOS LLDB). See [debug »](./docs/modules/plugin-debug.md).
- **Test** — visual regression, accessibility audit, performance, sensor/network
  simulation.

These come as ~20 built-in tool modules plus the on-demand debug plugin —
[full tool catalog »](./docs/modules/built-in-tools.md).

## Docs

- [Modules & tools overview](./docs/modules/README.md) — how it's organized
- Platforms: [android](./docs/modules/plugin-android.md) · [ios](./docs/modules/plugin-ios.md) · [web](./docs/modules/plugin-web.md) · [desktop](./docs/modules/plugin-desktop.md) · [aurora](./docs/modules/plugin-aurora.md)
- [Debug plugin](./docs/modules/plugin-debug.md) — runtime debugging
- [Built-in tools reference](./docs/modules/built-in-tools.md) — every tool + action

## Notes

- Pre-release under npm dist-tag `dev`; nothing loads by default — you enable
  platforms explicitly.
- The debug plugin isn't yet part of `mcp-devices install` — enable it with
  `MCP_DEVICES_TOOL_PLUGINS=debug` or `~/.mcp-devices/config.json`.
- Stable production line is **3.x** as `claude-in-mobile` (`npm i -g claude-in-mobile`).
