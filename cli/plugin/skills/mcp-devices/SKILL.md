---
name: mcp-devices
description: "This skill should be used when the user asks to interact with device screens (screenshot, annotate, tap, swipe, type text), manage apps (install, launch, stop, uninstall), transfer files (push, pull), query device info (logs, system info, clipboard, screen size), capture performance traces or heap artifacts, run shell commands, manage desktop windows, or automate Android, iOS, HarmonyOS, Aurora OS, or Desktop apps."
---

# mcp-devices native CLI

Fast CLI for mobile device automation across **Android** (via ADB), **iOS** (via simctl), **HarmonyOS** (via HDC), **Aurora OS** (via audb), and **Desktop** (via companion JSON-RPC app).

Binary: `mcp-devices-cli` (ensure it's in PATH or use its full path).

## Common Flags

| Flag | Description | Platforms |
|------|-------------|-----------|
| `--device <serial>` | Android/HarmonyOS serial or Aurora registry ID (Aurora default: audb selected ID) | Android, HarmonyOS, Aurora |
| `--simulator <name>` | iOS Simulator name (default: booted) | iOS |
| `--companion-path <path>` | Path to Desktop companion app (or set `MOBILE_TOOLS_COMPANION` env) | Desktop |

---

## Quick Reference

### devices

List connected devices across platforms.

```bash
mcp-devices-cli devices              # All platforms
mcp-devices-cli devices android      # Android only
mcp-devices-cli devices ios          # iOS simulators only
mcp-devices-cli devices --platform harmony # HarmonyOS devices only
mcp-devices-cli devices --platform aurora       # Aurora devices only
```

---

## Command Categories

Full command documentation split by scope:

| Reference | Commands | Platforms |
|-----------|----------|-----------|
| [`references/core.md`](references/core.md) | screenshot, gestures, apps, logs, shell, Perfetto/xctrace traces, Android/iOS heap artifacts, and more | Cross-platform |
| [`references/android-only.md`](references/android-only.md) | analyze-screen, find-and-tap, screen on/off | Android |
| [`references/aurora.md`](references/aurora.md) | audb 0.3 setup, device targeting, visual input, permissions, errors | Aurora phones and emulators |
| [`references/desktop.md`](references/desktop.md) | get-window-info, focus-window, resize-window, launch/stop desktop apps, metrics, monitors | Desktop |
| [`references/platform-support.md`](references/platform-support.md) | Per-platform support matrix and backend details | All |

---

## Tips

- Use `--compress` on screenshots when sending to LLM — reduces token usage significantly
- `analyze-screen` gives structured JSON of buttons/inputs/texts — useful for automated testing
- `find-and-tap` uses fuzzy matching with confidence scoring — good for flaky element names
- For Aurora, read [`references/aurora.md`](references/aurora.md): audb ^0.3.0, PATH before AUDB_PATH, explicit device IDs, visual input and Sailjail permissions. UI tree is unavailable.
- Desktop commands communicate via JSON-RPC with a companion app over stdin/stdout
- Combine `ui-dump` + `tap --index N` for reliable element interaction by index
- Use `wait` between actions in automation scripts to allow UI transitions
