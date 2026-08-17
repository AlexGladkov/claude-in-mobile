# Tool Plugin: Debug

Runtime debugging for Android and iOS: step through code, set breakpoints, inspect variables, and evaluate expressions in live debuggable applications.

## What it does

The debug plugin provides white-box debugging of live running applications:

- **Breakpoints:** Set and manage breakpoints by class name, method, or source line
- **Breakpoint events:** Receive notifications when breakpoints are hit
- **Step execution:** Step over, step into, or step out of method calls
- **Call stack inspection:** View call frames with class, method, and line numbers
- **Local variables:** Inspect variable names, types, and values; redacted to remove secrets
- **Expression evaluation:** Evaluate expressions on paused threads
- **Variable mutation:** Change local variable values on a paused thread
- **Thread management:** List threads and target specific threads for debugging
- **Session management:** Maintain multiple independent debug sessions

## When to use it

- **Debug a crash you can't reproduce from the UI** — attach, set a breakpoint at
  the suspected class/method, drive the app, and inspect the paused state.
- **Inspect a variable's real value at runtime** — pause at a line and read the
  call frame's locals instead of adding log statements and rebuilding.
- **Confirm a fix hypothesis without a rebuild** — evaluate an expression, or
  mutate a variable with `debug_set_var`, and resume to see the effect.
- **Understand control flow** — step OVER/INTO/OUT through a method to see which
  branch executes.
- **Catch an exception in context** — poll for `EXCEPTION_HIT` and inspect the
  frame where it was thrown.
- **Complement black-box UI automation** — pair `input`/`ui` actions with a live
  debugger to see what the app does internally when a button is tapped.

Not for: heap/memory profiling or performance traces (that is a separate,
deferred toolset — the debug plugin inspects breakpoint state, not dumps).

## Prerequisites

### Debuggable Application

The application **must be built with debug symbols and have `debuggable=true`**:

**Android:**
```xml
<application android:debuggable="true" ... >
```

**iOS:**
```swift
// Debug configuration in build settings
```

### Platform Requirements

**Android:**
- Requires `android:debuggable=true` in AndroidManifest.xml
- Uses JDWP (Java Debug Wire Protocol) over `adb forward`
- Works with Android emulators and physical devices with USB debugging enabled

**iOS:**
- Requires macOS with Xcode installed
- Uses LLDB (Low-Level Debugger) via Python sidecar
- Works with iOS Simulator only (physical device debugging requires additional setup)
- Simulator must be booted before debugging

## 12 Debug Tools

### Core Operations

| Tool | Purpose |
|------|---------|
| `debug_attach` | Attach the debugger to a running debuggable app; returns a sessionId for subsequent debug calls |
| `debug_sessions` | List active debug sessions (sessionId + platform); useful for discovering open sessions |
| `debug_detach` | Detach the debugger and end a session; the app continues running |

### Breakpoint Control

| Tool | Purpose |
|------|---------|
| `debug_break` | Set a breakpoint by class name/line (Android) or file/line (iOS); returns breakpoint id and verified status |
| `debug_remove_break` | Remove a breakpoint by its id |
| `debug_poll` | Poll the event queue for breakpoint hits, step hits, exceptions, class prepare, and VM death events |

### Thread Inspection & Control

| Tool | Purpose |
|------|---------|
| `debug_threads` | List VM threads with ids and names; use ids for targeting specific threads |
| `debug_pause_state` | Inspect a paused thread: call stack frames (class/method/line) and top frame's local variables (name/type/value) |
| `debug_step` | Step the paused thread: OVER (next line), INTO (into call), or OUT (out of method) |

### Value Inspection & Mutation

| Tool | Purpose |
|------|---------|
| `debug_eval` | Evaluate an expression on a paused thread: local names, field access, or method calls (Android); full LLDB expressions (iOS) |
| `debug_set_var` | Mutate a local variable on a paused thread; primitives, null, strings (Android); LLDB assignments (iOS) |
| `debug_pause_state` | (Also returns local values for inspection; see Thread Inspection) |

### Resume Execution

| Tool | Purpose |
|------|---------|
| `debug_resume` | Resume all threads in the debugged VM/process |

## Install & Enable

```sh
# 1. Install the npm package (pre-release)
npm i -g @mcp-devices/plugin-debug@dev

# 2. Enable the debug plugin via environment variable
MCP_DEVICES_TOOL_PLUGINS=debug

# Alternative: enable via config file (~/.mcp-devices/config.json)
# {
#   "tool_plugins": ["debug"]
# }

# 3. Restart the MCP server
```

**Note:** The debug plugin is not yet included in `mcp-devices install <platform>`. Enable it manually via environment variable or config file.

