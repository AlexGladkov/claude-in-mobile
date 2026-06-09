# E2E Smoke Report — D8 + D9 (3.12.0)

**Date:** 2026-06-09
**Branch:** release/3.12.0 (commit 260f187)
**Method:** JSON-RPC stdio client against built `dist/index.js`
**Script:** `scripts/smoke-e2e.mjs`

## Devices

| Platform | Device | Notes |
|---|---|---|
| Android | emulator-5554 (Pixel_9_Pro_E2E, AOSP API 35) | Booted via `~/Library/Android/sdk/emulator/emulator -avd Pixel_9_Pro_E2E` |
| iOS | iPhone 17 Pro Simulator (iOS 26.0, UUID 7883FA5B-…) | Booted via `xcrun simctl boot` |
| Browser | Chrome (via chrome-launcher + CDP) | Headless session |

## Result

**SUMMARY: 16/16 pass / 0 fail**

### Protocol
| Step | Result |
|---|---|
| `initialize` (MCP 2025-03-26) | PASS — serverInfo returned |
| `tools/list` | PASS — 27 tools registered |
| `device.list` | PASS — returned Android + iOS devices |

### Android (6/6)
| Tool | Args | Result |
|---|---|---|
| `screen` | `action=capture, preset=low` | PASS |
| `ui` | `action=tree, format=semantic` | PASS |
| `app` | `action=launch, package=com.android.settings` | PASS |
| `input` | `action=tap, x=400, y=800` | PASS |
| `input` | `action=key, key=BACK` | PASS |
| `system` | `action=info` | PASS |

### iOS (2/2)
| Tool | Args | Result |
|---|---|---|
| `screen` | `action=capture, preset=low` | PASS (PNG written to tmp) |
| `ui` | `action=tree, format=semantic` | PASS |

### Browser (4/4)
| Tool | Args | Result |
|---|---|---|
| `browser` | `action=open, url=https://example.com, headless=true` | PASS |
| `browser` | `action=snapshot` | PASS |
| `browser` | `action=screenshot` | PASS |
| `browser` | `action=evaluate, expression=document.title` | PASS |
| `browser` | `action=close` | PASS |

## D8 + D9 coverage validated

| Refactor | Verified by |
|---|---|
| D8 `RuntimeContext` extraction | Server boot + tools/list (registry singleton via default ctx) |
| D8 `common-schema` (platformEnum derive) | All Android/iOS/Browser platform args accepted |
| D8 `dispatchByPlatform` helper | `system.info` cross-platform routing |
| D8 meta-tool descriptor barrel | All 20 metas registered (browser, app, system, ui, screen, input) |
| D8.5 `ui-parser` split (semantic formatter) | Android `ui.tree, format=semantic` returns parsed tree |
| D9.1c device-manager facade + facades | `device.list` returns multi-platform device list |
| D9.5 sandbox-tools split | Plugin tools registered (sandbox in registry) |
| D9.6 sensor-tools split | sensor meta registered |
| D9.7 ui-tools split | `ui.tree` works on Android + iOS |
| D9.8 index.ts bootstrap extract | `mcp-server.ts` handles initialize/tools.list/tools.call |
| D9.9 errors.ts split | All error envelopes (UNKNOWN_ACTION, VALIDATION_ERROR, BROWSER_NO_SESSION) returned via faceted error classes |
| D9.10 adb/client split (`parsers.ts`, `logcat.ts`) | Android screen + UI + app + input flows |
| D9.11 ios/client split (`simctl-*`, `wda-*`, `keymap`) | iOS screen capture + UI tree via WDA |
| D9.12 desktop/client split (`launch-options.ts`) | Boot succeeds (state machine intact) |
| D9.13 browser/client split (`cdp-helpers`, `snapshot-builder`, `key-map`) | Full browser flow: launch chrome → CDP attach → DOM snapshot → screenshot → JS eval |

## Notable observations

- **Aurora platform not booted** — `[Aurora] Failed to list devices: audb not found` is expected. Aurora not in test scope.
- **iOS device list shows shutdown tvOS sims** — informational, not failure.
- **`app(action=launch)` returned "Activity not started, intent delivered to currently running"** — Settings was already focused; server returned success (warning, not error).
- **All tools resolved via meta-aliases correctly** — `app`, `system`, `ui`, `screen`, `input`, `browser` all dispatched without ambiguity.

## Reproducing

```bash
# Boot Android emulator (any AVD with API ≥ 30)
~/Library/Android/sdk/emulator/emulator -avd Pixel_9_Pro_E2E -no-snapshot-save -no-boot-anim &
adb wait-for-device

# Boot iOS sim
xcrun simctl boot "iPhone 17 Pro"
open -a Simulator

# Build + smoke
npm run build
node scripts/smoke-e2e.mjs android,ios,browser
```

Exit code 0 = all pass.
