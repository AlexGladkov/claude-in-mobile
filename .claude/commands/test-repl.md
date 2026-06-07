---
description: Run a REPL test scenario against the claude-in-mobile REPL plugin (python/node/bash/...).
---

# /test-repl — REPL Test Harness

Drive an interactive REPL (python, node, ghci, bash, custom CLI) through the
claude-in-mobile REPL plugin and verify a scripted scenario end-to-end.

This skill is a thin orchestration prompt — the actual work happens in the
MCP tools the REPL plugin exposes (`repl_spawn`, `repl_send`, `repl_key`,
`repl_expect`, `repl_snapshot`, `repl_list`, `repl_kill`). See the plugin at
`src/plugins/repl/` and the Rust supervisor at `cli/src/plugins/repl/`.

## Inputs

- `$ARGUMENTS` may contain:
  - a path to a scenario file under `.specs/repl/`, or
  - the literal name of a known REPL profile (`python`, `node`, `bash`, …) to
    run a smoke test against, or
  - free-form instructions describing the desired interaction.

## Procedure

1. **Determine REPL command.** Either from the scenario file front-matter
   (`cmd:` key) or pick the canonical command for the requested profile:
   - python → `python3 -i`
   - node → `node --interactive`
   - ghci → `ghci`
   - bash → `bash --norc --noprofile` (with `PS1="$ "` in env)
2. **Pre-flight.** Call `repl_list` and ensure no session named after the
   scenario already exists. If it does, prefer reusing if its status is
   `ready`; otherwise `repl_kill` it first and re-spawn.
3. **Spawn** the session via `repl_spawn`:
   - `id`: scenario slug
   - `cmd`: from step 1
   - `env`: only what the REPL needs (`PATH`, `HOME`, `LANG`, profile-specific)
   - `promptRegex`: optional override; defaults come from the supervisor's
     built-in profiles.
4. **Wait for the first prompt** with `repl_expect` (timeout 5000ms).
5. **For each step in the scenario:**
   - Call `repl_send` with the line to execute.
   - Call `repl_expect` and check the outcome `kind`:
     - `promptMatched` — proceed
     - `idle` — proceed but include a warning in the report
     - `exited` — abort the scenario and capture exit code
     - `timedOut` — capture the current snapshot for diagnosis and abort.
   - Capture `repl_snapshot` (with `tail` ≈ 40 lines) and assert the expected
     substring is present.
6. **Tear down** with `repl_kill` even on failure.
7. **Report** a per-step result table plus the final snapshot under
   `./swarm-report/test-repl-<slug>-<YYYY-MM-DD>.md`.

## Scenario file format

```markdown
---
cmd: python3 -i
prompt: ">>> "
---

# Pi via Leibniz
- send: import math
- expect_substring: ">>>"
- send: math.pi
- expect_substring: "3.14159"
```

Keep scenarios deterministic. If the REPL has nondeterministic output
(timestamps, hashes), assert on structural substrings rather than exact
matches.

## Out of scope

- Persistence across sessions — supervisor state lives in memory; killing
  Claude Code kills the REPL too.
- Recording / replay — planned for a later release; capture snapshots
  manually for now.
- Third-party REPL profiles — add an entry in
  `cli/src/plugins/repl/prompt_profiles.rs` and submit upstream.
