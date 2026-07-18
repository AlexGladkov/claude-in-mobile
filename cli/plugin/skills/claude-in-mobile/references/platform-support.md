# Platform Support Reference

## Platform Details

### Android

- **Backend:** ADB (`adb` must be in PATH)
- **Device selection:** `--device <serial>` (see `adb devices`)
- **Full feature support:** all 33 commands available
- **Key names:** home, back, enter, power, volume_up, volume_down, tab, delete, menu, camera, search

### iOS

- **Backend:** simctl (`xcrun simctl`)
- **Device selection:** `--simulator <name>` (default: booted simulator)
- **Supported:** screenshot, annotate, tap, long-press, swipe, input, key, ui-dump, find, tap-text, devices, apps, launch, stop, install, uninstall, clipboard, logs, clear-logs, system-info, current-activity, reboot, screen-size, open-url, shell
- **Not supported:** analyze-screen, find-and-tap, push-file, pull-file, screen power

### Aurora OS

- **Backend:** `audb >= 0.2.0` (`AUDB_PATH` override supported)
- **Device selection:** emulator-only, ID `emulator`
- **Supported:** screenshot and input, app/package lifecycle, process waits, clear-data, files/logs/info/shell, display control, performance/crashes, sandbox/SQLite, network/proxy/offline, location and raw sensors
- **Aurora namespace:** `claude-in-mobile aurora emulator|display|app|perf|crash|sandbox|network|location|sensor|package ...`
- **Not supported:** UI accessibility/annotation and reliable global clipboard; physical devices are deferred

### Desktop (Compose/Swing/AWT)

- **Backend:** companion JSON-RPC app (stdin/stdout communication)
- **Setup:** set `--companion-path` on each command or `MOBILE_TOOLS_COMPANION` env var
- **Supported:** screenshot, tap (coordinates + text), input, key, ui-dump, launch, stop, clipboard, window management, monitors, performance metrics
- **Not supported:** annotate, long-press, swipe, find, tap-text, analyze-screen, find-and-tap, apps listing, install, uninstall, push/pull files, logs, system-info, shell

## Platform Support Matrix

| Command | Android | iOS | Aurora | Desktop |
|---------|---------|-----|--------|---------|
| screenshot | yes | yes | yes | yes |
| annotate | yes | yes | no | no |
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
| clear-logs | yes | yes | yes | no |
| system-info | yes | yes | yes | no |
| current-activity | yes | yes | no | no |
| reboot | yes | yes | no | no |
| screen (power) | yes | no | yes | no |
| screen-size | yes | yes | no | no |
| open-url | yes | yes | yes | no |
| shell | yes | yes | yes | no |
| wait | n/a | n/a | n/a | n/a |
| window mgmt | no | no | no | yes |
| monitors | no | no | no | yes |
| perf metrics | yes | partial | yes | yes |
