# FL003: Test Cases — Proactive Scenario Generation & Execution

Status: draft
Priority: P0
Created: 2026-02-13
Target release: v2.11.0-experimental (experimental branch)
Replaces: FL002-test-reports.md (deprecated)

---

## Summary

When Claude works with a mobile app (testing features, debugging, exploring), it **proactively generates human-readable test cases** as YAML files in the user's repository. These test cases are high-level scenarios (not recorded MCP commands) that Claude can later re-execute, adapting to UI changes. Think of it as "BDD scenarios that write themselves."

### Key Insight

Test cases are **NOT** a replay of recorded actions. They are semantic, natural-language scenarios with assertions. When Claude re-executes a test case, it interprets the intent ("log in with valid credentials") and figures out the current UI path — even if buttons moved or text changed.

---

## User Experience

### Creation Flow

1. User asks Claude to do something with the app: "test the video upload feature", "check if login works"
2. Claude does the work — logs in, navigates, taps, verifies
3. **Without being asked**, Claude generates test case files and tells the user:

```
I generated 4 test cases while working on the video upload feature:
- TC-001-user-login.yaml — Login with valid credentials
- TC-002-create-content.yaml — Create a new content item
- TC-003-video-playback.yaml — Verify video plays in feed
- TC-004-e2e-video-upload.yaml — End-to-end video upload flow

They're saved in specs/testcases/. Take a look!
```

4. User reviews, edits if needed (standard YAML, easy to modify)
5. Files are NOT auto-committed — user decides when to commit

### Execution Flow

1. User says: "run tests 1 and 3" or "run TC-001 and TC-003"
2. Claude calls `list_testcases` to find files, then `run_testcase` for each (or `run_suite` for batch)
3. `run_testcase` returns YAML content — Claude reads the scenario and executes it step by step using MCP tools (tap, swipe, assert_visible, etc.)
4. If an assert fails — Claude marks that TC as FAILED, takes a screenshot, and continues to next TC
5. After all TCs complete, Claude saves a report to `specs/reports/`

---

## Architecture

### Split of Responsibilities

| Component | Responsibility |
|-----------|---------------|
| **SKILL.md** | Instructions for Claude: when to generate TCs, quality criteria, YAML format spec, dedup rules |
| **MCP tools** (TypeScript) | `save_testcase`, `list_testcases`, `get_testcase`, `delete_testcase`, `run_testcase`, `run_suite` |
| **CLI tools** (Rust) | Same 6 commands as CLI flags, same YAML format |
| **Claude (LLM)** | Analyzes session context, generates TC content, interprets & executes scenarios, generates reports |

### Why This Split?

- MCP server has **no access** to conversation context — it can't generate TCs
- Claude has context but **needs tools** to persist/list/read YAML files
- SKILL.md is the bridge: it tells Claude **when and how** to generate TCs proactively

### Data Flow

```
[Claude working with app]
       │
       ▼
[Claude analyzes session, generates YAML in memory]
       │
       ▼
[save_testcase(path, content)] ──► specs/testcases/TC-001-login.yaml
                                   specs/testcases/TC-002-signup.yaml
       │
       ▼
[Claude tells user: "I generated N test cases"]

--- later ---

[User: "run tests 1 3"]
       │
       ▼
[list_testcases(path)] ──► returns catalog with IDs
       │
       ▼
[run_testcase(id)] ──► returns YAML content to Claude
       │
       ▼
[Claude interprets scenario, calls tap/swipe/assert via MCP]
       │
       ▼
[Claude saves report to specs/reports/]
```

---

## MCP Tools (6 new tools)

### 1. save_testcase

Validates YAML structure and saves to disk.

```typescript
{
  name: "save_testcase",
  inputSchema: {
    path: "string (required) — directory path, e.g. /project/specs/testcases",
    filename: "string (required) — e.g. TC-001-user-login.yaml",
    content: "string (required) — YAML content"
  }
}
// Returns: { success: true, path: "/project/specs/testcases/TC-001-user-login.yaml" }
// Validates: YAML syntax, required fields (id, name, platform, steps)
```

### 2. list_testcases

Scans directory, parses YAML metadata, returns catalog.

```typescript
{
  name: "list_testcases",
  inputSchema: {
    path: "string (required) — directory to scan",
    platform: "string (optional) — filter by platform (android/ios/desktop)"
  }
}
// Returns: [{ id: "TC-001", name: "User Login", platform: "android", priority: "P0", tags: ["auth"], file: "TC-001-user-login.yaml" }, ...]
```

### 3. get_testcase

Reads and returns full YAML content of a test case.

```typescript
{
  name: "get_testcase",
  inputSchema: {
    path: "string (required) — full path to YAML file"
  }
}
// Returns: { content: "...full YAML...", parsed: { id, name, steps, ... } }
```

