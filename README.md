# mcp-devices 4.2.0 (ex-`claude-in-mobile`)

> ## 👉 Want everything in one package? Keep using `claude-in-mobile`.
>
> **Nothing changes for you.** Same install, all platforms bundled, still
> maintained:
>
> ```sh
> npm i -g claude-in-mobile
> ```
>
> That's it — the all-in-one edition. **Read on only if you'd rather install the
> platforms separately** (that's what `mcp-devices` is for).

---

## Two editions — same tool

| Edition | Best for | Install |
|---------|----------|---------|
| **`claude-in-mobile`** | Want it all in one, zero setup | `npm i -g claude-in-mobile` |
| **`mcp-devices`** | Want a slim base + only the platforms you need | `npm i -g mcp-devices` (+ platform plugins, below) |

Both are maintained. `claude-in-mobile` was renamed to `mcp-devices` in 4.0 and
split into a modular edition; the all-in-one keeps its name and its unchanged
install. The rest of this README covers the **modular `mcp-devices`** edition.

---

## Install in 3 steps (modular)
Requires Node.js 20 or newer.

```sh
# 1. base server
npm i -g mcp-devices

# 2. add a platform (example: Android)
npm i -g @mcp-devices/plugin-android
mcp-devices install android

# 3. point your MCP client at it
#    { "mcpServers": { "mobile": { "command": "mcp-devices" } } }
# Grok Build:
#    grok plugin marketplace add AlexGladkov/claude-in-mobile
#    grok plugin install mcp-devices --trust
```

Restart your MCP client. Done — ask Claude *"take a screenshot of my Android
device"* and it works.

Check prerequisites any time: `mcp-devices doctor`.

## Native shell CLI

The npm command `mcp-devices` is the Node.js MCP server. For direct shell
automation, install the native Rust CLI and use its unambiguous command name:

```sh
brew install AlexGladkov/tap/mcp-devices
mcp-devices-cli --help
mcp-devices-cli devices
```

The separate name prevents a global npm install from shadowing the native CLI
on `PATH`.

The built-in REPL also needs this binary. Linux x86_64 release installation
steps are in the [native CLI guide](./cli/README.md#from-release-binary); set
`MCP_DEVICES_BIN` if the executable is outside `PATH`.

## Pick your platform

Each platform is a separate package. Install the one(s) you need — full guide in
each doc:

| Platform | Install | Needs | Guide |
|----------|---------|-------|-------|
| Android | `npm i -g @mcp-devices/plugin-android` | `adb` | [android »](./docs/modules/plugin-android.md) |
| iOS | `npm i -g @mcp-devices/plugin-ios` | `xcrun` (macOS/Xcode) | [ios »](./docs/modules/plugin-ios.md) |
| Web | `npm i -g @mcp-devices/plugin-web` | Chrome | [web »](./docs/modules/plugin-web.md) |
| Desktop | `npm i -g @mcp-devices/plugin-desktop` | Java/JDK | [desktop »](./docs/modules/plugin-desktop.md) |
| Aurora | `npm i -g @mcp-devices/plugin-aurora` | `flutter-aurora` | [aurora »](./docs/modules/plugin-aurora.md) |
| HarmonyOS Next | `npm i -g @mcp-devices/plugin-harmony` | `hdc` (DevEco Studio) | [harmony »](./docs/modules/plugin-harmony.md) |
| All | `npm i -g @mcp-devices/plugin-all` | — | — |

After installing a package, enable it: `mcp-devices install <name>` (or `all`),
then restart.

## External plugins (opt-in)

Third-party plugins run as trusted JavaScript in the MCP server process. Install
only packages you trust; permissions are load gates, not a sandbox:

```sh
mcp-devices plugin install <npm-package-or-local-path>
mcp-devices plugin verify
mcp-devices plugin grant <plugin-id> <declared-permission>...
mcp-devices plugin external enable
```

Install records package metadata and a SHA-256 digest in
`~/.mcp-devices/plugins.lock`. External loading is disabled until explicitly
enabled, and a plugin declaring host permissions is skipped until every
declared permission has been granted. See the
[plugin authoring guide](./docs/plugins/authoring.md) and
[security baseline](./docs/security.md).

## What it can do

- **Drive apps** — screenshots, taps/swipes/typing, app launch, UI tree, shell,
  logs, permissions, files.
- **Debug live apps** — breakpoints, stepping, inspect variables, evaluate
  expressions (Android JDWP + iOS LLDB). See [debug »](./docs/modules/plugin-debug.md).
- **Test** — visual regression, accessibility audit, performance, sensor/network
  simulation.

These come as ~20 built-in tool modules plus the on-demand debug plugin —
[full tool catalog »](./docs/modules/built-in-tools.md).

## Switching from all-in-one to modular?

Happy with the bundled `claude-in-mobile`? **Do nothing** — it stays maintained
and installs exactly as before. This section is only if you *want* to move to the
slim modular edition.

- The Node MCP commands `claude-in-mobile` and `mcp-devices` keep working;
  the native shell interface is available as `mcp-devices-cli`.
- The only difference is that platforms aren't bundled — install the one(s) you
  actually use:

```sh
npm i -g mcp-devices
npm i -g @mcp-devices/plugin-android   # (or plugin-all for everything)
mcp-devices install android
```

Tools, actions, and MCP client config are identical to the bundled edition.

## Docs

- [Modules & tools overview](./docs/modules/README.md) — how it's organized
- Platforms: [android](./docs/modules/plugin-android.md) · [ios](./docs/modules/plugin-ios.md) · [web](./docs/modules/plugin-web.md) · [desktop](./docs/modules/plugin-desktop.md) · [aurora](./docs/modules/plugin-aurora.md) · [harmony](./docs/modules/plugin-harmony.md)
- [Debug plugin](./docs/modules/plugin-debug.md) — runtime debugging
- [Built-in tools reference](./docs/modules/built-in-tools.md) — every tool + action

## Notes

- The modular base loads no platforms by default — enable them with
  `mcp-devices install <name>`. The `claude-in-mobile` edition enables all.
- Enable the separately installed debug plugin with
  `mcp-devices plugin enable debug`; `MCP_DEVICES_TOOL_PLUGINS=debug` remains
  available as a per-run override.
- Prefer everything in one package? Use the all-in-one **`claude-in-mobile`**
  edition (`npm i -g claude-in-mobile`) — still maintained, install unchanged.
