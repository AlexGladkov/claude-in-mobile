# Design: Telegram bot-testing target (`@mcp-devices/plugin-telegram`)

Дата: 2026-06-28 · Консилиум: architect (typescript-pro), security (security-engineer), api (api-designer), devops (devops-orchestrator)

## Цель

Автотест Telegram-ботов без ручного протыкивания + зацикливание сценариев.
Новый таргет `telegram` рядом с android/ios/desktop/browser/aurora.

## Решения (зафиксированы)

| Вопрос | Решение |
|---|---|
| Слой теста | Black-box e2e через **MTProto userbot** (бот-в-бот в TG запрещён → единственный реальный путь) |
| Драйвер | **GramJS** (`telegram` npm) — тот же Node-рантайм, внутри плагина |
| Окружение | **Test DC** для loop/CI (программная регистрация, фейк-телефон, без SMS) + выделенный **prod throwaway** для smoke |
| Identity | **Framework-owned disposable**, личный аккаунт пользователя НЕ трогается никогда. Владелец бота даёт только `@username`/токен |
| Упаковка | On-demand плагин (как aurora: `mcp-devices install telegram`) |

## Архитектура (согласие 4/4)

- Пакет `packages/plugin-telegram/` зеркалит `plugin-aurora`: `index.ts` (manifest+adapter+init), `telegram-adapter.ts` (CorePlatformAdapter), `gram-client.ts`, `session-store.ts`, `conversation-tree.ts`, `identity.ts`.
- Мост `adaptersFromKernel` (`src/device/kernel-device-locator.ts:39`) подхватывает `plugin.adapter` по `manifest.id="telegram"` — **без правки ядра**.
- Платформа `telegram` НЕ добавляется в `BUILTIN_PLATFORMS` — регистрируется как плагин. Тип `Platform` (открытый, `platform-types.ts:25`) это уже разрешает.

### Conversation как ui-tree (ключевой приём)

Диалог сериализуется в **синтетические `UiElement`**: каждое сообщение/кнопка получает `index`/`text`/`resourceId`(=ref)/синтетический `bounds`. Тогда `ui_tree`/`ui_find`/`ui_wait`/`ui_assert_*`/`flow_*`/`input_tap(text|index|resourceId)` работают **без правок ядра**.

```
ConversationSnapshot (root, peer=@bot)
├─ message m1 (bot, "Choose:")
│   ├─ button b1 (callback, "Yes", data:"yes")
│   └─ button b2 (callback, "No",  data:"no")
├─ message m2 (me, "Yes")
└─ message m3 (bot, "Done")  reply-kb: [b3 /start] [b4 /help]
```

`tapButton{ref:"b1"}` → callback → `messages.getBotCallbackAnswer`; reply-кнопка → `sendMessage(text)`. Транспортная разница спрятана в адаптере.

**ВОЗРАЖЕНИЕ (зафиксировано):** НЕ тащить через координатный `tap(x,y)` — только ref-based, иначе хрупкий костыль, ломающийся при ре-флоу диалога.

## Маппинг на verbs

| Verb | TG | Изменения |
|---|---|---|
| `device_connect` (новый, generic) | login сессии + target bot, `dc:test\|prod` | новый verb ИЛИ через адаптерный `autoDetectDevice()` synthetic device — развилка |
| `ui_tree` | снапшот диалога (последние N msg + кнопки) | без изменений (синтет. UiElement) |
| `input_text` | отправить текст/команду | без изменений |
| `input_tap` | нажать кнопку по text/index/resourceId | без изменений |
| `ui_wait` | ждать новый ответ бота | **расширить** опц. полями: `newMessage`, `buttonText`, `media`, `settleMs` |
| `ui_assert_*` | проверить текст/кнопку/медиа | **расширить** опц. полями: `scope:lastBot`, `buttonText`, `buttonCount`, `media`, `edited`, `alert` |
| `screen_capture` | рендер диалога | v1: throw/опционально (текст дёшев через ui_tree); рендер медиа позже |
| `flow_run/batch`, `repeat.until_*` | сценарий + «жми Далее пока не Готово» | без изменений |

Новые TG-specific: `input_send_media/contact/location`.

## ⚠️ ОБЯЗАТЕЛЬНАЯ правка ядра (разрешённый конфликт)

Тип `Platform` открыт, но **zod-схемы закрыты** → первый plugin-платформенный таргет в это упирается:
1. `src/tools/device-tools.ts:6` — локальный хардкод `z.enum(["android","ios","desktop","aurora","browser"])`. Блокер: `device_*{platform:"telegram"}` отклонится до DeviceManager.
2. `src/tools/common-schema.ts` — общий `platformEnum` из `BUILTIN_PLATFORMS` (статичный, НЕ из plugin-реестра).

→ Сделать `platformEnum` динамическим: `z.string()` + рантайм-валидация против installed-адаптеров `DeviceManager`. Чинит telegram и любой будущий tizen. **Одна правка на всю plugin-модель.**

## Security — hard-требования (gate на мёрж)

