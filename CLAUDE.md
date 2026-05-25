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

## Pre-Release Checklist (STRICT)

Before tagging any release, ALL steps must pass. Do NOT tag until every item is green.

### 1. Version consistency
- [ ] `cli/Cargo.toml` version matches target release
- [ ] `package.json` version matches target release
- [ ] `cli/Cargo.lock` updated (`cargo check` after Cargo.toml change)

### 2. Build verification
- [ ] `npm run build` (tsc) — zero errors
- [ ] `npm run test` (vitest) — all tests pass, zero failures
- [ ] `cd cli && cargo build --release` — compiles without errors
- [ ] `cd cli && cargo test` — all tests pass

### 3. Release asset sanity check
- [ ] Verify previous release assets are Rust binaries (~3-4MB per arch), NOT Node.js bundles (~20MB)
- [ ] If previous release has wrong assets — delete it before creating new one

### 4. Tag and push
- [ ] `git tag v<version>` on the commit with all changes
- [ ] `git push origin main --tags` — triggers `release.yml` CI
- [ ] Wait for CI `Release CLI` workflow to complete

### 5. Post-release verification
- [ ] CI `build` jobs: success (both arm64 and x86_64)
- [ ] CI `release` job: success (GitHub release created)
- [ ] Release assets: check sizes are ~3-4MB (Rust), NOT ~20MB (Node.js)
- [ ] CI `update-homebrew` job: if fails (token issue), update formula manually:
  - Clone `AlexGladkov/homebrew-claude-in-mobile`
  - Update `version`, `sha256` for both arches
  - Push
- [ ] CI `verify-checksums` job: success (or manual verify if homebrew was updated manually)

### 6. Homebrew smoke test
- [ ] `brew update && brew upgrade claude-in-mobile`
- [ ] `claude-in-mobile --version` — shows correct version
- [ ] `claude-in-mobile doctor` — shows full CLI diagnostics (not MCP server banner)

### Known CI issues
- `HOMEBREW_TAP_TOKEN` secret may expire — causes `update-homebrew` job failure with `Bad credentials`. Fix: update the secret in repo settings, or update formula manually.
- Never create releases manually without git tags — CI won't run, assets will be wrong.
