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

## Usage Example

```
# Attach to a running Android app
debug_attach(platform: "android", app: "com.example.myapp")
# Returns: { sessionId: "session-123" }

# Set a breakpoint
debug_break(sessionId: "session-123", className: "com.example.MainActivity", line: 45)
# Returns: { id: "bp-1", verified: true }

# Wait for user interaction to trigger breakpoint
# ... user taps button ...

# Poll for breakpoint hit
debug_poll(sessionId: "session-123", cursor: 0)
# Returns: { events: [{ kind: "BREAKPOINT_HIT", threadId: "1", breakpointId: "bp-1" }], nextCursor: 1 }

# Inspect paused state
debug_pause_state(sessionId: "session-123", threadId: "1")
# Returns: { frames: [...], locals: [{ name: "count", type: "int", value: "42" }] }

# Evaluate expression
debug_eval(sessionId: "session-123", threadId: "1", expr: "count + 1")
# Returns: { value: "43" }

# Step over next line
debug_step(sessionId: "session-123", threadId: "1", action: "OVER")

# Resume execution
debug_resume(sessionId: "session-123")

# Detach
debug_detach(sessionId: "session-123")
```

## See Also

- [Built-in Tools Reference](./built-in-tools.md) — Other modules
- [Feature: Debug Module](../features/debug-module.md) — Additional debug configuration and details