### 4. delete_testcase

Deletes a test case file.

```typescript
{
  name: "delete_testcase",
  inputSchema: {
    path: "string (required) — full path to YAML file"
  }
}
// Returns: { success: true }
```

### 5. run_testcase

Reads YAML and returns content for Claude to interpret & execute.

```typescript
{
  name: "run_testcase",
  inputSchema: {
    path: "string (required) — full path to YAML file"
  }
}
// Returns: { id: "TC-001", content: "...full YAML...", parsed: { ... } }
// Claude then executes steps using existing MCP tools (tap, swipe, assert_visible, etc.)
```

**Important:** This tool does NOT execute the scenario. It returns the scenario to Claude, who interprets and executes it step by step. This enables adaptive execution — Claude figures out the UI path even if it changed since recording.

### 6. run_suite

Reads multiple test cases and returns them for sequential execution.

```typescript
{
  name: "run_suite",
  inputSchema: {
    ids: "string[] (required) — list of TC IDs or filenames",
    path: "string (required) — directory containing test cases",
    report_path: "string (optional) — where to save report, default: specs/reports/"
  }
}
// Returns: [{ id: "TC-001", content: "...", parsed: {...} }, { id: "TC-003", ... }]
// Claude executes each sequentially, marks pass/fail, saves report at the end
```

---

## Test Case YAML Format

```yaml
id: TC-001
name: User Login with Valid Credentials
platform: android
priority: P0
tags: [auth, login, smoke]
author: claude
created_at: 2026-02-13
linked_feature: user-authentication
last_run_status: passed  # updated after each run
description: >
  Verifies that a user can log in with valid email and password
  and is redirected to the home screen.

preconditions:  # optional
  - App is installed and launched
  - User account exists: test@example.com / password123

steps:
  - action: "Launch the app"
    expected: "Login screen is displayed"
  - action: "Enter email 'test@example.com' in the email field"
    expected: "Email field contains the entered text"
  - action: "Enter password 'password123' in the password field"
    expected: "Password field is filled (masked)"
  - action: "Tap the Login button"
    expected: "Home screen is displayed with user's name visible"
  - action: "Verify the navigation bar shows Home, Search, Profile tabs"
    expected: "All three tabs are visible"
```

### Field Descriptions

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique identifier, format: TC-NNN |
| `name` | yes | Human-readable name |
| `platform` | yes | Target platform: android, ios, desktop |
| `priority` | yes | P0 (critical), P1 (high), P2 (medium), P3 (low) |
| `tags` | yes | Array of tags for filtering/grouping |
| `author` | yes | Who created: "claude" or username |
| `created_at` | yes | ISO date |
| `linked_feature` | no | Related feature/ticket |
| `last_run_status` | no | Last execution result: passed/failed/skipped |
| `description` | yes | What this TC verifies |
| `preconditions` | no | Prerequisites before execution |
| `steps` | yes | Array of {action, expected} — high-level, natural language |

### Steps Format

Steps are **semantic, not mechanical**:
- "Tap the Login button" — NOT `tap(x=340, y=1200)`
- "Enter email in the email field" — NOT `input_text("test@example.com")`
- "Verify home screen is displayed" — NOT `assert_visible(text="Home")`

Claude interprets each step at execution time, finding the right UI elements via `find_and_tap`, `get_ui`, `analyze_screen`, etc.

---

## Report Format

Saved to `specs/reports/run-YYYY-MM-DD-HHMMSS.md`:

```markdown
# Test Run Report

Date: 2026-02-13 14:32:00
Platform: android
Device: Pixel 7 (emulator-5554)

## Summary

| Status | Count |
|--------|-------|
| Passed | 3 |
| Failed | 1 |
| Total  | 4 |

## Results

### TC-001: User Login with Valid Credentials — PASSED
- All 5 steps completed successfully
- Duration: 12s

### TC-002: Create Content Item — PASSED
- All 4 steps completed successfully
- Duration: 8s

### TC-003: Video Playback in Feed — FAILED
- Step 4 failed: "Verify video is playing"
- Expected: Video player visible with playback controls
- Actual: Loading spinner still shown after 10s timeout
- Screenshot: [attached]

### TC-004: E2E Video Upload — PASSED
- All 8 steps completed successfully
- Duration: 45s
```

---

## MCP Tool Call Filtering

During test case generation (when Claude is analyzing what happened), some MCP calls are **actions** and some are **queries**.

**Logged as actions** (potential TC steps):
- `tap`, `long_press`, `swipe`, `input_text`, `press_key`
- `launch_app`, `stop_app`, `open_url`

