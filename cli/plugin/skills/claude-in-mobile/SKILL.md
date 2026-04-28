---
name: claude-in-mobile
description: "This skill should be used when the user asks to interact with device screens (screenshot, annotate, tap, swipe, type text), manage apps (install, launch, stop, uninstall), transfer files (push, pull), query device info (logs, system info, clipboard, screen size), run shell commands, manage desktop windows, or automate Android, iOS, Aurora OS, or Desktop apps."
---

# claude-in-mobile CLI

Fast CLI for mobile device automation across **Android** (via ADB), **iOS** (via simctl), **Aurora OS** (via audb), and **Desktop** (via companion JSON-RPC app).

Binary: `claude-in-mobile` (ensure it's in PATH or use full path to the built binary).

## Common Flags

| Flag | Description | Platforms |
|------|-------------|-----------|
| `--device <serial>` | Android/Aurora device serial (default: first connected) | Android, Aurora |
| `--simulator <name>` | iOS Simulator name (default: booted) | iOS |
| `--companion-path <path>` | Path to Desktop companion app (or set `MOBILE_TOOLS_COMPANION` env) | Desktop |

---

## Quick Reference

### devices

List connected devices across platforms.

```bash
claude-in-mobile devices              # All platforms
claude-in-mobile devices android      # Android only
claude-in-mobile devices ios          # iOS simulators only
claude-in-mobile devices aurora       # Aurora devices only
```

---

## Command Categories

Full command documentation split by scope:

| Reference | Commands | Platforms |
|-----------|----------|-----------|
| [`references/core.md`](references/core.md) | screenshot, annotate, tap, swipe, input, key, ui-dump, apps, launch, stop, install, uninstall, logs, shell, and more | Cross-platform |
| [`references/android-only.md`](references/android-only.md) | analyze-screen, find-and-tap, screen on/off | Android |
| [`references/desktop.md`](references/desktop.md) | get-window-info, focus-window, resize-window, launch/stop desktop apps, metrics, monitors | Desktop |
| [`references/platform-support.md`](references/platform-support.md) | Per-platform support matrix and backend details | All |

---

## Tips

- Use `--compress` on screenshots when sending to LLM — reduces token usage significantly
- `analyze-screen` gives structured JSON of buttons/inputs/texts — useful for automated testing
- `find-and-tap` uses fuzzy matching with confidence scoring — good for flaky element names
- Aurora commands use `audb` (Aurora Debug Bridge) — similar to ADB
- Desktop commands communicate via JSON-RPC with a companion app over stdin/stdout
- Combine `ui-dump` + `tap --index N` for reliable element interaction by index
- Use `wait` between actions in automation scripts to allow UI transitions
