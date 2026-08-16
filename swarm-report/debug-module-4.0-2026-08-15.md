# Feature: debug-module on 4.0 — 2026-08-15

Port of the 3.15.0 runtime debugger onto the 4.0 microkernel/plugin edition as a
standalone on-demand package `@mcp-devices/plugin-debug`.

## Scope (user-confirmed)
- Platforms: **Android + iOS** (JDWP + LLDB sidecar).
- Packaging: **separate package** `@mcp-devices/plugin-debug@4.0.0` (not built into kernel).
- Out of scope: heap/memory **profiling** (separate deferred toolset).

## Branch / commits
Branch `feature/debug-module` (off `origin/release/4.0.0`), local, **unpushed**:
- `11bbcb6` feat(debug): the package + kernel tool-plugin loading.
- `d88c566` ci(debug): release.yml + publish-4.0.0-dev.sh plumbing.
(Contract/DoD: `docs/features/debug-module.md`.)

## What was built
- **First real tool-plugin in 4.0**: `SourcePlugin` with `capabilities:["meta-tools"]`,
  registers 12 tools via `ctx.registerTool()` in `init()`, `dispose()` tears down.
  Tools: `debug_{attach,break,remove_break,poll,pause_state,threads,eval,set_var,
  step,resume,detach,sessions}`.
- **Kernel**: `PACKAGED_TOOL_PLUGINS` + `loadToolPlugin()` (graceful-missing,
  outside `PlatformId`/`ALL_PLATFORMS`) + `src/runtime/tool-plugin-config.ts`
  (`MCP_DEVICES_TOOL_PLUGINS` env / config.json `tool_plugins`). Off by default.
- Ported JDWP client (`jdwp/**`, native TS) + LLDB client + `bin/ios-debug-daemon.py`.
  Own minimal adb/simctl exec — no dependency on plugin-android.
- All schemas draft **2020-12** + a regression-guard test (#57 class).

## Security P0 (all implemented + verified)
1. eval/set_var RCE gated by `android:debuggable=true` (`assertAndroidDebuggable`
   before opening the forward).
2. All ids validated before adb/simctl; **bundleId re-validated inside the python
   daemon** (independent trust boundary).
3. JDWP bound to `127.0.0.1`; guaranteed forward/daemon teardown + per-session async-mutex.
4. eval/pause_state results sanitized — secret redaction + 512-char cap; **no raw
   memory to the model**.
5. Daemon spawned only from the fixed in-package path (no env override).
6. Logs to stderr only (stdout = MCP JSON-RPC).

## Validation (run independently by orchestrator, not just subagent self-report)
- `npm run build` + `npx tsc --noEmit` — clean.
- `npx vitest run` — **1300/1300 (51 files)** (was 1246; +54 debug tests incl.
  12-tool schema-2020-12 guard, ported jdwp packet/values).
- On-demand smoke: default `--help` → debug OFF (0 tools); `MCP_DEVICES_TOOL_PLUGINS=debug`
  → 12 debug tools registered (kernel: 19 plugin tools = 7 repl + 12 debug).
- Schema check: `debug_break.inputSchema.$schema` = draft 2020-12, no draft-07 array `items`.
- Security spot-checks: daemon `_validate_bundle_id` regex present; `sanitizeResult`
  (512 cap + secret patterns); `assertAndroidDebuggable` via dumpsys; loopback; hardcoded daemon path.

## Consilium
3 parallel research agents (typescript-pro architecture, security-engineer,
devops-orchestrator) → converged design (meta-tools capability, PACKAGED_TOOL_PLUGINS,
own exec, security P0 additions beyond a straight port).

## Status
**Done** on `feature/debug-module`, unpushed. iOS/LLDB path implemented but needs
a macOS+Xcode+booted Simulator for live runtime test (Android JDWP works anywhere).

## Not shipped / deferred
- Push + merge to `release/4.0.0` — pending explicit user go.
- Publish is release-time (tag v4.0.0) — debug ships with the 4.0.0 major.
- Live iOS Simulator runtime test.