**Filtered out** (not TC steps):
- `screenshot`, `get_ui`, `analyze_screen`, `find_element`
- `list_devices`, `set_device`, `get_target`, `set_target`
- `get_logs`, `clear_logs`, `get_system_info`
- `wait`, `wait_for_element`
- All testcase tools themselves

Claude uses this distinction when generating TCs from session context — query calls are context, not steps.

---

## SKILL.md Instructions (Summary)

The SKILL.md will instruct Claude to:

1. **When to generate**: After completing any mobile testing/exploration session that involved 3+ meaningful interactions with the app
2. **How to generate**: Analyze the session, identify distinct logical scenarios, create one YAML per scenario
3. **Quality rules**:
   - Before creating, call `list_testcases` to check for duplicates
   - Each TC must test ONE specific scenario (not a grab-bag)
   - Steps must be semantic (natural language), not mechanical (coordinates)
   - Include meaningful assertions (expected results) for each step
   - If a session produced login + main feature + verification, create separate TCs for each + one E2E
4. **Naming**: Auto-increment ID from existing TCs, slug from scenario name
5. **Proactive behavior**: Generate TCs without being asked, inform user with summary

---

## Platform Specificity

Test cases are **platform-specific**:
- TC recorded/generated on Android runs only on Android
- For iOS, user needs a separate TC (or asks Claude to generate iOS version)
- `platform` field in YAML determines this
- `list_testcases` supports filtering by platform

---

## Non-Deterministic Execution

When Claude re-executes a TC, it may take a **different path** than the original:
- Button moved? Claude finds it by text/semantics
- New popup appeared? Claude dismisses it
- Layout changed? Claude adapts

This is a **feature, not a bug**. The TC verifies the **outcome** (user can log in), not the exact pixel path. As long as all `expected` assertions pass, the TC passes.

---

## Implementation Plan

### Phase 1: MCP Tools (TypeScript + Rust)

**TypeScript (src/index.ts):**
- Add 6 new tool handlers: save_testcase, list_testcases, get_testcase, delete_testcase, run_testcase, run_suite
- YAML parsing via `js-yaml` dependency (or inline parser for simple structure)
- Validation: required fields, YAML syntax
- ~300-400 lines

**Rust (cli/):**
- Same 6 commands as CLI flags
- YAML parsing via `serde_yaml`
- ~200-300 lines

### Phase 2: SKILL.md

- Write comprehensive instructions for Claude
- Include YAML format spec, quality criteria, dedup rules
- Example TCs for reference
- ~100-150 lines of prompt

### Phase 3: Testing

- Unit tests for YAML parsing/validation
- Unit tests for list/save/delete operations
- Integration test: generate TC -> save -> list -> run

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Claude generates low-quality/redundant TCs | SKILL.md quality rules + dedup check via list_testcases before save |
| TC fails due to app state (not logged in) | Optional `preconditions` field describes required state |
| YAML format too rigid/too flexible | Start with minimal required fields, extend in V2 |
| Large TC files bloat repo | Each TC is small (~20-50 lines YAML), not a concern |
| Non-deterministic execution = flaky tests | Expected — TC tests outcomes, not exact paths. SKILL.md instructs Claude to handle this |

---

## V2 (Future)

- **Parametrization**: One TC with multiple data sets (valid/invalid credentials)
- **Cross-platform**: Generate iOS TC from Android TC automatically
- **CI/CD integration**: Run TCs in headless mode via CLI
- **TC dependencies**: TC-002 requires TC-001 to pass first
- **Shared precondition suites**: Reusable setup sequences (e.g. "logged_in" precondition)

---

## Decision Log

| Question | Decision | Rationale |
|----------|----------|-----------|
| Recording mode | No recording needed | TC = semantic scenario, not replay of actions |
| TC format | High-level natural language | Resilient to UI changes, Claude interprets at runtime |
| File format | YAML | Structured, parseable, human-editable |
| Storage | User's repo: specs/testcases/ | TC belongs to the project, version-controlled with code |
| Reports | specs/reports/ | Separate from TCs, timestamped |
| Assertion on fail | Continue + report | Mark failed, proceed to next TC, summarize in report |
| Preconditions | Optional | Some TCs are self-contained, some need setup |
| Parametrization | V2 | Good idea but complex, defer |
| Cross-platform | Platform-specific | Different UI paths per platform |
| Runner | Claude interprets | MCP can't execute semantic steps, Claude adapts to UI |
| Proactive generation | Via SKILL.md | Claude generates TCs without being asked |
| MCP + CLI | Both in one release | Users need both execution modes |
| Git commits | Manual | Claude creates files, user commits |
| Quality control | SKILL.md rules + dedup check | Prevent redundant/low-quality TCs |
| Release | v2.11.0-experimental | Experimental branch for testing |
