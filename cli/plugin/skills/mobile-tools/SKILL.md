---
name: mobile-tools
description: "This skill should be used when the user asks to \"take a screenshot\", \"tap on element\", \"swipe up/down\", \"type text\", \"install app\", \"launch app\", \"list devices\", \"dump UI\", \"find element\", \"get logs\", \"push file\", \"get clipboard\", \"reboot device\", or interact with Android devices, iOS simulators, Aurora OS devices, or Compose Desktop apps. Provides CLI commands for mobile device automation across all platforms."
---

# mobile-tools CLI

Fast CLI for mobile device automation across **Android** (via ADB), **iOS** (via simctl), **Aurora OS** (via audb), and **Desktop** (via companion JSON-RPC app).

Binary: `mobile-tools` (ensure it's in PATH or use full path to the built binary).

## Quick Reference

### Device & Screenshot

```bash
# List all devices
mobile-tools devices

# Screenshot (outputs base64 to stdout)
mobile-tools screenshot android
mobile-tools screenshot ios
mobile-tools screenshot aurora
mobile-tools screenshot desktop --companion-path /path/to/companion

# Screenshot with compression for LLM
mobile-tools screenshot android --compress --max-width 800 --quality 60

# Save to file
mobile-tools screenshot android -o screen.png

# Annotated screenshot with element bounds drawn
mobile-tools annotate android -o annotated.png

# Analyze screen structure (Android) — returns categorized elements as JSON
mobile-tools analyze-screen

# Screen size
mobile-tools screen-size android
```

### Gestures

```bash
# Tap at coordinates
mobile-tools tap android 500 800
mobile-tools tap ios 200 400

# Tap by text (Android/Desktop)
mobile-tools tap android 0 0 --text "Login"

# Long press
mobile-tools long-press android 500 800 -d 2000
mobile-tools long-press android 0 0 --text "Delete"

# Swipe by coordinates
mobile-tools swipe android 500 1500 500 500 -d 300

# Swipe by direction (uses screen center)
mobile-tools swipe android 0 0 0 0 --direction up
mobile-tools swipe android 0 0 0 0 --direction left

# Fuzzy find and tap (Android)
mobile-tools find-and-tap "Submit" --min-confidence 50
```

### Text Input

```bash
# Type text
mobile-tools input android "Hello world"
mobile-tools input desktop "text" --companion-path /path/to/companion

# Press key
mobile-tools key android back
mobile-tools key android home
mobile-tools key android enter
mobile-tools key ios home
```

### UI Inspection

```bash
# Dump UI hierarchy as JSON
mobile-tools ui-dump android
mobile-tools ui-dump ios
mobile-tools ui-dump desktop --companion-path /path/to/companion

# Dump as XML
mobile-tools ui-dump android -f xml

# Find element
mobile-tools find android "Login"

# Tap element by text/resource-id
mobile-tools tap-text android "Submit"
```

### App Management

```bash
# List apps
mobile-tools apps android
mobile-tools apps android -f "myapp"
mobile-tools apps aurora

# Launch
mobile-tools launch android com.example.app
mobile-tools launch ios com.example.app
mobile-tools launch aurora harbour-myapp
mobile-tools launch desktop /path/to/app --companion-path /path/to/companion

# Stop
mobile-tools stop android com.example.app

# Install
mobile-tools install android /path/to/app.apk
mobile-tools install ios /path/to/app.app
mobile-tools install aurora /path/to/app.rpm

# Uninstall
mobile-tools uninstall android com.example.app
```

### File Transfer

```bash
# Push file to device
mobile-tools push-file android /local/path /sdcard/remote/path
mobile-tools push-file aurora /local/file /home/user/file

# Pull file from device
mobile-tools pull-file android /sdcard/remote/file /local/path
mobile-tools pull-file aurora /home/user/file /local/file
```

### Clipboard

```bash
# Get clipboard
mobile-tools get-clipboard android
mobile-tools get-clipboard ios
mobile-tools get-clipboard desktop --companion-path /path/to/companion

# Set clipboard
mobile-tools set-clipboard android "copied text"
mobile-tools set-clipboard ios "copied text"
```

### System & Logs

```bash
# Logs
mobile-tools logs android -l 50
mobile-tools logs android -f "MyTag"
mobile-tools logs aurora -l 200
mobile-tools clear-logs android

# System info
mobile-tools system-info android
mobile-tools system-info aurora

# Current activity
mobile-tools current-activity android

# Reboot
mobile-tools reboot android

# Screen power (Android)
mobile-tools screen on
mobile-tools screen off

# Open URL
mobile-tools open-url android "https://example.com"

# Shell command
mobile-tools shell android "ls /sdcard"
mobile-tools shell aurora "uname -a"

# Wait
mobile-tools wait 2000
```

### Desktop-specific

```bash
# All desktop commands require --companion-path or MOBILE_TOOLS_COMPANION env var

# Window management
mobile-tools get-window-info --companion-path /path/to/companion
mobile-tools focus-window "window-id" --companion-path /path/to/companion
mobile-tools resize-window "window-id" 800 600 --companion-path /path/to/companion

# App management
mobile-tools launch-desktop-app /path/to/app --companion-path /path/to/companion
mobile-tools stop-desktop-app "AppName" --companion-path /path/to/companion

# Performance
mobile-tools get-performance-metrics --companion-path /path/to/companion
mobile-tools get-monitors --companion-path /path/to/companion
```

## Platform Support Matrix

| Command | Android | iOS | Aurora | Desktop |
|---------|---------|-----|--------|---------|
| screenshot | yes | yes | yes | yes |
| annotate | yes | no | no | no |
| tap | yes | yes | yes | yes |
| long-press | yes | yes | yes | no |
| swipe | yes | yes | yes | no |
| input | yes | yes | yes | yes |
| key | yes | yes | yes | yes |
| ui-dump | yes | yes | no | yes |
| find/tap-text | yes | yes | no | no |
| analyze-screen | yes | no | no | no |
| find-and-tap | yes | no | no | no |
| devices | yes | yes | yes | n/a |
| apps | yes | yes | yes | n/a |
| launch | yes | yes | yes | yes |
| stop | yes | yes | yes | yes |
| install | yes | yes | yes | n/a |
| uninstall | yes | yes | yes | n/a |
| push-file | yes | no | yes | no |
| pull-file | yes | no | yes | no |
| clipboard | yes | yes | no | yes |
| logs | yes | yes | yes | no |
| system-info | yes | yes | yes | no |
| shell | yes | yes | yes | no |
| window mgmt | no | no | no | yes |
| monitors | no | no | no | yes |
| perf metrics | no | no | no | yes |

## Tips

- Use `--compress` on screenshots when sending to LLM — reduces token usage significantly
- `analyze-screen` gives structured JSON of buttons/inputs/texts — useful for automated testing
- `find-and-tap` uses fuzzy matching with confidence scoring — good for flaky element names
- Aurora commands use `audb` (Aurora Debug Bridge) — similar to ADB
- Desktop commands communicate via JSON-RPC with a companion app over stdin/stdout
