# Release v3.12.0 — 2026-06-08

## Включено

Абстракция, плагинность, масштабируемость. **14 этапов** (Phases 1-7 + D1-D7),
все additive, без breaking changes для существующих consumer.

### Phase 1 — Shared helpers (9253977)
constants/timeouts, utils/sleep, utils/tool-result, utils/run-tool-safely,
utils/parse-common-args, adb/commands.

### Phase 2 — defineTool + zod pilot (5947f4e)
src/tools/define-tool.ts + system-tools.ts мигрирован. zod 4.4.3.

### Phase 3 — Capability narrowing API (38bbb82)
public getAdapter, requireAppManagement/Permissions/Shell,
CapabilityNotSupportedError, deprecate getAndroidClient/getIosClient/...

### Phase 4 — Full kernel plugin set (c8f0cfd)
bootstrapKernel({}) → DEFAULT_BUILTINS.

### Phase 5 — ExternalPluginLoader + plugin-api 1.0.0 (8166586)
kernel/external-loader.ts, bootstrapKernelAsync,
CLAUDE_IN_MOBILE_EXTERNAL_PLUGINS=1, plugin-api alpha → 1.0.0.

### Phase 6 — UI scoring extraction (3e0449b)
adb/ui-scoring.ts, DEFAULT_SCORING_RULES, CLICKABLE_BOOST.

### Phase 7 — lite dep workspace pin (d51da71)
packages/lite/package.json.

### D1 — Open Platform union (3f47868)
`Platform = BuiltinPlatform | (string & {})`. BUILTIN_PLATFORMS,
isBuiltinPlatform, assertNever.

### D2 — Complete defineTool migration (b006b3d, d1678ed)
24/24 *-tools.ts files now use defineTool. defineTool patched to throw
ValidationError on schema failure (preserves typed-error contract).

### D3 — Polymorphic shell routing (7c7673b)
24 callsites moved off getAndroidClient onto DeviceManager.shell + tests
updated in lockstep. 6 callsites remain for genuinely platform-specific
methods (no CorePlatformAdapter equivalent).

### D4 — BuiltinToolsPlugin (dcd1565)
src/plugins/builtin-tools/ owns meta-tool registration, aliases, metadata.
src/index.ts 599 → 432 LOC. 20 *-meta.ts imports moved out.

### D5 — God objects decomposition (5357f78)
- desktop/client.ts 966 → 679 + permission-allowlist/log-ring/launchers
- adb/client.ts 776 → 640 + exec/text-escape/ui-tree-cache/keycodes
- flow-tools.ts 756 → 6 (barrel) + flow/
- sync-tools.ts 711 → 26 + sync/
- performance-tools.ts 639 → 28 + performance/

### D6 — Release matrix parametrisation (7228149)
.github/workflows/release.yml — update-homebrew + verify-checksums
discover platforms dynamically from artifact filenames.

### D7 — Per-platform npm shim packages (e516e17)
@claude-in-mobile/plugin-{android,ios,desktop,web,aurora}@3.12.0.
Root exports map updated with `./plugins/*`.

### CHANGELOG + retag (40327b4 + v3.12.0)

## Закрытые issues

Zero open issues at release time (`gh issue list --state open` empty).

## CI runs

Pre-push validation:
| Stage | Результат |
|---|---|
| `npm install` | clean, 5 new workspaces added |
| `npm run build` | clean (root tsc + 6 workspace builds) |
| `npx vitest run` | 1107 / 1107 |
| `cargo build --release` | clean |
| `cargo test --lib` | 87 / 87 |
| `node dist/index.js --version` | 3.12.0 |
| `node dist/index.js --help` | exits 0 |
| `import("./dist/browser/client.js")` | ok |
| `npm pack` + plugin-api bundled check | ok |

## Channels verification

Pre-push (CI runs on tag push).

## Метрики

| Метрика | До | После |
|---|---|---|
| src/index.ts LOC | 599 | 432 |
| desktop/client.ts LOC | 966 | 679 |
| adb/client.ts LOC | 776 | 640 |
| flow-tools.ts LOC | 761 | 6 |
| sync-tools.ts LOC | 757 | 26 |
| performance-tools.ts LOC | 713 | 28 |
| ui-parser.ts LOC | 996 | 952 |
| Hardcoded `setTimeout` sleeps | 15 | 0 |
| Hardcoded timeout numbers | 7 файлов | 1 (constants/timeouts.ts) |
| *-tools.ts using defineTool | 0/25 | 25/25 |
| Polymorphic shell callsites | 0 | 24 |
| Platform union | closed (5) | open (extensible) |
| First-party plugins under kernel | 1 (REPL) | 7 |
| Publishable packages | 2 (main, lite) | 8 (+plugin-api, +5 platform shims) |

## Известные ограничения (4.0.0 scope)

1. Source files под `src/plugins/<platform>/` — для 4.0.0 переехать в
   `packages/plugin-<name>/src/`. Топология готова, источник пока в
   main pkg.
2. Удаление deprecated `getAndroidClient/getIosClient/getAuroraClient` —
   6 callsites используют platform-specific методы (getCurrentActivity,
   raw adb exec, push/pull, iOS findElement, WebView). Требует расширения
   CorePlatformAdapter.
3. `ToolResult` не моделирует image content blocks нативно — пара
   image-возвращающих tools используют `as unknown as ToolResult`.

## Lessons learned

1. **zod v4 несовместим с zod-to-json-schema** (последний только v3).
   Использовать встроенный `z.toJSONSchema()`.
2. **defineTool должен throw ValidationError**, не возвращать errorResult.
   Иначе ломаются ~30 тестов с `.rejects.toThrow(ValidationError)`.
   runToolSafely должен re-throw MobileError.
3. **Замена getAndroidClient(...).shell() → deviceManager.shell()
   требует update test mocks в lockstep** — мок-стратегия завязана на
   старый accessor. Option A (обновлять production + tests парно) —
   единственно правильный путь.
4. **Декомпозиция god-objects:** RPC transport в desktop/client.ts
   нельзя извлечь без рефакторинга lifecycle FSM. Не форсить fake
   boundary — оставить как есть до отдельного PR.
5. **npm workspace dep на root pkg:** wildcard `"*"` работает, но
   semver pin `^3.12.0` не работает до публикации. Workspace install
   справляется; pin становится правдой только после `npm publish`.
6. **Subagent параллелизация zod migration:** 4 параллельных subagent
   справились с 24 файлами. Один из батчей (large files) корректно
   возразил по semantic issue и потребовал patch defineTool — это
   правильный pushback, а не упрямство.
