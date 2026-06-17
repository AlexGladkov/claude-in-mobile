# Modular platform delivery — 4.0.0-dev

**Date:** 2026-06-17
**Branch:** `release/4.0.0-dev` (experimental; 3.x stays prod)

## Goal
Slim base + deliver platforms on demand (`install <p>` / `install all`),
default no platforms.

## Delivered
- **Phase 1 — conditional loading.** Base is slim by default; platforms gated
  by `CLAUDE_IN_MOBILE_PLATFORMS` / `~/.claude-in-mobile/config.json`. Missing
  platform → actionable error. (`runtime/platform-config.ts`, `bootstrap.ts`)
- **Phase 2 — CLI.** `platforms` / `install <p|all>` / `uninstall` / `doctor`
  (toolchain checks). Config persisted. (`runtime/platform-cli.ts`)
- **Physical split (5/5 — ALL platforms).** android, ios, web, desktop, aurora
  fully extracted into `@claude-in-mobile/plugin-*` standalone packages, loaded
  by dynamic import, **absent from the base bundle**. Base is truly slim
  (builtin-tools + repl). Base accesses their clients/adapters structurally via
  `adapters/contracts.ts` (no `instanceof` / no impl imports).
- **Decomposition fix (the keystone).** The generic UI-tree subsystem
  (`ui-parser`/`ui-scoring`/`ui-tree-cache`) was mis-homed under android's
  `adb/` though ~33 sites (a11y/autopilot/perf/tools) use it. Extracted to a
  neutral `src/ui-tree/`, which is what unblocked the android split. `adb/`
  now holds only android-device code (+ `adb/commands` shell-string builders
  kept in base for generic sensor/system tools). iOS similarly split:
  device-control → package, the `ios/build` .ipa pipeline + appstore/TestFlight
  tools stay in base (independent of device-control).
- **`@claude-in-mobile/plugin-all`** meta — install all packaged platforms.
- **vitest** now covers `packages/*/src` tests (1270 total).
- Version bumped to 4.0.0-dev across all manifests; lockfiles synced; emnapi
  linux branch preserved.

## All five split — how the "hard" two were done
android and ios initially looked un-extractable; that was a **componentization
gap**, not a hard block:
- **android:** the generic UI-tree subsystem was mis-homed under `adb/`.
  Extracting it to neutral `src/ui-tree/` (33 import sites updated) left `adb/`
  android-only and the split became clean. `adb/commands` (pure shell strings,
  used by generic sensor/system tools) stays in base via `claude-in-mobile/adb/*`.
- **ios:** device-control (`client`/`wda`/`go-ios`/`simctl`/`keymap`) moved to
  the package; the independent `ios/build` .ipa pipeline + appstore/TestFlight
  tools stay in base. `getIosClient` resolved structurally (`IosClientLike`).

## Verification
- Full suite **1270/1270**; tsc clean; build clean.
- Slim base boots (`--version` → 4.0.0-dev) with zero platforms.
- Clean-dir install of base tarball: no platform impl bundled; enabling a
  packaged platform without its package → graceful warn + boots.
- Dynamic load proven: enabling web/desktop/aurora registers them from their
  packages; android/ios register in-base. All 5 coexist.

## Pending (needs explicit go)
- **Publish 4.0.0-dev to npm** (base + plugin-{aurora,web,desktop,all} under
  dist-tag `dev`) — outward/irreversible, awaiting confirmation. CI runners are
  unavailable, so publish would be manual (as with 3.14.0).
- Wire `install` to actually `npm i @claude-in-mobile/plugin-<p>@dev` once the
  packages are published (currently enables config + guides).
