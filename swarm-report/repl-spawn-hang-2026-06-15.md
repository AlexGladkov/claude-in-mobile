# Bug Report — `repl_spawn` hangs (#46)

**Date:** 2026-06-15
**Profile:** Поиск бага
**Reporter:** clayly (Fedora 44, Claude Code CLI 2.1.177)

## Symptom

`repl_spawn` MCP call hung > 1 hour, no output. The reported command was a
Gradle `installDebug` build launched with an env-var prefix and `2>&1`.

## Root cause

`src/plugins/repl/client.ts` — `ReplBridgeClient.start()`.

`start()` resolved its `readyPromise` only on the supervisor's `ready` event
line. If the supervisor child process exited (or stayed silent) **before**
emitting `ready`, neither `resolve` nor `reject` was ever called:

- The `child.on("exit")` handler called `failAllPending(...)`, but at startup
  the `pending` map is empty, and the `readyPromise`'s `resolve`/`reject` are
  captured in closures — they are **not** in `pending`. So `failAllPending`
  could not unblock startup.
- There was **no startup timeout**.
- The 30s per-request timeout (`requestTimeoutMs`) is armed *inside* `call()`,
  in a Promise body that only runs **after** `await this.start()` resolves.
  With `start()` hung, that timer was never created.

Net effect: `await this.start()` never settled → `repl_spawn` (and every
other tool) hung indefinitely. Matches the > 1h report.

Triggers in the wild: a stale/old `claude-in-mobile` binary without the
`repl-supervisor` subcommand, a crash-on-startup, or a wrong `binaryPath` /
`CLAUDE_IN_MOBILE_BIN`.

## Fix

`start()` now:
1. Settles exactly once (`settled` guard).
2. Rejects on early child `exit` (unblocks a startup still waiting for `ready`).
3. Enforces a startup timeout (`startTimeoutMs`, default 10s) and SIGKILLs a
   hung child, with an actionable error message.
4. Resets the cached `readyPromise` on failure so a later `call()` retries a
   fresh supervisor instead of re-throwing a dead-on-arrival rejection.

New option: `ReplBridgeOptions.startTimeoutMs` (default 10_000).

### Tests (regression)

`src/plugins/repl/client.test.ts`:
- exits-before-ready (`true`) → rejects, no hang.
- never-emits-ready (`yes`) → startup timeout rejects within budget.
- failed start does not poison the client → second `call()` retries.

All repl tests green (23/23), `tsc --noEmit` clean.

## Systemic fix — `cmd` execution model (shell mode)

After the hang fix, the user's command still wouldn't run. Research showed the
deeper, systemic issue and a non-crutch fix.

### Root (systemic)

`cmd` is described as "Command line to spawn" — a single string. Callers (and
the model driving the MCP) naturally write a **shell** command line: env-var
prefixes, redirections, pipes, globs, `&&`. But `cmd` is executed as **bare
argv** via a hand-rolled shlex (`parse_cmd`) — **no shell**. The field *looks*
like a shell line but *is* an argv. Hand-rolled shlex is itself a half-measure
(reimplements a slice of shell parsing; fragile) and silently dies on shell
syntax.

### Prior art

PTY/process spawners take `(program, argv)` and make shell semantics an
**explicit opt-in** implemented by delegating to a real shell — never by
reimplementing parsing:
- Node `child_process.spawn(cmd, args, {shell})` → `shell:true` runs `/bin/sh -c`.
- Python `subprocess(..., shell=True)` → `/bin/sh -c`.
- pexpect / node-pty → no split; docs say spawn `/bin/sh -c` for shell features.

### Fix (chosen: shell mode + nudge, `/bin/sh -c`)

`SpawnArgs.shell?: boolean` (default `false`):
- `shell:false` → current direct argv exec. Secure default, no injection surface.
- `shell:true` → spawn `["/bin/sh", "-c", cmd]`. Env prefixes, `2>&1`, pipes,
  globs, `&&` all honoured natively. No hand-rolled detection, no shell
  reimplementation.

**Nudge** (demoted from "the fix" to friendly guard): in the default
`shell:false` path, quote-aware detection of unquoted shell metacharacters
(`| ; < > $( ` backtick `, &&`) or a leading `VAR=value` prefix returns a clear
error pointing at `shell:true` — instead of a silently-dead session. Quote-aware
so a quoted URL (`"…?a=1&b=2"`) or `python -c "print(1)"` is not flagged; a lone
`&` is intentionally not flagged (collides with literal `&`; `2>&1` is already
caught by `>`).

The user's command now works either way:
```
repl_spawn(id:"build", cwd:"…", shell:true,
  cmd:"JAVA_HOME=… ANDROID_HOME=… …/gradlew -p … :composeApp:installDebug --no-daemon 2>&1")
```
or with `shell:false` + env param (no `2>&1`).

Files: `cli/src/plugins/repl/{session,supervisor,bridge}.rs`,
`src/plugins/repl/{types.ts,index.ts}`. Rust 29/29, TS 23/23 green.

### Related gap — `pick_profile` (fixed)

