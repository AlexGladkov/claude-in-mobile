# Runtime debugger (`debug`)

White-box runtime debugging of a **debuggable** live app: breakpoints, poll for
hits, inspect paused frames/locals, evaluate, mutate, step. Android speaks JDWP
directly over `adb`. **iOS/Simulator (LLDB) support ships in 3.16** — attaching
with `platform:'ios'` is rejected in this release.

The `debug` module is **off by default** — enable it first:
`device(action:'enable_module', module:'debug')`.

## Hard precondition

Only **debuggable builds** are attachable — Android `android:debuggable=true`.
Release/Store apps are **not** debuggable (the runtime-debug analogue of the
FLAG_SECURE screenshot limit).

Note: the `adb forward` used for JDWP exposes the debuggable VM on a localhost
port with no authentication (JDWP has none by design). Run on trusted,
single-user hosts only; sessions are torn down on detach and on VM death.

## Workflow

1. **Attach** — `debug(action:'attach', platform:'android', app:'<package>')`.
   Returns `{ sessionId, pid }`. Keep the `sessionId`.
2. **Set traps** — `debug(action:'break', sessionId, className:'com.app.Foo', line:42)`
   or method-entry `debug(action:'break', sessionId, className:'com.app.Foo', method:'onResume')`.
   Returns `{ id, verified }`. `verified:false` = class not loaded yet
   (deferred binding is not supported yet — attach after the class loads).
   `debug(action:'remove_break', sessionId, breakpointId)` clears one;
   `debug(action:'sessions')` lists active sessions.
3. **Poll** — `debug(action:'poll', sessionId, cursor:0)`. Non-blocking; start
   cursor at 0 and reuse `nextCursor`. Events: `BREAKPOINT_HIT`, `STEP_HIT`,
   `EXCEPTION_HIT`, `CLASS_PREPARE`, `VM_DEATH`. If `events` is empty, ask the
   user to interact with the app, then poll again. `alive:false` = VM gone.
   Each hit carries `threadId` and a resolved `location` (class/method/line).
4. **Inspect** — `debug(action:'pause_state', sessionId, threadId)` → call stack
   frames (with lines) + the top frame's locals (name/type/value, `objectId`
   for objects). `debug(action:'threads', sessionId)` lists all threads.
5. **Evaluate / mutate** — `debug(action:'eval', sessionId, threadId, expr)`.
   Expr forms: a local name, `name.field`, or `name.method(args)` with literal
   args (int/long/float/bool/null/"str"); `this` is a valid receiver; methods/
   fields resolve up the superclass chain. `debug(action:'set_var', sessionId,
   threadId, name, value)` mutates a local.
6. **Step / resume** — `debug(action:'step', sessionId, threadId, action:'OVER'|'INTO'|'OUT')`
   then poll for `STEP_HIT`. `debug(action:'resume', sessionId)` resumes the VM.
7. **Detach** — `debug(action:'detach', sessionId)` (the app keeps running).

## Rules of thumb

- Inspect/step/eval require a thread **suspended** by a hit — you'll get a clear
  error otherwise. Poll first, use the `threadId` from the hit.
- Track breakpoint ids and `remove_break` traps you no longer need.
- Object ids from `pause_state`/`eval` stay valid while the thread is suspended.
- Concurrent debug calls on one session are serialized automatically.
