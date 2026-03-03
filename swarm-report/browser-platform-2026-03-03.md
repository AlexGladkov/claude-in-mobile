# Report: Browser Platform (CDP-based)
Дата: 2026-03-03

## Описание задачи
Реализована поддержка браузера как новой платформы в MCP-сервер claude-in-mobile v2.15.0. Браузер управляется через Chrome DevTools Protocol (CDP) напрямую без Playwright. Реализована система именованных persistent-сессий для изоляции браузерных окон.

## Research (консилиум)

### Архитектура
BrowserAdapter реализует интерфейс PlatformAdapter без разбиения интерфейса на подмножества. Используется stub-паттерн аналогично Desktop и Aurora адаптерам для унификации дизайна.

### DevOps
- Автодетекция Chrome через chrome-launcher
- Параметр handleSIGINT: false для корректной обработки сигналов
- Профили пользователя с правами доступа 0o700 для безопасности
- Зависимости: chrome-launcher + chrome-remote-interface

### UI/UX
- browser_open возвращает snapshot с элементами
- Приоритет разрешения элементов: ref > selector > text
- 4 уровня защиты от stale refs (повторная попытка snapshot, fallback на CSS, fallback на text, ошибка)

### CDP (Chrome DevTools Protocol)
- Accessibility.getFullAXTree() для получения полного дерева доступности
- Input.dispatchMouseEvent для клика по координатам
- Input.insertText для ввода текста
- BackendNodeId + CSS fallback для разрешения элементов

### Security
- Блокировка опасных протоколов: file://, chrome://
- Профили с правами 0o700 (rwx------)
- Очистка orphan Chrome процессов при закрытии сессии

### API Design
- session параметр опциональный (default: "default")
- 7 классов ошибок для различных сценариев
- wait_for_selector с параметром state для различных состояний элемента

## Что реализовано

### Новые файлы
- **src/browser/types.ts** — BrowserSession, RefEntry, BLOCKED_URL_PROTOCOLS, DEFAULT_SESSION
- **src/browser/session-manager.ts** — SessionManager: управление именованными сессиями, профили 0o700, PID/lock файлы
- **src/browser/client.ts** — BrowserClient: запуск Chrome, навигация, getSnapshot (Accessibility.getFullAXTree + refs), click, fill, pressKey, screenshot, evaluate, waitForSelector, close
- **src/browser/index.ts** — barrel export для browser модуля
- **src/adapters/browser-adapter.ts** — BrowserAdapter implements PlatformAdapter: 13 стабов, публичный browser-API
- **src/tools/browser-tools.ts** — 14 MCP-инструментов для браузера

### Изменённые файлы
- **package.json** — версия v2.15.0, добавлены зависимости chrome-launcher и chrome-remote-interface
- **src/device-manager.ts** — Platform += "browser", интеграция BrowserAdapter
- **src/errors.ts** — 5 новых browser error классов
- **src/index.ts** — регистрация browserTools, добавлен SIGHUP handler для cleanup, версия v2.15.0
- **src/tools/flow-tools.ts** — whitelist += 8 browser_* инструментов
- 9 файлов tool-файлов — Platform enum += "browser"

## Validation

### Сборка и тесты
- npm install: ✅ Зависимости установлены
- npm run build: ✅ TypeScript компиляция без ошибок
- npm test: ✅ 129 тестов пройдено

### Live CDP тестирование
- Chrome запуск headless: ✅ Браузер запускается через chrome-launcher
- snapshot: ✅ Полное дерево доступности с refs возвращается
- screenshot: ✅ 15473 байт успешно получен
- evaluate: ✅ JavaScript код выполняется в контексте страницы
- navigate back/forward: ✅ История навигации работает
- close: ✅ Сессия и Chrome процесс корректно закрываются

### Регрессионное тестирование
- Android: ✅ Enum в platform-dependent коде, без регрессий
- iOS: ✅ Enum в platform-dependent коде, без регрессий
- Desktop: ✅ Enum в platform-dependent коде, без регрессий
- Whitelist инструментов: ✅ 8 browser_* инструментов добавлены в flow-tools.ts

## Статус
Done

Браузер как платформа полностью интегрирован в MCP-сервер claude-in-mobile v2.15.0 с поддержкой CDP, именованными сессиями, и всеми необходимыми инструментами для автоматизации.
