# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.10.3] — 2026-05-31

### Security (CWE-78 — OS Command Injection)

Closes **#40** — host-side RCE via standalone `&` bypass in `system_shell`. Reported by `mcfly-zzh`. The denylist in `validateShellCommand` did not block a standalone `&`; payloads like `command="x & touch /tmp/RCE"` reached `execSync("adb shell ${command}")` and the host shell forked `touch /tmp/RCE` on the developer's workstation. Severity: High.

**Structural fix** — host shell is no longer invoked. All device clients route through argv-form execution (`execFileSync(bin, [...args])`); shell metacharacters in arguments are passed as literal argv slots and never parsed by `/bin/sh`. CWE-78 is closed by construction, not by denylist.

Applies to:

- `src/adb/client.ts` — Android (ADB)
- `src/ios/client.ts` — iOS Simulator (`xcrun simctl`)
- `src/aurora/client.ts` — Aurora OS (`audb`)
- `src/desktop/gradle.ts` — Desktop Gradle invocations

Defense in depth — denylist in `src/utils/sanitize.ts` extended to block `&`, `${...}`, `<(...)`, `>(...)`, and tab characters.

**Rust CLI** — same fix class extended to `cli/src/**`:

- `cli/src/utils/validate.rs` (new) — entry-point whitelist validators: `validate_permission_name`, `validate_relative_path`, `validate_pref_key`, `validate_xml_filename`, `validate_sqlite_value`, `validate_osascript_key`.
- `cli/src/android.rs` — six CRITICAL injection sites (`sandbox_prefs_read/write`, `sandbox_sqlite_query`, `sandbox_file_list/read`, `permission_grant/revoke`) now reject inputs that contain shell metacharacters at function entry, before any `Command::new` is built.
- `cli/src/ios.rs` — `osascript` keystroke fallback now whitelists the key against `^[A-Za-z0-9_]+$`; documented SECURITY INVARIANT comment anchored on the `pbcopy` fallback static path.

### Added

- **`DeviceShellCmd` builder** (`cli/src/utils/device_shell.rs`) — typed builder for `adb shell <string>` / `audb shell <string>` composition. Three argument kinds: `Literal` (compile-time `&'static str`), `Validated` (passes a whitelist validator), `UserInput` (auto-quoted via POSIX `'` → `'\''` escaping). User-controlled segments are inert against metacharacters by construction; reviewers grep `user_input(` to audit every untrusted entry point. Closes **#42**.
- **`shell` subcommand opt-in gate** — `claude-in-mobile shell {android|ios|aurora}` now requires one of `--i-know-what-im-doing`, `CLAUDE_IN_MOBILE_ALLOW_SHELL=1` env, or interactive TTY. Prevents supply-chain / CI misuse of the documented arbitrary-execution backdoor. Closes **#41**. **See "Breaking" below.**
- **LLM-friendly `system_shell` error diagnostics** — when the denylist rejects a payload, the error names the offending metacharacter and suggests the canonical alternative tool (`ui_tap`/`ui_swipe`, `app_launch`, `system_open_url`). Tab character calls out copy-paste as the likely source. `$()` / `${}` explain that the shell does not expand here.
- **`system_shell` tool description** — now upfront-documents the rejected metacharacter set and points callers (especially LLM-driven) at the right alternative tools. URLs with `&` in the query string MUST go through `system_open_url`.
- Regression tests:
  - `src/adb/client.test.ts`, `src/ios/client.test.ts`, `src/aurora/client.test.ts` — fake-binary shim + proof-file side-effect; reproduces the original PoC from #40 across all three clients.
  - `src/utils/sanitize.test.ts` — bypass primitives (`&`, `${...}`, `<()`, `>()`, tab) + LLM-friendly diagnostic assertions.
  - `src/tools/system-tools.test.ts` — cross-platform `system_shell` regression on every supported platform.
  - `cli/src/utils/validate.rs`, `cli/src/utils/device_shell.rs`, `cli/src/utils/shell_gate.rs` — unit tests on injection payloads, metachar corpus, and gate truth table.