1. **Секреты только env + home-`0o600`.** `TELEGRAM_API_ID/API_HASH/STRING_SESSION` из `process.env` (CI secrets) ИЛИ `~/.mcp-devices/telegram/<session>/session` с `FILE_MODE 0o600`/`DIR_MODE 0o700` + `validatePathContainment` (зеркало `baseline-store.ts`). Ничего в дереве проекта, ничего в git.
2. **Redaction в коде (load-bearing).** `src/utils/sanitize.ts::sanitizeErrorMessage` сейчас НЕ ловит StringSession (голый base64) и bot-token. Добавить правила: bot-token `\d{8,10}:[A-Za-z0-9_-]{35}` и base64-auth блобы. GramJS-логгер → `none`. Session-объект не логировать никогда.
3. **Fail-closed изоляция prod.** Дефолт test DC. Prod только при `TELEGRAM_ALLOW_PROD=1` + отдельный `TELEGRAM_PROD_STRING_SESSION`. Sanity-ассерт DC-endpoint перед первым действием. Маркер режима в `<session-id>` (`test-dc-*`/`prod-*`). CI не содержит prod-session в принципе.
4. **FLOOD_WAIT-aware.** Ловить `FloodWaitError`, спать `e.seconds` с cap (>300с → fail, не спать полчаса). Loop/soak/CI — ТОЛЬКО test DC. Prod — единичный smoke вне цикла.
5. **Disposable identity — инвариант.** Нет кодового пути, принимающего реальный номер юзера. Auto-provision прибит к test-DC ветке (prod-ветка не имеет регистрации). От владельца бота — только `@username`/публичный токен.

**НЕ шипить в v1:** prod по умолчанию; кастомное at-rest шифрование (остаёмся на `0o600` как playwright/baseline); приём чужого StringSession как входа; авторегистрацию на prod DC; multi-account/2FA-менеджмент.

**Threat model:** StringSession = полный бессрочный доступ к аккаунту в обход 2FA (CRITICAL, но disposable identity снижает blast radius до bounded). Векторы: случайный коммит, CI-логи, home-sync (iCloud/Dropbox), компрометация CI-секрета.

## DevOps — CI

- **PR-CI (`ci.yml`) НЕ трогает live Telegram.** Юнит-тесты плагина с мок-GramJS попадают в `test` job автоматом (`packages/*/src/**/*.test.ts`).
- Отдельный **`.github/workflows/telegram-e2e.yml`**: триггеры `workflow_dispatch` (inputs: iterations, soak) + `schedule` nightly `0 2 * * *` + `push: main, paths: packages/plugin-telegram/**`. `timeout-minutes: 15`.
- **Auto-provision:** `scripts/telegram-provision.mjs` логинится на test DC (`99966X YYYY` + код = dc_id×5), отдаёт session в память runner'а (`::add-mask::`), НЕ кешируется между runs.
- Секреты GH: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_TEST_BOT_TOKEN`. Phone/code НЕ секреты (детерминированы).
- **Bot-under-test:** in-process spawn (`scripts/telegram-test-bot.mjs &`), без Docker — копирует паттерн `scripts/smoke-e2e.mjs`.
- **E2E:** `scripts/telegram-e2e.mjs` = продолжение `smoke-e2e.mjs` (McpClient spawn → JSON-RPC → отчёт в `swarm-report/`). `upload-artifact if: always(), retention 30d`.
- **Prod guard (3 уровня):** YAML hardcode `TELEGRAM_DC=test` (не параметризовать) + рантайм-throw в `client.ts` если не test без явного opt-in + фейк-телефон физически невалиден на prod (`PHONE_NUMBER_INVALID`). Отдельная job `telegram-prod-smoke` только `if: workflow_dispatch && inputs.target==prod`.

## Looping / сценарии

- Сценарий = массив `FlowStep` → `flow_run`/`flow_batch` (TG-verbs allow-by-default).
- `/loop` + персистентный `./swarm-report/<slug>-e2e-scenario.md` чеклист (устойчив к компактизации): продолжать с первого `[ ]`, каждый цикл `device_connect resetDialog:true` (чистый контекст бота → нет флапов).
- `repeat.until_found:"Готово"` для wizard-флоу.

## /test-telegram skill

Зеркалит `/test-android`: аргументы `[session] [target] [scenario-path] [dc]` (default `dc:test`), недостающее — `AskUserQuestion`. Секреты только из env, НЕ из аргументов, НЕ в отчёт. Выход: `HARNESS_RESULT` (status/passed/failed/failures). Если сессия `needs_login` — стоп с инструкцией (НЕ автологин — security-граница).

## Граничные случаи

FLOOD_WAIT → не ретраить, пауза/fail · timeout бота (typing-then-silence = бот упал) · кнопка пропала (бот edit'нул msg → ui_tree fresh) · callback истёк · url/webapp-кнопка → SKIP (нет браузера) · multi-message ответ → settleMs · параллель на одной сессии → запретить (MTProto не реентерабелен) · `USER_IS_BLOCKED` → BOT_BLOCKED.

## Файлы (точки работы)

Ядро (минимум правок): `src/tools/device-tools.ts:6`, `src/tools/common-schema.ts` (открыть platformEnum) · `src/utils/sanitize.ts` (redaction).
Референсы: `packages/plugin-aurora/*` · `src/utils/baseline-store.ts` (storage 0o700/0o600) · `src/store/app-store-connect.ts` (env-секреты) · `scripts/smoke-e2e.mjs` (e2e-паттерн) · `src/tools/ui/{tree,wait,assert,find}.ts` · `src/tools/flow/*` · `~/.claude/commands/test-android.md`.
Новое: `packages/plugin-telegram/**` · `.github/workflows/telegram-e2e.yml` · `scripts/telegram-{provision,test-bot,e2e}.mjs`.

## Открытые развилки (на след. итерацию)

1. `device_connect` новым generic-verb'ом vs synthetic device через `autoDetectDevice()`.
2. `screen_capture`: throw в v1 vs сразу рендер диалога в PNG.
3. Объём v1: только test-DC (без prod-smoke) первым релизом?