`pick_profile` matched `cmd.contains(hint)` over the whole command string, so a
path like `/home/pythonista/repl` falsely matched the `python` profile, and the
list order made `ipython` (contains `python`) claim the `python` profile listed
before it. Fixed: match `starts_with(hint)` against the **basename of argv[0]**
— order-independent and path/arg-safe. (`cli/src/plugins/repl/prompt_profiles.rs`,
+4 tests.)

### Usage note — not a code change

`repl_spawn` is built for *interactive* prompt-driven sessions. A long
non-interactive build (`installDebug`) is usually better run via a backgrounded
shell. The tool works regardless; no schema change made (workflow advice would
just be noise in the tool description).

## Systemic audit (P1–P4) — additional fixes

A follow-on audit of the repl plugin surfaced four systemic issues (a
concurrency design limit, a correctness desync, a crash, and a secret leak).
All fixed in this release.

### P1 — No concurrency across sessions (architecture)

The supervisor JSON-RPC loop was strictly serial (`for line in lines { dispatch }`)
and `expect` held the **global** `sessions` mutex across the entire blocking
`wait_ready`. So a long `repl_expect` on one session froze every other op
(spawn/send/snapshot/list/kill) on every session — defeating named multi-session.

Fix: per-session `Arc<SessionHandle>` (brief map lock → clone handle → operate).
`expect`/`send`/`kill` take only that session's mutex; `list`/`snapshot` read a
shared `Arc<Mutex<SessionState>>` clone, so they never block on a busy session.
The bridge dispatches each request on its own thread with a single mpsc-fed
stdout writer (no frame interleave). End-to-end smoke confirmed `list` returns
in ~0 ms while a 2 s `expect` is in flight. (`session.rs`, `supervisor.rs`,
`bridge.rs`, +concurrency test.)

Known limitation (documented): `kill` on a session blocked in its *own* expect
waits until that expect's (now-bounded) timeout. Clients must await each
response before the next — concurrent in-flight requests have no server-side
ordering guarantee (the TS client already awaits).

### P2 — Request/expect timeout desync (correctness)

TS `requestTimeoutMs` was a fixed 30 s while `expect.timeoutMs` is user-settable
and unbounded. `repl_expect({timeoutMs: 60000})` → client rejected at 30 s while
the supervisor kept running; the late response was dropped and the session
wedged. Fix: `call()` takes a per-call timeout override; `expect` passes
`timeoutMs + 5000` buffer. (`client.ts`, `index.ts`, +2 tests.)

### P3 — UTF-8 slice panic in `prompt_matches` (crash)

`&buf[buf.len()-4096..]` panicked when the offset landed mid-codepoint
(cyrillic/emoji/box-drawing terminal output) — and a panic on the bridge thread
would take the supervisor (and all sessions) down. Fix: walk forward to the next
char boundary. (`expect.rs`, +multibyte test.)

### P4 — Secret leak via `repl_list` (security)

Redaction ran only in `snapshot()`; `list()` returned `SessionInfo.cmd`
verbatim, leaking inline credentials (`TOKEN=x cmd`, `mysql -psecret`) — more
likely now with `shell:true`. Fix: redact `cmd` on the `list` egress too.
(`index.ts`, +2 tests.)

### Logged, not fixed

- P5 (minor): the reader thread does `from_utf8_lossy` per 4096-byte chunk, so a
  codepoint split across reads mojibakes the `raw` accumulator. Low impact — the
  vt100 path consumes raw bytes correctly; only the secondary `raw` buffer is
  affected.

### Verification (whole release)

- TS: full suite **1234/1234**, `tsc --noEmit` clean.
- Rust: lib **97/97**, bin **141/141** (one transient `os error 2` in a non-repl
  bin test under full-suite parallelism — pre-existing flake, passed on 3 reruns).
- End-to-end stdio smoke against the built binary: spawn → expect → send →
  snapshot → list → kill → shutdown, plus the P1 concurrency check.

## Files changed

- `src/plugins/repl/client.ts` — hang fix (startup settle/timeout).
- `src/plugins/repl/client.test.ts` — hang regression tests.
- `src/plugins/repl/types.ts`, `src/plugins/repl/index.ts` — `shell` arg + schema.
- `cli/src/plugins/repl/session.rs` — shell mode, quote-aware shell-syntax
  detection, tests.
- `cli/src/plugins/repl/supervisor.rs`, `cli/src/plugins/repl/bridge.rs` —
  thread `shell` through SpawnRequest / JSON-RPC.
- `cli/src/plugins/repl/prompt_profiles.rs` — basename/`starts_with` profile
  matching + tests.
- `cli/src/plugins/repl/session.rs` — `state()` accessor for lock-free reads.
- `cli/src/plugins/repl/supervisor.rs` — per-session `SessionHandle`,
  non-blocking `list`/`snapshot`, concurrency test (P1).
- `cli/src/plugins/repl/bridge.rs` — threaded dispatch + single mpsc writer (P1).
- `cli/src/plugins/repl/expect.rs` — char-boundary-safe tail + test (P3).
- `src/plugins/repl/index.ts` — `list` cmd redaction (P4), `expect` timeout
  coupling (P2).
- `src/plugins/repl/index.test.ts` — P2/P4 tests.