### Changed

- All device-side pipes (`| tail -N`, `| grep`, `| head -N`) in `getNetworkStats`, `getMemoryInfo`, `getCpuInfo`, `getLogs`, `getAppLogs` replaced with Node-side `.split("\n").slice(...)` filtering. Output identical; +50–100ms over large logs because the device sends the full stream before filtering.
- `iosClient.openUrl()` — was string-interpolated `execSync` despite an in-code comment claiming argv-form. Now actually uses argv-form.
- `iosClient.getAppLogs()` — `bundleId` is now validated via `validateBundleId` before reaching the predicate.
- Aurora `runCommandSync(string)` helper replaced with `runAudbSync(args[])`; all callers updated to pass argv.
- `escape_adb_text` (`cli/src/commands/flow.rs`) deleted — superseded by `DeviceShellCmd`'s POSIX single-quoting, which covers the full shell metacharacter set.

### Breaking

- **`claude-in-mobile shell` subcommand requires opt-in in non-TTY contexts.**
  CI scripts and automation that previously ran `claude-in-mobile shell android "<cmd>"` from a pipe will now print an ERROR and exit 1. Migration:
  ```bash
  # Per-invocation:
  claude-in-mobile shell android "ls" --i-know-what-im-doing
  # Or session-wide:
  export CLAUDE_IN_MOBILE_ALLOW_SHELL=1
  ```
  Interactive terminal use is unaffected.
- **`system_shell` MCP tool now rejects more payloads.** The following used to pass and now error with `SHELL_INJECTION_BLOCKED`:
  - Standalone `&` (background separator) — including inside `&` in URL query strings. Use `system_open_url` for URLs.
  - `${...}` brace expansion — inline the value.
  - `<(...)` / `>(...)` process substitution — not supported on Android shell.
  - Tab characters — often a side effect of copy-paste; replace with single spaces.
- **Rust CLI sandbox/permission commands reject shell metacharacters.** `sandbox prefs read/write`, `sandbox sqlite query`, `sandbox file list/read`, `permission grant/revoke` now hard-reject paths, keys, values, or permission names containing shell metacharacters (`;`, `|`, `&`, `<`, `>`, `$`, backtick, quotes, parens, braces, glob chars, newline, tab) or path-traversal `..`. Scripts that previously relied on lax inputs will see a clear validation error.

### Internal

- Two follow-up hardening issues opened, both deferred from v3.10.3 because they are not exploitable today after the structural fix landed:
  - **#41** — gate the `shell` subcommand (DONE in this release) + `escape_adb_text` extension (SUPERSEDED by `DeviceShellCmd`).
  - **#42** — `DeviceShellCmd` typed builder + migration of every `format!() → adb shell` site in the Rust CLI (DONE in this release).

### Verification

- `npm run build` (tsc) — clean
- `npm test` (vitest) — **1012 / 1012 passed**, 32 files
- `cargo build --release` — clean (3 pre-existing dead-code warnings)
- `cargo test` — **86 / 86 passed** (35 lib + 51 bin)
- Manual smoke checks: `shell` opt-in gate behavior verified against the release binary (non-TTY error, env-var opt-in, flag opt-in, `--help` SECURITY paragraph).

### Upgrade

```bash
brew update && brew upgrade claude-in-mobile
claude-in-mobile --version    # 3.10.3
claude-in-mobile doctor       # verify CLI diagnostics
```

If `brew upgrade` reports `already installed`, see the "Known Issue" note at the top of the README.

---

## [3.10.2] — 2026-05-29

- `config` subcommand added with persistent turbo toggle.

## [3.10.1] — 2026-05-28

- Version bump (no functional changes).

## [3.10.0] — 2026-05-27

- CLI parity — 47 MCP tools ported to Rust CLI.
