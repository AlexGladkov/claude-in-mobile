# Multi-Device Sync Testing — v3.5.0 Feature 3

**Дата:** 2026-04-24
**Ветка:** release/v3.5.0

## Описание

Координированное тестирование на нескольких устройствах одновременно. Sync groups с ролями, барьерная синхронизация, кросс-девайсные ассерты.

## Итоги Research (консилиум)

6 экспертов параллельно:
- **Архитектор:** отдельный sync engine, in-memory groups, barriers + events
- **Фронтенд:** role-based targeting, barriers inline, cross_assert отдельный action
- **UI-дизайнер:** per-role output blocks, barrier markers `~~`, `PARTIAL` status
- **Безопасность:** TTL на группы, blocklist, proto pollution defense, barrier timeout
- **DevOps:** unit-тесты с моками, лимиты как в flow
- **API-дизайнер:** новый `sync` meta-tool (не расширять flow), 6 actions

## План

6 шагов:
1. Error classes → errors.ts (4 класса)
2. sync-tools.ts — основная реализация (6 actions, barriers, state)
3. sync-meta.ts — createMetaTool wrapper
4. index.ts — регистрация hidden module
5. recorder-tools.ts — blocklist sync tools
6. Tests

## Реализовано

### Новые файлы
- `src/tools/sync-tools.ts` — 6 tool handlers, barrier engine, module state (~450 строк)
- `src/tools/meta/sync-meta.ts` — createMetaTool wrapper
- `src/tools/sync-tools.test.ts` — 26 тестов

### Изменённые файлы
- `src/errors.ts` — +4 error classes: SyncGroupNotFoundError, SyncGroupExistsError, SyncBarrierTimeoutError, SyncRoleNotFoundError. SYNC_BARRIER_TIMEOUT добавлен в RETRYABLE_CODES.
- `src/index.ts` — import syncMeta/syncAliases, registerToolsHidden, registerAliasesWithDefaults
- `src/tools/recorder-tools.ts` — 7 sync tool names добавлены в RECORDING_BLOCKLIST

### Архитектура
- **Hidden module** — `sync` загружается по требованию через `device(action:'enable_module', module:'sync')`
- **6 actions:** create_group, run, assert_cross, status, list, destroy
- **Role-based targeting** — роли (sender/receiver) привязаны к deviceId при создании группы
- **Barrier sync** — barriers inline в steps, Promise-based с timeout
- **In-memory groups** — TTL 5 мин, макс 5 групп, макс 10 ролей
- **Blocklist** — system_shell, browser_evaluate, sync recursion, flow nesting, recorder, install_app, push_file

### Безопасность
- validateBaselineName для имён групп и ролей
- validateDeviceId для deviceId
- FORBIDDEN_KEYS (proto pollution) на step args
- Barrier timeout (30s) предотвращает dangling promises
- TTL auto-destroy (5 мин) предотвращает memory leaks
- Max duration guard (120s) на sync_run
- Blocklist enforcement на каждый step action

## Результаты Validation

- TypeScript: 0 ошибок компиляции
- Тесты: **17 файлов, 555 тестов — ALL PASS**
- Регрессии: нет (529 → 555)
- Новые тесты: 26 (create_group: 6, run: 8, assert_cross: 5, status: 2, list: 2, destroy: 2, TTL: 1)

### Исправления при валидации
- `__proto__` не перечисляется через Object.keys() в V8 → тест заменён на `constructor`

## Статус: Done
