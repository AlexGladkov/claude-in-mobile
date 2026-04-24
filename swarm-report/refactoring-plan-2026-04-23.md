# План рефакторинга: claude-in-mobile v3.4.0

Дата: 2026-04-23
Ветка: release/v3.4.0

## Фаза 1: Security fixes (🔴 Critical) — 14 пунктов

### 1.1. flow_batch: добавить проверку FLOW_ALLOWED_ACTIONS
- [ ] 1.1.1. В `src/tools/flow-tools.ts:108` — добавить `if (!FLOW_ALLOWED_ACTIONS.has(cmd.name))` перед `ctx.handleTool()`, бросать MobileError
- [ ] 1.1.2. Тест: flow_batch с system_shell должен выбрасывать ошибку

### 1.2. getLogs(): валидация параметров tag и since
- [ ] 1.2.1. В `src/adb/client.ts:514` — regex-валидация `^[a-zA-Z0-9_.:*-]+$` для tag
- [ ] 1.2.2. В `src/adb/client.ts:525` — regex-валидация формата since
- [ ] 1.2.3. Добавить `validateLogTag()` и `validateLogTimestamp()` в `src/utils/sanitize.ts`

### 1.3. deviceId: валидация формата
- [ ] 1.3.1. Добавить `validateDeviceId(id)` в `src/utils/sanitize.ts` — regex `^[a-zA-Z0-9._:@-]+$`
- [ ] 1.3.2. Вызывать в `src/adb/client.ts:134` (setDevice)
- [ ] 1.3.3. Вызывать в конструкторе `src/adb/client.ts:21`

### 1.4. uninstallApp: добавить validatePackageName
- [ ] 1.4.1. В `src/adb/client.ts:420-422` — validatePackageName перед exec

### 1.5. app_install: валидация пути
- [ ] 1.5.1. В `src/tools/app-tools.ts:57` — validatePath(args.path)

### 1.6. Store tools: validatePackageName + validatePath
- [ ] 1.6.1. store-tools.ts: validatePackageName во всех 7 handlers
- [ ] 1.6.2. store-tools.ts: validatePath в store_upload
- [ ] 1.6.3. huawei-tools.ts: validatePackageName в 4 handlers + validatePath
- [ ] 1.6.4. rustore-tools.ts: validatePackageName в 5 handlers + validatePath

### 1.7. browser_open: централизованная validateUrl
- [ ] 1.7.1. В `src/tools/browser-tools.ts:20-28` — validateUrl перед adapter.open()
- [ ] 1.7.2. В browser_navigate — validateUrl при наличии args.url

### 1.8. Shell command blocklist: расширить
- [ ] 1.8.1. В `src/utils/sanitize.ts:4` — добавить curl, wget, nc, dd, ncat, netcat, [\n\r]
- [ ] 1.8.2. Тесты на новые паттерны

### 1.9. inputText: экранировать newline
- [ ] 1.9.1. В `src/adb/client.ts:261-275` — добавить .replace(/[\n\r]/g, "")

### 1.10. Soft errors -> isError: true (9 мест)
- [ ] 1.10.1-1.10.9. flow-tools.ts (6 мест), interaction-tools.ts (1), store/huawei/rustore-tools.ts (3) — заменить return {text: "Error..."} на throw ValidationError

### 1.11. desktop_launch: валидация
- [ ] 1.11.1. validatePath для projectPath
- [ ] 1.11.2. validateJvmArg для jvmArgs

### 1.12. Google Play JSON.parse с try/catch
- [ ] 1.12.1. В `src/store/google-play.ts:35` — обернуть JSON.parse

### 1.13. Handler-level validatePackageName/validatePermission
- [ ] 1.13.1. app-tools.ts: app_launch, app_stop
- [ ] 1.13.2. permission-tools.ts: grant, revoke, reset

## Фаза 2: Architecture deduplication (🟠 High) — 12 пунктов

### 2.1. context.ts: разделить God File
- [ ] 2.1.1. Создать context/shared-state.ts
- [ ] 2.1.2. Создать context/ios-helpers.ts
- [ ] 2.1.3. Создать context/hints.ts
- [ ] 2.1.4. context.ts = фасад с реэкспортами
- [ ] 2.1.5. Обновить импорты

