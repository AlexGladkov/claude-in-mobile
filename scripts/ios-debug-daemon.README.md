# ios-debug-daemon

A headless iOS Simulator debug sidecar daemon. It drives LLDB's Python SB API
over stdio JSON-RPC and is intended to be spawned by the Node MCP server as the
**iOS backend** of the cross-platform runtime debugger (the Android side speaks
JDWP natively).

- One long-lived process holds a single `lldb.SBDebugger` (`SetAsync(True)`).
- Each attached app is a **session** keyed by a string `sessionId`, owning its
  own `SBTarget`/`SBProcess`.
- A background `SBListener` thread per session drains process stop events into
  an in-memory queue with a monotonically increasing cursor. The protocol is
  strictly **poll-based**: `poll` never blocks.

Only the Python standard library and the `lldb` module are used.

## Invocation

The daemon **must** run under Xcode's Python with the LLDB bindings on
`PYTHONPATH`:

```sh
PYTHONPATH="$(xcrun lldb -P)" xcrun python3 scripts/ios-debug-daemon.py
```

If `import lldb` fails, the daemon emits a single well-formed JSON error line on
stdout and exits non-zero:

```json
{"id": null, "ok": false, "error": "lldb Python bindings unavailable: ... Run with: PYTHONPATH=\"$(xcrun lldb -P)\" xcrun python3 scripts/ios-debug-daemon.py"}
```

## Wire protocol

Newline-delimited JSON, one object per line.

```
Request:  {"id": <int>, "method": "<verb>", "params": {...}}
Response: {"id": <int>, "ok": true,  "result": {...}}
     or:  {"id": <int>, "ok": false, "error": "<message>"}
```

- **stdin**  — requests (one JSON object per line)
- **stdout** — responses (one JSON object per line, and *nothing else*)
- **stderr** — logs / diagnostics only

## Verbs

| Verb | Params | Result |
|------|--------|--------|
| `ping` | — | `{ lldb:true, version:"<lldb version>" }` |
| `attach` | `{ bundleId, launch?:bool, wait?:bool }` | `{ sessionId, pid }` |
| `setBreakpoint` | `{ sessionId, file, line }` | `{ breakpointId, verified:bool }` |
| `setFunctionBreakpoint` | `{ sessionId, symbol }` | `{ breakpointId, verified }` |
| `catchException` | `{ sessionId, language?:"swift"\|"objc" }` | `{ breakpointId }` |
| `removeBreakpoint` | `{ sessionId, breakpointId }` | `{}` |
| `poll` | `{ sessionId, cursor:int }` | `{ events:[...], nextCursor:int }` |
| `pauseState` | `{ sessionId, threadId }` | `{ frames:[{ index, function, file, line, locals:[{ name, type, value, objectId? }] }] }` |
| `inspect` | `{ sessionId, objectId, maxDepth?:1 }` | `{ type, value, nested:{ <child>:{ type, value, objectId? } } }` |
| `eval` | `{ sessionId, threadId, expr }` | `{ type, value, objectId? }` |
| `setVar` | `{ sessionId, threadId, name, value }` | `{}` |
| `step` | `{ sessionId, threadId, action:"OVER"\|"INTO"\|"OUT"\|"RESUME" }` | `{}` |
| `detach` | `{ sessionId }` | `{}` |
| `shutdown` | — | `{ bye:true }` |

### Event kinds (`poll`)

`BREAKPOINT_HIT` · `EXCEPTION` · `STEP` · `STOPPED` · `EXITED`

Each event is `{ kind, threadId, location:{file,line,function}? }`. `poll`
returns every event with cursor `>= cursor` and the `nextCursor` to pass next
time. It never blocks.

### `attach` semantics

- `launch:true` runs `simctl launch --wait-for-debugger booted <bundleId>` to
  obtain a **suspended** pid, then `AttachToProcessWithID`. Use
  `step {action:"RESUME"}` to let it run to the first breakpoint. `wait`
  defaults to `true`.
- `launch:false` looks up the **already-running** pid for the bundle on the
  booted simulator (via `simctl spawn booted launchctl list`) and attaches.
- If attach is denied because the app lacks `get-task-allow` (i.e. it is not a
  Debug-config build — the usual case for system apps and Release builds), the
  daemon returns:

  > `app is not a debug build (get-task-allow) — only Debug-config builds are attachable [lldb: <raw lldb message>]`

### `setVar` semantics

