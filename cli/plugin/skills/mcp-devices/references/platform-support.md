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

### HarmonyOS

- **Backend:** HDC (`hdc` in PATH or `HDC_PATH` set to the executable)
- **Device selection:** `--device <serial>` (see `hdc list targets -v`)
- **Supported:** screenshot, coordinate tap and long-press, swipe, input, key, ui-dump (JSON), devices, apps, launch, stop, install, uninstall, push-file, pull-file, logs, clear-logs, system-info, open-url, shell
- **Not supported:** annotate, text-based element search/tap, clipboard, current-activity, reboot, screen power, screen-size, flows

### Aurora OS

- **Backend:** audb ^0.3.0; executable in PATH takes priority over AUDB_PATH.
- **Device selection:** `--device <registry-id>`; omitted uses audb's default, not the first connected target. Phones and emulators share the same commands.
- **Supported:** screenshots, coordinate tap/double tap/long press, swipe, Unicode input, named keys, devices, apps, launch, stop, RPM install/uninstall, push/pull, logs, info, screen-size, URL opening, shell and Sailjail permissions.
- **Not supported:** UI tree/annotate/find/tap-text, clipboard, activity, reboot and screen power. Sensor/perf/sandbox extensions are outside this integration.
- **Setup and limitations:** read [aurora.md](aurora.md). Check readiness with `mcp-devices-cli aurora --device ID doctor`; registry state unknown is not a connectivity result.

### Desktop (Compose/Swing/AWT)

- **Backend:** companion JSON-RPC app (stdin/stdout communication)
- **Setup:** set `--companion-path` on each command or `MOBILE_TOOLS_COMPANION` env var
- **Supported:** screenshot, tap (coordinates + text), input, key, ui-dump, launch, stop, clipboard, window management, monitors, performance metrics
- **Not supported:** annotate, long-press, swipe, find, tap-text, analyze-screen, find-and-tap, apps listing, install, uninstall, push/pull files, logs, system-info, shell

## Platform Support Matrix

| Command | Android | iOS | HarmonyOS | Aurora | Desktop |
|---------|---------|-----|-----------|--------|---------|
| screenshot | yes | yes | yes | yes | yes |
| annotate | yes | yes | no | no | no |
| tap | yes | yes | yes | yes | yes |
| long-press | yes | yes | yes | yes | no |
| swipe | yes | yes | yes | yes | no |
| input | yes | yes | yes | yes | yes |
| key | yes | yes | yes | yes | yes |
| ui-dump | yes | yes | yes | no | yes |
| find/tap-text | yes | yes | no | no | no |
| analyze-screen | yes | no | no | no | no |
| find-and-tap | yes | no | no | no | no |
| devices | yes | yes | yes | yes | n/a |
| apps | yes | yes | yes | yes | n/a |
| launch | yes | yes | yes | yes | yes |
| stop | yes | yes | yes | yes | yes |
| install | yes | yes | yes | yes | n/a |
| uninstall | yes | yes | yes | yes | n/a |
| push-file | yes | no | yes | yes | no |
| pull-file | yes | no | yes | yes | no |
| clipboard | yes | yes | no | no | yes |
| logs | yes | yes | yes | yes | no |
| clear-logs | yes | yes | yes | yes | no |
| system-info | yes | yes | yes | yes | no |
| current-activity | yes | yes | no | no | no |
| reboot | yes | yes | no | no | no |
| screen (power) | yes | no | no | no | no |
| screen-size | yes | yes | no | yes | no |
| open-url | yes | yes | yes | yes | no |
| shell | yes | yes | yes | yes | no |
| wait | n/a | n/a | n/a | n/a | n/a |
| window mgmt | no | no | no | no | yes |
| monitors | no | no | no | no | yes |
| perf metrics | no | no | no | no | yes |
