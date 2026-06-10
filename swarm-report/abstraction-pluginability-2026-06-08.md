# Research: Abstraction, Pluginability & Scalability

Date: 2026-06-08
Scope: src/, packages/, .github/workflows/release.yml
Mode: research-only, no code changes.

## TL;DR

Кодовая база **в середине миграции** на микроядро + плагины (ADR 0001/0002).
Каркас правильный (`kernel/`, `plugins/`, `adapters/`, `PluginManifest`,
`LifecycleOrchestrator`, ISP-интерфейсы, contract suite), **но работает
параллельно с легаси-стеком**. Tools всё ещё ходят в
`DeviceManager.getAndroidClient()/getIosClient()/...` напрямую (107 callsites),
`AndroidPlugin.init()` пустой, регистрация tools захардкожена в `src/index.ts`
(19 meta-импортов), `Platform` — closed union, runtime plugin discovery
отсутствует. Phase 2 из заявленных Phase 5.

Главная проблема: **OCP нарушен** — добавление новой платформы (tvOS, kaios)
требует правки 6+ мест в core. Третья сторона не может зарегистрировать
платформу без форка.

---

## 1. God Objects

| Файл | LOC | Что мешает |
|---|---|---|
| `src/adb/ui-parser.ts` | 996 | parse + scoring + filter + redact в одном модуле. Scoring `:733-769` — magic numbers (100/95/80/75/60/40/35) без таблицы |
| `src/desktop/client.ts` | 966 | JSON-RPC + Gradle launcher (`:13`) + permission allowlist (`:54-60`) + log ring (`:402`) + window/clipboard/perf домены |
| `src/adb/client.ts` | 776 | adb exec + text escaping + UI cache + input/keys/screenshot/permission/logs/clipboard |
| `src/tools/flow-tools.ts` | 761 | 4 независимых tool (`flow_run`, `flow_batch`, `flow_parallel`, turbo UI) в одном файле |
| `src/tools/sync-tools.ts` / `performance-tools.ts` / `recorder-tools.ts` | 757 / 713 / 710 | Та же история |
| `src/index.ts` | 599 | bootstrap + 19 meta-импортов (`:31-50`) + dispatcher + retry + MCP wiring |

## 2. Duplication

### Архитектурный уровень
- **107 прямых вызовов** `ctx.deviceManager.getAndroidClient()/getIosClient()/getDesktopClient()/getBrowserClient()/getAuroraClient()` в `src/tools/*.ts`. Tools НЕ полиморфны — switch-by-platform вручную.
- **Каждый client заново реализует** retry/timeout/deviceId-filter/screenshot/ui hierarchy/input/tap/swipe. Общий базовый класс/миксин отсутствует.
- **19 `tools/meta/*-meta.ts`** на 90% дублируют структуру (meta object + alias map). Готовый кандидат на DSL/кодоген.

### Code-level
- **D1** `deviceId + platform` boilerplate — **125+ callsites** (`sensor-tools.ts:109-110`, `system-tools.ts:20-21`, etc.). Один и тот же snippet:
  ```ts
  const deviceId = args.deviceId as string | undefined;
  const platform = (args.platform as Platform | undefined) ?? ctx.deviceManager.getCurrentPlatform();
  ```
- **D2** catch→MobileError — `err instanceof Error ? err.message : String(err)` в ~30 местах (`sensor-tools.ts:128-134`, `system-tools.ts:185-189`, `flow-tools.ts:334,596`).
- **D3** `STABLE_INTERVAL_MS = 300` + retry loop — посимвольный дубль в `screenshot-tools.ts:7-25` и `visual-tools.ts:13-27`.
- **D4** `await new Promise(r => setTimeout(r, ms))` — **15 повторов** (`app-tools.ts:97`, `clipboard-tools.ts:55,97`, `flow-tools.ts:594,611,642`, etc.).
- **D5** `getAndroidClient(deviceId).shell(...)` без общей обёртки — `intent-tools.ts:225,308,367,427`, `sensor-tools.ts:146,166`, `sandbox-tools.ts:146,318`.
- **D6** Battery parse / broadcasts собираются вручную в `sensor-tools.ts:240-285`.

