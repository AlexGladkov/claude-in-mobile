# Refactoring Report — D8 (3.12.0)

**Date:** 2026-06-09
**Branch:** release/3.12.0
**Driver:** `swarm-report/abstraction-plugin-scalability-2026-06-09.md`

## Summary

- **Stack:** TypeScript (Node.js ≥18, ESM), vitest 4, zod 4
- **Scope:** 5 targets from architect audit, all in 3.12.0 release branch
- **Result:** All five completed, baseline tests preserved

## Findings

| Severity | Found | Fixed | Skipped |
|---|---|---|---|
| High | 5 | 5 | 0 |
| Medium | 0 | 0 | 0 |
| **Total** | **5** | **5** | **0** |

## Lint / test delta

| Check | Before | After |
|---|---|---|
| `tsc --noEmit` | clean | clean |
| `vitest run` | 1107/1107 | 1107/1107 |
| `node dist/index.js --help` | OK | OK |
| Dynamic `import('./dist/browser/client.js')` | OK (`BrowserClient`) | OK (`BrowserClient`) |

## Changes by phase

### D8.1 — common-schema
- New: `src/tools/common-schema.ts` (+33 LOC) — `platformEnum` derived from `BUILTIN_PLATFORMS`, `deviceIdField`
- Modified: 15 `*-tools.ts` files (−108 LOC net)
- Skipped: `browser-tools.ts` (no platformEnum/deviceIdField), `autopilot-tools.ts` / `accessibility-tools.ts` / `sandbox-tools.ts` kept narrower local enums (intentional — fewer platforms supported)

### D8.2 — dispatchByPlatform
- New: `src/tools/helpers/dispatch.ts` (+40 LOC)
- Refactored 5 multi-branch chains: `system-tools.ts`, `intent-tools.ts:151,287`, `performance/common.ts:38`, `sensor-tools.ts:96`
- **Agent pushback accepted:** 17 single-branch `if (platform !== "android")` guards left for a separate `requirePlatform` helper — wrapping each in `dispatchByPlatform` worsens readability

### D8.3 — meta-tool descriptor barrel
- New: `src/tools/meta/index.ts` (+208 LOC) — `MetaToolDescriptor` type, `META_TOOL_DESCRIPTORS` array (20), `META_SHORT_ALIASES`, `META_LEGACY_ALIASES`
- Refactored: `src/plugins/builtin-tools/index.ts` 287 → 141 LOC (−146)
- Friction estimate dropped from 8/10 → 3/10 (adding a meta tool: 1 edit site)
- **Design choice:** barrel-aggregation instead of per-meta default-export — avoids touching 20 modules + their callers in tests

### D8.4 — RuntimeContext extraction
- New: `src/runtime/runtime-context.ts`, `src/tools/tool-registry.ts`, `src/tools/registry-types.ts`, `src/tools/recorder-state.ts`, `src/tools/context/shared-state-class.ts`
- Refactored: `src/tools/registry.ts` 302→109, `recorder-tools.ts` (+2 structural), `context/shared-state.ts` 38→30
- Eliminated 10 module-level `let`/mutable slots
- Public API + every legacy top-level function unchanged
- Test injection: `createRuntimeContext()`, `setDefaultRuntimeContext()`, `resetDefaultRuntimeContext()`
- **Out of scope (deferred):** transport-level multi-session resolution per MCP request

### D8.5 — ui-parser split
- `src/adb/ui-parser.ts` 954 → 43 LOC (facade)
- New tree under `src/adb/ui-parser/`:
  - `types.ts` (93), `node-parser.ts` (154), `element-builder.ts` (481)
  - `formatters/{index,semantic,compact,full}.ts` (17/34/54/144)
- Strategy registry `FORMATTERS = { semantic, compact, full }`
- Behaviour-preserving — `ui-parser.test.ts` 94/94 pass

## Files added (high level)

```
src/tools/common-schema.ts
src/tools/helpers/dispatch.ts
src/tools/meta/index.ts
src/runtime/runtime-context.ts
src/tools/tool-registry.ts
src/tools/registry-types.ts
src/tools/recorder-state.ts
src/tools/context/shared-state-class.ts
src/adb/ui-parser/types.ts
src/adb/ui-parser/node-parser.ts
src/adb/ui-parser/element-builder.ts
src/adb/ui-parser/formatters/{index,semantic,compact,full}.ts
```

## Skipped (with reasons)

| Item | Reason |
|---|---|
| 17 single-branch platform guards | Need separate `requirePlatform` helper — wrong shape for `dispatchByPlatform` |
| Per-meta `default MetaToolDescriptor` exports | 20-module churn for zero net friction reduction; barrel achieves same plugin-side ergonomics |
| Transport-level per-request session resolution | API-breaking, deferred to 4.0.0 — `RuntimeContext` is structurally ready |
| `context.ts` module-level `deviceManager` singleton | Touches `ToolContext` shape, out of D8 scope |
| `recorder-tools.ts:21` `createLazySingleton` for store | Not requested, separate refactor |

## Validation result

PASS. Baseline preserved across all phases. Smoke tests per `.claude/profiles/release.md` (runtime `--help` exit + dynamic ESM round-trip) clean.
