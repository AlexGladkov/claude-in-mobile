# Feature: `@mcp-devices/plugin-debug` — runtime debug module (4.0)

Port of the 3.15.0 runtime debugger onto the 4.0 microkernel + plugin edition,
as a standalone on-demand package. White-box debugging of a live **debuggable**
Android app (JDWP) and iOS Simulator app (LLDB), complementing the black-box UI
automation. This is the first real *tool-plugin* in 4.0 (registers MCP tools via
`ctx.registerTool()` rather than wrapping a device adapter).

Scope (confirmed 2026-08-15): **Android + iOS** (JDWP + LLDB sidecar),
**separate package** `@mcp-devices/plugin-debug@4.0.0`. Heap/memory profiling is
**out of scope** (separate deferred profiling toolset).

## Architecture

- `SourcePlugin` with `manifest.capabilities = ["meta-tools"]` (marker: not a
  platform; `findByCapability("screen")` must not return it).
- `init(ctx)` constructs one `DebugController` (closure singleton) and calls
  `ctx.registerTool(def)` for every debug tool. `dispose()` → `controller.disposeAll()`.
- On-demand load **outside** `PlatformId`/`ALL_PLATFORMS`:
  - `PACKAGED_TOOL_PLUGINS: Record<string,string> = { debug: "@mcp-devices/plugin-debug" }` in `bootstrap.ts`.
  - `loadToolPlugin(id, logger)` — same graceful-missing semantics as
    `loadPackagedPlatform` (ERR_MODULE_NOT_FOUND → warn + skip), no `PlatformId` binding.
  - `tool-plugin-config.ts` → `resolveEnabledToolPlugins()` reads
    `MCP_DEVICES_TOOL_PLUGINS` (csv) and/or config.json `{ "tool_plugins": ["debug"] }`.
  - `bootstrapKernelAsync` loops enabled tool-plugins after the platform loop;
    registered tools flow into the existing `tools` Map → served by MCP.
- Debug talks to `adb`/`simctl` via its **own** minimal exec (`AdbRunner`
  `(args) => execFile("adb", args)`), no dependency on `@mcp-devices/plugin-android`.

## Package layout

```
packages/plugin-debug/
  package.json        # @mcp-devices/plugin-debug@4.0.0, files:["dist","bin"], deps plugin-api + mcp-devices:*
  tsconfig.json       # copy of plugin-android
  bin/ios-debug-daemon.py
  src/
    index.ts          # createPlugin(): SourcePlugin (default + named)
    plugin.ts         # DebugPlugin class, init/dispose
    controller.ts     # DebugController (ported)
    tools.ts          # ToolDefinition[] via define-tool (draft 2020-12)
    exec.ts           # AdbRunner / simctl exec + id validation
    jdwp/             # connection, packet, session, debugger, values, constants (+ tests)
    lldb/client.ts    # LLDB sidecar client (spawns bin/ios-debug-daemon.py)
```

Runtime daemon path: `join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "ios-debug-daemon.py")`
(`dist/ → ../bin/`, stable in dev symlink and after `npm install`).

## Tools (MCP `debug` surface, ~12 actions)

`attach` · `break` (line or method-entry) · `remove_break` · `poll` (non-blocking
event queue: BREAKPOINT_HIT / STEP_HIT / EXCEPTION_HIT / CLASS_PREPARE / VM_DEATH) ·
`pause_state` (frames + top-frame locals) · `threads` · `eval` · `set_var` ·
`step` (OVER/INTO/OUT) · `resume` · `detach` · `sessions`.

Each tool's `inputSchema` MUST emit **JSON Schema draft 2020-12** (draft-07
array-form `items` from `z.tuple()` 400s every Claude request — #57).

## Session FSM

`detached → attached → paused → (resumed → paused|running) → detached`.
Sessions persist across tool calls, serialized per session via async-mutex.
`MAX_SESSIONS = 16`; dead-session reaping; port free-list.

## Edge cases (each needs a test or explicit handling)

- No device / device offline; process (pid) not found; app not `debuggable=true`.
- Duplicate attach to same pid; detach while paused; poll on detached session.
- JDWP socket death / VM_DEATH mid-session → forward torn down, session reaped.
- LLDB daemon spawn failure (no `xcrun`/python3), RPC timeout (30s), daemon crash.
- Breakpoint on not-yet-loaded class (CLASS_PREPARE) ; eval on invalid thread id.
- Session cap exceeded (>16) → rejected with clear error.

## Security invariants (P0 — enforced + Validation-checked)

1. **Injection:** package/bundle/device/pid validated (`validatePackageName` /
   `validateBundleId` reverse-DNS / `validateDeviceId` / positive-int pid) **before**
   any `adb`/`simctl`/lldb call; all exec uses argv arrays (no `shell:true`, no
   string concat). Re-validate `bundleId` **inside** `ios-debug-daemon.py` (the
   daemon must not trust its caller — independent trust boundary).
2. **Loopback-only:** JDWP forward/connection bound to `127.0.0.1`; verified via
   `lsof`/`netstat` that the port is not reachable off-host.
3. **Guaranteed teardown:** `adb forward` and the python daemon are torn down on
   `detach`, `VM_DEATH`, socket close, process shutdown (SIGINT/SIGTERM →
   `handle.disposeAll()` in `platform-cli.ts`), and on unhandled throw. After
   teardown: `adb forward --list` empty, no daemon in `ps`, port free.
4. **No raw memory to the model:** `eval` / `pause_state` / inspect return
   **structural** values (type, length, truncated/masked representation) — never
   raw heap bytes, full string tables, or secret-like values. Hard length cap +
   redaction of secret-looking fields. (Reuse `src/utils/sanitize.ts`.)
5. **Daemon integrity:** the python daemon is spawned **only** from the fixed
   in-package path (never from args/env override). No untrusted `DAEMON_PATH`/`PYTHON`.
6. **`debuggable` gate:** Android attach rejected before opening the forward if the
   app is not debuggable; iOS `get-task-allow` error mapped clearly. Precondition
   never weakened.
7. **stdout is MCP JSON-RPC only** — all plugin/daemon logs go to stderr.

## Definition of Done

- [ ] `packages/plugin-debug` builds (`tsc`) and is in the root build script + workspaces.
- [ ] All 12 tools registered via `ctx.registerTool`, schemas verified draft 2020-12
      (regression-guard test, per #57).
- [ ] JDWP client + tests (`packet.test`, `values.test`) ported and green.
- [ ] Kernel `PACKAGED_TOOL_PLUGINS` + `loadToolPlugin` + `tool-plugin-config`;
      on-demand load with graceful-missing (plugin absent → feature unavailable,
      kernel does not crash).
- [ ] iOS LLDB sidecar shipped in `bin/`, resolved from `dist/`, `chmod +x` in build.
- [ ] All 7 security invariants implemented; each mapped to a Validation check.
- [ ] `release.yml` (verify-plugin-versions + publish loop) and
      `publish-4.0.0-dev.sh` include `plugin-debug`; NOT in `plugin-all`.
- [ ] Validation: `npm run build` + `vitest` green; runtime smoke
      (`node dist/index.js --help` no hang; on-demand load with/without the
      package installed; `await import("@mcp-devices/plugin-debug/dist/...")`
      round-trip, no ESM regression).
```