## 3. Missing Abstractions

| Проблема | Где |
|---|---|
| `getAndroidClient()` возвращает **конкретный** `AdbClient` вместо интерфейса. Утечка платформенного API в tools | 107 callsites |
| `PlatformAdapter = intersection of ALL capabilities` (`adapters/platform-adapter.ts:135-140`) помечен `@deprecated`, но используется. ISP объявлен (`hasAppManagement/hasPermissions/hasShell`), но tools его не зовут | вся `tools/` |
| Нет `ToolHandler<P extends Platform>`. Tools — голые функции `(args, ctx) => unknown` (`tools/registry.ts:5-8`) | все tools |
| `AndroidPlugin.init()` **пустой** (`plugins/android/index.ts:48`). Плагин не регистрирует tools — это делает легаси `index.ts` | все plugins |
| `bootstrap.ts:43-50 DEFAULT_BUILTINS` — список захардкожен. Нет динамической загрузки | `runtime/bootstrap.ts` |
| `Platform = "android" \| "ios" \| "desktop" \| "aurora" \| "browser"` — **closed union** (`device-manager.ts:35`). Третья сторона не может объявить `"tizen"` | `device-manager.ts` |

## 4. Hardcodes

### Таймауты разбросаны
- `adb/client.ts:9-10` — 15_000/30_000
- `desktop/client.ts:43-45` — 45_000/5_000/100
- `ios/wda/wda-manager.ts:13-14` — 30_000/120_000
- `ios/wda/wda-client.ts:13` — 10_000
- `kernel/lifecycle.ts:9-10` — 10_000/5_000
- inline: `flow-tools.ts:70` (800ms), `clipboard-tools.ts:55,97`, `performance-tools.ts:227,481`
- Три отдельных «30 секунд»: `MAX_MONITOR_DURATION_MS`, `SYNC_BARRIER_TIMEOUT`, `PLAYBACK_MAX_STEP_TIMEOUT`

### Пути / порты
- `aurora/client.ts:105` — `${process.env.HOME}/.config/audb/current_device`
- `desktop/client.ts:54-60` — `APP_PATH_ALLOWLIST` зашит в коде
- `ios/wda/wda-manager.ts:247` — диапазон портов `8100..8200`

### ADB-команды inline-строками
- `sensor-tools.ts:167` — `appops set com.android.shell android:mock_location allow`
- `system-tools.ts:108` — `am start -a android.intent.action.VIEW -d '${url}'`
- `sensor-tools.ts:239-271` — `dumpsys battery reset|set level|set status`
- `system-tools.ts:277,308` — `pidof -s ${pkg}`

### Magic numbers
- Scoring `ui-parser.ts:733-769` (100/95/80/75/60/40/35/+10) без таблицы коэффициентов
- `flow-tools.ts:31-35` — FLOW_MAX_STEPS=20, FLOW_MAX_DURATION=60000
- `ios/client.ts:297-298` — centerX=200, centerY=400

## 5. Type-safety

- **T1** 125 случаев `args.X as Type` — handler принимает `Record<string, unknown>` и кастует руками. zod не используется на runtime несмотря на наличие `inputSchema`.
- **T2** Production `as any`: `screenshot-tools.ts:230`.
- **T3** Platform branching через `if (platform === "ios")` без discriminated union. Добавление платформы в `Platform` молча компилируется (нет exhaustiveness check).
- **T4** Возврат tool — три формата: `{text}` / `{text, isError:true}` / `{content: [{type:"text", text}]}` (`flow-tools.ts:388,504` vs sensor-tools vs остальные).
- **T5** 70+ `as any` в тестах для подмены `ctx.deviceManager` — нет тестового билдера контекста.
- **N5** JSON Schema `enum: ["android","ios"]` задаётся вручную каждый раз — рассинхрон со `Platform` неизбежен.

## 6. Naming / API inconsistency

