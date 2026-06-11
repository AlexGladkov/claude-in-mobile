# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.13.0] — 2026-06-11

App Store Connect / TestFlight support. "Выложи релиз в TestFlight" now
works end-to-end: the pipeline detects the project kind, builds the .ipa,
validates the bundle, uploads to ASC and distributes to beta groups.
Battle-tested by shipping a real KMP app (SwarmHost) to TestFlight as the
release gate.

### Added

- **`store` provider `"apple"`** alongside google/huawei/rustore, with
  unified actions: `build`, `upload`, `set_notes`, `submit`,
  `get_releases`, `promote`. Aliases: `testflight_build`,
  `testflight_upload`, `testflight_status`, `testflight_set_notes`,
  `testflight_distribute`, `testflight_submit`.
- **ASC REST client** (`src/store/app-store-connect.ts`) extending
  `AbstractStoreClient`: findApp, getBuilds (processingState polling),
  setWhatToTest (POST→409→PATCH), getBetaGroups, addBuildToGroup,
  submitForBetaReview, setEncryptionExempt.
- **Zero-dep ES256 JWT** (`src/store/asc-jwt.ts`) via `node:crypto`
  (`dsaEncoding: ieee-p1363`), 10-min TTL, in-memory cache. No `jose` —
  avoids the #43 ERR_REQUIRE_ESM class entirely.
- **iOS build pipeline** (`src/ios/build/`): project detection
  (Flutter / React Native / KMP / vanilla Xcode), scheme listing +
  release-scheme heuristic, `xcodebuild archive` + `-exportArchive`
  with ASC API key auth (cloud signing), on-the-fly ExportOptions.plist,
  `flutter build ipa` shortcut, `xcrun altool` upload with
  `--upload-package`→`--upload-app` fallback.
- **IPA validate gate**: `altool --validate-app` runs before every
  upload — Apple silently drops invalid packages server-side (the build
  never appears in `/v1/builds`); the gate surfaces every `detail :`
  failure synchronously as a typed `IpaValidationError`. Optional
  `skipValidation` bypass.
- **Bundle-reject recovery hints** for the three rejects every KMP/CMP
  project hits: missing `UILaunchScreen`, missing `CFBundleIconName`,
  incomplete `UISupportedInterfaceOrientations` (iPad multitasking).
- **Typed ASC errors** (`src/errors/asc.ts`): AscKeyMissing, AscAuth,
  AscUpload, AscRateLimit (retryable), TestflightVersionCollision,
  TestflightSigning, TestflightProcessingFailed, IpaValidation.
- Validators: `validateAscKeyId`, `validateAscIssuerId`,
  `validateXcodeScheme`, `validateVersionString`; standalone JWT
  redaction (`eyJ…` → `[REDACTED_JWT]`) in `sanitizeErrorMessage`.

### Changed

- Build-error classifier now surfaces actual `error:` / `e: ` lines
  from redacted xcodebuild/gradle stderr instead of the last-200-chars
  tail.
- Store meta description documents the Apple pipeline:
  `build → upload → get_releases (poll) → set_notes → promote`.

### Security

- ASC key material is **env-only** (`ASC_KEY_ID` / `ASC_ISSUER_ID` /
  `ASC_KEY_FILE` or `ASC_PRIVATE_KEY`, fastlane-convention fallback) —
  tool args cannot point at key files, closing an arbitrary-file-read /
  signed-exfil oracle. xcodebuild/altool run argv-form only; signing
  identities and `AuthKey_*.p8` names are stripped from all output
  returned to the LLM.

## [3.12.0] — 2026-06-08

Abstraction, pluginability & scalability refactor. Foundation release for
the microkernel migration originally outlined in ADR 0001/0002. All changes
land additively — existing MCP clients, plugin authors, and the legacy
DeviceManager facade keep working unchanged. The architecture report driving
the work is at `swarm-report/abstraction-pluginability-2026-06-08.md`.

### Added

- **Shared tool-layer helpers** (Phase 1):
  - `src/constants/timeouts.ts` — single source for ADB/DESKTOP/WDA/KERNEL/
    FLOW/RECORDER/SYNC/PERFORMANCE/SCREEN/CLIPBOARD timeouts.
  - `src/utils/sleep.ts` — replaces the 15 inline `new Promise(r =>
    setTimeout)` snippets.
  - `src/utils/tool-result.ts` — `textResult/errorResult/jsonResult`
    builders carrying both MCP `content[]` and legacy `text` for non-breaking
    migration.
  - `src/utils/run-tool-safely.ts` — HOC that converts unknown thrown errors
    into structured `errorResult` while re-throwing `MobileError` so typed
    error contracts (and tests) stay intact.
  - `src/utils/parse-common-args.ts` — extracts `{deviceId, platform}` once,
    centralising a ~125-callsite pattern.
  - `src/adb/commands.ts` — hoists `adb shell` strings (battery, mock
    location, pidof, am, input, screen) into typed builders for one-place
    edits and easier security review.

