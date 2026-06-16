# Release v3.14.0 — 2026-06-16

## Включено
- fix(repl): #46 hang + bridge audit P1–P4 (concurrency, timeout desync,
  UTF-8 panic, `repl_list` secret leak) + `pick_profile` basename matching.
- feat(repl): `shell` option on `repl_spawn` (`/bin/sh -c`, quote-aware
  metachar guard).
- feat(ios): physical iPhone discovery via go-ios (Phase 1) + WDA-on-device
  bring-up (Phase 2): device-destination xcodebuild + automatic signing +
  team-unique bundle id + `ios forward`; WDA screenshots.
- chore(release): bump 4 mandatory manifests + 5 workspace plugins, CHANGELOG.

## Закрытые issues
- #46 — `repl_spawn` hangs. Commented with the fix + install snippet.
  Auto-closes on merge to main (commit carries `Fixes #46`).

## Версия (semver)
- minor bump 3.13.0 → 3.14.0 (new feature: physical iOS).

## Pre-flight (Стадии 0–6)
- Issues gate: only #46, fixed in-branch.
- Manifests: package.json, cli/Cargo.toml, .claude-plugin/marketplace.json,
  cli/plugin/.claude-plugin/plugin.json + 5 workspace plugins → 3.14.0.
- Lockfiles synced; **emnapi linux optional-dep branch preserved (count = 5 ≥ 4)**
  — the chronic class that broke 3.12.0 and 3.13.0.
- build clean; vitest 1241/1241; cargo build --release clean; cargo test --lib
  97/97.
- Binary smoke: `--version`/`--help` exit 0; repl-supervisor → ready + ok.
- Tarball install smoke: plugin-api bundled; clean-dir install no E404; binary
  → 3.14.0.

## CI runs
- **GitHub Actions runners unavailable (out of budget) — `release.yml` did NOT
  run.** The entire release was performed MANUALLY (local builds + gh + npm +
  homebrew). This is a deviation from the normal automated pipeline; see Lessons.

## Channels verification (Стадия 9 — all 3, really checked)
- **GitHub:** Release v3.14.0 created with 2 tar.gz assets (arm64 3.86 MB,
  x86_64 4.11 MB) + sha256 sidecars. Within the 3–9 MB expectation.
- **npm:** `claude-in-mobile@3.14.0` published (`--access public`, no
  `--provenance` — needs CI OIDC). `dist-tags.latest = 3.14.0`. Fresh
  `npx claude-in-mobile@3.14.0 --version` → 3.14.0 (no E404).
- **Homebrew:** tap formula bumped 3.13.0 → 3.14.0 (version + both sha256),
  pushed to `AlexGladkov/homebrew-claude-in-mobile`. `brew upgrade` →
  Cellar 3.14.0; Rust binary `--version` → 3.14.0. npm-g symlink shadow
  resolved by `npm i -g claude-in-mobile@3.14.0` (both now 3.14.0).
- Post-install repl-supervisor smoke → ready + ok.

## Артефакты / sha256
- arm64: `1f6cd28c54ac5fbc380c94cb68fadbc59e60a7de557eeaae3421329f5f5eed71`
- x86_64: `3978f8ba3c5ad79fd0554edd372a106cba813e851bdd6a6dd307ff1ca4189462`

## Известные ограничения / отложено
- npm publish lacks provenance attestation (CI-only). Acceptable one-off.
- iOS Phase 2 (WDA-on-device) shipped but live tap/screenshot unverified on a
  real device (blocked earlier on an Xcode signing account). Code paths are
  guarded and fail with actionable errors.
- Branch not yet merged to main (next step) — #46 closes then.

## Lessons learned (manual-release deviation)
- **CI was dead → manual release.** Reproduced every release.yml job by hand:
  cross-build both darwin targets (`--target aarch64/x86_64-apple-darwin`),
  tar.gz + sha256, `gh release create`, `npm publish --access public`, tap
  formula bump + push, then 3-channel verification. Worth scripting as
  `scripts/manual-release.sh` for the next time runners are unavailable.
- npm-g vs brew binary share the `/opt/homebrew/bin` prefix; the npm symlink
  shadows the Rust binary. Always update BOTH on release (profile Stage 9
  already warns; confirmed again here).