- `screen_capture` vs `browser_screenshot` — разные имена для одного действия.
- `tap` (mobile) vs `click` (browser) — нет общей `interact(action, target)`.
- `args.platform` где-то optional, где-то required — нет правила.
- Платформа берётся 3 способами: cast / `getCurrentPlatform()` / inline enum в schema.

## 7. Plugin Architecture (текущее)

**Хорошо:**
- `PluginManifest{id, apiVersion, capabilities, tools?}` + `SourcePlugin{init, dispose?}`
- `LifecycleOrchestrator` с `withTimeout`, идемпотентным dispose, event bus
- `CapabilityResolver` для поиска по capability
- `contract-suite.ts` — обязательные инварианты для каждого плагина
- `DeviceManager.fromKernel()` — bridge без статической зависимости от plugins/**
- `@claude-in-mobile/plugin-api 1.0.0-alpha.0` опубликован отдельно

**Плохо:**
- Плагины **не регистрируют tools** через `ctx.registerTool`. `init()` пустой везде кроме REPL.
- `DEFAULT_BUILTINS` зашит в `bootstrap.ts:43-50`.
- Adapter и Plugin — две дублирующие сущности на текущем этапе.
- `device-manager.ts:103-117` всё ещё знает все 5 платформ напрямую через `new AndroidAdapter/IosAdapter/...`.
- **Runtime discovery отсутствует** — путь `~/.claude-in-mobile/plugins/` закомментирован (ADR 0001 deferred).
- `plugin-api` версии `-alpha.0` — production-зависимость невозможна.

## 8. Scalability — стоимость новой платформы

**Добавить платформу (например `tizen`) сегодня:**
1. Править `Platform` union в `device-manager.ts:35`
2. Конструктор `DeviceManager` + `getTizenClient()`
3. `bootstrap.ts` builtins
4. Все switch-by-platform: `intent/performance/flow/sensor/device-tools.ts`
5. Adapter + Plugin
6. CI release.yml (Homebrew formula, npm бандл, checksums)

**6+ точек правки. Нарушение OCP.** Без форка core — невозможно.

## 9. CI / Distribution

**Хардкоды в release.yml:**
1. `verify-plugin-versions` смотрит только `.claude-plugin` (marketplace.json, plugin.json) — не вся инфра.
2. Homebrew formula — только `darwin-arm64` + `darwin-x86_64`. Linux/Windows нет.
3. `publish-npm` публикует один монолитный пакет `claude-in-mobile` — новые плагины раздувают core.
4. `verify-checksums` ждёт строго два артефакта — третий пройдёт молча.

`packages/claude-in-mobile-lite` зависит от `"claude-in-mobile": "*"` — wildcard ломает воспроизводимые сборки.

Корневой `package.json` **без `workspaces`** — пакеты разрабатываются вручную.

---

## TOP-Recommendations

### Архитектура (HIGH)

1. **Завершить Phase 5 ADR 0002.** Перенести регистрацию tools из `src/index.ts` внутрь `Plugin.init()` через `ctx.registerTool()`. `index.ts` → ~150 LOC bootstrap.
2. **Удалить `getAndroidClient()/getIosClient()/...` из `DeviceManager`.** Заменить на `getAdapter(platform): CorePlatformAdapter` + capability narrowing через type guards. 107 callsites переписать.
3. **Polymorphic tools.** Switch-by-platform в `intent-tools.ts:171/358/371`, `performance-tools.ts:52/65/70`, `sensor-tools.ts:118` заменить на вызовы через `CapabilityResolver`. Нет capability — fail-fast с TypedError.
4. **Open `Platform`.** Поднять из closed union в `string` ID, валидируемый registry. Сторонний плагин объявляет `platform: "tizen"` без правки core.

### Code-level (HIGH/MED)

5. `parseCommonArgs(args, ctx) → {deviceId, platform}` — снимает 125 callsites.
6. `runToolSafely(handler)` HOC + `toMobileError(err, code)` — снимает D2.
7. `defineTool(zodSchema, handler)` адаптер — выкидывает 125 ручных кастов, JSON Schema генерится из zod (фикс N5).
8. `src/constants/timeouts.ts` — single source для всех `_MS` (H1, H4, H5).
9. `src/adb/commands.ts` — `BATTERY.RESET`, `MOCK_LOCATION_GRANT`, `PIDOF(pkg)` (H2, D5/D6, security audit).
10. `src/utils/sleep.ts` — 15 повторов D4.
11. `waitForStableFrame(captureFn, opts)` — снимает D3.
12. `androidShell(ctx, deviceId, cmd)` обёртка — снимает D5.
13. Unified `ToolResult` + `textResult()/errorResult()` — фикс T4, N4.
14. Discriminated union на `Platform` + `assertNever` в switch (T3).
15. Декомпозировать `desktop/client.ts` (966) → `GradleLauncher` + `JsonRpcTransport` + `PermissionAllowlist` + `DesktopState` + `LogRing`. То же для `adb/client.ts` → `AdbExec` + `AdbInput` + `AdbScreenshot` + `AdbLogs` + `UiTreeCache`.
16. Декомпозировать `flow-tools.ts` (761) → `flow-batch.ts` + `flow-run.ts` + `flow-parallel.ts` + `flow-common.ts`. Аналогично sync/performance/recorder.
17. Декларативный DSL для `*-meta.ts` (19 файлов) — один YAML/TS → autogen.

### Distribution (MED)

18. **Implement `ExternalPluginLoader`.** `~/.claude-in-mobile/plugins/<id>/index.js` discovery через `import()`. Проверка manifest через `ApiVersionMismatchError`. Разблокирует ADR 0001.
19. **Publish `@claude-in-mobile/plugin-api` as `1.0.0` stable.** Убрать `-alpha.0`.
20. **Fix `lite` dep.** `"claude-in-mobile": "*"` → конкретная версия или peerDependency.
21. **Параметризовать матрицу в release.yml.** Платформы в `env.TARGETS` или JSON — одно место правки.
22. **Split npm.** `@claude-in-mobile/core` + опциональные `@claude-in-mobile/plugin-<id>`. `npm install core plugin-ios` — меньше зависимостей.

### Низкий приоритет (LOW)

23. Scoring `ui-parser.ts:733-769` → декларативная таблица `{matcher, score}[]` в `ui-scoring.ts`.
24. `Context` test-builder `makeTestContext()` — убрать 70+ `as any` в тестах (T5).
25. Унифицировать naming: `screen_capture` / `interact(action: "tap"|"click", target)`.

---

## Roadmap (предложение)

| Phase | Цель | Объём |
|---|---|---|
| **1. Quick wins** | constants/timeouts.ts, sleep.ts, runToolSafely, parseCommonArgs, ToolResult builder | 1-2 дня. 70% дубликата снято. |
| **2. zod-first tools** | defineTool(schema, handler), миграция 25 *-tools.ts | 3-5 дней. Type-safety end-to-end. |
| **3. Polymorphic tools** | Удалить getAndroidClient/getIosClient, заменить на getAdapter + capability narrowing | 1 неделя. 107 callsites. |
| **4. Phase 5 ADR 0002** | Перенести регистрацию tools в Plugin.init(), очистить index.ts | 1 неделя. |
| **5. Open Platform + external loader** | `Platform: string`, ExternalPluginLoader, plugin-api 1.0.0 | 1 неделя. Third-party разблокированы. |
| **6. Decomposition** | Разбить god objects (adb/desktop/flow/etc.) | 1-2 недели. |
| **7. Distribution split** | `@claude-in-mobile/core` + `@claude-in-mobile/plugin-<id>`, параметризованный CI | 1 неделя. |

Полный объём: **5-7 недель** инкрементальной работы без breaking changes
во внешнем MCP-контракте.

---

## Источники

- architect consilium (TS-pro): архитектурный обзор, god objects, missing abstractions
- developer consilium (TS-pro): code-level duplication, hardcodes, type-safety
- devops consilium: plugin distribution, CI, npm topology
- ast-index + Read по src/, packages/, .github/workflows/release.yml
