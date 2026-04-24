# AI Test Autopilot — Report
Дата: 2026-04-24
Релиз: v3.6.0, Feature 3/3

## Описание
AI Test Autopilot — скрытый модуль для автоматического исследования приложений, генерации тестовых сценариев и самовосстановления сломанных тестов.

## Research (Консилиум)
- **Архитектор**: explorer engine (BFS/DFS/smart), nav-graph, screen fingerprinting, generator, healer. Реюз существующих analyzeScreen(), findBestMatch(), ScenarioStore
- **API Designer**: 5 actions (explore/generate/heal/status/tests), ExplorationStore, интеграция с flow_run
- **Security**: blocklist деструктивных элементов, dry-run, confidence thresholds, ограничение графа, санитизация путей

## Реализация

### Новые файлы (10)
- `src/autopilot/types.ts` — Типы: ScreenNode, NavigationEdge, NavigationGraphData, ExplorationResult, GeneratedTest, HealingResult, DESTRUCTIVE_PATTERNS
- `src/autopilot/screen-fingerprint.ts` — SHA-256 fingerprinting экранов по элементам
- `src/autopilot/nav-graph.ts` — NavigationGraph class (addScreen, addEdge, getAllPaths, toJSON/fromJSON)
- `src/autopilot/explorer.ts` — Explorer engine с BFS/DFS/smart стратегиями, blocklist, dryRun
- `src/autopilot/generator.ts` — Генерация flow_run/steps тестов из навигационного графа
- `src/autopilot/healer.ts` — Self-healing через fuzzy matching (Levenshtein, className, bounds proximity)
- `src/utils/exploration-store.ts` — Персистентное хранение в .test-explorations/ с санитизацией
- `src/tools/autopilot-tools.ts` — 5 обработчиков (explore, generate, heal, status, tests)
- `src/tools/meta/autopilot-meta.ts` — Мета-тул через createMetaTool()
- `src/tools/autopilot-tools.test.ts` — 30 тестов

### Модифицированные файлы (2)
- `src/errors.ts` — 4 новых ошибки: ExplorationNotFoundError, ExplorationLimitError, HealingFailedError, TestGenerationError
- `src/index.ts` — Регистрация hidden module + 5 алиасов (autopilot_explore, autopilot_generate, autopilot_heal, autopilot_status, autopilot_tests)

## Validation
- **TypeScript**: 0 ошибок компиляции
- **Тесты**: 662/662 passing (было 632, +30 новых)
- **Регрессии**: 0

## Безопасность
- Blocklist деструктивных паттернов (delete, remove, logout, sign out, uninstall, format, reset, clear all)
- dryRun режим — анализ без выполнения действий
- Confidence threshold для self-healing (отклонение ниже порога)
- Ограничения графа: maxScreens (20), maxActions (100)
- Санитизация путей файлов, лимит хранилища (100 explorations)

## Статус: Done