To verify:
```sh
# After restart, the debug tools should appear in the MCP tool list
mcp-devices  # and check for debug_* tools
```

## Security & Privacy

- **Eval/mutation only on debuggable apps:** By design, eval and set_var only work on applications compiled with `debuggable=true`. Do not relax this requirement.
- **Result sanitization:** All eval and variable values returned to the LLM are sanitized:
  - Values matching secret patterns (password, token, key, JWT, base64-like, hex-like) are redacted as `[REDACTED]`
  - Very long string values are truncated to 512 characters
  - Object fields are recursively sanitized
- **No plaintext secrets in logs:** Debug sessions capture no plaintext secrets in command output

## Example Workflows

### Workflow 1: Android — Debug a crash at startup

_Task: App crashes on launch, but only on the emulator. Attach debugger and inspect the crash._

```
// 1. Attach debugger to running app (or launch suspended)
debug_attach(platform: 'android', app: 'com.example.myapp', launch: true)
→ { sessionId: 'session-1' }

// 2. Set breakpoint at suspected crash location (method entry)
debug_break(sessionId: 'session-1', className: 'com.example.MainActivity', method: 'onCreate')
→ { id: 'bp-1', verified: false }  // not yet loaded; will arm on CLASS_PREPARE

// 3. Let app run; it should hit onCreate
debug_poll(sessionId: 'session-1', cursor: 0)
→ { events: [
     { kind: 'CLASS_PREPARE', class: 'com.example.MainActivity' },
     { kind: 'BREAKPOINT_HIT', threadId: '1', breakpointId: 'bp-1' }
   ], nextCursor: 2 }

// 4. Inspect the paused thread
debug_pause_state(sessionId: 'session-1', threadId: '1')
→ {
     frames: [
       { class: 'com.example.MainActivity', method: 'onCreate', line: 25 },
       { class: 'android.app.Activity', method: 'performCreate', line: ... }
     ],
     locals: [
       { name: 'this', type: 'MainActivity', objectId: 'obj-1' },
       { name: 'savedInstanceState', type: 'Bundle', objectId: null }  // null = Bundle is null
     ]
   }

// 5. Evaluate the potential crash cause (e.g., NullPointerException on savedInstanceState)
debug_eval(sessionId: 'session-1', threadId: '1', expr: 'savedInstanceState')
→ { value: 'null' }  // confirmed: Bundle is null on first launch

// 6. Step into getBoolean call to see if that's the crash
debug_step(sessionId: 'session-1', threadId: '1', action: 'INTO')
→ { ok: true, action: 'INTO', hint: 'poll for STEP_HIT' }

// 7. Poll for step completion
debug_poll(sessionId: 'session-1', cursor: 2)
→ { events: [{ kind: 'STEP_HIT', threadId: '1' }], nextCursor: 3 }

// 8. Inspect new line
debug_pause_state(sessionId: 'session-1', threadId: '1')
→ Shows paused at next line (Bundle.getBoolean dereference)

// 9. Resume and detach
debug_resume(sessionId: 'session-1')
debug_detach(sessionId: 'session-1')
```

### Workflow 2: iOS — Debug variable mutation

_Task: User's auth token is wrong. Debug the login flow and fix it on the fly._

```
// 1. Attach to iOS app (Simulator)
debug_attach(platform: 'ios', app: 'com.mycompany.myapp', launch: true)
→ { sessionId: 'session-2' }

// 2. Set breakpoint at login method
debug_break(sessionId: 'session-2', method: 'performLogin', file: 'LoginViewController.swift')
→ { id: 'bp-2', verified: true }  // file-based breakpoint

// 3. Trigger login in UI (user interaction)
// ... (outside debugger; UI agent taps Login button) ...

// 4. Wait for breakpoint hit
debug_poll(sessionId: 'session-2', cursor: 0)
→ { events: [{ kind: 'BREAKPOINT_HIT', threadId: '1', breakpointId: 'bp-2' }], nextCursor: 1 }

// 5. Inspect locals
debug_pause_state(sessionId: 'session-2', threadId: '1')
→ {
     locals: [
       { name: 'self', type: 'LoginViewController', objectId: 'obj-2' },
       { name: 'token', type: 'String', value: '[REDACTED]' },  // secret sanitized
       { name: 'response', type: 'LoginResponse', objectId: 'obj-3' }
     ]
   }

// 6. Evaluate token format (is it correct?)
debug_eval(sessionId: 'session-2', threadId: '1', expr: 'token.count')
→ { value: '0' }  // empty! that's the bug

// 7. Mutate the variable to correct value (for testing)
debug_set_var(sessionId: 'session-2', threadId: '1', name: 'token', value: 'valid-token-12345')
→ { ok: true }

// 8. Step over and resume
debug_step(sessionId: 'session-2', threadId: '1', action: 'OVER')
debug_poll(sessionId: 'session-2', cursor: 1)
debug_resume(sessionId: 'session-2')

// 9. Observe result in UI (login succeeds with fixed token)
```

