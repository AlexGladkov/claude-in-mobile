# Release v4.0.0 — 2026-08-18

The **mcp-devices** edition shipped to npm `latest` (no longer `dev`) + Homebrew.

## Included
- Rename claude-in-mobile → mcp-devices; microkernel + on-demand plugin architecture.
- **Two editions:** `mcp-devices` (slim modular) + `claude-in-mobile` (all-in-one —
  depends on mcp-devices + `@mcp-devices/plugin-all`, enables all platforms by
  default; existing install unchanged).
- `@mcp-devices/plugin-debug` — runtime debugger (Android JDWP + iOS LLDB, 12 tools),
  first on-demand tool-plugin.
- Scoped platform plugins (android/ios/web/desktop/aurora/all) + plugin-api@1.0.0.
- npm provenance on scoped plugins; debug security hardening; high-sev advisory
  remediation (sharp/libvips, ip-address, quinn-proto, anyhow, crossbeam-epoch).

## Closed issues
- 0 open at release (Stage 0 gate clean).

## Pre-flight (all green)
- Versions 4.0.0 across 4 core manifests + 7 scoped plugins; tree clean.
- `npm run build` + `tsc` + `vitest` **1300/1300**; `cargo build --release` +
  `cargo test` 97; `npm audit` + `cargo audit` green; runtime smoke 4.0.0.
- All-in-one mechanism verified locally (claude-in-mobile → all 5 platforms load).
- Branch CI green before tag (all 6 jobs).

## Homebrew (B4)
- Tap `AlexGladkov/homebrew-claude-in-mobile`: created `Formula/mcp-devices.rb`
  (`oldname "claude-in-mobile"`, installs `mcp-devices` binary + `claude-in-mobile`
  symlink), removed `claude-in-mobile.rb`. release.yml update-homebrew +
  verify-checksums retargeted to mcp-devices.rb.

## CI run
- Release run 32119941700 — **all 8 jobs success** (setup, build ×2,
  verify-plugin-versions, release, publish-npm, update-homebrew, verify-checksums).

## Channels verification (Stage 9)
- **npm:** `mcp-devices@4.0.0` → `latest` ✓; `claude-in-mobile@4.0.0` → `latest`
  (deps mcp-devices@4.0.0 + @mcp-devices/plugin-all@4.0.0) ✓; platform plugins +
  plugin-all @4.0.0 ✓; plugin-api@1.0.0 ✓.
- `npx mcp-devices@4.0.0 --version` → 4.0.0 ✓.
- `npx claude-in-mobile@4.0.0 --version` → 4.0.0 ✓ (all-in-one installs
  mcp-devices + plugin-all + 5 platforms from public npm).
- **GitHub:** release v4.0.0 with 2 native assets (~3.8 MB / 4.0 MB darwin arm64/x86_64).
- **Homebrew:** mcp-devices.rb patched with real SHAs + version 4.0.0; verify-checksums passed.

## Known / follow-up
- `@mcp-devices/plugin-debug@4.0.0` published (CI `+ pkg`, and write-side
  "cannot publish over 4.0.0" both confirm), but npm READ replicas lagged on the
  brand-new package name for a while — `npm view` 404 briefly. Not a gap; verify
  it resolves (`npm view @mcp-devices/plugin-debug version`).
- plugin-debug was the first-ever publish of that name; if provenance turns out
  missing due to the read anomaly, a 4.0.1 with a clean CI publish would restore it.

## Lessons learned
- The scoped-plugin publish loop masks a per-package failure (subshell error not
  checked; step exit = last command). A brand-new package that read-404s is
  indistinguishable from a failed publish at a glance — check the write side
  ("cannot publish over") before manual re-publish. Consider `set -e` / explicit
  failure aggregation in the loop.
