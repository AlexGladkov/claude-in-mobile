# Spec: Browser Platform (CDP-based)

Date: 2026-03-03
Author: interview с пользователем

---

## Цель

Добавить поддержку браузера как новой платформы в MCP-сервер `claude-in-mobile`.
Браузер управляется через CDP (Chrome DevTools Protocol) напрямую — без зависимости от Playwright.
Сессии именованы, persistent, аналогично тому, как работает playwright-cli в экосистеме.

---

## Стек / Зависимости

- **chrome-launcher** — запуск системного Chrome/Chromium (headless / headed)
- **chrome-remote-interface** — WebSocket CDP-клиент
- **Persistent profiles** — `~/.claude-in-mobile/browser-profiles/<session-name>/`

---

## Архитектурные решения

### 1. Новая Platform

```typescript
export type Platform = "android" | "ios" | "desktop" | "aurora" | "browser";
```

### 2. Разделение PlatformAdapter на CoreAdapter + SystemAdapter

Текущий `PlatformAdapter` содержит методы, которые неприменимы к браузеру (`shell`, `getLogs`, `launchApp`, `installApp`, `grantPermission` и т.д.).

**Решение:** разделить интерфейс на два:

```typescript
// src/adapters/core-adapter.ts — обязателен для всех платформ
interface CoreAdapter {
  platform: Platform;
  listDevices(): Device[];
  selectDevice(deviceId: string): void;
  getSelectedDeviceId(): string | undefined;
  autoDetectDevice(): Device | undefined;
  tap(x, y, targetPid?): Promise<void>;
  doubleTap(x, y, intervalMs?): Promise<void>;
  longPress(x, y, durationMs?): Promise<void>;
  swipe(x1, y1, x2, y2, durationMs?): Promise<void>;
  swipeDirection(direction): Promise<void>;
  inputText(text, targetPid?): Promise<void>;
  pressKey(key, targetPid?): Promise<void>;
  screenshotAsync(compress, options?): Promise<{data, mimeType}>;
  getScreenshotBufferAsync(): Promise<Buffer>;
  screenshotRaw(): string;
  getUiHierarchy(): Promise<string>;
}

// src/adapters/system-adapter.ts — опционален (только mobile/desktop)
interface SystemAdapter extends CoreAdapter {
  launchApp(packageOrBundleId): string;
  stopApp(packageOrBundleId): void;
  installApp(path): string;
  grantPermission(pkg, permission): string;
  revokePermission(pkg, permission): string;
  resetPermissions(pkg): string;
  shell(command): string;
  getLogs(options): string;
  clearLogs(): string;
  getSystemInfo(): Promise<string>;
}
```

- `AndroidAdapter`, `IosAdapter`, `DesktopAdapter`, `AuroraAdapter` → реализуют **SystemAdapter** (обратная совместимость — SystemAdapter extends CoreAdapter)
- `BrowserAdapter` → реализует только **CoreAdapter**
- `PlatformAdapter` = `CoreAdapter | SystemAdapter` (union type для DeviceManager)

Функция-гард для проверки:
```typescript
function isSystemAdapter(a: CoreAdapter): a is SystemAdapter
```

### 3. Именованные сессии

- Сессия = имя (string) → `{ browser: Chrome instance, page: CDP Page, profileDir: string }`
- `Map<string, BrowserSession>` в `BrowserClient`
- Дефолтное имя сессии: `"default"`
- Persistent profile: `~/.claude-in-mobile/browser-profiles/<session-name>/`

### 4. Жизненный цикл браузера

- Браузер **запускается лениво** при первом browser_open / первом вызове любого browser_* инструмента
- **Закрывается** при `browser_close(session?)` или при `set_target(другая платформа)` → закрываются ВСЕ сессии
- При завершении MCP-сервера (SIGTERM/SIGINT) — cleanup закрывает все браузеры

### 5. tap на браузере

`tap(x, y)` реализован через `Input.dispatchMouseEvent` (CDP) — native mouse click по координатам. Это самый надёжный и быстрый способ (нет DOM-запросов, работает с canvas).

### 6. Ref-система для snapshot

`browser_snapshot()` делает:
1. `Runtime.evaluate` — обходит DOM, строит aria-like дерево интерактивных элементов
2. Каждому элементу присваивает ref (`e1`, `e2`, ...)
3. Сохраняет `Map<ref, uniqueSelector>` в памяти per-session
4. Возвращает текстовое дерево вида:
```
button "Login" [e1]
input "Email" [e2]
link "Forgot password" [e3]
```

`browser_click(ref='e1')` → резолвит selector из Map → `Runtime.evaluate("document.querySelector(...).click()")`

Рефы инвалидируются при новом `browser_snapshot()` или при навигации.

### 7. wait_for

