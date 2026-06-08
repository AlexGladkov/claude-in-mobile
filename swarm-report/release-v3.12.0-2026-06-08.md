# Release v3.12.0 — 2026-06-08

## Включено

Абстракция, плагинность, масштабируемость — фундамент микроядерной миграции
(ADR 0001/0002). 7 фаз, additive, без breaking changes.

### Phase 1 — Shared helpers (commit 9253977)
- `src/constants/timeouts.ts` — единая таблица таймаутов
  (ADB/DESKTOP/WDA/KERNEL/FLOW/RECORDER/SYNC/PERFORMANCE/SCREEN/CLIPBOARD)
- `src/utils/sleep.ts` — снимает 15 inline `new Promise(setTimeout)`
- `src/utils/tool-result.ts` — `textResult/errorResult/jsonResult` с двойной
  схемой (`content[]` + legacy `text`) для non-breaking миграции
- `src/utils/run-tool-safely.ts` — HOC: `MobileError` re-throw, unknown
  errors → `errorResult`
- `src/utils/parse-common-args.ts` — извлечение `{deviceId, platform}`
- `src/adb/commands.ts` — `BATTERY`, `AM`, `INPUT`, `SCREEN`, `PIDOF`,
  `MOCK_LOCATION_GRANT` (снимает hardcode `adb shell` strings)

### Phase 2 — defineTool + zod (commit 5947f4e)
- `src/tools/define-tool.ts` — `defineTool({name, schema, handler})` с
  автогенерацией JSON Schema через `z.toJSONSchema()`
- `zod ^4.4.3` добавлен как direct dependency
- `system-tools.ts` (11 tools, ~380 LOC) мигрирован как pilot
- runToolSafely: re-throw MobileError для сохранения test contracts

### Phase 3 — Capability narrowing (commit 38bbb82)
- `DeviceManager.getAdapter()` стал публичным
- `requireAppManagement/requirePermissions/requireShell` в
  `adapters/platform-adapter.ts`
- `CapabilityNotSupportedError`
- `getAndroidClient/getIosClient/getAuroraClient` помечены `@deprecated`

### Phase 4 — Full kernel plugin set (commit c8f0cfd)
- `bootstrapKernel({})` теперь использует `DEFAULT_BUILTINS`
- android/ios/desktop/web/aurora под kernel lifecycle

### Phase 5 — ExternalPluginLoader + plugin-api 1.0.0 (commit 8166586)
- `src/kernel/external-loader.ts` — сканер
  `~/.claude-in-mobile/plugins/<id>/`
- `bootstrapKernelAsync({ externalPlugins: true })`
- env `CLAUDE_IN_MOBILE_EXTERNAL_PLUGINS=1` — opt-in
- `@claude-in-mobile/plugin-api`: `1.0.0-alpha.0` → `1.0.0`

### Phase 6 — UI scoring extraction (commit 3e0449b)
- `src/adb/ui-scoring.ts` — declarative `DEFAULT_SCORING_RULES`
  (100/95/80/75/60/40/35 → таблица rules)
- `CLICKABLE_BOOST = 10`
- `ui-parser.ts`: 996 → ~952 LOC

### Phase 7 — Distribution (commit d51da71)
- `packages/lite` ← workspace bind

### Release (commit dab763b, tag v3.12.0)
- Bump 4 манифестов (package.json, cli/Cargo.toml, marketplace.json,
  plugin.json)
- CHANGELOG entry с полным списком фаз

## Закрытые issues

Нет — `gh issue list --state open` пустой на момент релиза.

## CI runs

Локальная валидация (CI после push):
| Stage | Результат |
|---|---|
| `npm run build` | clean |
| `npx vitest run` | 1107 / 1107 |
| `cargo build --release` | clean (39 warnings, не блокеры) |
| `cargo test --lib` | 87 / 87 |
| `node dist/index.js --version` | 3.12.0 |
| `node dist/index.js --help` | exits 0 |
| `import("./dist/browser/client.js")` | ok (no ERR_REQUIRE_ESM) |
| `repl-supervisor shutdown` | `{"event":"ready"}` + `{"id":"r1","result":"ok"}` |
| `npm pack` + tmp install | 3.12.0 + plugin-api bundled |

## Channels verification

Pre-push (CI запустится на push тега).

## Известные ограничения / отложено

**Out of scope для 3.12.0, трекаются в 3.13.x:**

1. **Open `Platform` union** — `string` ID. Breaking change ~50+ switch-by-
   platform сайтов. Только при major bump (4.0.0).
2. **Полная миграция 25 `*-tools.ts`** на defineTool. Сейчас только
   `system-tools.ts`. Остальные 24 продолжают работать через legacy
   ToolDefinition path. Миграция инкрементальная по 5 файлов на коммит.
3. **107 callsites `getAndroidClient/getIosClient/...`** → `getAdapter` +
   capability guards. Инфраструктура готова, миграция точечная.
4. **Регистрация tools в `Plugin.init()`** через `ctx.registerTool`. Сейчас
   `Plugin.init()` пустой у платформенных плагинов; tools регистрируются
   централизованно из `src/index.ts`. Перенос требует расщепления meta-tool
   слоя по плагинам.
5. **Декомпозиция god objects:** `desktop/client.ts` (966 LOC),
   `adb/client.ts` (776), `flow-tools.ts` (761), `sync-tools.ts` (757),
   `performance-tools.ts` (713), `recorder-tools.ts` (710). Каждый —
   отдельный surgical split.
6. **`release.yml` matrix parametrisation** — платформы в `env.TARGETS`.
7. **npm split** — `@claude-in-mobile/core` + опциональные
   `@claude-in-mobile/plugin-<id>`.
8. **Декларативный DSL для `tools/meta/*-meta.ts`** — 19 файлов с ~90%
   дублированием.

## Lessons learned

1. **Phase 4 ловушка:** перенос регистрации tools из `index.ts` в
   `Plugin.init()` концептуально прост, но meta-tools (device/screen/etc.)
   кросс-платформенные, не привязаны к плагину. Нужен отдельный
   `BuiltinToolsPlugin` для централизованной регистрации, ИЛИ расщепление
   meta-tools на platform-tools — оба варианта = breaking changes в MCP
   surface. Отложено.
2. **zod v4 + zod-to-json-schema несовместимы** (последний поддерживает
   только v3). zod v4 имеет встроенный `z.toJSONSchema()` — пользоваться
   им. `zod-to-json-schema` deps не нужен.
3. **runToolSafely должен re-throw MobileError**, иначе ломаются тесты
   которые проверяют `await expect(handler(...)).rejects.toThrow(MobileError)`.
   Только unknown errors конвертируются в errorResult.
4. **`packages/lite/package.json` workspace dep:** npm не поддерживает
   `workspace:` протокол. Wildcard `"*"` остаётся — пин `^3.12.0` не
   работает до публикации main пакета. Workspace install справляется,
   но в публичном npm dep будет указывать на latest. Решение в 3.13:
   опубликовать lite как полностью отдельный пакет с pinned dep.
