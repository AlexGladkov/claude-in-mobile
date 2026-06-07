# Capability Reference (v1)

A plugin declares the set of capabilities it provides through
`PluginManifest.capabilities`. Capabilities are the contract: the kernel and
its consumers reason about plugins by what they can do, not by their id.

Adding a new capability requires:

1. Updating `ALL_CAPABILITIES` and the `Capability` enum on both sides
   (TypeScript and Rust mirror).
2. Documenting the capability here.
3. Bumping `@claude-in-mobile/plugin-api` by one minor.

## Capabilities

| Capability      | Intent                                                                 | Examples                                |
|-----------------|------------------------------------------------------------------------|------------------------------------------|
| `screen`        | Provides a rectangular pixel snapshot of the source.                   | Android screenshot, browser screenshot.  |
| `input`         | Accepts pointer / key input.                                           | Android tap, REPL send text.             |
| `ui`            | Exposes a queryable element tree.                                      | UIAutomator hierarchy, DOM snapshot.     |
| `shell`         | Exposes an arbitrary shell on the source.                              | `adb shell`, `audb shell`.               |
| `appLifecycle`  | Launch / stop / install applications.                                  | Android `am start`, simctl `launch`.     |
| `permissions`   | Runtime permission grant / revoke.                                     | Android runtime perms, iOS settings.     |
| `logs`          | Streamed log source.                                                   | logcat, `xcrun simctl spawn ... log`.    |
| `terminal`      | Interactive PTY-backed text stream.                                    | REPL plugin (python/node/bash).          |
| `fileTransfer`  | Push / pull files between host and source.                             | `adb push`, `scp` for SSH plugin.        |
| `deviceMgmt`    | Manages multiple addressable devices under one source.                 | Android (multi-device), iOS Simulator.   |

## Built-in plugin coverage

| Plugin   | screen | input | ui | shell | appLifecycle | permissions | logs | terminal | deviceMgmt |
|----------|--------|-------|----|-------|--------------|-------------|------|----------|------------|
| android  | ✓      | ✓     | ✓  | ✓     | ✓            | ✓           | ✓    |          | ✓          |
| ios      | ✓      | ✓     | ✓  | ✓     | ✓            | ✓           | ✓    |          | ✓          |
| desktop  | ✓      | ✓     | ✓  | ✓     | ✓            |             | ✓    |          | ✓          |
| web      | ✓      | ✓     | ✓  |       |              |             |      |          |            |
| aurora   | ✓      | ✓     | ✓  | ✓     | ✓            |             | ✓    |          | ✓          |
| repl     |        | ✓     |    |       |              |             |      | ✓        |            |

`fileTransfer` is reserved for v3.12 (SSH / android push-pull plugins).
