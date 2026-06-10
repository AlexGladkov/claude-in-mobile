# Security & Memory Audit — 3.12.0 (D1–D9)

**Date:** 2026-06-09
**Scope:** `24fac26..HEAD` (3.11.5 → 3.12.0), 187 production files, ~15k insertions
**Method:** 3 parallel auditors — security-engineer (injection/leakage), typescript-pro (memory/resource leaks), typescript-pro (capability boundaries)

## VERDICT: SAFE TO RELEASE ✅

3.12.0 is a structural file-split refactor. Every security-sensitive guard and
state-retention semantic moved **verbatim**. No new regressions across all three
audit dimensions. All findings below are **pre-existing**, low/medium, and
device- or local-scoped — track as follow-up, do not block release.

---

## 1. Injection / Data Leakage (security-engineer)

**Guards verified intact after the split:**
- **Host CWE-78:** every host spawn (`adb`, `xcrun`, `defaults`, `ps`, `osascript`, gradle) uses `execFile*`/`spawn` argv form. `/bin/sh -c` never invoked with interpolated LLM strings. (`adb/exec.ts`, `ios/simctl-exec.ts`, `desktop/permission-allowlist.ts`)
- `escapeAndroidInputText` (`adb/text-escape.ts`) — byte-identical to baseline, still wired into `inputText`.
- `validateShellCommand` denylist (`sanitize.ts`) — intact.
- Path traversal: `validateAndResolveAppPath` (realpath + allowlist + `..` block), `validatePath`, `validatePathContainment` — survived all sandbox splits.
- Prototype pollution: `FORBIDDEN_KEYS` enforced in `sync/common.ts:93` + `scenario-store.ts:145,177`.
- Recorder redaction: `isSensitiveInput` + `[REDACTED]` fire at capture (`recorder/redaction.ts`, `capture.ts:39-55`); `sanitizeErrorMessage` strips Bearer/token/key.
- SQLi: `sqlite-query.ts` — SELECT/PRAGMA allowlist + multi-statement block intact.

**Findings (both pre-existing, non-blocking):**

| # | Sev | File:line | Threat | Note |
|---|-----|-----------|--------|------|
| S1 | low | `tools/sandbox/prefs-write.ts:46-52` | device-side arg injection (CWE-78, run-as scoped) | `sanitizeForShell` strips shell metachars but **not** `'`/`"`. A quote in value/key breaks device-side `sed 's\|...\|'`. Blast radius = target app's own run-as sandbox. Fix: also escape `'`/`"`, or base64 the sed expr. |
| S2 | low | `browser/types.ts:82` | URL scheme bypass (CWE-601) | Browser `validateUrl` uses **denylist** (file/chrome/devtools/...) not allowlist. `data:`/`blob:`/`javascript:`/`ftp:` pass → CDP `Page.navigate` loads them. Fix: switch to http/https allowlist matching `sanitize.validateUrl`. |

---

## 2. Memory / Resource Leaks (typescript-pro)

**The D8.4 "double retention" risk does NOT materialize.** `shared-state.ts` re-exports the singleton's Map references (`_state.lastScreenshotMap`...) — exactly one set of Maps, no duplicate alongside old module globals.

**Verified clean (3.12.0 refactor leak-neutral):**
- D8.4 caches keyed by **platform** (≤3 entries) or finite cacheKey — no per-ephemeral-deviceId explosion. (`shared-state-class.ts`)
- `ToolRegistry.notifyToolListChanged` — single nullable slot, NOT appending array. No listener leak. (`tool-registry.ts:25`)
- `RecorderState.active` — single slot, `set(null)` clears. (`recorder-state.ts`)
- `UiTreeCache` — single entry, TTL 500ms. `LogRing` — FIFO bounded 10k.
- Desktop `pendingRequests` Map — deleted on response/timeout/stop/crash, each `clearTimeout`'d. CLEAN.
- Browser `close()`/`closeAll()` — `cdp.close()` + `chrome.kill()` + `removeSession()`; sessions Map ends empty. CLEAN.
- iOS WDA cache — nulled on `setDevice`/`cleanup`; `WDAManager` self-deletes on process exit. CLEAN.

**Findings (all pre-existing, none from 3.12.0):**

| # | Sev | File:line | Leak | Note |
|---|-----|-----------|------|------|
| M1 | high | `browser/client.ts:153,175` | CDP listener accumulation | every `navigateToUrl`/reload registers fresh `Page.loadEventFired(cb)`, never removed → unbounded handler growth on long browser sessions. Highest-value fix for long-running stdio server. Fix: register once at session create, route via emitter/disposable. (since v3.0.0) |
| M3 | medium | `desktop/client.ts:336-356` | un-disposed process+listeners | `handleCrash`→`launch()` respawns without `removeAllListeners()` on old child process / readline. Bounded by `MAX_RESTARTS=3` per cycle but lingers to GC. Fix: detach old listeners + close readline before respawn. (pre-D9) |
| M4 | low | `desktop/client.ts:228` | stranded `once("ready")` | timeout path doesn't remove the `ready` listener. Bounded by launch count. |

---

## 3. Capability Boundaries / Access Control (typescript-pro)

**All guards fail CLOSED — no fail-open regressions.**

| # | Check | Result | File |
|---|-------|--------|------|
| C1 | `dispatchByPlatform` default | PASS — throws on missing key, no permissive fallthrough | `helpers/dispatch.ts:32-39` |
| C2 | Capability guards post-D9 split | PASS — every privileged method re-checks `hasShell`/`hasAppManagement`/`hasPermissions` | `proxies/{app,log,permission}-proxy.ts` |
| C3 | Platform union opening (D1) | PASS — `platformEnum=z.enum(BUILTIN_PLATFORMS)` rejects arbitrary strings; `getAdapter` throws `Unknown platform`. Union is type-level only. | `common-schema.ts:25`, `device-manager.ts:127` |
| C5 | defineTool zod migration | PASS — no `.passthrough()`/`.loose()`; zod strips unknown keys; `z.unknown()` fields re-validated at runtime | `sensor/location.ts:22` |
| C6 | Meta-tool action dispatch | PASS — `handlers.get(action)` → `UnknownActionError`; strictly enum+Map gated | `meta/create-meta-tool.ts:82` |

**Standing item (not a regression):**

| # | Sev | File:line | Note |
|---|-----|-----------|------|
| C4 | medium (gated) | `kernel/external-loader.ts:75-78` | `resolveEntry` uses `resolve(dir, pkg.main)` without asserting result stays in `dir` — malicious `package.json` `main:"../../.."` could load JS outside plugin sandbox. **Harmless today** — feature opt-in behind `CLAUDE_IN_MOBILE_EXTERNAL_PLUGINS=1` (default off), attacker controlling plugin dir already has FS access. **Must fix before flag default-on:** `if (!resolvedEntry.startsWith(resolve(dir)+sep)) skip;` |

---

## Follow-up issues to file (none block 3.12.0)

1. **[high]** browser CDP `loadEventFired` listener leak (M1) — register once per session.
2. **[medium]** desktop crash-restart listener disposal (M3).
3. **[medium]** browser `validateUrl` denylist → allowlist (S2).
4. **[medium]** external-loader path-containment check before default-on promotion (C4).
5. **[low]** `prefs-write` sanitizeForShell escape `'`/`"` (S1).
6. **[low]** desktop stranded `once("ready")` cleanup (M4).
