# Core Commands (Cross-Platform)

Commands available on multiple platforms (Android, iOS, HarmonyOS, Aurora, Desktop — varies per command).

---

### screenshot

Capture a screenshot. Outputs base64 to stdout by default, or save to file with `-o`.

```bash
mcp-devices-cli screenshot android
mcp-devices-cli screenshot ios
mcp-devices-cli screenshot --platform harmony
mcp-devices-cli screenshot aurora
mcp-devices-cli screenshot desktop --companion-path /path/to/companion

# Save to file
mcp-devices-cli screenshot android -o screen.png

# Compress for LLM (resize + JPEG quality reduction)
mcp-devices-cli screenshot android --compress --max-width 800 --quality 60
```

| Flag | Description | Default |
|------|-------------|---------|
| `-o, --output <path>` | Save to file instead of base64 stdout | stdout |
| `-c, --compress` | Enable compression (resize + quality) | false |
| `--max-width <px>` | Max width when compressing | 1024 |
| `--max-height <px>` | Max height when compressing | unlimited |
| `--quality <1-100>` | JPEG quality when compressing | 80 |
| `--monitor-index <n>` | Monitor index (Desktop) | primary |

**Platforms:** Android, iOS, HarmonyOS, Aurora, Desktop

---

### annotate

Capture screenshot with UI element bounding boxes drawn over it. Useful for visual debugging and identifying tap targets.

```bash
mcp-devices-cli annotate android -o annotated.png
mcp-devices-cli annotate ios -o annotated.png
```

| Flag | Description |
|------|-------------|
| `-o, --output <path>` | Save to file instead of base64 stdout |

**Platforms:** Android, iOS

---

### screen-size

Get screen resolution in pixels. Aurora uses the actual PNG dimensions.

```bash
mcp-devices-cli screen-size android
mcp-devices-cli screen-size ios
mcp-devices-cli screen-size aurora --device phone
```

**Platforms:** Android, iOS, HarmonyOS, Aurora

---

### tap

Tap at exact coordinates, or by text/resource-id/index.

```bash
# By coordinates
mcp-devices-cli tap android 500 800
mcp-devices-cli tap ios 200 400
mcp-devices-cli tap --platform harmony 300 600
mcp-devices-cli tap aurora 300 600
mcp-devices-cli tap desktop 100 200 --companion-path /path/to/companion

# By text (searches UI tree, finds element, taps center)
mcp-devices-cli tap android 0 0 --text "Login"
mcp-devices-cli tap desktop 0 0 --text "Submit" --companion-path /path/to/companion

# By resource-id (Android)
mcp-devices-cli tap android 0 0 --resource-id "btn_login"

# By element index from ui-dump (Android)
mcp-devices-cli tap android 0 0 --index 5
```

| Flag | Description | Platforms |
|------|-------------|-----------|
| `--text <text>` | Tap element matching text | Android, Desktop |
| `--resource-id <id>` | Tap element by resource-id | Android |
| `--index <n>` | Tap element by ui-dump index | Android |

**Platforms:** Android, iOS, HarmonyOS, Aurora, Desktop

---

### tap-text

Find an element by text, resource-id, or content-desc in the UI hierarchy and tap it. Shortcut for `find` + `tap`.

```bash
mcp-devices-cli tap-text android "Submit"
mcp-devices-cli tap-text ios "Login"
```

**Platforms:** Android, iOS

---

### find

Search UI hierarchy for an element by text, resource-id, or content-desc. Returns element coordinates and bounds.

```bash
mcp-devices-cli find android "Login"
mcp-devices-cli find ios "Submit"
```

**Platforms:** Android, iOS

---

### long-press

Long press at coordinates or by text. Duration configurable in milliseconds.

```bash
# By coordinates
mcp-devices-cli long-press android 500 800 -d 2000
mcp-devices-cli long-press ios 300 600
mcp-devices-cli long-press --platform harmony 400 700
mcp-devices-cli long-press aurora 400 700

# By text (Android: finds element, long presses at center)
mcp-devices-cli long-press android 0 0 --text "Delete"
```

| Flag | Description | Default |
|------|-------------|---------|
| `-d, --duration <ms>` | Press duration in milliseconds | 1000 |
| `--text <text>` | Find by text and long press | — |

**Platforms:** Android, iOS, HarmonyOS, Aurora

---

### swipe

Swipe gesture between coordinates, or by named direction (up/down/left/right).

```bash
# By coordinates (x1 y1 x2 y2)
mcp-devices-cli swipe android 500 1500 500 500 -d 300

# By direction (uses screen center, swipes 400px)
mcp-devices-cli swipe android 0 0 0 0 --direction up
mcp-devices-cli swipe ios 0 0 0 0 --direction left
mcp-devices-cli swipe --platform harmony 0 0 0 0 --direction left
mcp-devices-cli swipe aurora 0 0 0 0 --direction down
```

