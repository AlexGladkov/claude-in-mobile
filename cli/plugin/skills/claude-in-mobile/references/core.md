# Core Commands (Cross-Platform)

Commands available on multiple platforms (Android, iOS, Aurora, Desktop — varies per command).

---

### screenshot

Capture a screenshot. Outputs base64 to stdout by default, or save to file with `-o`.

```bash
mcp-devices screenshot android
mcp-devices screenshot ios
mcp-devices screenshot aurora
mcp-devices screenshot desktop --companion-path /path/to/companion

# Save to file
mcp-devices screenshot android -o screen.png

# Compress for LLM (resize + JPEG quality reduction)
mcp-devices screenshot android --compress --max-width 800 --quality 60
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
mcp-devices annotate android -o annotated.png
mcp-devices annotate ios -o annotated.png
```

| Flag | Description |
|------|-------------|
| `-o, --output <path>` | Save to file instead of base64 stdout |

**Platforms:** Android, iOS

---

### screen-size

Get screen resolution in pixels.

```bash
mcp-devices screen-size android
mcp-devices screen-size ios
```

**Platforms:** Android, iOS

---

### tap

Tap at exact coordinates, or by text/resource-id/index.

```bash
# By coordinates
mcp-devices tap android 500 800
mcp-devices tap ios 200 400
mcp-devices tap aurora 300 600
mcp-devices tap desktop 100 200 --companion-path /path/to/companion

# By text (searches UI tree, finds element, taps center)
mcp-devices tap android 0 0 --text "Login"
mcp-devices tap desktop 0 0 --text "Submit" --companion-path /path/to/companion

# By resource-id (Android)
mcp-devices tap android 0 0 --resource-id "btn_login"

# By element index from ui-dump (Android)
mcp-devices tap android 0 0 --index 5
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
mcp-devices tap-text android "Submit"
mcp-devices tap-text ios "Login"
```

**Platforms:** Android, iOS

---

### find

Search UI hierarchy for an element by text, resource-id, or content-desc. Returns element coordinates and bounds.

```bash
mcp-devices find android "Login"
mcp-devices find ios "Submit"
```

**Platforms:** Android, iOS

---

### long-press

Long press at coordinates or by text. Duration configurable in milliseconds.

```bash
# By coordinates
mcp-devices long-press android 500 800 -d 2000
mcp-devices long-press ios 300 600
mcp-devices long-press aurora 400 700

# By text (Android: finds element, long presses at center)
mcp-devices long-press android 0 0 --text "Delete"
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
mcp-devices swipe android 500 1500 500 500 -d 300

# By direction (uses screen center, swipes 400px)
mcp-devices swipe android 0 0 0 0 --direction up
mcp-devices swipe ios 0 0 0 0 --direction left
mcp-devices swipe aurora 0 0 0 0 --direction down
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
mcp-devices input android "Hello world"
mcp-devices input ios "Search query"
mcp-devices input aurora "user@example.com"
mcp-devices input desktop "text" --companion-path /path/to/companion
```

**Platforms:** Android, iOS, Aurora, Desktop

---

### key

Press a hardware/software key or button.

```bash
mcp-devices key android back
mcp-devices key android home
mcp-devices key android enter
mcp-devices key ios home
mcp-devices key aurora back
mcp-devices key desktop enter --companion-path /path/to/companion
```

Common keys: `home`, `back`, `enter`, `power`, `volume_up`, `volume_down`, `tab`, `delete`.

**Platforms:** Android, iOS, Aurora, Desktop

---

### ui-dump

Dump the current UI hierarchy. Default format is JSON; also supports XML for Android.

```bash
mcp-devices ui-dump android
mcp-devices ui-dump android -f xml
mcp-devices ui-dump ios
mcp-devices ui-dump desktop --companion-path /path/to/companion
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
mcp-devices apps android
mcp-devices apps android -f "myapp"
mcp-devices apps ios
mcp-devices apps aurora
```

| Flag | Description |
|------|-------------|
| `-f, --filter <text>` | Filter by package/bundle name |

