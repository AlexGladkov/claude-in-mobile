# 4.0 — dual-name migration (claude-in-mobile → mcp-devices)

Date: 2026-08-13 · Branch: `release/4.0.0`

## Goal

4.0 renames the package `claude-in-mobile` → `mcp-devices`. Teaching every user
the new name is impractical, so **both names must keep installing AND updating**
on all three channels. Canonical name = `mcp-devices`; `claude-in-mobile` = a
maintained compatibility alias.

## Status

### Done (part 1 — npm core, committed `c0baa6f`)
- Root `mcp-devices` `bin` exposes **both** commands (`mcp-devices` +
  `claude-in-mobile`) → `dist/index.js`.
- Shim package `compat/claude-in-mobile` (published as `claude-in-mobile`):
  depends on `mcp-devices` at the same version, forwards the CLI in-process
  (`import("mcp-devices")`), one-time TTY migration notice. Locally validated:
  `--version` forwards to the real CLI.

### Done (part 2a — release.yml, this branch)
- `publish-npm` gains a "Publish claude-in-mobile compat shim" step: syncs the
  shim `version` and its `mcp-devices` dependency to the tag, then publishes
  (idempotent dist-tag move if already there). So `npm i -g claude-in-mobile@latest`
  always resolves the matching `mcp-devices` engine.

### Remaining (part 2b — Homebrew, apply AT 4.0 release time)

Must NOT be applied before 4.0 ships — it would break current 3.15.0 brew users
whose tap formula still serves the 3.x `claude-in-mobile`.

Tap repo `AlexGladkov/homebrew-claude-in-mobile`, at 4.0 release:

1. Add `Formula/mcp-devices.rb` (canonical), e.g.:
   ```ruby
   class McpDevices < Formula
     desc "..."
     homepage "https://github.com/AlexGladkov/claude-in-mobile"
     version "4.0.0"
     # keep old-name users auto-migrating on `brew upgrade`
     oldname "claude-in-mobile"   # (or: oldnames ["claude-in-mobile"])
     on_macos do
       on_arm do
         url ".../claude-in-mobile-#{version}-darwin-arm64.tar.gz"   # asset name unchanged
         sha256 "..."
       end
       on_intel do
         url ".../claude-in-mobile-#{version}-darwin-x86_64.tar.gz"
         sha256 "..."
       end
     end
     def install
       bin.install "mcp-devices"
       bin.install_symlink bin/"mcp-devices" => "claude-in-mobile"  # both commands
     end
     test do
       system bin/"mcp-devices", "--version"
     end
   end
   ```
   The tarball ASSET name stays `claude-in-mobile-<v>-<platform>.tar.gz` (the
   binary inside is `mcp-devices`) — deliberately not renamed, to avoid churning
   the asset/URL/verify-checksums chain. Revisit only if a clean asset rename is
   wanted later.
2. Update `release.yml` `update-homebrew` + `verify-checksums` to target
   `Formula/mcp-devices.rb` (currently `Formula/claude-in-mobile.rb`), and make
   the Python patcher bump that file. Keep (or oldname-redirect) the legacy
   `claude-in-mobile.rb` so `brew install claude-in-mobile` still resolves during
   the transition.
3. Result: `brew install mcp-devices` (new) and `brew upgrade claude-in-mobile`
   (old → auto-migrated via `oldname`) both work; both commands are on PATH.

## Net user experience after 4.0

| Channel | Old command still works? | Still updates? |
|---------|--------------------------|----------------|
| npm `claude-in-mobile` | yes (shim + bin alias) | yes (shim dep synced each release) |
| npm `mcp-devices` | n/a (new canon) | yes |
| brew `claude-in-mobile` | yes (oldname migrate) | yes (`brew upgrade`) |
| brew `mcp-devices` | n/a (new canon) | yes |
| CLI command | both `mcp-devices` and `claude-in-mobile` available | — |

## Related 4.0-readiness note (separate)

The `release/4.0.0-dev` line has **5 pre-existing failing tests** in
`src/runtime/bootstrap.test.ts` (`getPlugin returns typed plugin instance` etc.)
— unrelated to dual-name, must be fixed before a real 4.0 release.