- **`defineTool({name, schema, handler})`** (Phase 2): builds a
  `ToolDefinition` from a zod schema. JSON Schema is generated via the
  built-in `z.toJSONSchema()` so the hand-maintained `inputSchema` no longer
  drifts from the runtime cast. Schema-validation failure throws
  `ValidationError` (a `MobileError` subclass) which `runToolSafely`
  re-throws so the typed-error contract propagates cleanly to MCP callers.
  **All 25 `*-tools.ts` files** now use `defineTool` — the legacy
  `ToolDefinition` path remains supported by the registry but no
  first-party tool uses it. Adds `zod ^4.4.3` as a direct dependency.

- **Capability-narrowing API** (Phase 3): `DeviceManager.getAdapter()` is
  now public. `requireAppManagement(adapter)`, `requirePermissions(adapter)`,
  and `requireShell(adapter)` in `adapters/platform-adapter.ts` throw a
  typed `CapabilityNotSupportedError` instead of forcing every tool to roll
  its own `if (platform !== "android")` early return.

- **Full kernel plugin set + BuiltinToolsPlugin** (Phase 4): `bootstrapKernel`
  loads android/ios/desktop/web/aurora plugins alongside REPL, plus a new
  first-party `BuiltinToolsPlugin` (`src/plugins/builtin-tools/`, capability
  `meta-tools`) that owns the cross-platform meta-tool registration,
  v3.0/v3.1 backward-compat aliases, and `MODULE_METADATA`. `src/index.ts`
  drops from 599 to 432 LOC; all 20 `*-meta.ts` imports moved into the new
  plugin.

- **External plugin discovery** (Phase 5, opt-in): new
  `src/kernel/external-loader.ts` walks `~/.claude-in-mobile/plugins/<id>/`
  (plus any `additionalRoots`), resolves each entry via `package.json`
  `main`/`module`, dynamically imports it and registers the factory.
  `apiVersion` is gated before registration; broken plugins are logged and
  skipped, never thrown. Enabled via
  `CLAUDE_IN_MOBILE_EXTERNAL_PLUGINS=1`. ADR 0001's deferred filesystem
  loader has landed.

- **Declarative UI scoring** (Phase 6): `findBestMatch()` in `adb/ui-parser`
  used to inline a 7-branch if/else cascade with magic numbers
  (100/95/80/75/60/40/35). Extracted into `src/adb/ui-scoring.ts` as a
  declarative `DEFAULT_SCORING_RULES` table plus `CLICKABLE_BOOST` constant.
  `ui-parser.ts` shrinks 996 → ~952 LOC.

- **Open `Platform` union** (D1): `Platform` is now
  `BuiltinPlatform | (string & {})`. The branded-string trick keeps IDE
  autocomplete for the five canonical IDs while letting third-party plugins
  declare an arbitrary `platform: "tizen"` without forking core. Exports
  `BUILTIN_PLATFORMS`, `isBuiltinPlatform`, and `assertNever` for callers
  that still want exhaustive narrowing.

- **Polymorphic shell routing** (D3): 24 production callsites moved off the
  deprecated raw-client accessors onto `DeviceManager.shell(cmd, platform,
  deviceId)` which routes via `getAdapter` + `hasShell` guard. Test mocks
  updated in lockstep. Six callsites remain on `getAndroidClient()` for
  genuinely platform-specific methods (getCurrentActivity, raw adb exec,
  push/pull, iOS findElement, WebViewInspector setup).

- **God-object decomposition** (D5):
  - `desktop/client.ts`: 966 → 679 LOC. Extracted
    `desktop/permission-allowlist.ts`, `desktop/log-ring.ts`,
    `desktop/launchers.ts`.
  - `adb/client.ts`: 776 → 640 LOC. Extracted `adb/exec.ts`,
    `adb/text-escape.ts`, `adb/ui-tree-cache.ts`, `adb/keycodes.ts`.
  - `flow-tools.ts`: 756 → 6 LOC (barrel) + `flow/` directory
    (run/batch/parallel/common).
  - `sync-tools.ts`: 711 → 26 LOC (barrel) + `sync/` directory
    (create-group/run/assert-cross/status/list/destroy/common).
  - `performance-tools.ts`: 639 → 28 LOC (barrel) + `performance/`
    directory (snapshot/baseline/compare/monitor/crashes/framestats/common).
  All extracted symbols re-exported from the original module so existing
  imports keep working with zero test impact.