### Workflow 3: Android — Inspect exception

_Task: App throws exception after tapping a button. Catch and inspect the exception._

```
// 1. Attach & set method-entry breakpoint (robust without line numbers)
debug_attach(platform: 'android', app: 'com.example.myapp')
→ { sessionId: 'session-3' }

debug_break(sessionId: 'session-3', className: 'com.example.DataProcessor', method: 'processData')
→ { id: 'bp-3', verified: true }

// 2. Trigger button click in UI (causes method call)

// 3. Poll for hit
debug_poll(sessionId: 'session-3', cursor: 0)
→ { events: [{ kind: 'BREAKPOINT_HIT', threadId: '2', breakpointId: 'bp-3' }], nextCursor: 1 }

// 4. Inspect state at entry
debug_pause_state(sessionId: 'session-3', threadId: '2')
→ {
     locals: [
       { name: 'this', type: 'DataProcessor', ... },
       { name: 'data', type: 'Data', objectId: 'obj-4' }
     ]
   }

// 5. Step through until exception
debug_step(sessionId: 'session-3', threadId: '2', action: 'OVER')
debug_poll(sessionId: 'session-3', cursor: 1)
→ { events: [{ kind: 'STEP_HIT', threadId: '2' }], nextCursor: 2 }

// ... repeat stepping ...

// Eventually:
debug_poll(sessionId: 'session-3', cursor: N)
→ { events: [{ kind: 'EXCEPTION_HIT', threadId: '2', exception: 'NullPointerException' }], nextCursor: N+1 }

// 6. Inspect exception state
debug_pause_state(sessionId: 'session-3', threadId: '2')
→ Shows stack frames and locals at crash point

// 7. Evaluate expression to understand cause
debug_eval(sessionId: 'session-3', threadId: '2', expr: 'data.getValue()')
→ { value: 'null' }  // root cause found

// 8. Detach
debug_detach(sessionId: 'session-3')
```

### Workflow 4: Multi-session — Debug two apps in parallel

```
// 1. Attach to first app
debug_attach(platform: 'android', app: 'com.example.app1')
→ { sessionId: 'session-app1' }

// 2. Attach to second app
debug_attach(platform: 'android', app: 'com.example.app2')
→ { sessionId: 'session-app2' }

// 3. List all sessions
debug_sessions()
→ { sessions: [
     { sessionId: 'session-app1', platform: 'android' },
     { sessionId: 'session-app2', platform: 'android' }
   ] }

// 4. Set breakpoints in both
debug_break(sessionId: 'session-app1', className: 'com.example.app1.MainActivity', line: 20)
debug_break(sessionId: 'session-app2', className: 'com.example.app2.Service', method: 'onStart')

// 5. Interact with both apps (in parallel or sequentially) and debug each

// 6. Detach both when done
debug_detach(sessionId: 'session-app1')
debug_detach(sessionId: 'session-app2')
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `debug_attach` fails / rejected before attaching | App is not `debuggable` (release build) | Attach only to a debug build (`android:debuggable=true`); the barrier is enforced and not weakened |
| Debug tools don't appear in the tool list | Plugin not enabled | Set `MCP_DEVICES_TOOL_PLUGINS=debug` (or `config.json` `tool_plugins: ["debug"]`) and restart the MCP server |
| `debug_attach` can't find the process | App not running, or wrong `app`/`deviceId` | Launch the app first (Android); pass the exact package/bundle id; check `deviceId` with `device(action:'list')` |
| `debug_break` returns `verified: false` | Target class not loaded yet | Expected — the breakpoint arms on `CLASS_PREPARE`; drive the app to load the class, then `debug_poll` |
| iOS debug fails | Not on macOS, no Xcode, or no booted Simulator | iOS (LLDB) requires macOS + Xcode + a booted Simulator |
| Locals show `…redacted` or truncated values | Secret redaction / length cap | By design — raw memory is never returned to the model; use `debug_eval` for a specific structural value |
| Session seems stuck | Prior session not detached | `debug_sessions` to list, `debug_detach` to clean up; sessions are capped |

## See Also

- [Built-in Tools Reference](./built-in-tools.md) — Other modules
- [Feature: Debug Module](../features/debug-module.md) — Additional debug configuration and details
