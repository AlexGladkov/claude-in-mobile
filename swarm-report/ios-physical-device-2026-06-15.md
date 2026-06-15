# Feature — Physical iPhone support via MCP (go-ios + WDA)

**Date:** 2026-06-15
**Profile:** Бизнес-фича
**Status:** Phase 1 complete & verified on-device. Phase 2 code complete;
live verification blocked on an Xcode Apple-ID sign-in (see below).

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

## Phase 2 (code complete) — WDA on the device

`WDAManager.ensureWDAReady(deviceId, isSimulator)`: physical devices take a new
`launchWDADevice()` that runs `xcodebuild test` against `platform=iOS,id=<udid>`
with `-allowProvisioningUpdates`, `DEVELOPMENT_TEAM` (IOS_TEAM_ID/WDA_TEAM_ID env,
else first codesigning identity), and a team-unique `PRODUCT_BUNDLE_IDENTIFIER`
(WDA_BUNDLE_ID, default `com.<team>.WebDriverAgentRunner`). WDA listens on the
device; `ios forward` maps it to a local port so the localhost WDAClient is
unchanged. `IosClient` routes launches physical-vs-sim via go-ios membership.
Screenshots: `WDAClient.screenshot()` (GET /screenshot) + `screenshotRawAsync()`
route physical→WDA, simulator→simctl.

### Live bring-up result (blocked, environment)

The on-device e2e (`screenshotRawAsync` → xcodebuild → forward → WDA) ran and
failed at signing — exactly the expected first-run hurdle, not a code defect:

```
No Account for Team "UL6KLBDCNB". Add a new account in Accounts settings...
No profiles for 'com.facebook.WebDriverAgentRunner.xctrunner' were found
```

Two causes, both now addressed except the one requiring the user:
1. **No Apple ID signed in to Xcode** for the team — `-allowProvisioningUpdates`
   needs an account in Xcode > Settings > Accounts, not just a keychain cert.
   **User action required.**
2. Stock `com.facebook.WebDriverAgentRunner` is unsignable under another team —
   fixed by the team-unique bundle-id override.

Developer Mode is ON and the Mac is trusted. The go-ios tunnel question for iOS
26.5 forwarding is still UNKNOWN — the run failed before the forward/WDA stage.

### Runbook to finish live verification

1. Xcode > Settings > Accounts → add the Apple ID for team `UL6KLBDCNB`.
2. (optional) `export WDA_BUNDLE_ID=com.<you>.WebDriverAgentRunner`.
3. Re-run the device bring-up; if WDA starts but the screenshot/health check
   times out, start the go-ios tunnel (`sudo ios tunnel start` or
   `ENABLE_GO_IOS_AGENT=user`) and re-run.

### Remaining (after live verification)

- `cli/src/ios.rs` mirror (Rust CLI physical discovery + screenshot path).
- Confirm/handle the iOS 17+ tunnel requirement for `ios forward`.
- On-device e2e: tap / input / ui-tree.

## Files changed

Phase 1:
- `src/ios/go-ios/{parsers,client,index}.ts` (new), `parsers.test.ts` (new)
- `src/ios/client.ts` — merge physical devices into `getDevices()`

Phase 2:
- `src/ios/wda/wda-manager.ts` — `launchWDADevice` (device destination, signing,
  bundle-id override), `ios forward` lifecycle, team-id resolve.
- `src/ios/wda/wda-client.ts` — `screenshot()` (GET /screenshot).
- `src/ios/client.ts` — `isSimulatorDevice` routing, `screenshotRawAsync`.
- `src/adapters/ios-adapter.ts` — async screenshot via `screenshotRawAsync`.
