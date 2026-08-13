# Implementation Report: Telegram bot-testing target

Дата: 2026-06-29 · Профиль: Бизнес-фича · Ветка: `feature/telegram-target` (от `release/4.0.0-dev`)
Дизайн-источник: [telegram-target-design-2026-06-28.md](./telegram-target-design-2026-06-28.md)

## Задача

Добавить в v4 таргет `telegram` для автотестирования Telegram-ботов: бот-в-бот
прокликивание + зацикливание сценариев. Диалог с ботом = синтетическое UI-дерево,
verbs `ui_tree`/`input_tap`/`input_text`/`ui_wait`/`ui_assert_*` работают без правок ядра verb-слоя.

## Что предшествовало

Прошлый заход дошёл только до дизайн-консилиума (отчёт 2026-06-28) и крашнулся
ДО написания кода. Кода нигде не сохранилось (ни worktree, ни stash, ни reflog) —
дизайн уцелел, реализация начата с нуля.

## Research — ре-валидация дизайна (консилиум 3/3, opus)

Дизайн архитектурно валиден, точки интеграции ядра не поехали после ребрендинга
(`@claude-in-mobile/*` → `@mcp-devices/*` тронул только namespace). Найдено:

- **2 дыры дизайна:** (#1) ref-based tap невозможен — ядро всё схлопывает в `tap(x,y)`
  (`resolve-element.ts:97` → `interaction-tools.ts:66`); (#2) `getUiHierarchy()` отдаёт
  XML-строку, не `UiElement[]` (`ui/tree.ts:46`). Оба закрыты при реализации (см. ниже).
- **Security T1 (критично):** слепое зеркало `baseline-store.ts:53` дефолтит в `cwd` →
  StringSession попал бы в дерево проекта/git. + T3 (redaction снапшота), T4 (`client.start` phone-путь).
- **DevOps:** GramJS ESM/CJS риск (#43-класс) → проверен гейтом ДО кода.

## GramJS gate (риск #43) — ПРОЙДЕН

Изолированный probe: `import('telegram')` v2.26.22 под Node 22 (точный CI-рантайм) —
ESM OK, `TelegramClient`/`StringSession` доступны, `save()`→`""`. `npm audit` = 0 уязвимостей,
11M / 46 транзитивных deps.

## Что реализовано

### Ядро (минимальная правка plugin-модели)
- `src/tools/common-schema.ts` — `platformEnum: z.enum([...])` → `z.string()` (чинит ~28 потребителей);
  валидация делегирована существующему `DeviceManager.getAdapter()`.
- `src/tools/device-tools.ts:6` — локальный `z.enum` → `z.string()`.

### Пакет `packages/plugin-telegram/` (@mcp-devices/plugin-telegram, on-demand как aurora)
- `index.ts` — манифест `id:"telegram"`, caps `ui/input/deviceMgmt`, v `4.0.0-dev`.
- `telegram-adapter.ts` — `CorePlatformAdapter`; `tap(x,y)` декодит `y→кнопку` из кэш-снапшота.
- `conversation-tree.ts` — диалог → uiautomator-XML-строка (дыра #2); **bounds encode/decode** (дыра #1):
  кнопка `i` → `bounds=[0,i*100][1000,i*100+80]`, `floor(centerY/100)=i`, биективно. Тест round-trip i=0..20.
- `gram-client.ts` — GramJS-обёртка, ленивый `import`, logger `NONE`, FloodWait cap 300с, sanitize в catch.
- `session-store.ts` — **home-only** `~/.mcp-devices/telegram/<session>/`, 0o600/0o700, path-containment (T1).
- `identity.ts` — disposable test-DC, prod fail-closed (`TELEGRAM_ALLOW_PROD==="1"`, без phone-пути — T4).

### Security redaction
- `src/utils/sanitize.ts` — +2 правила (bot-token `\d{8,10}:[A-Za-z0-9_-]{32,}`, base64 session `{120,}`),
  порядок specific→broad, ReDoS-чистые. Тесты + проверка в свежем dist (no leak).

### Install wiring (telegram как installable on-demand)
- `platform-config.ts` ALL_PLATFORMS +telegram · `bootstrap.ts` PACKAGED_PLATFORMS +`@mcp-devices/plugin-telegram`
  · `platform-cli.ts` TOOLCHAIN +telegram (`probe:[]`, no native CLI) + usage-строка.
- Побочно починено: root `build` не включал plugin-telegram; отсутствовал node_modules symlink.

### Shipping
- `scripts/publish-4.0.0-dev.sh` — `plugin-telegram` в PLUGINS.
- Skill-доки: `references/telegram.md` (нов.) + `platform-support.md`/`SKILL.md` обновлены.
- CI-скаффолд: `.github/workflows/telegram-e2e.yml` + `scripts/telegram-{provision,test-bot,e2e}.mjs`
  (test-DC hardcode, prod-smoke gated, артефакты 30d). **Live-прогон требует секретов — не запускался.**

## Validation

- `npx tsc --noEmit` — чисто.
- `npx vitest run` — **1282 passed / 52 files** (вкл. plugin-telegram: encode/decode round-trip,
  session-store T1, gram-client мок/FloodWait/prod-gate). Live-сети в тестах нет.
- Runtime smoke: `node dist/index.js --help` exit 0 (риск #44 нет) · плагин ESM round-trip OK ·
  `platformEnum` принимает telegram+android · redaction в свежем dist работает · `platforms` показывает
  telegram в Available · `install telegram` не падает, doctor `ok (no external CLI)`.
- 3 `.mjs` — `node --check` ok; YAML валиден.

## Известные follow-up (НЕ блокируют ядро)

1. **`device_connect` / выбор target-бота — открытая развилка дизайна.** Как адаптер узнаёт
   `@username` тестируемого бота при инициализации плагина в MCP-сервере — не дошито. e2e-скрипт
   временно пробрасывает `TELEGRAM_BOT_USERNAME` через env. Нужен generic `device_connect` verb
   ИЛИ adapter-config механизм. **Это главный пробел до полной usability.**
2. CI live-e2e требует GitHub secrets: `TELEGRAM_API_ID/API_HASH/TEST_BOT_TOKEN` (+ prod session).
   Без них workflow упадёт на provision (ожидаемо, помечено в шапке).
3. Юзер-фейсинг `/test-telegram` skill (зеркало `/test-android`) — global-skill вне репо, не создан.
4. test-DC provision требует `testServers:true` + Bot API `/test/` URL — учтено в скриптах.

## Status: Partial — функциональное ядро Done и провалидировано; live-e2e/skill/device_connect — follow-up.