- **Parametrised release matrix** (D6): `release.yml` `update-homebrew` and
  `verify-checksums` jobs no longer hardcode `darwin-arm64` /
  `darwin-x86_64`. They discover the platform list from the actual artifact
  filenames (`update-homebrew` builds a `{platform: sha}` JSON map;
  `verify-checksums` queries the GitHub Releases API for `*.tar.gz`
  assets). Adding a third arch is now a one-line edit to the build matrix.

- **Per-platform npm shim packages** (D7): five new publishable workspaces:
  `@claude-in-mobile/plugin-{android,ios,desktop,web,aurora}` at 3.12.0.
  Each is a ~20 LOC re-export shim of the corresponding plugin from the
  main package via the new `claude-in-mobile/plugins/*` exports map. The
  actual implementation continues to live in the main pkg; the shims
  establish publishable topology so third parties can declare a hard
  dependency on a specific platform plugin today, and so the 4.0.0
  source-move is a one-step relocation.

### Changed

- **`@claude-in-mobile/plugin-api` → 1.0.0** (was 1.0.0-alpha.0). The
  contract has been stable since 3.10; third-party plugin authors can now
  declare a production-grade dep without anchoring to a pre-release.
- `DeviceManager.getAndroidClient` / `getIosClient` / `getAuroraClient` are
  now `@deprecated`. Existing 107 callsites continue to work; new code
  should use `getAdapter(platform, deviceId)` + capability type guards.

### D8 — Second-wave abstraction (2026-06-09)

Follow-up to the 3.12.0 architecture review (see
`swarm-report/abstraction-plugin-scalability-2026-06-09.md`). Five
behaviour-preserving refactors, all additive:

- **D8.1 — common-schema (`src/tools/common-schema.ts`).** Shared
  `platformEnum` derived from `BUILTIN_PLATFORMS` (single source of
  truth) and `deviceIdField`. Replaces duplicated literals across 15
  `*-tools.ts` files. Adding a new platform now propagates to every
  tool schema automatically. Net −108 LOC.
- **D8.2 — `dispatchByPlatform` helper (`src/tools/helpers/dispatch.ts`).**
  Replaces 5 multi-branch platform `if/else` chains in
  `system-tools.ts`, `intent-tools.ts` (×2), `performance/common.ts`,
  `sensor-tools.ts`. Single-branch guards intentionally left for a
  future `requirePlatform` helper.
- **D8.3 — meta-tool descriptor barrel (`src/tools/meta/index.ts`).**
  `BuiltinToolsPlugin.init` no longer hardcodes 20 `xMeta`/`xAliases`
  imports; the plugin shrinks 287 → 141 LOC and iterates a single
  `META_TOOL_DESCRIPTORS` array. Adding a meta tool: 1 edit site
  (was 3). Profile gating + alias precedence preserved.
- **D8.4 — `RuntimeContext` extraction (`src/runtime/runtime-context.ts`).**
  Tool registry, recorder state, and per-device shared caches moved
  into a `RuntimeContext` class with a lazy default singleton. Removes
  10 module-level `let`/mutable slots from `registry.ts`,
  `recorder-tools.ts`, `context/shared-state.ts`. Public API and
  every legacy top-level function unchanged. Tests can inject fresh
  contexts via `createRuntimeContext()` / `resetDefaultRuntimeContext()`.
- **D8.5 — `ui-parser` split (`src/adb/ui-parser/`).** Old 954-LOC
  monolith becomes a 43-LOC facade that re-exports
  `node-parser.ts` / `element-builder.ts` /
  `formatters/{semantic,compact,full}.ts`. Strategy-pattern
  `FORMATTERS` registry. No call-site changes.

All five validated: `tsc --noEmit` clean, 1107/1107 vitest pass,
`node dist/index.js --help` exits 0, dynamic ESM import of
`dist/browser/client.js` resolves `BrowserClient`.

### D9 — God-object elimination, three iterations (2026-06-09)

Closed the loop on the D8 review: every production file that could be
split without harming a load-bearing state machine was split. 15 splits
across 3 iterations, all behaviour-preserving, 1107/1107 tests after each.