### 2.2. interaction-tools.ts: извлечь resolveElementCoordinates()
- [ ] 2.2.1. Создать src/tools/helpers/resolve-element.ts
- [ ] 2.2.2. Рефакторить input_tap, input_double_tap, input_long_press, clipboard_paste

### 2.3. ui-tools.ts: извлечь getUiElementsForAssert()
- [ ] 2.3.1. Создать src/tools/helpers/get-elements.ts
- [ ] 2.3.2. Заменить 7 if/else platform dispatching блоков

### 2.4. Meta tools: создать createMetaTool()
- [ ] 2.4.1. Создать src/tools/meta/create-meta-tool.ts
- [ ] 2.4.2. Рефакторить 8 meta-файлов

### 2.5. Store clients: базовый класс AbstractStoreClient
- [ ] 2.5.1. Создать src/store/base-client.ts (api<T>(), streamToBuffer())
- [ ] 2.5.2. Наследовать 3 клиента
- [ ] 2.5.3. Удалить дублированные методы

### 2.6. Store tools: createLazySingleton
- [ ] 2.6.1. Создать src/utils/lazy.ts
- [ ] 2.6.2. Заменить 3 паттерна в store-tools/huawei-tools/rustore-tools

### 2.7. registry.ts: freeze после init
- [ ] 2.7.1. Добавить freezeRegistry()

### 2.8. FLOW_ALLOWED_ACTIONS: из registry динамически
- [ ] 2.8.1. Заменить хардкод на getRegisteredToolNames() - FLOW_BLOCKED_ACTIONS
- [ ] 2.8.2. Добавить getRegisteredToolNames() в registry.ts

### 2.9. Error messages: v3.0 → v3.4 имена
- [ ] 2.9.1. errors.ts: обновить ссылки
- [ ] 2.9.2. ui-tools.ts: обновить hint text
- [ ] 2.9.3. Grep + обновить все устаревшие ссылки

### 2.10. hints default: согласовать = true
- [ ] 2.10.1. interaction-tools.ts: default: true

### 2.11. package vs packageName: задокументировать
- [ ] 2.11.1. Добавить alias packageName → package в app-meta

### 2.12. assert_visible/assert_gone: isError: true при FAIL
- [ ] 2.12.1. ui-tools.ts: добавить isError: true

## Фаза 3: API consistency & typing (🟡 Medium) — 6 пунктов

### 3.1. Type guards вместо `as` casts
- [ ] 3.1.1. Создать src/tools/helpers/args-parser.ts
- [ ] 3.1.2. Применить в 3 самых частотных файлах (~100+ casts)

### 3.2. CDP типизация в browser module
- [ ] 3.2.1. Создать src/browser/cdp-types.ts
- [ ] 3.2.2. Применить в browser/client.ts

### 3.3. catch (error: any) → catch (error: unknown)
- [ ] 3.3.1. Заменить в ~38 местах

### 3.4. Убрать emoji из ui_tap_text
- [ ] 3.4.1. ✅ → OK:, ❌ → FAIL:

### 3.5. Version: single source of truth
- [ ] 3.5.1. index.ts: читать version из package.json

### 3.6. Error messages: sanitize sensitive data
- [ ] 3.6.1. Создать sanitizeErrorMessage() в sanitize.ts
- [ ] 3.6.2. Применить в store clients

## Фаза 4: Tests (⬜) — 4 пункта

### 4.1. Security validation на handler level
- [ ] 4.1.1. app-tools.test.ts
- [ ] 4.1.2. store-tools.test.ts
- [ ] 4.1.3. permission-tools.test.ts

### 4.2. flow_batch security
- [ ] 4.2.1. flow_batch + system_shell → ошибка
- [ ] 4.2.2. flow_batch + input_tap → OK
- [ ] 4.2.3. flow_run + system_shell → ошибка

### 4.3. Error hierarchy
- [ ] 4.3.1. Все subclasses имеют code, name, isRetryable

### 4.4. Sanitize edge cases
- [ ] 4.4.1. Новые blocked patterns
- [ ] 4.4.2. validateDeviceId
- [ ] 4.4.3. validateLogTag, validateLogTimestamp
- [ ] 4.4.4. inputText newline escaping
