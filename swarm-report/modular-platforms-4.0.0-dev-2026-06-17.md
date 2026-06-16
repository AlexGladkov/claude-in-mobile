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
- **Physical split (3/5).** aurora, web, desktop fully extracted into
  `@claude-in-mobile/plugin-*` standalone packages, loaded by dynamic import,
  **absent from the base bundle** (verified: no `audb`/`chrome-*`/`src/desktop`
  in base dist). Base accesses their clients/adapters structurally via
  `adapters/contracts.ts` (no `instanceof` / no impl imports).
- **`@claude-in-mobile/plugin-all`** meta — install all packaged platforms.
- **vitest** now covers `packages/*/src` tests (1270 total).
- Version bumped to 4.0.0-dev across all manifests; lockfiles synced; emnapi
  linux branch preserved.

## NOT split — android & ios (gated in-base)
These remain inside the base package (conditionally loaded, fully functional).
**Why not extracted:** `src/adb` is not android-only — `adb/ui-parser` (+
`commands`) is imported by ~33 sites across a11y, autopilot, perf and many
tools; `src/ios` is similarly large. A clean physical split first requires
extracting that shared UI-parsing into base/shared-core and decoupling
`perf/collector` etc. — a separate refactor with real blast radius across the
tool layer. Forcing it under time pressure would be techdebt; deferred as the
documented next step.

### Follow-up to finish android/ios extraction
1. Keep `adb/ui-parser`, `adb/ui-scoring`, `adb/ui-tree-cache`, `adb/commands`
   in base (shared); expose via `claude-in-mobile/adb/*` export.
2. Move only device-specific adb files (client, webview, logcat, exec,
   resolver, keycodes, text-escape, parsers) into `plugin-android`.
3. Decouple `perf/collector` from `AdbClient` (→ `AdbClientLike`).
4. Same shared-vs-device triage for `src/ios`.

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