- **iter1:** `device-manager.ts` 688→571 (extracted `src/device/`
  client-cache / device-resolver / kernel-device-locator + `platform-types.ts`);
  `recorder-tools.ts` 667→15 (`src/tools/recorder/` redaction / capture /
  playback / tools); `ui-parser/element-builder.ts` 481→31
  (element-finders / screen-analyzer / diff-engine); `utils/image.ts`
  721→34 (`src/utils/image/` types / backend / encode / compress /
  compare / drawing / overlay / annotate).
- **iter2:** `sandbox-tools.ts` 533→3 (per-tool files under
  `src/tools/sandbox/`); `sensor-tools.ts` 452→15 (`src/tools/sensor/`,
  battery/thermal status-code tables hoisted to `constants.ts`);
  `ui-tools.ts` 417→36 (`src/tools/ui/`, `maxChars` hardcode hoisted to
  `src/constants/truncation.ts`); `index.ts` 432→169
  (`src/runtime/` mcp-instructions / mcp-server / cli);
  `device-manager.ts` 571→450 (capability proxies
  `src/device/proxies/{input,app,permission,log,screen}-proxy.ts`).
- **iter3:** `device-manager.ts` 450→335 (desktop-facade +
  device-facade); `errors.ts` 457→7 (12 category modules under
  `src/errors/`); `adb/client.ts` 640→545 (`parsers.ts`, `logcat.ts`);
  `ios/client.ts` 687→524 (simctl-exec / simctl-commands /
  simctl-parsers / wda-payloads / wda-errors / keymap / types);
  `desktop/client.ts` 679→622 (`launch-options.ts`); `browser/client.ts`
  587→408 (cdp-helpers / snapshot-builder / key-map).
- Remaining >400 LOC files (desktop 622, adb 545, ios 524, browser 408)
  are deliberate stops: RPC state machine, security-sensitive exec
  surfaces, WDA retry orchestration, CDP session lifecycle. Splitting
  further would trade encapsulation for a metric.

### Security

Three-consilium audit of the full 3.12.0 diff (injection / memory leaks /
capability boundaries) found **zero regressions from the refactor** and six
pre-existing issues, all fixed in this release:

- **Browser URL validation switched from denylist to allowlist** — only
  `http:`/`https:` reach CDP `Page.navigate`; `data:`, `javascript:`,
  `blob:`, `ftp:` now throw `BrowserSecurityError` (was: passed the old
  denylist). `src/browser/types.ts`, `client.ts`.
- **Browser CDP listener leak fixed** — every navigation/reload
  registered a persistent `Page.loadEventFired` handler that was never
  removed; long sessions accumulated handlers unbounded. Converted to
  one-shot promise form with timeout race. `src/browser/client.ts`.
- **Desktop crash-restart now disposes the old child process** —
  listeners, stdout/stderr streams and the readline interface are
  detached (and the process killed if still alive) before respawn;
  `waitForReady` cleans up its `once("ready")` listener on all three
  outcomes. `src/desktop/client.ts`.
- **External plugin loader path containment** — a plugin's
  `package.json` `main` is now verified to resolve inside the plugin
  directory; `main: "../../.."` escapes are skipped with a warning
  (fail closed). `src/kernel/external-loader.ts`.
- **Sandbox prefs-write quote escaping** — `'`/`"` in values are escaped
  for the device-side single-quoted `sed` program (`'` → `'\''`),
  closing a run-as-scoped injection. `src/tools/sandbox/prefs-write.ts`.

### E2E

- New on-device smoke harness `scripts/smoke-e2e.mjs` — JSON-RPC stdio
  client driving the built server. 16/16 pass on Android emulator
  (Pixel 9 Pro, API 35), iOS Simulator (iPhone 17 Pro, iOS 26.0) and
  headless Chrome (CDP). Reports in `swarm-report/e2e-d8d9-2026-06-09/`.

Deferred to 4.0.0 (require breaking changes):
- True multi-session `Session` resolved per MCP request (current
  `RuntimeContext` is structurally ready; transport rewire is the
  breaking part).
- `requirePlatform`/`assertPlatform` helper normalising 17 remaining
  single-branch platform guards.
- Hoisting `context.ts`'s module-level `deviceManager` singleton into
  `RuntimeContext` (touches `ToolContext` shape).

### Notes

Every item from the original refactor plan (Phases 1-7 + D1-D7) is in
this release, plus the D8 second-wave above. Items that remain for a
future major (4.0.0) are pure breaking changes that would force
consumers to rewrite:

