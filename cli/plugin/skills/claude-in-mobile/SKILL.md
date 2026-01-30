---
name: claude-in-mobile
description: "This skill should be used when the user asks to interact with device screens (screenshot, annotate, tap, swipe, type text), manage apps (install, launch, stop, uninstall), transfer files (push, pull), query device info (logs, system info, clipboard, screen size), run shell commands, manage desktop windows, or automate Android, iOS, Aurora OS, or Desktop apps."
---

# claude-in-mobile CLI

Fast CLI for mobile device automation across **Android** (via ADB), **iOS** (via simctl), **Aurora OS** (via audb), and **Desktop** (via companion JSON-RPC app).

Binary: `claude-in-mobile` (ensure it's in PATH or use full path to the built binary).

## Common Flags

Most commands accept platform-specific device selectors:

| Flag | Description | Platforms |
|------|-------------|-----------|
| `--device <serial>` | Android/Aurora device serial (default: first connected) | Android, Aurora |
| `--simulator <name>` | iOS Simulator name (default: booted) | iOS |
| `--companion-path <path>` | Path to Desktop companion app (or set `MOBILE_TOOLS_COMPANION` env) | Desktop |

---

## Commands Reference

### devices

List connected devices across platforms.

```bash
claude-in-mobile devices              # All platforms
claude-in-mobile devices android      # Android only
claude-in-mobile devices ios          # iOS simulators only
claude-in-mobile devices aurora       # Aurora devices only
```

**Platforms:** Android, iOS, Aurora

---

### screenshot

Capture a screenshot. Outputs base64 to stdout by default, or save to file with `-o`.

```bash
claude-in-mobile screenshot android
claude-in-mobile screenshot ios
claude-in-mobile screenshot aurora
claude-in-mobile screenshot desktop --companion-path /path/to/companion

# Save to file
claude-in-mobile screenshot android -o screen.png

# Compress for LLM (resize + JPEG quality reduction)
claude-in-mobile screenshot android --compress --max-width 800 --quality 60
```

| Flag | Description | Default |
|------|-------------|---------|
| `-o, --output <path>` | Save to file instead of base64 stdout | stdout |
| `-c, --compress` | Enable compression (resize + quality) | false |
| `--max-width <px>` | Max width when compressing | 1024 |
| `--max-height <px>` | Max height when compressing | unlimited |
| `--quality <1-100>` | JPEG quality when compressing | 80 |
| `--monitor-index <n>` | Monitor index (Desktop) | primary |

**Platforms:** Android, iOS, Aurora, Desktop

---

### annotate

Capture screenshot with UI element bounding boxes drawn over it. Useful for visual debugging and identifying tap targets.

```bash
claude-in-mobile annotate android -o annotated.png
claude-in-mobile annotate ios -o annotated.png
```

| Flag | Description |
|------|-------------|
| `-o, --output <path>` | Save to file instead of base64 stdout |

**Platforms:** Android, iOS

---

### analyze-screen

Parse current screen and return categorized interactive elements as structured JSON. Groups elements into buttons, inputs, texts, etc. Useful for automated test flows.

```bash
claude-in-mobile analyze-screen
claude-in-mobile analyze-screen --device emulator-5554
```

**Platforms:** Android only

---

### screen-size

Get screen resolution in pixels.

```bash
claude-in-mobile screen-size android
claude-in-mobile screen-size ios
```

**Platforms:** Android, iOS

---

### tap

Tap at exact coordinates, or by text/resource-id/index.

```bash
# By coordinates
claude-in-mobile tap android 500 800
claude-in-mobile tap ios 200 400
claude-in-mobile tap aurora 300 600
claude-in-mobile tap desktop 100 200 --companion-path /path/to/companion

# By text (searches UI tree, finds element, taps center)
claude-in-mobile tap android 0 0 --text "Login"
claude-in-mobile tap desktop 0 0 --text "Submit" --companion-path /path/to/companion

# By resource-id (Android)
claude-in-mobile tap android 0 0 --resource-id "btn_login"

# By element index from ui-dump (Android)
claude-in-mobile tap android 0 0 --index 5
```

| Flag | Description | Platforms |
|------|-------------|-----------|
| `--text <text>` | Tap element matching text | Android, Desktop |
| `--resource-id <id>` | Tap element by resource-id | Android |
| `--index <n>` | Tap element by ui-dump index | Android |

**Platforms:** Android, iOS, Aurora, Desktop

---

### tap-text

Find an element by text, resource-id, or content-desc in the UI hierarchy and tap it. Shortcut for `find` + `tap`.

```bash
claude-in-mobile tap-text android "Submit"
claude-in-mobile tap-text ios "Login"
```

**Platforms:** Android, iOS

---

### find

Search UI hierarchy for an element by text, resource-id, or content-desc. Returns element coordinates and bounds.

```bash
claude-in-mobile find android "Login"
claude-in-mobile find ios "Submit"
```

**Platforms:** Android, iOS

---

### find-and-tap

Fuzzy-match an element by description and tap it. Uses confidence scoring for inexact matches.

```bash
claude-in-mobile find-and-tap "Submit Order" --min-confidence 50
claude-in-mobile find-and-tap "Cancel" --min-confidence 30
```

| Flag | Description | Default |
|------|-------------|---------|
| `--min-confidence <0-100>` | Minimum match confidence threshold | 30 |

**Platforms:** Android only

---

### long-press

Long press at coordinates or by text. Duration configurable in milliseconds.

```bash
# By coordinates
claude-in-mobile long-press android 500 800 -d 2000
claude-in-mobile long-press ios 300 600
claude-in-mobile long-press aurora 400 700

# By text (Android: finds element, long presses at center)
claude-in-mobile long-press android 0 0 --text "Delete"
```

| Flag | Description | Default |
|------|-------------|---------|
| `-d, --duration <ms>` | Press duration in milliseconds | 1000 |
| `--text <text>` | Find by text and long press | — |

**Platforms:** Android, iOS, Aurora

---

### swipe

Swipe gesture between coordinates, or by named direction (up/down/left/right).

```bash
# By coordinates (x1 y1 x2 y2)
claude-in-mobile swipe android 500 1500 500 500 -d 300

# By direction (uses screen center, swipes 400px)
claude-in-mobile swipe android 0 0 0 0 --direction up
claude-in-mobile swipe ios 0 0 0 0 --direction left
claude-in-mobile swipe aurora 0 0 0 0 --direction down
```

| Flag | Description | Default |
|------|-------------|---------|
| `-d, --duration <ms>` | Swipe duration in milliseconds | 300 |
| `--direction <dir>` | Swipe direction: up, down, left, right (overrides coordinates) | — |

**Platforms:** Android, iOS, Aurora

---

### input

Type text into the currently focused field.

```bash
claude-in-mobile input android "Hello world"
claude-in-mobile input ios "Search query"
claude-in-mobile input aurora "user@example.com"
claude-in-mobile input desktop "text" --companion-path /path/to/companion
```

**Platforms:** Android, iOS, Aurora, Desktop

---

### key

Press a hardware/software key or button.

```bash
claude-in-mobile key android back
claude-in-mobile key android home
claude-in-mobile key android enter
claude-in-mobile key android power
claude-in-mobile key ios home
claude-in-mobile key aurora back
claude-in-mobile key desktop enter --companion-path /path/to/companion
```

Common keys: `home`, `back`, `enter`, `power`, `volume_up`, `volume_down`, `tab`, `delete`.

**Platforms:** Android, iOS, Aurora, Desktop

---

### ui-dump

Dump the current UI hierarchy. Default format is JSON; also supports XML for Android.

```bash
claude-in-mobile ui-dump android
claude-in-mobile ui-dump android -f xml
claude-in-mobile ui-dump ios
claude-in-mobile ui-dump desktop --companion-path /path/to/companion
```

| Flag | Description | Default |
|------|-------------|---------|
| `-f, --format <fmt>` | Output format: `json` or `xml` | json |
| `--show-all` | Include non-interactive elements (Android) | false |

**Platforms:** Android, iOS, Desktop

---

### apps

List installed applications, optionally filtered by name.

```bash
claude-in-mobile apps android
claude-in-mobile apps android -f "myapp"
claude-in-mobile apps ios
claude-in-mobile apps aurora
```

| Flag | Description |
|------|-------------|
| `-f, --filter <text>` | Filter by package/bundle name |

**Platforms:** Android, iOS, Aurora

---

### launch

Launch an application by package name, bundle ID, or path.

```bash
claude-in-mobile launch android com.example.app
claude-in-mobile launch ios com.example.app
claude-in-mobile launch aurora harbour-myapp
claude-in-mobile launch desktop /path/to/app --companion-path /path/to/companion
```

**Platforms:** Android, iOS, Aurora, Desktop

---

### stop

Force-stop/kill an application.

```bash
claude-in-mobile stop android com.example.app
claude-in-mobile stop ios com.example.app
claude-in-mobile stop aurora harbour-myapp
claude-in-mobile stop desktop "AppName" --companion-path /path/to/companion
```

**Platforms:** Android, iOS, Aurora, Desktop

---

### install

Install an application package onto the device.

```bash
claude-in-mobile install android /path/to/app.apk
claude-in-mobile install ios /path/to/app.app
claude-in-mobile install aurora /path/to/app.rpm
```

**Platforms:** Android, iOS, Aurora

---

### uninstall

Remove an installed application from the device.

```bash
claude-in-mobile uninstall android com.example.app
claude-in-mobile uninstall ios com.example.app
claude-in-mobile uninstall aurora harbour-myapp
```

**Platforms:** Android, iOS, Aurora

---

### push-file

Copy a local file to the device filesystem.

```bash
claude-in-mobile push-file android /local/path /sdcard/remote/path
claude-in-mobile push-file aurora /local/file /home/user/file
```

**Platforms:** Android, Aurora

---

### pull-file

Copy a file from device filesystem to local machine.

```bash
claude-in-mobile pull-file android /sdcard/remote/file /local/path
claude-in-mobile pull-file aurora /home/user/file /local/file
```

**Platforms:** Android, Aurora

---

### get-clipboard

Read current clipboard content from the device.

```bash
claude-in-mobile get-clipboard android
claude-in-mobile get-clipboard ios
claude-in-mobile get-clipboard desktop --companion-path /path/to/companion
```

**Platforms:** Android, iOS, Desktop

---

### set-clipboard

Set clipboard content on the device.

```bash
claude-in-mobile set-clipboard android "copied text"
claude-in-mobile set-clipboard ios "copied text"
claude-in-mobile set-clipboard desktop "text" --companion-path /path/to/companion
```

**Platforms:** Android, iOS, Desktop

---

### logs

Retrieve device logs. Supports line limit and filtering.

```bash
claude-in-mobile logs android -l 50
claude-in-mobile logs android -f "MyTag"
claude-in-mobile logs ios -l 200
claude-in-mobile logs aurora -l 100
```

| Flag | Description | Default |
|------|-------------|---------|
| `-l, --lines <n>` | Number of log lines to retrieve | 100 |
| `-f, --filter <text>` | Filter by tag/process/text | — |
| `--level <V/D/I/W/E/F>` | Log level filter (Android) | — |
| `--tag <tag>` | Filter by tag (Android) | — |
| `--package <pkg>` | Filter by package name (Android) | — |

**Platforms:** Android, iOS, Aurora

---

### clear-logs

Clear all device logs.

```bash
claude-in-mobile clear-logs android
claude-in-mobile clear-logs ios
claude-in-mobile clear-logs aurora
```

**Platforms:** Android, iOS, Aurora

---

### system-info

Get device system information (battery, memory, OS version, etc.).

```bash
claude-in-mobile system-info android
claude-in-mobile system-info ios
claude-in-mobile system-info aurora
```

**Platforms:** Android, iOS, Aurora

---

### current-activity

Get the currently displayed activity or foreground app.

```bash
claude-in-mobile current-activity android
claude-in-mobile current-activity ios
```

**Platforms:** Android, iOS

---

### reboot

Reboot the device or restart the simulator.

```bash
claude-in-mobile reboot android
claude-in-mobile reboot ios
```

**Platforms:** Android, iOS

---

### screen

Control screen power state (turn display on/off).

```bash
claude-in-mobile screen on
claude-in-mobile screen off
```

**Platforms:** Android only

---

### open-url

Open a URL in the device's default browser.

```bash
claude-in-mobile open-url android "https://example.com"
claude-in-mobile open-url ios "https://example.com"
claude-in-mobile open-url aurora "https://example.com"
```

**Platforms:** Android, iOS, Aurora

---

### shell

Execute an arbitrary shell command on the device.

```bash
claude-in-mobile shell android "ls /sdcard"
claude-in-mobile shell ios "ls ~/Documents"
claude-in-mobile shell aurora "uname -a"
```

**Platforms:** Android, iOS, Aurora

---

### wait

Pause execution for a specified duration. Useful in automation scripts between actions.

```bash
claude-in-mobile wait 2000    # wait 2 seconds
claude-in-mobile wait 500     # wait 500ms
```

**Platforms:** cross-platform (no device interaction)

---

### get-window-info

List all open desktop windows with their IDs, titles, positions, and sizes.

```bash
claude-in-mobile get-window-info --companion-path /path/to/companion
```

**Platforms:** Desktop only

---

### focus-window

Bring a desktop window to front by its ID (from `get-window-info`).

```bash
claude-in-mobile focus-window "window-id" --companion-path /path/to/companion
```

**Platforms:** Desktop only

---

### resize-window

Resize a desktop window to specified width and height.

```bash
claude-in-mobile resize-window "window-id" 800 600 --companion-path /path/to/companion
```

**Platforms:** Desktop only

---

### launch-desktop-app

Launch a desktop application by path.

```bash
claude-in-mobile launch-desktop-app /path/to/app --companion-path /path/to/companion
```

**Platforms:** Desktop only

---

### stop-desktop-app

Stop a running desktop application by name.

```bash
claude-in-mobile stop-desktop-app "AppName" --companion-path /path/to/companion
```

**Platforms:** Desktop only

---

### get-performance-metrics

Get CPU/memory usage metrics for running desktop applications.

```bash
claude-in-mobile get-performance-metrics --companion-path /path/to/companion
```

**Platforms:** Desktop only

---

### get-monitors

List connected monitors with resolutions and positions.

```bash
claude-in-mobile get-monitors --companion-path /path/to/companion
```

**Platforms:** Desktop only

---

## Additional Resources

For full platform support matrix and per-platform details (backends, supported/unsupported commands), see **`references/platform-support.md`**.

## Tips

- Use `--compress` on screenshots when sending to LLM — reduces token usage significantly
- `analyze-screen` gives structured JSON of buttons/inputs/texts — useful for automated testing
- `find-and-tap` uses fuzzy matching with confidence scoring — good for flaky element names
- Aurora commands use `audb` (Aurora Debug Bridge) — similar to ADB
- Desktop commands communicate via JSON-RPC with a companion app over stdin/stdout
- Combine `ui-dump` + `tap --index N` for reliable element interaction by index
- Use `wait` between actions in automation scripts to allow UI transitions