| Flag | Description | Default |
|------|-------------|---------|
| `-d, --duration <ms>` | Swipe duration in milliseconds | 300 |
| `--direction <dir>` | Swipe direction: up, down, left, right (overrides coordinates) | — |

**Platforms:** Android, iOS, HarmonyOS, Aurora

---

### input

Type text into the currently focused field.

```bash
mcp-devices-cli input android "Hello world"
mcp-devices-cli input ios "Search query"
mcp-devices-cli input --platform harmony "Search query"
mcp-devices-cli input aurora "user@example.com"
mcp-devices-cli input desktop "text" --companion-path /path/to/companion
```

**Platforms:** Android, iOS, HarmonyOS, Aurora, Desktop

---

### key

Press a hardware/software key or button.

```bash
mcp-devices-cli key android back
mcp-devices-cli key android home
mcp-devices-cli key android enter
mcp-devices-cli key ios home
mcp-devices-cli key --platform harmony back
mcp-devices-cli key aurora back
mcp-devices-cli key desktop enter --companion-path /path/to/companion
```

Common keys: `home`, `back`, `enter`, `power`, `volume_up`, `volume_down`, `tab`, `delete`.

**Platforms:** Android, iOS, HarmonyOS, Aurora, Desktop

---

### ui-dump

Dump the current UI hierarchy. Default format is JSON; also supports XML for Android.

```bash
mcp-devices-cli ui-dump android
mcp-devices-cli ui-dump android -f xml
mcp-devices-cli ui-dump ios
mcp-devices-cli ui-dump --platform harmony
mcp-devices-cli ui-dump desktop --companion-path /path/to/companion
```

| Flag | Description | Default |
|------|-------------|---------|
| `-f, --format <fmt>` | Output format: `json` or `xml` | json |
| `--show-all` | Include non-interactive elements (Android) | false |

**Platforms:** Android, iOS, HarmonyOS, Desktop

---

### apps

List installed applications, optionally filtered by name.

```bash
mcp-devices-cli apps android
mcp-devices-cli apps android -f "myapp"
mcp-devices-cli apps ios
mcp-devices-cli apps --platform harmony
mcp-devices-cli apps aurora
```

| Flag | Description |
|------|-------------|
| `-f, --filter <text>` | Filter by package/bundle name |

**Platforms:** Android, iOS, HarmonyOS, Aurora

---

### launch

Launch an application by package name, bundle ID, or path.

```bash
mcp-devices-cli launch android com.example.app
mcp-devices-cli launch ios com.example.app
mcp-devices-cli launch --platform harmony com.example.app --ability EntryAbility --module entry
mcp-devices-cli launch aurora harbour-myapp
mcp-devices-cli launch desktop /path/to/app --companion-path /path/to/companion
```

**Platforms:** Android, iOS, HarmonyOS, Aurora, Desktop

---

### stop

Force-stop/kill an application.

```bash
mcp-devices-cli stop android com.example.app
mcp-devices-cli stop ios com.example.app
mcp-devices-cli stop --platform harmony com.example.app
mcp-devices-cli stop aurora harbour-myapp
mcp-devices-cli stop desktop "AppName" --companion-path /path/to/companion
```

**Platforms:** Android, iOS, HarmonyOS, Aurora, Desktop

---

### install

Install an application package onto the device.

```bash
mcp-devices-cli install android /path/to/app.apk
mcp-devices-cli install ios /path/to/app.app
mcp-devices-cli install --platform harmony /path/to/app.hap
mcp-devices-cli install aurora /path/to/app.rpm
```

**Platforms:** Android, iOS, HarmonyOS, Aurora

---

### uninstall

Remove an installed application from the device.

```bash
mcp-devices-cli uninstall android com.example.app
mcp-devices-cli uninstall ios com.example.app
mcp-devices-cli uninstall --platform harmony com.example.app
mcp-devices-cli uninstall aurora harbour-myapp
```

**Platforms:** Android, iOS, HarmonyOS, Aurora

---

### push-file

Copy a local file to the device filesystem.

```bash
mcp-devices-cli push-file android /local/path /sdcard/remote/path
mcp-devices-cli push-file --platform harmony /local/path /data/local/tmp/remote
mcp-devices-cli push-file aurora /local/file /home/user/file
```

**Platforms:** Android, HarmonyOS, Aurora

---

### pull-file

Copy a file from device filesystem to local machine.

```bash
mcp-devices-cli pull-file android /sdcard/remote/file /local/path
mcp-devices-cli pull-file --platform harmony /data/local/tmp/remote /local/path
mcp-devices-cli pull-file aurora /home/user/file /local/file
```

**Platforms:** Android, HarmonyOS, Aurora

---

### get-clipboard

Read current clipboard content from the device.

```bash
mcp-devices-cli get-clipboard android
mcp-devices-cli get-clipboard ios
mcp-devices-cli get-clipboard desktop --companion-path /path/to/companion
```