- Moving the per-platform plugin source out of the main pkg into the
  shim workspaces (the topology is ready; the file move + dependency
  flip is the breaking change).
- Removing the deprecated `getAndroidClient` / `getIosClient` /
  `getAuroraClient` accessors entirely (six callsites still reach
  platform-specific methods that have no `CorePlatformAdapter` equivalent
  — those need the adapter contract widened first).
- Tightening `ToolResult` to model image content blocks natively
  (currently the few image-returning tools cast through `as unknown as
  ToolResult`).

## [3.11.5] — 2026-06-07

### Fixed

- **REPL plugin tools (`repl_spawn`, `repl_send`, `repl_key`, `repl_expect`,
  `repl_snapshot`, `repl_list`, `repl_kill`) are now actually exposed via
  MCP.** Root cause: `src/runtime/bootstrap.ts` (and its
  `DEFAULT_BUILTINS` containing `createReplPlugin`) was wired in code but
  never called from the MCP entry point `src/index.ts`. The kernel was
  only instantiated by `bootstrap.test.ts`; production runs registered
  only the legacy meta-tools and the REPL plugin remained invisible — so
  the 3.11.4 release notes advertised `repl_*` tools that no MCP client
  could see.

  Fix: `src/index.ts` now bootstraps the kernel with the REPL plugin,
  awaits `kernel.initAll()`, and bridges each `PluginContext`-registered
  `ToolDefinition` into the existing MCP `registerTools` registry before
  freezing. `kernel.disposeAll()` is wired into the graceful shutdown
  path so the Rust supervisor child is killed on `SIGTERM` / `SIGINT` /
  stdin close.

  Platform plugins (android/ios/desktop/web/aurora) remain on the legacy
  meta-tool layer for this release — only REPL is bridged through the
  kernel. Full kernel migration is scoped for v3.12.

  Defensive note: the supervisor process is *not* spawned at bootstrap.
  `ReplBridgeClient.start()` is lazy, called only on the first
  `repl_spawn` / `repl_send` / etc. `--help`, `--version`, `--init` still
  exit before any child process is launched.

## [3.11.4] — 2026-06-07

### Fixed

- **#45 — `npx claude-in-mobile@latest` fails with 404 on
  `@claude-in-mobile/plugin-api`.** The 3.11.x line declared a dependency
  on the workspace package `@claude-in-mobile/plugin-api`, which was never
  published to the public npm registry. Local development worked through
  the workspace symlink; every end-user install failed at dependency
  resolution. The same root cause as the 3.11.0 → 3.11.2 internal hotfix
  chain, but with a much larger blast radius — the npm tarball itself
  was broken for everyone whose MCP config points at `@latest`.

  Fix: `package.json` now lists `@claude-in-mobile/plugin-api` in
  `bundledDependencies`. `npm publish` packs the workspace package's
  built output directly into the tarball under
  `node_modules/@claude-in-mobile/plugin-api/`, so npm never queries the
  registry for it. The dep version was pinned to `1.0.0-alpha.0` (was
  `*`) to satisfy `bundledDependencies` requirements.

  Until `@claude-in-mobile/plugin-api` is properly published as a
  standalone npm package (planned for v3.12), this is the supported way
  to ship the contract alongside the host package.

Local verification — `npm install ./claude-in-mobile-3.11.4.tgz` into an
empty project succeeds without contacting the registry for the bundled
dep.

## [3.11.3] — 2026-06-07

### Fixed

- **#43 — Browser module fails with `ERR_REQUIRE_ESM`.** `chrome-launcher`
  ships as ESM-only and could not be loaded via `createRequire` under
  Node 20+. `BrowserClient.launch` now uses dynamic `await import()` for
  both `chrome-launcher` and `chrome-remote-interface`. The enclosing
  function is already async, so no surface change.
- **#44 — Agents deadlock on `npx -y claude-in-mobile --help`.** Without a
  `--help` short-circuit the MCP server started its stdio JSON-RPC loop
  and blocked forever waiting on stdin, which looked like a hang to the
  calling agent (notably Gemini). The entrypoint now handles `--help`,
  `-h`, `--version` and `-V` explicitly: it prints the usage info / version
  to stdout and exits 0 before any server initialisation.

## [3.11.2] — 2026-06-07

### Fixed

- Release workflow now grants `id-token: write` to the `publish-npm` job.
  `npm publish --access public --provenance` mints a Sigstore attestation
  linking the published tarball to the exact workflow run, which the npm
  CLI refuses to do without `id-token: write`. The 3.11.1 release built
  and packaged successfully but failed at the publish step with
  `npm error EUSAGE — Provenance generation in GitHub Actions requires
  "write" access to the "id-token" permission`.

