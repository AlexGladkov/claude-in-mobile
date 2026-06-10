# Research: Abstraction / Plugin-ability / Scalability

**Date:** 2026-06-09
**Branch:** release/3.12.0
**Hypothesis:** много дублирования кода, god objects, мало интерфейсов, много хардкодов.
**Verdict:** Частично подтверждено. После D5 (commit 5357f78) крупные god-объекты раздроблены, но всплыл **второй слой**: дублирование схем в tool-handlers, captured platform-switches в обход adapter ISP, и shared mutable singletons блокирующие multi-session.

---

## Inventory (после D5)

### TypeScript >300 LOC (production, не тесты)
| File | LOC | Заметка |
|---|---|---|
| `src/adb/ui-parser.ts` | 954 | Самый большой. XML parse + scoring + 3 формата вывода в одном файле. |
| `src/device-manager.ts` | 688 | Регресснул назад от заявленных 230. Снова накапливает ответственности. |
| `src/ios/client.ts` | 687 | Платформенный client. |
| `src/desktop/client.ts` | 679 | Был 966 — RPC state machine остался монолитом. |
| `src/tools/recorder-tools.ts` | 666 | Запись + playback + redaction + 11 tool defs + blocklists. |
| `src/adb/client.ts` | 640 | Был 776. |
| `src/browser/client.ts` | 587 | |
| `src/tools/sandbox-tools.ts` | 535 | |
| `src/tools/sensor-tools.ts` | 465 | |
| `src/tools/ui-tools.ts` | 426 | |
| `src/tools/intent-tools.ts` | 398 | |
| `src/tools/autopilot-tools.ts` | 369 | |
| `src/tools/system-tools.ts` | 350 | |

### Rust CLI крупнейшие
- `cli/src/android.rs` 2721 · `cli/src/cli.rs` 1870 · `commands/flow.rs` 1465 · `commands/recorder.rs` 1085 · `cli/src/ios.rs` 1055 · `commands/device.rs` 953.

### Plugin scaffold
- `src/kernel/` — `registry.ts`, `lifecycle.ts`, `external-loader.ts`, `eventbus.ts`.
- `src/plugins/{android,ios,desktop,aurora,web,builtin-tools,repl}/index.ts` — SourcePlugin импл.
- `packages/plugin-api/` — контракты типов.
- ADR в `specs/`, contract-suite в `src/plugins/contract-suite.ts`.

---

## Findings (severity / file:line / issue / abstraction)