**Platforms:** Android, iOS, Desktop

---

### set-clipboard

Set clipboard content on the device.

```bash
mcp-devices-cli set-clipboard android "copied text"
mcp-devices-cli set-clipboard ios "copied text"
mcp-devices-cli set-clipboard desktop "text" --companion-path /path/to/companion
```

**Platforms:** Android, iOS, Desktop

---

### logs

Retrieve device logs. Supports line limit and filtering.

```bash
mcp-devices-cli logs android -l 50
mcp-devices-cli logs android -f "MyTag"
mcp-devices-cli logs ios -l 200
mcp-devices-cli logs --platform harmony -l 200
mcp-devices-cli logs aurora -l 100
```

| Flag | Description | Default |
|------|-------------|---------|
| `-l, --lines <n>` | Number of log lines to retrieve | 100 |
| `-f, --filter <text>` | Filter by tag/process/text | — |
| `--level <V/D/I/W/E/F>` | Log level filter (Android) | — |
| `--tag <tag>` | Filter by tag (Android) | — |
| `--package <pkg>` | Filter by package name (Android) | — |

**Platforms:** Android, iOS, HarmonyOS, Aurora

---

### clear-logs

Clear all device logs.

```bash
mcp-devices-cli clear-logs android
mcp-devices-cli clear-logs ios
mcp-devices-cli clear-logs --platform harmony
mcp-devices-cli clear-logs aurora
```

**Platforms:** Android, iOS, HarmonyOS, Aurora

---

### system-info

Get device system information (battery, memory, OS version, etc.).

```bash
mcp-devices-cli system-info android
mcp-devices-cli system-info ios
mcp-devices-cli system-info --platform harmony
mcp-devices-cli system-info aurora
```

**Platforms:** Android, iOS, HarmonyOS, Aurora

---

### current-activity

Get the currently displayed activity or foreground app.

```bash
mcp-devices-cli current-activity android
mcp-devices-cli current-activity ios
```

**Platforms:** Android, iOS

---

### reboot

Reboot the device or restart the simulator.

```bash
mcp-devices-cli reboot android
mcp-devices-cli reboot ios
```

**Platforms:** Android, iOS

---

### open-url

Open a URL in the device's default browser.

```bash
mcp-devices-cli open-url android "https://example.com"
mcp-devices-cli open-url ios "https://example.com"
mcp-devices-cli open-url --platform harmony "https://example.com"
mcp-devices-cli open-url aurora "https://example.com"
```

**Platforms:** Android, iOS, HarmonyOS, Aurora

---

### shell

Execute an arbitrary shell command on the device.

```bash
mcp-devices-cli shell android "ls /sdcard"
mcp-devices-cli shell ios "ls ~/Documents"
mcp-devices-cli shell --platform harmony "param get"
mcp-devices-cli shell aurora "uname -a"
```

**Platforms:** Android, iOS, HarmonyOS, Aurora

---

### wait

Pause execution for a specified duration. Useful in automation scripts between actions.

```bash
mcp-devices-cli wait 2000    # wait 2 seconds
mcp-devices-cli wait 500     # wait 500ms
```

**Platforms:** cross-platform (no device interaction)

---

### perf-trace

Capture a bounded native trace. Android writes a Perfetto protobuf; iOS
Simulator writes a zipped Instruments Time Profiler trace.

```bash
mcp-devices-cli perf-trace --platform android --package com.example.app \
  --duration-ms 5000 --output ./app.perfetto-trace --device emulator-5554
mcp-devices-cli perf-trace --platform ios --bundle-id com.example.app \
  --duration-ms 5000 --output ./app.trace.zip --simulator "iPhone 17 Pro"
```

`--preset` accepts `ui-jank` or `startup`. Duration must be 1,000–15,000 ms.
iOS Simulator cannot record Animation Hitches, so `ui-jank` uses Time Profiler
and reports the fallback.

**Platforms:** Android, iOS Simulator

---

### perf-heap-capture

Capture an HPROF from a debuggable Android app or a one-second Instruments
Allocations bundle from a running iOS Simulator app.

```bash
mcp-devices-cli perf-heap-capture --platform android --package com.example.app \
  --output ./before.hprof
mcp-devices-cli perf-heap-capture --platform ios --bundle-id com.example.app \
  --output ./before.allocations.trace.zip
```

Artifacts are private (`0600`), bounded, and never overwrite an existing path.
The native CLI does not expire them automatically.

**Platforms:** Android, iOS Simulator

---

### perf-heap-diff

Compare two native heap artifacts by byte size. The signed delta is a
diagnostic signal, not proof of a memory leak.

```bash
mcp-devices-cli perf-heap-diff ./before.hprof ./after.hprof
```

**Platforms:** local command; no device access

For Aurora device setup, permission operations, coordinate scaling and recovery,
read [aurora.md](aurora.md).