Runtime behaviour is identical to 3.11.0 / 3.11.1.

## [3.11.1] — 2026-06-07

### Fixed

- `npm run build` now builds the `@claude-in-mobile/plugin-api` workspace
  package before compiling the main TypeScript sources. Without this, fresh
  CI checkouts (and any contributor running `npm ci` then `npm run build`)
  failed with `TS2307: Cannot find module '@claude-in-mobile/plugin-api'`.
  The error only surfaced in the 3.11.0 release pipeline because local
  development environments had a stale `packages/plugin-api/dist/` from
  earlier manual builds.

This is a build-pipeline-only hotfix; runtime behaviour is unchanged from
3.11.0. If you already installed 3.11.0 successfully through Homebrew, no
upgrade is required for functionality. The npm publish for 3.11.0 did not
succeed; install `claude-in-mobile@3.11.1` from npm.

## [3.11.0] — 2026-06-07

### Architecture — Microkernel

claude-in-mobile now uses a microkernel design with capability-based plugins.
Existing platforms (Android, iOS, Desktop, Web, Aurora) are wrapped as
first-party plugins; the kernel itself knows nothing about them. The public
contract is split into a new package, `@claude-in-mobile/plugin-api`, with an
independent semver.

ADRs:

- `docs/adr/0001-microkernel-architecture.md` — design rationale, layering
  rule, consequences.
- `docs/adr/0002-plugin-api-v1.md` — formal v1 contract, lifecycle FSM,
  event topics.

Layout:

- `packages/plugin-api/` — new workspace, exports `Capability`,
  `SourcePlugin`, `PluginManifest`, `PluginContext`, event topics, errors.
  Versioned at `1.0.0-alpha.0`.
- `src/kernel/` — TypeScript kernel (registry, lifecycle, event bus,
  resolver, guard, loader). 23 unit tests.
- `src/plugins/<id>/` — Android, iOS, Desktop, Web, Aurora, REPL plugins.
  Each ships a `contract.test.ts` consuming the generic plugin suite.
- `src/runtime/bootstrap.ts` — composition root. Registers all built-ins and
  exposes a `KernelHandle`.
- `DeviceManager.fromKernel(handle)` — duck-typed factory that bridges the
  legacy facade to the new registry without forcing plugins to depend on it.
- `src/architecture.test.ts` — layering invariants enforced as tests (kernel
  ↛ plugins, plugin ↛ plugin, plugin ↛ legacy facade).

Rust mirror:

- `cli/src/kernel/` — `Capability`, `PluginManifest`, `SourcePlugin`,
  `Registry`, `Resolver`. Mirrors the TS semantics; `serde(rename_all =
  "camelCase")` keeps the wire format identical. 18 unit tests.
- `cli/src/plugins/` — Android, iOS, Desktop, Web, Aurora, REPL plugins +
  `register_builtins(registry)`. Manifests are the contract reference; full
  command dispatch arrives with the REPL bridge.

### Added — REPL plugin (`terminal` + `input` capabilities)

claude-in-mobile can now drive interactive REPLs and CLI tools (python,
node, ghci, bash, custom CLIs) through a PTY-backed source.

- Rust supervisor in `cli/src/plugins/repl/` using `portable-pty 0.9` and
  `vt100 0.15`. Multi-session, in-memory state, JSON-RPC stdio bridge.
- New subcommand `claude-in-mobile repl-supervisor` — long-lived loop
  consumed by the TypeScript plugin. Not intended for direct human use; the
  wire protocol is documented in `cli/src/plugins/repl/bridge.rs`.
- TypeScript plugin in `src/plugins/repl/` exposes seven MCP tools:
  `repl_spawn`, `repl_send`, `repl_key`, `repl_expect`, `repl_snapshot`,
  `repl_list`, `repl_kill`.
- Prompt-detection cascade: regex → idle timeout → child exit. Default
  profiles for python, ipython, node, ghci, psql, bash, zsh, sh.
- Skill `/test-repl` (`.claude/commands/test-repl.md`) for scripted
  scenarios.

### Security baseline

- Secret redaction layer on every `repl_snapshot` response. Covers AWS
  access keys, GitHub PATs, OpenAI/Anthropic keys, Bearer headers, JWTs,
  Google API keys, Slack tokens. See `src/plugins/repl/redaction.ts`.
