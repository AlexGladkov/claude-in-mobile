# Runtime debugger (`debug`)

White-box runtime debugging of a **debuggable** live app: breakpoints, poll for
hits, inspect paused frames/locals, evaluate, mutate, step. Android speaks JDWP
directly over `adb`; iOS drives LLDB on the Simulator.

The `debug` module is **off by default** — enable it first:
`device(action:'enable_module', module:'debug')`.

## Hard precondition

Only **debuggable builds** are attachable — Android `android:debuggable=true`,
iOS `get-task-allow` (Debug config). Release/Store apps are **not** debuggable
(the runtime-debug analogue of the FLAG_SECURE screenshot limit). iOS requires
macOS + Xcode and (today) the **Simulator**.

## Workflow

1. **Attach** — `debug(action:'attach', platform:'android', app:'<package>')`
   (iOS: `platform:'ios', app:'<bundleId>'`, launches suspended by default).
   Returns `{ sessionId, pid }`. Keep the `sessionId`.
2. **Set traps** — `debug(action:'break', sessionId, className:'com.app.Foo', line:42)`
   or method-entry `debug(action:'break', sessionId, className:'com.app.Foo', method:'onResume')`.
   iOS: `{ file:'ContentView.swift', line:42 }` or `{ method:'symbol' }`.
   Returns `{ id, verified }`. `verified:false` = class not loaded yet
   (deferred binding is not supported yet — attach after the class loads).
3. **Poll** — `debug(action:'poll', sessionId, cursor:0)`. Non-blocking; start
   cursor at 0 and reuse `nextCursor`. Events: `BREAKPOINT_HIT`, `STEP_HIT`,
   `EXCEPTION_HIT`, `CLASS_PREPARE`, `VM_DEATH`. If `events` is empty, ask the
   user to interact with the app, then poll again. `alive:false` = VM gone.
   Each hit carries `threadId` and a resolved `location` (class/method/line).
4. **Inspect** — `debug(action:'pause_state', sessionId, threadId)` → call stack
   frames (with lines) + the top frame's locals (name/type/value, `objectId`
   for objects). `debug(action:'threads', sessionId)` lists all threads.
5. **Evaluate / mutate** — `debug(action:'eval', sessionId, threadId, expr)`.
   Android expr forms: a local name, `name.field`, or `name.method(args)` with
   literal args (int/long/float/bool/null/"str"); `this` is a valid receiver.
   iOS: full LLDB expressions. `debug(action:'set_var', sessionId, threadId,
   name, value)` mutates a local.
6. **Step / resume** — `debug(action:'step', sessionId, threadId, action:'OVER'|'INTO'|'OUT')`
   then poll for `STEP_HIT`. `debug(action:'resume', sessionId)` resumes the VM.
7. **Detach** — `debug(action:'detach', sessionId)` (the app keeps running).

## Rules of thumb

- Inspect/step/eval require a thread **suspended** by a hit — you'll get a clear
  error otherwise. Poll first, use the `threadId` from the hit.
- Track breakpoint ids and `remove_break` traps you no longer need.
- Object ids from `pause_state`/`eval` stay valid while the thread is suspended.
- Concurrent debug calls on one session are serialized automatically.
