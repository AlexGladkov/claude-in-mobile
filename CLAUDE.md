# claude-in-mobile

## Tech Stack
- **MCP Server:** TypeScript (Node.js), vitest
- **CLI:** Rust (Cargo), Swift helpers
- **Distribution:** Homebrew tap (`AlexGladkov/homebrew-claude-in-mobile`)
- **CI:** GitHub Actions — `release.yml` (triggered by `v*.*.*` tags), `ci.yml` (push/PR)

## Agents

### Consilium
| Role       | Agent                              |
|------------|------------------------------------|
| architect  | voltagent-lang:typescript-pro      |
| developer  | voltagent-lang:typescript-pro      |
| security   | voltagent-infra:security-engineer  |
| devops     | devops-orchestrator                |

### Executing
| Agent                             | Scope            |
|-----------------------------------|------------------|
| voltagent-lang:typescript-pro     | src/**/*.ts      |
| voltagent-lang:rust-engineer      | cli/src/**/*.rs  |
| voltagent-lang:swift-expert       | cli/assets/*.swift |

## Local profiles

This project ships its own profile set in `.claude/profiles/`. They override
the user-level profiles from `~/.claude/profiles/` whenever the triggering
keywords match. Read the profile file FIRST and follow it literally — the
profile is the source of truth, this CLAUDE.md is only a router.

| Profile        | File                              | Triggers                                                 |
|----------------|-----------------------------------|----------------------------------------------------------|
| Подготовка релиза | `.claude/profiles/release.md`  | релиз, выпустить, hotfix, patch release, опубликовать, npm publish, brew upgrade |

If a request matches a local profile trigger, switch to that profile before
anything else and ignore the more generic global routing.

## Release workflow — see `.claude/profiles/release.md`

The release procedure lives in the profile above and is non-negotiable. Two
properties of that procedure that are critical for this repository:

1. **Stage 0 — open issues are a release gate.** Before bumping any
   version, run `gh issue list --state open` and either fix or explicitly
   defer each item. Skipping this stage is how #43 (`ERR_REQUIRE_ESM` in
   the browser module) sat unfixed across 3.10.3 → 3.11.2.
2. **Runtime smoke ≠ tsc/vitest.** The release profile mandates running
   `node dist/index.js --help` (catches #44-class deadlocks) and a
   `await import("./dist/browser/client.js")` round-trip (catches #43-class
   ESM regressions). These cannot be replaced by unit tests.

The legacy Pre-Release Checklist that previously lived in this file was
replaced by the profile in v3.11.3 — see commit history for the original
text.