- Minimal environment allowlist when spawning the REPL supervisor
  subprocess. Per-session env is passed explicitly through `repl_spawn.env`.
- `ci.yml` now runs `npm audit --omit=dev --audit-level=high` and `cargo
  audit --deny warnings` on every push.
- `docs/security.md` documents the 3.11.0 baseline and what is deferred to
  v4 (sandbox, per-plugin permissions, signing).

### Developer experience

- `docs/plugins/{api-v1,authoring,capability-reference}.md` — reference
  documentation for plugin authors.
- `docs/plugins/template/` — copy-and-edit scaffold for new plugins.
- Generic plugin contract suite in `src/plugins/contract-suite.ts` — every
  plugin must invoke `runPluginContract(factory)`; CI enforces architecture
  invariants.

### Compatibility

Public MCP tool names are unchanged. Existing skills (`/test-android`,
`/test-ios`, `/test-desktop`, `/test-web`, `/test-aurora`) work as before.
DeviceManager's legacy constructor is preserved; `fromKernel` is additive.

`@claude-in-mobile/plugin-api` starts at `1.0.0-alpha.0` and follows its own
semver. The `apiVersion` field on every plugin manifest gates compatibility
with the kernel.

## [3.10.3] — 2026-05-31

### Security (CWE-78 — OS Command Injection)

Closes **#40** — host-side RCE via standalone `&` bypass in `system_shell`. Reported by `mcfly-zzh`. The denylist in `validateShellCommand` did not block a standalone `&`; payloads like `command="x & touch /tmp/RCE"` reached `execSync("adb shell ${command}")` and the host shell forked `touch /tmp/RCE` on the developer's workstation. Severity: High.

**Structural fix** — host shell is no longer invoked. All device clients route through argv-form execution (`execFileSync(bin, [...args])`); shell metacharacters in arguments are passed as literal argv slots and never parsed by `/bin/sh`. CWE-78 is closed by construction, not by denylist.

Applies to:

- `src/adb/client.ts` — Android (ADB)
- `src/ios/client.ts` — iOS Simulator (`xcrun simctl`)
- `src/aurora/client.ts` — Aurora OS (`audb`)
- `src/desktop/gradle.ts` — Desktop Gradle invocations

Defense in depth — denylist in `src/utils/sanitize.ts` extended to block `&`, `${...}`, `<(...)`, `>(...)`, and tab characters.

**Rust CLI** — same fix class extended to `cli/src/**`:

- `cli/src/utils/validate.rs` (new) — entry-point whitelist validators: `validate_permission_name`, `validate_relative_path`, `validate_pref_key`, `validate_xml_filename`, `validate_sqlite_value`, `validate_osascript_key`.
- `cli/src/android.rs` — six CRITICAL injection sites (`sandbox_prefs_read/write`, `sandbox_sqlite_query`, `sandbox_file_list/read`, `permission_grant/revoke`) now reject inputs that contain shell metacharacters at function entry, before any `Command::new` is built.
- `cli/src/ios.rs` — `osascript` keystroke fallback now whitelists the key against `^[A-Za-z0-9_]+$`; documented SECURITY INVARIANT comment anchored on the `pbcopy` fallback static path.

### Added

- **`DeviceShellCmd` builder** (`cli/src/utils/device_shell.rs`) — typed builder for `adb shell <string>` / `audb shell <string>` composition. Three argument kinds: `Literal` (compile-time `&'static str`), `Validated` (passes a whitelist validator), `UserInput` (auto-quoted via POSIX `'` → `'\''` escaping). User-controlled segments are inert against metacharacters by construction; reviewers grep `user_input(` to audit every untrusted entry point. Closes **#42**.
- **`shell` subcommand opt-in gate** — `claude-in-mobile shell {android|ios|aurora}` now requires one of `--i-know-what-im-doing`, `CLAUDE_IN_MOBILE_ALLOW_SHELL=1` env, or interactive TTY. Prevents supply-chain / CI misuse of the documented arbitrary-execution backdoor. Closes **#41**. **See "Breaking" below.**
- **LLM-friendly `system_shell` error diagnostics** — when the denylist rejects a payload, the error names the offending metacharacter and suggests the canonical alternative tool (`ui_tap`/`ui_swipe`, `app_launch`, `system_open_url`). Tab character calls out copy-paste as the likely source. `$()` / `${}` explain that the shell does not expand here.
- **`system_shell` tool description** — now upfront-documents the rejected metacharacter set and points callers (especially LLM-driven) at the right alternative tools. URLs with `&` in the query string MUST go through `system_open_url`.
- Regression tests:
  - `src/adb/client.test.ts`, `src/ios/client.test.ts`, `src/aurora/client.test.ts` — fake-binary shim + proof-file side-effect; reproduces the original PoC from #40 across all three clients.
  - `src/utils/sanitize.test.ts` — bypass primitives (`&`, `${...}`, `<()`, `>()`, tab) + LLM-friendly diagnostic assertions.
  - `src/tools/system-tools.test.ts` — cross-platform `system_shell` regression on every supported platform.
  - `cli/src/utils/validate.rs`, `cli/src/utils/device_shell.rs`, `cli/src/utils/shell_gate.rs` — unit tests on injection payloads, metachar corpus, and gate truth table.