| Sev | Category | Where | Issue | Suggested abstraction |
|---|---|---|---|---|
| **High** | Duplication | 16 файлов в `src/tools/*-tools.ts` — `app-tools.ts:8`, `sensor-tools.ts:74`, `intent-tools.ts:97`, … | `z.enum(["android","ios","desktop","aurora","browser"])` + `deviceIdField` переобъявлены 16 раз. Новая платформа = 16 правок. | `tools/common-schema.ts`: `platformEnum` derived from `BUILTIN_PLATFORMS` (`device-manager.ts:58`). |
| **High** | Missing abstraction | `system-tools.ts:100`, `intent-tools.ts:160/166/240`, `sensor-tools.ts:109`, `performance/common.ts:44/57/62` (23 сайта) | Цепочки `if (platform === "android") ... else if ("ios") ...`. Adapter ISP (`adapters/platform-adapter.ts:97`) уже предоставляет capabilities `hasAppManagement`/`requireShell` — tool-слой их игнорирует. | `dispatchByPlatform({android, ios, unsupported})` + capability-checks. Заменяет 23 ветвления table lookup-ами. |
| **High** | God object | `src/adb/ui-parser.ts:1-954` | Regex parse + element scoring + semantic compaction + formatter — всё в одном. | Split: `node-parser.ts` / `element-builder.ts` / `formatters/{semantic,compact,full}.ts`. Strategy для формата. |
| **High** | Plugin friction | `src/plugins/builtin-tools/index.ts:54-72` (20 хардкод-импортов `xMeta`) + `:112-133` (литерал `Record<string,ToolDefinition>`) | Новый meta-tool требует правок в builtin-tools, profiles, registry, aliases. Discovery нет. Friction **8/10**. | Self-registration: `meta/*-meta.ts` экспортит `{ meta, aliases, profile, category }`, builtin-loader = 30 строк. Или `ctx.registerMetaTool()` на `PluginContext`. |
| **High** | Scalability bottleneck | `recorder-tools.ts:34` (`let activeRecording`), `tools/registry.ts:18-40` (`toolMap`/`aliasMap`/`frozen`), `tools/context/shared-state.ts:11-20` (4 module-level `Map`) | Process-singletons. Вторая MCP-сессия разделит recording state, last-screenshot cache, registry mutex. Multi-session невозможна. | `Session` / `RuntimeContext` — registry + recorder + caches как поля. `handleTool` резолвит сессию из request metadata. |
| **Medium** | Duplication | `recorder-tools.ts:38-62` — `RECORDING_BLOCKLIST` + `PLAYBACK_BLOCKED_ACTIONS` | Хардкод-списки имён tools, дублируются и расходятся при добавлении нового tool. | Metadata в самом tool def: `defineTool({ name, sensitive: true, recordable: false })`. Recorder читает registry. |
| **Medium** | Hardcodes | `intent-tools.ts:33-39` (`FLAG_ACTIVITY_*`), `sensor-tools.ts:53-68` (battery/thermal коды), `index.ts:73-78` (`RETRY_CONFIG`), `browser-tools.ts:198` / `ui-tools.ts:66` (`maxChars: 15_000`) | Магические числа и платформенные таблицы внутри handlers. `src/constants/` уже имеет `timeouts.ts` — паттерн есть, не используется. | Вынести в `constants/android.ts`, `constants/truncation.ts`, `runtime/retry-policy.ts` (data-driven error→policy map). |
| **Medium** | Scattered enum | `BUILTIN_PLATFORMS` в `device-manager.ts:58`, но 16 meta-tools реруют список вручную | Single source of truth нарушен. | Derive Zod enum из `BUILTIN_PLATFORMS`; plugins расширяют через `unionWith(plugin.platforms)`. |
| **Medium** | Duplication | `device-manager.ts:688` — по методу на `get<Platform>Client()`, 125 вызовов в `src/tools` | Сам паттерн — switch по платформе внутри DeviceManager. | `adapterFor(platform).asXxx()` или `getClient<T>(platform, capability)` с discriminated union. Handlers перестают знать конкретные client-классы. |
| **Low** | God object | `device-manager.ts:1-688` | Routing + kernel adapter + client cache + device lookup. | Extract `KernelDeviceLocator` / `ClientCache` / `DeviceResolver`. |
| **Low** | God object | `recorder-tools.ts:1-666` | Capture + playback + scenario CRUD + redaction + 11 tool defs. | Split `recorder/{state,redaction,playback,tools}.ts`. |

---

## Top-5 рефакторинг-таргеты (приоритет)

1. **`tools/common-schema.ts` + derive `platformEnum` из `BUILTIN_PLATFORMS`.** High ROI, low risk. Один файл, удаляет ~80 строк в 16 tool-файлах, разблокирует third-party платформы.
2. **`dispatchByPlatform` helper + удалить platform-if-chains.** Adapter ISP уже сделан — tools-слой его игнорирует. 23 ветвления → table-lookup. Унифицирует "platform not supported" сообщения.
3. **Meta-tool self-registration.** Заменяет 20 хардкод-импортов в `BuiltinToolsPlugin.init`. Friction плагина 8/10 → 3/10.
4. **`Session` / `RuntimeContext`.** Предусловие multi-session, testability, удаления `let frozen` / `let activeRecording`. Big-bang — после 1-3.
5. **`ui-parser.ts` split + Strategy formatters.** 954 LOC → 4 файла. Парсинг и форматирование независимы — добавление новых компактных форматов без правок regex.

---

## Что уже хорошо

- D5/D4 (3.12.0) реально раздробили 5 god-объектов — `flow-tools` 756→6, `sync-tools` 711→26, `performance-tools` 639→28 LOC.
- Plugin-API + kernel + contract-suite на месте, ADR-0002 определяет инварианты.
- Adapter pattern + 20+ интерфейсов, наследования нет — composition over inheritance работает.
- `constants/timeouts.ts` показывает что centralization-паттерн уже существует — его надо просто расширить.

## Что плохо

- Plugins **не владеют регистрацией tools** — реальная регистрация в `BuiltinToolsPlugin` через хардкод-импорты.
- Module-level mutable state (`let activeRecording`, registry mutex, last-screenshot maps) — multi-session нереализуема.
- Список платформ существует в двух+ местах: `BUILTIN_PLATFORMS` и 16 enum-литералов.
- `if (platform === ...)` в handlers — adapter ISP обходится.
