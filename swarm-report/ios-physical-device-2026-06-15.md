# Feature — Physical iPhone support via MCP (go-ios + WDA)

**Date:** 2026-06-15
**Profile:** Бизнес-фича
**Status:** Phase 1 complete & verified on-device. Phase 2 pending.

## Goal

Drive a **physical iPhone** through the mobile MCP (tap/input/screenshot/ui),
not just simulators. Today discovery is simctl-only and all UI automation
assumes a simulator destination.

## Architecture decision — A (xcodebuild + go-ios), B deferred

- **A (chosen):** reuse the existing xcodebuild-based `wda-manager` to build/run
  WebDriverAgent (now with a device destination + automatic signing), and use
  go-ios only for device discovery and USB port-forwarding. Maximum reuse;
  requires Xcode at runtime; not headless.
- **B (deferred follow-up):** go-ios `runwda` + a pre-signed WDA.ipa + tunnel.
  Headless/CI-friendly end state, but front-loads signed-ipa + tunnel +
  process-supervision complexity. The Phase 1 discovery abstraction keeps B
  pluggable behind the same interface later.

## Environment confirmed

- go-ios installed via `npm i -g go-ios` (binary `ios`, v1.2.0).
- Signing identity present: `Apple Development: Alex Gladkov (UL6KLBDCNB)`.
- Device: iPhone 15 Pro (iPhone16,1), **iOS 26.5**, trusted (udid
  `00008130-0014191E2221001C`). iOS 17+ ⇒ device services need
  `ios tunnel` (sudo or `ENABLE_GO_IOS_AGENT=user`) — relevant to Phase 2 only.
- `ios list`/`ios info` work over usbmux WITHOUT the tunnel (discovery is fine).

## Phase 1 (done) — discovery

The platform abstraction (`CorePlatformAdapter`) already routes per-`deviceId`
and `autoDetectDevice` already matches `connected`, so **no adapter changes were
needed**. Work was confined to the iOS discovery layer:

New `src/ios/go-ios/`:
- `parsers.ts` — pure parsers for go-ios newline-delimited JSON. `parseDeviceList`
  (`ios list`), `parseInfo` (`ios info`), `toIosDevice`. Robust against the
  interleaved structured-log lines (e.g. the iOS 17+ "agent not running" WARN).
- `client.ts` — `listPhysicalDevices()` / `isGoIosAvailable()`: argv-form
  `execFileSync` (never `/bin/sh`, mirrors `simctl-exec`), stderr ignored so the
  result JSON parses cleanly. **Best-effort**: if go-ios is absent or errors,
  returns `[]` — simulator-only setups are unaffected.
- `parsers.test.ts` — 9 tests over the real `ios list`/`ios info` shapes.

Wiring:
- `IosClient.getDevices()` now returns `[...simulators, ...listPhysicalDevices()]`.
- Physical devices: `isSimulator:false`, `state:"connected"`,
  `runtime:"iOS <ver>"`. `validateDeviceId` already accepts the hex+dash udid.

### Verified

- Unit: iOS suite 64/64; full TS suite **1241/1241**; `tsc --noEmit` clean.
- **Live on-device:** `listPhysicalDevices()` returned the iPhone with correct
  fields. The device now appears in `getDevices()` and is selectable.

## Phase 2 (pending) — make actions work on the device

Discovery alone doesn't move the phone. Remaining work:

1. **WDA on device** — `wda-manager.ts:160` hardcodes
   `platform=iOS Simulator`. Add a device branch: `platform=iOS,id=<udid>` +
   automatic provisioning (`-allowProvisioningUpdates`, the dev identity).
2. **Port forwarding** — `ios forward <local> 8100` so the existing localhost
   `wda-client` reaches WDA unchanged. Discover/track the local port.
3. **iOS 17+ tunnel** — bring up `ios tunnel` (sudo or userspace agent) as a
   prerequisite; surface a clear error if absent.
4. **Screenshots** — `screenshotRaw` uses `simctl io` (simulator-only). Route
   physical screenshots through WDA `/screenshot` (or go-ios).
5. **Rust CLI mirror** — `cli/src/ios.rs` device enumeration + screenshot path.
6. **Live e2e** — tap/input/ui-tree on the device.

Phase 2 needs the tunnel + a device-targeted xcodebuild (slow, first-run
provisioning) and iterative on-device testing — best as its own focused session.

## Files changed (Phase 1)

- `src/ios/go-ios/{parsers,client,index}.ts` (new), `parsers.test.ts` (new)
- `src/ios/client.ts` — merge physical devices into `getDevices()`
