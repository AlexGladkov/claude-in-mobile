# Token Optimization v3.4.0

**Дата:** 2026-04-19
**Профиль:** Бизнес-фича
**Статус:** Done

## Описание задачи

Комплексная оптимизация токенов MCP-сервера: снижение overhead'а с ~9,000 токенов/запрос до ~1,500 за счёт консолидации 81 инструмента в 8 meta-tools + 3 опциональных модуля, сокращения описаний, удаления дублирования platform, добавления truncation и динамической загрузки модулей.

## Итоги Research (консилиум)

6 агентов параллельно определили 5 векторов оптимизации:
- **Архитектор:** 81 tool schema = ~9,000 токенов, рекомендация: meta-tool action router
- **Фронтенд:** Описания слишком длинные (~100-200 chars), platform дублируется в 36 tools
- **UI-дизайнер:** Инструкции в описаниях вместо server instructions
- **Security:** Unbounded output (shell, logs, evaluate) = 50-200K token burns
- **DevOps:** CLI vs MCP: CLI выигрывает ~30% по запуску, MCP — по schema overhead
- **API-дизайнер:** Консолидация 81 → 9-12 meta-tools с backward-compat aliases

## План (5 фаз)

1. Response truncation
2. Description shortening + server instructions перенос
3. Platform removal из single-platform tools
4. Meta-tool consolidation: 81 → 11 инструментов
5. Dynamic tool registration: lazy-load browser/desktop/store

## Что реализовано

### Phase 1: Truncation
- **Создан:** `src/utils/truncate.ts` — централизованная утилита (maxChars/maxLines)
- **Применён к:** system_shell, system_logs, browser_evaluate, browser_snapshot, flow_batch

### Phase 2-3: Descriptions + Platform
- Все 81 описание сокращены до <100 chars
- Usage hints перенесены в server instructions
- Platform удалён из inputSchema у 8 single-platform tools

### Phase 4: Meta-tool Consolidation
- **Создано 9 meta-tool файлов:** `src/tools/meta/{device,input,screen,ui,app,system,browser,desktop,store}-meta.ts`
- Каждый использует action router pattern с Map<action, handler>
- 81+ старых имён работают через `registerAliasesWithDefaults` (backward compat)
- `browser-meta.ts` — обработка коллизии `action` param (remapped на `nav`)
- `store-meta.ts` — мульти-провайдер (google/huawei/rustore) с `provider` param
- `flow-tools.ts` — FLOW_ALLOWED_ACTIONS расширен 9 meta-именами
- `index.ts` — полностью переписан для meta-tools

### Phase 5: Dynamic Tool Registration
- **Расширен:** `src/tools/registry.ts` — hiddenTools Set, registerToolsHidden, unhideTools, hideTools, getModuleStatus, setToolListChangedNotifier
- `getTools()` фильтрует hidden tools
- Chain resolution: alias → aliasWithDefaults → meta tool
- `device-meta.ts` — добавлены actions: enable_module, disable_module, list_modules
- `index.ts` — browser/desktop/store регистрируются hidden, notifier подключён к MCP notifications
- Capabilities: `tools: { listChanged: true }`

### Прочее
- `client-adapter.ts` — instructions обновлены под meta-tools
- `package.json` — version 3.4.0
- Тесты расширены: +7 новых тестов (chain resolution, dynamic registration)

## Файлы (созданные / изменённые)

| Файл | Действие |
|------|----------|
| `src/utils/truncate.ts` | Создан |
| `src/tools/meta/device-meta.ts` | Создан |
| `src/tools/meta/input-meta.ts` | Создан |
| `src/tools/meta/screen-meta.ts` | Создан |
| `src/tools/meta/ui-meta.ts` | Создан |
| `src/tools/meta/app-meta.ts` | Создан |
| `src/tools/meta/system-meta.ts` | Создан |
| `src/tools/meta/browser-meta.ts` | Создан |
| `src/tools/meta/desktop-meta.ts` | Создан |
| `src/tools/meta/store-meta.ts` | Создан |
| `src/index.ts` | Переписан |
| `src/tools/registry.ts` | Расширен |
| `src/tools/registry.test.ts` | Расширен (+7 тестов) |
| `src/client-adapter.ts` | Обновлён |
| `src/client-adapter.test.ts` | Обновлён |
| `src/tools/system-tools.ts` | Изменён |
| `src/tools/browser-tools.ts` | Изменён |
| `src/tools/flow-tools.ts` | Изменён |
| `src/tools/interaction-tools.ts` | Изменён |
| `src/tools/screenshot-tools.ts` | Изменён |
| `src/tools/ui-tools.ts` | Изменён |
| `src/tools/device-tools.ts` | Изменён |
| `src/tools/app-tools.ts` | Изменён |
| `src/tools/clipboard-tools.ts` | Изменён |
| `src/tools/permission-tools.ts` | Изменён |
| `src/tools/desktop-tools.ts` | Изменён |
| `src/tools/store-tools.ts` | Изменён |
| `src/tools/huawei-tools.ts` | Изменён |
| `src/tools/rustore-tools.ts` | Изменён |
| `package.json` | version 3.3.0 → 3.4.0 |

## Результаты Validation

- **Build (tsc):** OK — 0 ошибок
- **Tests:** 149/149 пройдены (5 файлов)
- **--init claude-code:** Valid JSON output
- **--init opencode:** Valid JSON output

## Экономия токенов (оценка)

| Вектор | Экономия (токенов/запрос) |
|--------|--------------------------|
| Meta-tool consolidation (81→8+3) | ~7,500 |
| Dynamic loading (browser/desktop/store hidden) | ~1,200 |
| Description shortening | ~500 |
| Platform removal | ~300 |
| **Итого (core tools)** | **~8,000 из ~9,000** |
| Truncation (response) | предотвращает 50-200K token burns |

## Проблемы и откаты

Нет. Все фазы выполнены без откатов.