- `browser_open` и `browser_navigate` ждут `domcontentloaded` (быстро)
- Отдельный инструмент `browser_wait_for_selector(selector, timeout?)` для SPA

### 8. evaluate JS

Полный `Runtime.evaluate` без ограничений — максимальная надёжность для автоматизации.

---

## Инструменты

### Управление сессиями

| Инструмент | Параметры | Описание |
|---|---|---|
| `browser_open` | `url, session?, headless?` | Открыть URL в сессии. Запускает браузер если нет. |
| `browser_close` | `session?` | Закрыть сессию (или все если session не указан) |
| `browser_list_sessions` | — | Список активных сессий с URL и заголовком |

### Навигация

| Инструмент | Параметры | Описание |
|---|---|---|
| `browser_navigate` | `url, session?` | Перейти по URL в сессии |
| `browser_back` | `session?` | Назад |
| `browser_forward` | `session?` | Вперёд |
| `browser_reload` | `session?` | Перезагрузить |
| `browser_wait_for_selector` | `selector, timeout?, session?` | Ждать элемент |

### Взаимодействие

| Инструмент | Параметры | Описание |
|---|---|---|
| `browser_click` | `ref?, selector?, text?, session?` | Клик по элементу (ref из snapshot, CSS selector, или текст) |
| `browser_fill` | `ref?, selector?, text, session?` | Заполнить input |
| `browser_press_key` | `key, session?` | Нажать клавишу (Enter, Tab, Escape, ...) |

### Инспекция

| Инструмент | Параметры | Описание |
|---|---|---|
| `browser_snapshot` | `session?` | Aria-like snapshot с ref-ами интерактивных элементов |
| `browser_screenshot` | `session?, fullPage?` | Скриншот страницы |
| `browser_evaluate` | `expression, session?` | Выполнить JavaScript, вернуть результат |

### Через существующие инструменты (работают на browser платформе)

| Инструмент | Реализация в BrowserAdapter |
|---|---|
| `screenshot()` | `browser_screenshot` текущей активной сессии |
| `tap(x, y)` | `Input.dispatchMouseEvent` по координатам |
| `get_ui()` | `browser_snapshot` текущей активной сессии |
| `input_text(text)` | `Input.insertText` CDP |
| `press_key(key)` | `Input.dispatchKeyEvent` CDP |

---

## Файловая структура

### Новые файлы

```
src/browser/
  client.ts          — BrowserClient: CDP wrapper, управление Chrome instances
  session.ts         — BrowserSession type, SessionManager
  snapshot.ts        — DOM→aria snapshot + ref-система
  index.ts           — exports
src/adapters/
  core-adapter.ts    — CoreAdapter interface (новый)
  system-adapter.ts  — SystemAdapter interface (новый, extends CoreAdapter)
  browser-adapter.ts — BrowserAdapter implements CoreAdapter
src/tools/
  browser-tools.ts   — все browser_* инструменты
```

### Изменяемые файлы

```
src/adapters/platform-adapter.ts  — удалить, заменить на core-adapter.ts + system-adapter.ts
src/adapters/android-adapter.ts   — implements SystemAdapter
src/adapters/ios-adapter.ts       — implements SystemAdapter
src/adapters/desktop-adapter.ts   — implements SystemAdapter
src/adapters/aurora-adapter.ts    — implements SystemAdapter
src/device-manager.ts             — добавить BrowserAdapter, Platform | "browser", cleanup
src/index.ts                      — registerTools([...browserTools])
package.json                      — +chrome-launcher, +chrome-remote-interface
```

---

## Безопасность

- `browser_evaluate` — полный доступ к JS без ограничений (MCP-сервер локальный, доверенная среда)
- Persistent profiles хранятся в `~/.claude-in-mobile/` — вне рабочей директории проекта
- CDP подключение — только localhost (не экспонируется наружу)

---

## Граничные случаи

| Ситуация | Поведение |
|---|---|
| Chrome не установлен | Понятная ошибка с инструкцией по установке |
| Сессия не найдена | Авто-создание с `about:blank`, ошибка с подсказкой |
| Ref устарел (после navigation) | Ошибка "Ref stale, call browser_snapshot first" |
| Selector не найден | Ошибка с текстом selector и предложением вызвать snapshot |
| Таймаут wait_for_selector | Ошибка с текстом selector и timeout |
| set_target('android') пока открыт браузер | Все browser-сессии закрываются, Chrome завершается |

---

## Обратная совместимость

- Все существующие инструменты (tap, screenshot, get_ui, ...) продолжают работать на android/ios/desktop/aurora без изменений
- DeviceManager использует type guard `isSystemAdapter()` перед вызовом системных методов
- `PlatformAdapter` = `CoreAdapter` (алиас для обратной совместимости где нужно)