Primary path is `SBValue.SetValueFromCString`. Swift value types (`Int`,
`String`, structs) typically reject this with **"Invalid encoding"** because the
Swift type system exposes no C-string encoder, so the daemon transparently
falls back to an eval-based assignment (`<name> = <value>`) through the Swift
expression compiler. Mutable (`var`) locals succeed; immutable (`let`) locals
correctly fail with an "is immutable" error surfaced as `ok:false`.

## Validation status — LIVE VALIDATED (full loop)

Environment: Xcode `lldb-1703.0.31.2`, Swift 6.2, iPhone 17 Pro / iOS 26.0
simulator (booted).

### 1. Boot + `ping` — PASS

```json
{"id": 1, "ok": true, "result": {"lldb": true, "version": "lldb-1703.0.31.2\nApple Swift version 6.2 (swiftlang-6.2.0.19.9 clang-1700.3.19.1)"}}
```

### 2. Attach-denied (get-task-allow guard) — PASS

Launched `com.apple.mobilesafari` on the booted sim, then attached to the
running pid (`launch:false`). LLDB denied the attach; the daemon mapped it to
the contract's exact message:

```json
{"id": 3, "ok": false, "error": "app is not a debug build (get-task-allow) — only Debug-config builds are attachable [lldb: attach failed (Not allowed to attach to process.  Look in the console messages (Console.app), near the debugserver entries, when the attach failed.  The subsystem that denied the attach permission will likely have logged an informative message about why it was denied.)]"}
```

### 3. Full debug loop against a Debug-build app — PASS

A tiny SwiftUI-style Debug binary (`swiftc -g -Onone`, arm64 simulator target,
wrapped as `DebugProbe.app`, `simctl install`) was driven end-to-end:

- `attach {launch:true, wait:true}` → suspended pid, `sessionId`.
- `setBreakpoint main.swift:7` → `{ breakpointId:1, verified:true }`.
- `step {action:"RESUME"}` → process runs.
- `poll` → `BREAKPOINT_HIT` with `location {file:"main.swift", line:7, function:"DebugProbe.compute(Swift.Int) -> Swift.Int"}`.
- `pauseState` → frame 0 locals read via `frame.GetVariables(True,True,False,True)`:
  `seed=1`, `doubled=2`, `mutable=101`, `label="seed=1"` (String assigned a
  stable `objectId`).
- `eval "seed * 10"` → `{ type:"Swift.Int", value:"10" }`.
- `inspect` on the String objectId → `{ type:"Swift.String", value:"\"seed=1\"", nested:{ _guts:{ type:"Swift._StringGuts", objectId:"obj-2" } } }`.
- `setVar mutable=777` → `{}`; `eval "mutable"` → `777` (fallback path exercised).
- `setVar label="x"` (immutable) → clean `ok:false` "is immutable" error.
- `step {action:"OVER"}` → `poll` returned `STEP` at line 8.
- `detach`, `shutdown` → clean.

The test app was uninstalled after validation.

### Not exercised live

- `setFunctionBreakpoint`, `catchException`, `removeBreakpoint`, `EXCEPTION`
  and `EXITED` events — implemented against the same SB API surface probed
  during recon but not driven end-to-end in this session. To validate manually:
  attach to the Debug app, `setFunctionBreakpoint {symbol:"DebugProbe.compute"}`
  (expect `verified:true` after resume it fires as `BREAKPOINT_HIT`);
  `catchException {language:"swift"}` then make the app `fatalError()`/throw and
  poll for `EXCEPTION`; kill the app process and poll for `EXITED`;
  `removeBreakpoint` a known id and confirm `{}`.

## Reproducing the validation

```sh
# 1. ping + attach-denied (Safari must be running for the deny path):
xcrun simctl launch booted com.apple.mobilesafari
printf '%s\n%s\n' \
  '{"id":1,"method":"ping"}' \
  '{"id":3,"method":"attach","params":{"bundleId":"UIKitApplication:com.apple.mobilesafari","launch":false}}' \
  | PYTHONPATH="$(xcrun lldb -P)" xcrun python3 scripts/ios-debug-daemon.py

# 2. Full loop requires a Debug-config app installed on the booted sim; build a
#    minimal one with `swiftc -g -Onone -sdk "$(xcrun --sdk iphonesimulator
#    --show-sdk-path)" -target arm64-apple-ios26.0-simulator`, wrap in a .app
#    with an Info.plist, `xcrun simctl install booted <App>.app`, then drive the
#    verbs above keeping the daemon process alive across requests.
```