### Changed

- All device-side pipes (`| tail -N`, `| grep`, `| head -N`) in `getNetworkStats`, `getMemoryInfo`, `getCpuInfo`, `getLogs`, `getAppLogs` replaced with Node-side `.split("\n").slice(...)` filtering. Output identical; +50–100ms over large logs because the device sends the full stream before filtering.
- `iosClient.openUrl()` — was string-interpolated `execSync` despite an in-code comment claiming argv-form. Now actually uses argv-form.
- `iosClient.getAppLogs()` — `bundleId` is now validated via `validateBundleId` before reaching the predicate.
- Aurora `runCommandSync(string)` helper replaced with `runAudbSync(args[])`; all callers updated to pass argv.
- `escape_adb_text` (`cli/src/commands/flow.rs`) deleted — superseded by `DeviceShellCmd`'s POSIX single-quoting, which covers the full shell metacharacter set.

### Breaking

- **`claude-in-mobile shell` subcommand requires opt-in in non-TTY contexts.**
  CI scripts and automation that previously ran `claude-in-mobile shell android "<cmd>"` from a pipe will now print an ERROR and exit 1. Migration:
  ```bash
  # Per-invocation:
  claude-in-mobile shell android "ls" --i-know-what-im-doing
  # Or session-wide:
  export CLAUDE_IN_MOBILE_ALLOW_SHELL=1
  ```
  Interactive terminal use is unaffected.
- **`system_shell` MCP tool now rejects more payloads.** The following used to pass and now error with `SHELL_INJECTION_BLOCKED`:
  - Standalone `&` (background separator) — including inside `&` in URL query strings. Use `system_open_url` for URLs.
  - `${...}` brace expansion — inline the value.
  - `<(...)` / `>(...)` process substitution — not supported on Android shell.
  - Tab characters — often a side effect of copy-paste; replace with single spaces.
- **Rust CLI sandbox/permission commands reject shell metacharacters.** `sandbox prefs read/write`, `sandbox sqlite query`, `sandbox file list/read`, `permission grant/revoke` now hard-reject paths, keys, values, or permission names containing shell metacharacters (`;`, `|`, `&`, `<`, `>`, `$`, backtick, quotes, parens, braces, glob chars, newline, tab) or path-traversal `..`. Scripts that previously relied on lax inputs will see a clear validation error.

### Internal

- Two follow-up hardening issues opened, both deferred from v3.10.3 because they are not exploitable today after the structural fix landed:
  - **#41** — gate the `shell` subcommand (DONE in this release) + `escape_adb_text` extension (SUPERSEDED by `DeviceShellCmd`).
  - **#42** — `DeviceShellCmd` typed builder + migration of every `format!() → adb shell` site in the Rust CLI (DONE in this release).

### Verification

- `npm run build` (tsc) — clean
- `npm test` (vitest) — **1012 / 1012 passed**, 32 files
- `cargo build --release` — clean (3 pre-existing dead-code warnings)
- `cargo test` — **86 / 86 passed** (35 lib + 51 bin)
- Manual smoke checks: `shell` opt-in gate behavior verified against the release binary (non-TTY error, env-var opt-in, flag opt-in, `--help` SECURITY paragraph).

### Upgrade

```bash
brew update && brew upgrade claude-in-mobile
claude-in-mobile --version    # 3.10.3
claude-in-mobile doctor       # verify CLI diagnostics
```

If `brew upgrade` reports `already installed`, see the "Known Issue" note at the top of the README.

---

## [3.10.2] — 2026-05-29

- `config` subcommand added with persistent turbo toggle.

## [3.10.1] — 2026-05-28

- Version bump (no functional changes).

## [3.10.0] — 2026-05-27

- CLI parity — 47 MCP tools ported to Rust CLI.
