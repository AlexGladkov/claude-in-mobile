# 3.15.0 — Runtime debugger for AI agents (Android JDWP + iOS LLDB)

Date: 2026-08-11 · Type: feature (multi-iteration)

## Status (delivered)

Both backends live-validated + a unified MCP surface, all green (suite 1276):
- **Android JDWP** (`src/debug/jdwp/`): attach, class/method/line resolution,
  line + method-entry breakpoints, event poll-queue, stack frames (named, with
  lines), top-frame locals, single-step, resume/detach. Validated on Android 14
  against a debuggable Compose app.
- **iOS LLDB** (`scripts/ios-debug-daemon.py` + `src/debug/lldb/client.ts`):
  Python SB-API sidecar, 14 verbs. Validated on the iPhone 17 Pro simulator
  against a swiftc -g Debug app (attach→break→hit→locals→eval→setVar→step→detach).
- **Unified** (`src/debug/controller.ts` + `src/tools/debug-tools.ts` +
  `debug` meta): DebugController holds sessions across MCP calls and dispatches
  by platform. Controller live-validated end-to-end on Android
  (MCP tool → controller → JDWP → device).

Pending before tagging 3.15.0 / follow-ups:
- Android eval + set-var (JDWP InvokeMethod) — iOS has both; Android returns a
  clear "pending" for now.
- Android deferred breakpoints (ClassPrepare binding), watchpoints, exception
  traps, coroutine-frame locals.
- iOS physical device (RemoteXPC tunnel + DDI) — Simulator only today.
- Release gating per `.claude/profiles/release.md`.

## Goal

Give agents white-box **runtime** debugging of a live app — breakpoints,
exception traps, watchpoints, locals/frames, deep object inspection, expression
evaluation, live variable mutation, stepping — to complement our existing
black-box UI automation. Inspired by the *approach* of
[debroid](https://github.com/PatilShreyas/debroid) (Apache-2.0), but implemented
from scratch in our own stack — we are **not** bundling or shelling their tool.

## Hard precondition (both platforms)

Only **debuggable builds** are attachable — Android `android:debuggable=true`,
iOS `get-task-allow` (Debug-config builds). Release/Store apps are not
debuggable, exactly like the FLAG_SECURE limit on screenshots. Surface this in
every debug tool's description.

## Android — native JDWP over TS (this line)

We speak **JDWP directly** over an `adb forward tcp:<port> jdwp:<pid>` socket.
No JDI/JVM dependency; a from-scratch wire client in `src/debug/jdwp/`.

Status — **foundation landed & validated live** (Android 14 / API 34 emulator,
against a debuggable Compose app):
- `constants.ts` — command sets, event kinds, tags, error names.
- `packet.ts` — big-endian reader/writer, variable-width ids as `bigint`
  (ART ids are 8 bytes → beyond Number.MAX_SAFE_INTEGER), packet framing. Unit-tested.
- `connection.ts` — socket, JDWP handshake, packet correlation (id→reply),
  async VM event delivery (Event.Composite).
- `session.ts` — attach flow (forward + handshake + IDSizes), version, thread
  enumeration + names, suspend/resume, dispose. Live smoke: `scripts/jdwp-smoke.mjs`.

Roadmap to a shippable 3.15.0 Android debug capability:
1. Class/method/line resolution: `ClassesBySignature`, `Method.LineTable`,
   `ReferenceType.MethodsWithGeneric`, deferred `ClassPrepare` binding.
2. Breakpoints: `EventRequest.Set` (BREAKPOINT + LocationOnly), Clear.
3. Event polling: decode `Event.Composite` → BREAKPOINT_HIT / EXCEPTION / STEP /
   WATCHPOINT / CLASS_PREPARE, cursor-based queue (agent-poll model).
4. Pause state: `ThreadReference.Frames`, `StackFrame.GetValues`,
   `Method.VariableTableWithGeneric` (slot→name), value decoding by tag.
5. Object inspection: `ObjectReference` fields, recursive with cycle guard.
6. Expression eval + set-var: `ObjectReference.InvokeMethod` / `ClassType.InvokeMethod`.
7. Stepping: `EventRequest.Set` (SINGLE_STEP) over/into/out.
8. Exception traps + watchpoints.
9. Coroutine-aware locals (Kotlin Continuation shallow frame extraction).
10. MCP surface: a `debug` meta-tool (attach/launch/break/catch-exception/watch/
    poll/pause-state/inspect/eval/set-var/step/detach) on the Android adapter,
    behind a `DebugAdapter` capability guard; daemon holds sessions across calls.

## iOS — LLDB Python SB API sidecar (separate track, later)

Recon verdict (verified on this machine, Xcode lldb-1703, iOS 26 sim):
**feasible, Simulator-first.** Not JDWP — a **Python sidecar** holding an
`SBDebugger` (the JDI-equivalent), driven by Node over JSON-RPC; it talks to
Apple's `debugserver` (GDB-remote). Full capability parity via the SB API
(`BreakpointCreateByLocation`, `BreakpointCreateForException`, `SBWatchpoint`,
`frame.GetVariables`, `EvaluateExpression`, `SetValueFromCString`, `StepOver/Into/Out`,
`SBListener` async stop events).

- Simulator (Tier 1, MVP): `xcrun simctl launch --wait-for-debugger <bundle>` →
  attach by pid. No DDI / signing / tunnel.
- Physical device iOS 17+ (Tier 2, separate project): RemoteXPC trusted tunnel +
  Developer Disk Image; `devicectl --json-output` / pymobiledevice3.
- Risks: dSYM/symbol discipline; Swift async frames flaky (prefer
  `frame variable` over `po`); Xcode-python ABI coupling (`xcrun lldb -P`);
  async stop-event threading (deadlock class — same care as our REPL).
- `lldb-mi` is a dead end (unshipped/unmaintained, no Swift). Do not design on it.

Not in 3.15.0 — iOS is a follow-on (3.16/4.x). Android ships first.

## Notes

- Attribution: debroid is Apache-2.0; we reuse its *design/command surface* as
  inspiration, not its code. No NOTICE obligation for clean-room reimplementation,
  but credit it in the release notes.
- On the 4.0 plugin edition this naturally becomes an on-demand `debug` plugin.