**Platforms:** Android, iOS, Aurora

---

### launch

Launch an application by package name, bundle ID, or path.

```bash
mcp-devices launch android com.example.app
mcp-devices launch ios com.example.app
mcp-devices launch aurora harbour-myapp
mcp-devices launch desktop /path/to/app --companion-path /path/to/companion
```

**Platforms:** Android, iOS, Aurora, Desktop

---

### stop

Force-stop/kill an application.

```bash
mcp-devices stop android com.example.app
mcp-devices stop ios com.example.app
mcp-devices stop aurora harbour-myapp
mcp-devices stop desktop "AppName" --companion-path /path/to/companion
```

**Platforms:** Android, iOS, Aurora, Desktop

---

### install

Install an application package onto the device.

```bash
mcp-devices install android /path/to/app.apk
mcp-devices install ios /path/to/app.app
mcp-devices install aurora /path/to/app.rpm
```

**Platforms:** Android, iOS, Aurora

---

### uninstall

Remove an installed application from the device.

```bash
mcp-devices uninstall android com.example.app
mcp-devices uninstall ios com.example.app
mcp-devices uninstall aurora harbour-myapp
```

**Platforms:** Android, iOS, Aurora

---

### push-file

Copy a local file to the device filesystem.

```bash
mcp-devices push-file android /local/path /sdcard/remote/path
mcp-devices push-file aurora /local/file /home/user/file
```

**Platforms:** Android, Aurora

---

### pull-file

Copy a file from device filesystem to local machine.

```bash
mcp-devices pull-file android /sdcard/remote/file /local/path
mcp-devices pull-file aurora /home/user/file /local/file
```

**Platforms:** Android, Aurora

---

### get-clipboard

Read current clipboard content from the device.

```bash
mcp-devices get-clipboard android
mcp-devices get-clipboard ios
mcp-devices get-clipboard desktop --companion-path /path/to/companion
```

**Platforms:** Android, iOS, Desktop

---

### set-clipboard

Set clipboard content on the device.

```bash
mcp-devices set-clipboard android "copied text"
mcp-devices set-clipboard ios "copied text"
mcp-devices set-clipboard desktop "text" --companion-path /path/to/companion
```

**Platforms:** Android, iOS, Desktop

---

### logs

Retrieve device logs. Supports line limit and filtering.

```bash
mcp-devices logs android -l 50
mcp-devices logs android -f "MyTag"
mcp-devices logs ios -l 200
mcp-devices logs aurora -l 100
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
mcp-devices clear-logs android
mcp-devices clear-logs ios
mcp-devices clear-logs aurora
```

**Platforms:** Android, iOS, Aurora

---

### system-info

Get device system information (battery, memory, OS version, etc.).

```bash
mcp-devices system-info android
mcp-devices system-info ios
mcp-devices system-info aurora
```

**Platforms:** Android, iOS, Aurora

---

### current-activity

Get the currently displayed activity or foreground app.

```bash
mcp-devices current-activity android
mcp-devices current-activity ios
```

**Platforms:** Android, iOS

---

### reboot

Reboot the device or restart the simulator.

```bash
mcp-devices reboot android
mcp-devices reboot ios
```

**Platforms:** Android, iOS

---

### open-url

Open a URL in the device's default browser.

```bash
mcp-devices open-url android "https://example.com"
mcp-devices open-url ios "https://example.com"
mcp-devices open-url aurora "https://example.com"
```

**Platforms:** Android, iOS, Aurora

---

### shell

Execute an arbitrary shell command on the device.

```bash
mcp-devices shell android "ls /sdcard"
mcp-devices shell ios "ls ~/Documents"
mcp-devices shell aurora "uname -a"
```

**Platforms:** Android, iOS, Aurora

---

### wait

Pause execution for a specified duration. Useful in automation scripts between actions.

```bash
mcp-devices wait 2000    # wait 2 seconds
mcp-devices wait 500     # wait 500ms
```

**Platforms:** cross-platform (no device interaction)
