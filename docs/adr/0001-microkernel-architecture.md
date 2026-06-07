# ADR 0001: Microkernel Architecture

- Status: Accepted
- Date: 2026-06-07
- Release: 3.11.0

## Context

claude-in-mobile поддерживает несколько платформ-источников (Android, iOS, Desktop, Web,
Aurora) и планирует добавлять новые (REPL, SSH, custom data sources). Текущая структура
работает на ISP-адаптерах, но содержит точки жёсткой связности:

- `type Platform = "android" | "ios" | ...` — закрытое объединение, блокирует runtime
  расширение.
- `DeviceManager` создаёт адаптеры захардкоженным конструктором; `instanceof`-ветки
  повторяются ~15 раз.
- Добавление нового источника требует правок в 6+ файлах (registry, profiles,
  device-manager, meta-tools, Clap value_parsers и т.д.).
- Нет общего contract-теста — каждый адаптер тестируется в изоляции, регрессии в
  межплатформенных инвариантах не ловятся.

При росте числа источников это превращается в комбинаторный взрыв.

## Decision

Принимаем архитектурный стиль **microkernel (plugin-based)**:

1. **Kernel** — минимальное стабильное ядро. Знает про абстрактные `Capability`,
   жизненный цикл плагина, шину событий, регистрацию и резолв инструментов. Не знает
   ничего о конкретных источниках.
2. **Plugins** — все конкретные источники (включая Android/iOS/Desktop/Web/Aurora и
   будущий REPL) равноправны. Каждый плагин — самодостаточный модуль
   `src/plugins/<id>/` с манифестом и декларацией capabilities.
3. **Communication** — плагины не импортируют друг друга. Орчестрация (например
   `flow-tools`) идёт через типизированный event bus и capability resolver ядра.
4. **Contract** — публичный API ядра вынесен в отдельный пакет
   `@claude-in-mobile/plugin-api` с независимым semver. Breaking change в контракте =
   мажорный bump пакета (см. ADR 0002).
5. **Isolation** — для 3.11 плагины запускаются inline (in-tree only). Sandbox для
   third-party — отдельная инициатива, не входит в скоуп этого релиза.

## Consequences

### Положительные

- Добавление нового источника = создание одной директории `src/plugins/<id>/`.
- Удаление плагина = удаление директории; ядро остаётся рабочим.
- Lint/architecture-тесты блокируют циклические импорты и протечки конкретики в ядро.
- Generic contract-suite ловит регрессии у всех плагинов одинаково.
- Версионирование контракта отвязано от версии продукта.

### Отрицательные

- Дополнительный indirection через event bus и capability resolver — debugging
  чуть дороже. Mitigation: `kernel.dumpRegistry()`, trace mode.
- Соблазн преждевременной абстракции в ядре. Правило: если функциональность нужна
  ≥2 плагинам — в kernel; иначе остаётся в плагине.
- Контракт `plugin-api 1.0` после публикации меняется только через major bump.
  Требует тщательного review перед фиксацией.

## Layering rule (enforced)

```
MCP server (src/index.ts)
    │ зависит от
    ▼
Plugins (src/plugins/**)
    │ зависят только от
    ▼
Kernel (src/kernel/**)
    │ зависит только от
    ▼
@claude-in-mobile/plugin-api (packages/plugin-api)
```

Запрещено:

- `kernel/**` → `plugins/**`
- `plugins/<a>/**` → `plugins/<b>/**`
- `plugins/**` → `device-manager.ts` (legacy facade)

Проверка — architecture vitest-тест (`src/__tests__/architecture.test.ts`).

## References

- VSCode Extension API — manifest-driven activation
- Eclipse OSGi — capability/dependency declarations
- esbuild — inline plugin functions, минимальный API surface
- ADR 0002 — Plugin API v1 contract
