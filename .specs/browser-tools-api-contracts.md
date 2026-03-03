# API Contracts: Browser Tools (MCP)

Date: 2026-03-03
Status: Draft
Parent spec: `.specs/browser-platform.md`

---

## Общие конвенции

### session (опциональный, default: "default")

Параметр `session` присутствует почти во всех browser-инструментах. Решение по дизайну:

- **Тип:** `string`
- **Обязательность:** опциональный (`required` НЕ содержит `session`)
- **Default:** `"default"` (применяется на уровне handler, не в JSON Schema)
- **Описание:** одинаковое во всех инструментах для консистентности

Обоснование: в 90% случаев агент работает с одной сессией. Заставлять передавать `session: "default"` каждый раз -- ненужный шум в LLM-контексте. Но для multi-session сценариев (сравнение двух сайтов, тест в разных профилях) -- параметр доступен.

### Формат ответов

MCP-протокол поддерживает три формата content в ответе:

| Тип | Структура handler return | Когда |
|---|---|---|
| text | `{ text: string }` | Все инструменты кроме screenshot |
| image | `{ image: { data: string, mimeType: string }, text?: string }` | browser_screenshot |
| error | `throw new BrowserError(...)` -> `{ text: "Error: ...", isError: true }` | Все ошибки |

### Приоритет таргетирования элементов (browser_click, browser_fill)

Три способа указать элемент: `ref`, `selector`, `text`. Приоритет разрешения (первый найденный):

```
1. ref     -- самый быстрый и надежный, из кеша snapshot
2. selector -- CSS selector, прямой DOM-запрос
3. text    -- поиск по текстовому содержимому, самый медленный
```

Если указано несколько -- используется первый по приоритету. Если не указан ни один -- ошибка.

### Классы ошибок (новые, в src/errors.ts)

```typescript
export class BrowserError extends MobileError {
  constructor(message: string, code: string) {
    super(message, code);
  }
}

export class BrowserNotInstalledError extends BrowserError {
  constructor() {
    super(
      "Chrome/Chromium not found.\n\nInstall Google Chrome or set CHROME_PATH environment variable.",
      "BROWSER_NOT_INSTALLED"
    );
  }
}

export class BrowserSessionNotFoundError extends BrowserError {
  constructor(session: string) {
    super(
      `Browser session "${session}" not found. Use browser_open to create a session or browser_list_sessions to see active sessions.`,
      "SESSION_NOT_FOUND"
    );
  }
}

export class BrowserRefStaleError extends BrowserError {
  constructor(ref: string) {
    super(
      `Ref "${ref}" is stale (page changed since last snapshot). Call browser_snapshot to get fresh refs.`,
      "REF_STALE"
    );
  }
}

export class BrowserSelectorNotFoundError extends BrowserError {
  constructor(selector: string) {
    super(
      `Element not found: "${selector}". Use browser_snapshot to see available elements.`,
      "SELECTOR_NOT_FOUND"
    );
  }
}

export class BrowserNavigationTimeoutError extends BrowserError {
  constructor(url: string, timeoutMs: number) {
    super(
      `Navigation to "${url}" timed out after ${timeoutMs}ms. The page may be slow to load.`,
      "NAVIGATION_TIMEOUT"
    );
  }
}

export class BrowserWaitTimeoutError extends BrowserError {
  constructor(selector: string, timeoutMs: number) {
    super(
      `Timeout waiting for selector "${selector}" after ${timeoutMs}ms. Element may not exist or may be hidden.`,
      "WAIT_TIMEOUT"
    );
  }
}
```

---

## Инструменты: Управление сессиями

### 1. browser_open

Открыть URL в именованной browser-сессии. Если сессия не существует -- запускает Chrome и создает сессию. Если сессия уже существует -- навигирует на указанный URL.

**inputSchema:**

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "URL to open. Must include protocol (https:// or http://)."
    },
    "session": {
      "type": "string",
      "description": "Session name. Each session has its own browser window and persistent profile (cookies, localStorage). Defaults to \"default\"."
    },
    "headless": {
      "type": "boolean",
      "description": "Run browser without visible window. Useful for background automation. Default: false (headed).",
      "default": false
    }
  },
  "required": ["url"]
}
```

**Формат ответа:** text

```
Opened https://example.com in session "default" (headed)
Page title: Example Domain
```

**Семантика:**
- Ждет `Page.domContentEventFired` перед возвратом (не `Page.loadEventFired` -- быстрее на тяжелых страницах)
- Persistent profile: `~/.claude-in-mobile/browser-profiles/<session>/`
- Если Chrome не найден -- `BrowserNotInstalledError`

**Примеры вызова:**

```json
// Минимальный
{ "url": "https://github.com" }

// Именованная сессия, headless
{ "url": "https://example.com/admin", "session": "admin", "headless": true }

// Вторая сессия для сравнения
{ "url": "https://staging.example.com", "session": "staging" }
```

---

### 2. browser_close

Закрыть browser-сессию. Если session не указан -- закрывает ВСЕ сессии и завершает Chrome.

**inputSchema:**

```json
{
  "type": "object",
  "properties": {
    "session": {
      "type": "string",
      "description": "Session to close. If omitted, closes ALL sessions and shuts down the browser."
    }
  }
}
```

**Формат ответа:** text

```
Closed session "default"
```
или
```
Closed all sessions (3 sessions terminated)
```

**Семантика:**
- Закрытие несуществующей сессии -- НЕ ошибка, возвращает `Session "foo" was not active`
- При закрытии последней сессии Chrome process завершается автоматически

**Примеры вызова:**

```json
// Закрыть конкретную сессию
{ "session": "admin" }

// Закрыть все
{}
```

---

### 3. browser_list_sessions

Список активных browser-сессий с URL и заголовком страницы.

**inputSchema:**

```json
{
  "type": "object",
  "properties": {}
}
```

**Формат ответа:** text

```
Active browser sessions (2):
  default: "GitHub" — https://github.com (headed)
  staging: "Staging Admin" — https://staging.example.com/admin (headless)
```
или
```
No active browser sessions. Use browser_open to start one.
```

**Примеры вызова:**

```json
{}
```

---

## Инструменты: Навигация

### 4. browser_navigate

Перейти по URL в существующей сессии. Сессия ДОЛЖНА быть уже открыта через `browser_open`.

**inputSchema:**

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "URL to navigate to. Must include protocol (https:// or http://)."
    },
    "session": {
      "type": "string",
      "description": "Target session. Defaults to \"default\"."
    }
  },
  "required": ["url"]
}
```

**Формат ответа:** text

```
Navigated to https://example.com/dashboard
Page title: Dashboard - Example
```

**Семантика:**
- Ждет `Page.domContentEventFired`
- Инвалидирует ref-кеш сессии
- Если сессия не существует -- `BrowserSessionNotFoundError`
- Если навигация зависла > 30s -- `BrowserNavigationTimeoutError`

**Отличие от browser_open:** `browser_open` создает сессию при необходимости. `browser_navigate` требует существующую сессию. Это намеренное разделение: агент должен явно решать, когда создавать новую сессию (с профилем, headed/headless выбором), а когда навигировать в существующей.

**Примеры вызова:**

```json
{ "url": "https://example.com/settings" }
{ "url": "https://example.com/api/docs", "session": "docs" }
```

---

### 5. browser_back

Навигация назад в истории (эквивалент кнопки "Back" в браузере).

**inputSchema:**

```json
{
  "type": "object",
  "properties": {
    "session": {
      "type": "string",
      "description": "Target session. Defaults to \"default\"."
    }
  }
}
```

**Формат ответа:** text

```
Navigated back
Page title: Home - Example
```

**Семантика:**
- CDP: `Page.navigateToHistoryEntry` с предыдущим entry
- Ждет `Page.domContentEventFired`
- Инвалидирует ref-кеш
- Если нет предыдущей записи в истории: `Cannot go back — no previous page in history`

**Примеры вызова:**

```json
{}
{ "session": "admin" }
```

---

### 6. browser_forward

Навигация вперед в истории.

**inputSchema:**

```json
{
  "type": "object",
  "properties": {
    "session": {
      "type": "string",
      "description": "Target session. Defaults to \"default\"."
    }
  }
}
```

**Формат ответа:** text

```
Navigated forward
Page title: Settings - Example
```

**Семантика:** Аналогично `browser_back`, но в обратном направлении.

**Примеры вызова:**

```json
{}
{ "session": "docs" }
```

---

### 7. browser_reload

Перезагрузить текущую страницу.

**inputSchema:**

```json
{
  "type": "object",
  "properties": {
    "session": {
      "type": "string",
      "description": "Target session. Defaults to \"default\"."
    }
  }
}
```

**Формат ответа:** text

```
Page reloaded
Page title: Dashboard - Example
```

**Семантика:**
- CDP: `Page.reload`
- Ждет `Page.domContentEventFired`
- Инвалидирует ref-кеш

**Примеры вызова:**

```json
{}
```

---

## Инструменты: Взаимодействие

### 8. browser_click

Кликнуть по элементу. Поддерживает три способа таргетирования с явным приоритетом.

**inputSchema:**

```json
{
  "type": "object",
  "properties": {
    "ref": {
      "type": "string",
      "description": "Element ref from browser_snapshot output (e.g. \"e1\", \"e14\"). Fastest and most reliable method — always prefer this when available."
    },
    "selector": {
      "type": "string",
      "description": "CSS selector (e.g. \"#submit-btn\", \".nav-link:first-child\"). Use when ref is unavailable."
    },
    "text": {
      "type": "string",
      "description": "Click element by its visible text content (partial match, case-insensitive). Slowest method — use only when ref and selector are unavailable."
    },
    "session": {
      "type": "string",
      "description": "Target session. Defaults to \"default\"."
    }
  }
}
```

Нет `required` массива -- но handler валидирует что хотя бы один из `ref`/`selector`/`text` указан.

**Формат ответа:** text

```
Clicked [e1] button "Login"
```
или
```
Clicked element matching selector "#submit-btn"
```
или
```
Clicked element containing text "Sign up"
```

**Семантика приоритета:**

```
if ref    -> resolveRef(ref) -> querySelector(cachedSelector) -> element.click()
elif selector -> querySelector(selector) -> element.click()
elif text     -> findByTextContent(text) -> element.click()
else          -> error "Provide ref, selector, or text"
```

Детали:
- `ref`: резолвит CSS selector из `Map<ref, selector>` (кеш snapshot). Если ref не найден в кеше -- `BrowserRefStaleError`
- `selector`: прямой `document.querySelector()`. Если не найден -- `BrowserSelectorNotFoundError`
- `text`: `Runtime.evaluate` с обходом DOM, ищет элемент по `textContent` (partial, case-insensitive). Предпочитает кликабельные элементы (button, a, [role="button"]). Если не найден -- `BrowserSelectorNotFoundError`

**Почему click а не tap:** В контексте браузера семантически правильнее "click". Для пиксельных координат (tap(x,y)) используется существующий generic `tap` инструмент через `BrowserAdapter.tap()` -> `Input.dispatchMouseEvent`. `browser_click` работает на уровне DOM-элементов.

**Примеры вызова:**

```json
// По ref (рекомендуемый)
{ "ref": "e1" }

// По CSS selector
{ "selector": "#login-button" }

// По тексту
{ "text": "Sign in" }

// В конкретной сессии
{ "ref": "e5", "session": "admin" }
```

---

### 9. browser_fill

Заполнить текстовое поле. Очищает текущее содержимое и вводит новый текст.

**inputSchema:**

```json
{
  "type": "object",
  "properties": {
    "ref": {
      "type": "string",
      "description": "Element ref from browser_snapshot output (e.g. \"e2\"). Fastest and most reliable method."
    },
    "selector": {
      "type": "string",
      "description": "CSS selector of the input/textarea element."
    },
    "value": {
      "type": "string",
      "description": "Text to enter into the field. The field will be cleared first."
    },
    "session": {
      "type": "string",
      "description": "Target session. Defaults to \"default\"."
    }
  },
  "required": ["value"]
}
```

**Формат ответа:** text

```
Filled [e2] input "Email" with "user@example.com"
```

**Семантика:**
- Таргетирование: тот же приоритет `ref > selector` (text не поддерживается для fill -- неоднозначно, какой input заполнять по тексту)
- Если ни ref ни selector не указаны -- заполняет текущий focused элемент (если это input/textarea)
- Реализация: `element.focus()` -> `element.value = ""` -> `Input.insertText(value)` + dispatch input/change events
- Не ограничен input/textarea -- работает с contenteditable

**Почему `value` а не `text`:** Избежать коллизии с потенциальным будущим параметром `text` для поиска по текстовому содержимому (как в browser_click). Имя `value` также ближе к DOM-семантике (`input.value`).

**Примеры вызова:**

```json
// По ref
{ "ref": "e2", "value": "user@example.com" }

// По CSS selector
{ "selector": "#password", "value": "secret123" }

// Focused element
{ "value": "search query" }

// В именованной сессии
{ "ref": "e3", "value": "admin@corp.com", "session": "admin" }
```

---

### 10. browser_press_key

Нажать клавишу или комбинацию клавиш.

**inputSchema:**

```json
{
  "type": "object",
  "properties": {
    "key": {
      "type": "string",
      "description": "Key or key combination. Single keys: Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, F1-F12. Combinations: Control+a, Control+c, Control+v, Alt+Tab, Shift+Enter."
    },
    "session": {
      "type": "string",
      "description": "Target session. Defaults to \"default\"."
    }
  },
  "required": ["key"]
}
```

**Формат ответа:** text

```
Pressed key: Enter
```
или
```
Pressed key combination: Control+a
```

**Семантика:**
- CDP: `Input.dispatchKeyEvent` (keyDown + keyUp)
- Комбинации через `+` разделитель: сначала keyDown для модификаторов, потом основная клавиша, потом keyUp в обратном порядке
- Имена клавиш соответствуют [UI Events KeyboardEvent.key](https://developer.mozilla.org/en-US/docs/Web/API/UI_Events/Keyboard_event_key_values)

**Примеры вызова:**

```json
{ "key": "Enter" }
{ "key": "Tab" }
{ "key": "Escape" }
{ "key": "Control+a" }
{ "key": "Control+Shift+k", "session": "dev" }
```

---

## Инструменты: Инспекция

### 11. browser_snapshot

Получить accessibility-like snapshot страницы: текстовое дерево интерактивных элементов с ref-ами.

**inputSchema:**

```json
{
  "type": "object",
  "properties": {
    "session": {
      "type": "string",
      "description": "Target session. Defaults to \"default\"."
    }
  }
}
```

**Формат ответа:** text

Точный формат вывода (aria-like дерево):

```
- navigation
  - link "Home" [e1]
  - link "Products" [e2]
  - link "About" [e3]
- main
  - heading "Welcome to Example" [e4]
  - paragraph "Lorem ipsum dolor sit amet..."
  - form
    - textbox "Email address" [e5]
    - textbox "Password" [e6]
    - button "Log in" [e7]
    - link "Forgot password?" [e8]
  - list
    - listitem
      - link "Feature one" [e9]
    - listitem
      - link "Feature two" [e10]
- footer
  - link "Privacy Policy" [e11]
  - link "Terms" [e12]
```

**Принципы формата:**
1. Каждая строка: `<indent><role> "<accessible name>" [<ref>]`
2. `role` -- ARIA role или HTML semantics (link, button, textbox, heading, navigation, main, list, listitem, paragraph, img, checkbox, radio, combobox, tab, dialog...)
3. `"accessible name"` -- вычисленное имя (aria-label > aria-labelledby > innerText > placeholder > title). Пустые имена опускаются.
4. `[ref]` -- ТОЛЬКО для интерактивных элементов (кликабельные, фокусируемые, editable). Неинтерактивные элементы ref не получают.
5. Отступ 2 пробела на уровень вложенности
6. Текстовые ноды без семантики группируются или опускаются
7. Скрытые элементы (`display:none`, `visibility:hidden`, `aria-hidden="true"`) -- НЕ включаются

**Кеш ref -> selector:**

При каждом вызове `browser_snapshot`:
1. Предыдущий кеш полностью сбрасывается
2. Обходится DOM, строится дерево
3. Для каждого элемента с ref генерируется уникальный CSS selector
4. `Map<string, string>` сохраняется per-session: `{ "e1": "nav > a:nth-child(1)", "e2": "nav > a:nth-child(2)", ... }`

Ref-ы нумеруются последовательно начиная с `e1` при каждом snapshot вызове (НЕ глобальный счетчик).

**Инвалидация:** Ref-кеш инвалидируется при:
- Новом вызове `browser_snapshot` (перезаписывается)
- `browser_navigate`, `browser_back`, `browser_forward`, `browser_reload` (сбрасывается полностью)
- SPA-навигации, детектируемой через CDP `Page.frameNavigated`

**Примеры вызова:**

```json
{}
{ "session": "admin" }
```

---

### 12. browser_screenshot

Сделать скриншот страницы.

**inputSchema:**

```json
{
  "type": "object",
  "properties": {
    "session": {
      "type": "string",
      "description": "Target session. Defaults to \"default\"."
    },
    "fullPage": {
      "type": "boolean",
      "description": "Capture full scrollable page instead of just the visible viewport. Default: false.",
      "default": false
    }
  }
}
```

**Формат ответа:** image + text (опционально)

Handler return:

```typescript
{
  image: {
    data: string,    // base64-encoded JPEG
    mimeType: "image/jpeg"
  },
  text: "Screenshot: 1280x720 (viewport)"  // или "Screenshot: 1280x4500 (full page)"
}
```

**Семантика:**
- CDP: `Page.captureScreenshot`
- Сжатие: JPEG quality 55, max 540x960 (viewport) -- те же дефолты что у существующего `screenshot` инструмента для консистентности
- fullPage: `Page.captureScreenshot({ captureBeyondViewport: true, clip: { ...fullContentSize } })`
- Viewport screenshot -- дефолт, дешевле по токенам

**Примеры вызова:**

```json
// Viewport
{}

// Full page
{ "fullPage": true }

// Конкретная сессия
{ "session": "staging", "fullPage": true }
```

---

### 13. browser_evaluate

Выполнить произвольный JavaScript в контексте страницы.

**inputSchema:**

```json
{
  "type": "object",
  "properties": {
    "expression": {
      "type": "string",
      "description": "JavaScript expression to evaluate in the page context. For complex objects, the result will be JSON-serialized. For DOM nodes, a description string is returned."
    },
    "session": {
      "type": "string",
      "description": "Target session. Defaults to \"default\"."
    }
  },
  "required": ["expression"]
}
```

**Формат ответа:** text

**Сериализация результата:**

```typescript
// CDP: Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true })

// Маппинг типов результата -> текст:
// undefined       -> "undefined"
// null            -> "null"
// string          -> значение строки as-is
// number, boolean -> String(value)
// object/array    -> JSON.stringify(value, null, 2) (с обрезкой до 10000 символов)
// DOM Node        -> "<tagName#id.class1.class2>" (description, не сериализуется)
// Error           -> "Error: message\n  stack..."
// Promise         -> авто-await через awaitPromise: true
// function        -> "function functionName() { ... }" (toString)
```

Ограничения ответа:
- Максимум 10000 символов текста (обрезается с `... (truncated, ${totalLength} chars)`)
- Circular references: `JSON.stringify` упадет -- ловим и возвращаем `[Circular object, type: ${typeof}]`

**Примеры вызова:**

```json
// Простое выражение
{ "expression": "document.title" }
// -> "Example Domain"

// Получить данные из page
{ "expression": "JSON.stringify(performance.timing)" }
// -> "{ \"navigationStart\": 1709234567890, ... }"

// Модифицировать DOM
{ "expression": "document.querySelector('#theme-toggle').click()" }
// -> "undefined"

// Async/await (через awaitPromise)
{ "expression": "await fetch('/api/status').then(r => r.json())" }
// -> "{ \"status\": \"ok\", \"version\": \"2.1.0\" }"

// Получить cookies
{ "expression": "document.cookie" }
// -> "session_id=abc123; theme=dark"

// localStorage
{ "expression": "Object.fromEntries(Object.entries(localStorage))" }
// -> "{ \"token\": \"...\", \"preferences\": \"...\" }"
```

---

### 14. browser_wait_for_selector

Ждать появления элемента на странице. Критически важно для SPA, lazy-loaded контента, модальных окон.

**inputSchema:**

```json
{
  "type": "object",
  "properties": {
    "selector": {
      "type": "string",
      "description": "CSS selector to wait for (e.g. \".modal-content\", \"#results-list\", \"[data-loaded='true']\")."
    },
    "timeout": {
      "type": "number",
      "description": "Maximum wait time in milliseconds. Default: 5000, max: 30000.",
      "default": 5000
    },
    "state": {
      "type": "string",
      "enum": ["attached", "visible"],
      "description": "What state to wait for. \"attached\" = element exists in DOM (may be hidden). \"visible\" = element exists and is visible (not display:none, not visibility:hidden, has non-zero size). Default: \"visible\".",
      "default": "visible"
    },
    "session": {
      "type": "string",
      "description": "Target session. Defaults to \"default\"."
    }
  },
  "required": ["selector"]
}
```

**Формат ответа:** text

```
Element found: ".modal-content" (visible, 1230ms)
```
или ошибка:
```
BrowserWaitTimeoutError: Timeout waiting for selector ".modal-content" after 5000ms.
```

**Семантика:**
- Polling с интервалом 100ms через `Runtime.evaluate`
- `attached`: `document.querySelector(selector) !== null`
- `visible`: querySelector + `offsetWidth > 0 && offsetHeight > 0 && getComputedStyle(el).visibility !== 'hidden'`
- Timeout cap: max 30000ms (защита от зависания)

**Примеры вызова:**

```json
// Ждать модальное окно
{ "selector": ".modal-dialog" }

// Ждать загрузку данных с увеличенным timeout
{ "selector": "#results-table tbody tr", "timeout": 10000 }

// Ждать элемент в DOM (может быть скрыт)
{ "selector": "[data-testid='notification']", "state": "attached" }

// В конкретной сессии
{ "selector": ".dashboard-loaded", "session": "admin", "timeout": 15000 }
```

---

## Полная таблица инструментов

| # | Инструмент | required | Ответ | Идемпотентен |
|---|---|---|---|---|
| 1 | `browser_open` | `url` | text | Да (повторный open той же сессии -- навигация) |
| 2 | `browser_close` | -- | text | Да (закрытие закрытого -- OK) |
| 3 | `browser_list_sessions` | -- | text | Да (read-only) |
| 4 | `browser_navigate` | `url` | text | Да |
| 5 | `browser_back` | -- | text | Нет (зависит от истории) |
| 6 | `browser_forward` | -- | text | Нет |
| 7 | `browser_reload` | -- | text | Да |
| 8 | `browser_click` | -- (но min 1 of ref/selector/text) | text | Нет (side effects) |
| 9 | `browser_fill` | `value` | text | Да (повторное заполнение = то же значение) |
| 10 | `browser_press_key` | `key` | text | Нет |
| 11 | `browser_snapshot` | -- | text | Да (read-only) |
| 12 | `browser_screenshot` | -- | image+text | Да (read-only) |
| 13 | `browser_evaluate` | `expression` | text | Зависит от expression |
| 14 | `browser_wait_for_selector` | `selector` | text | Да (read-only poll) |

---

## Авто-создание сессии vs требование существующей

**Решение по дизайну:** Только `browser_open` создает сессии. Все остальные инструменты ТРЕБУЮТ существующую сессию.

Обоснование:
- Явное управление жизненным циклом -- агент всегда знает, когда он создал сессию
- Нет магического auto-create, которое может скрыть баги (забыл открыть, но click "работает" на about:blank)
- Понятные ошибки: `Session "foo" not found. Use browser_open to create a session.`

Исключение: если сессия `"default"` не существует и вызван любой browser_* без session -- ошибка с подсказкой вместо silent auto-create:
```
No active browser session. Use browser_open(url) to start one.
```

---

## Взаимодействие с существующими generic-инструментами

Когда target platform = "browser", существующие generic-инструменты делегируют в BrowserAdapter:

| Generic инструмент | BrowserAdapter метод | Поведение |
|---|---|---|
| `screenshot()` | `getScreenshotBufferAsync()` | Скриншот активной сессии viewport, те же compress параметры |
| `tap(x, y)` | `tap(x, y)` | `Input.dispatchMouseEvent` по координатам (mousePressed + mouseReleased) |
| `get_ui()` | `getUiHierarchy()` | Вызывает `browser_snapshot` активной сессии |
| `input_text(text)` | `inputText(text)` | `Input.insertText` CDP |
| `press_key(key)` | `pressKey(key)` | `Input.dispatchKeyEvent` CDP |
| `swipe(x1,y1,x2,y2)` | `swipe()` | `Input.dispatchMouseEvent` drag: mousePressed -> mouseMoved -> mouseReleased |
| `find_element(text)` | -- | НЕ поддержан, возвращает "Use browser_snapshot for browser platform" |

"Активная сессия" = последняя сессия, с которой было взаимодействие, или `"default"`.

---

## Интеграция с batch_commands / run_flow

Browser-инструменты ДОЛЖНЫ быть добавлены в `FLOW_ALLOWED_ACTIONS`:

```typescript
const FLOW_ALLOWED_ACTIONS = new Set([
  // ... existing
  "browser_open", "browser_close", "browser_navigate",
  "browser_back", "browser_forward", "browser_reload",
  "browser_click", "browser_fill", "browser_press_key",
  "browser_snapshot", "browser_screenshot", "browser_evaluate",
  "browser_wait_for_selector",
  // browser_list_sessions NOT in flows (read-only utility, not an action)
]);
```

---

## TypeScript: полный код browser-tools.ts (inputSchema only)

```typescript
import type { ToolDefinition } from "./registry.js";
import type { ToolContext } from "./context.js";

// Session parameter reused across all browser tools
const sessionParam = {
  type: "string" as const,
  description: 'Target session. Defaults to "default".',
};

export const browserTools: ToolDefinition[] = [
  // === Session management ===
  {
    tool: {
      name: "browser_open",
      description:
        "Open a URL in a named browser session. Creates the session (launches Chrome) if it doesn't exist. If the session is already open, navigates to the URL. Each session has its own window and persistent profile (cookies, localStorage are preserved).",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL to open. Must include protocol (https:// or http://).",
          },
          session: sessionParam,
          headless: {
            type: "boolean",
            description: "Run browser without visible window. Default: false.",
            default: false,
          },
        },
        required: ["url"],
      },
    },
    handler: async (args, ctx) => {
      // TODO: implement
      throw new Error("Not implemented");
    },
  },
  {
    tool: {
      name: "browser_close",
      description:
        "Close a browser session. If session is omitted, closes ALL sessions and shuts down the browser process.",
      inputSchema: {
        type: "object",
        properties: {
          session: sessionParam,
        },
      },
    },
    handler: async (args, ctx) => {
      throw new Error("Not implemented");
    },
  },
  {
    tool: {
      name: "browser_list_sessions",
      description:
        "List all active browser sessions with their current page URL and title.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler: async (args, ctx) => {
      throw new Error("Not implemented");
    },
  },

  // === Navigation ===
  {
    tool: {
      name: "browser_navigate",
      description:
        "Navigate to a URL in an existing browser session. The session must be opened first with browser_open.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL to navigate to. Must include protocol (https:// or http://).",
          },
          session: sessionParam,
        },
        required: ["url"],
      },
    },
    handler: async (args, ctx) => {
      throw new Error("Not implemented");
    },
  },
  {
    tool: {
      name: "browser_back",
      description: "Navigate back in browser history.",
      inputSchema: {
        type: "object",
        properties: {
          session: sessionParam,
        },
      },
    },
    handler: async (args, ctx) => {
      throw new Error("Not implemented");
    },
  },
  {
    tool: {
      name: "browser_forward",
      description: "Navigate forward in browser history.",
      inputSchema: {
        type: "object",
        properties: {
          session: sessionParam,
        },
      },
    },
    handler: async (args, ctx) => {
      throw new Error("Not implemented");
    },
  },
  {
    tool: {
      name: "browser_reload",
      description: "Reload the current page.",
      inputSchema: {
        type: "object",
        properties: {
          session: sessionParam,
        },
      },
    },
    handler: async (args, ctx) => {
      throw new Error("Not implemented");
    },
  },

  // === Interaction ===
  {
    tool: {
      name: "browser_click",
      description:
        'Click an element on the page. Specify the target using ref (from browser_snapshot), CSS selector, or visible text. Priority: ref > selector > text. At least one targeting parameter is required.',
      inputSchema: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description:
              'Element ref from browser_snapshot (e.g. "e1", "e14"). Fastest and most reliable — prefer this.',
          },
          selector: {
            type: "string",
            description:
              'CSS selector (e.g. "#submit-btn"). Use when ref is unavailable.',
          },
          text: {
            type: "string",
            description:
              "Click element by visible text (partial match, case-insensitive). Slowest — use as last resort.",
          },
          session: sessionParam,
        },
      },
    },
    handler: async (args, ctx) => {
      throw new Error("Not implemented");
    },
  },
  {
    tool: {
      name: "browser_fill",
      description:
        "Fill a text field. Clears existing content and types new text. Target the field using ref or CSS selector. If neither is provided, fills the currently focused element.",
      inputSchema: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description:
              'Element ref from browser_snapshot (e.g. "e5"). Fastest and most reliable.',
          },
          selector: {
            type: "string",
            description: "CSS selector of the input/textarea element.",
          },
          value: {
            type: "string",
            description: "Text to enter. The field will be cleared first.",
          },
          session: sessionParam,
        },
        required: ["value"],
      },
    },
    handler: async (args, ctx) => {
      throw new Error("Not implemented");
    },
  },
  {
    tool: {
      name: "browser_press_key",
      description:
        'Press a key or key combination. Single keys: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, F1-F12. Combinations with "+": Control+a, Control+c, Alt+Tab, Shift+Enter.',
      inputSchema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description:
              'Key name or combination (e.g. "Enter", "Control+a", "Shift+Tab").',
          },
          session: sessionParam,
        },
        required: ["key"],
      },
    },
    handler: async (args, ctx) => {
      throw new Error("Not implemented");
    },
  },

  // === Inspection ===
  {
    tool: {
      name: "browser_snapshot",
      description:
        'Get an accessibility snapshot of the page — a text tree of interactive elements with refs. Use refs with browser_click/browser_fill for reliable element targeting. Much cheaper than screenshot for understanding page structure. Refs become stale after navigation — call snapshot again if you get a "ref stale" error.',
      inputSchema: {
        type: "object",
        properties: {
          session: sessionParam,
        },
      },
    },
    handler: async (args, ctx) => {
      throw new Error("Not implemented");
    },
  },
  {
    tool: {
      name: "browser_screenshot",
      description:
        "Take a screenshot of the browser page. Returns a compressed image. Use browser_snapshot instead when you only need to understand page structure (much cheaper).",
      inputSchema: {
        type: "object",
        properties: {
          session: sessionParam,
          fullPage: {
            type: "boolean",
            description:
              "Capture the full scrollable page instead of just the visible viewport. Default: false.",
            default: false,
          },
        },
      },
    },
    handler: async (args, ctx) => {
      throw new Error("Not implemented");
    },
  },
  {
    tool: {
      name: "browser_evaluate",
      description:
        "Execute JavaScript in the page context. Returns the result as text. Objects are JSON-serialized. Promises are awaited automatically. Use for reading page data, modifying DOM, or interacting with page APIs.",
      inputSchema: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description:
              "JavaScript expression to evaluate. For objects, use JSON.stringify() explicitly if you need formatted output.",
          },
          session: sessionParam,
        },
        required: ["expression"],
      },
    },
    handler: async (args, ctx) => {
      throw new Error("Not implemented");
    },
  },
  {
    tool: {
      name: "browser_wait_for_selector",
      description:
        "Wait for an element matching a CSS selector to appear on the page. Essential for SPAs, lazy-loaded content, and animations.",
      inputSchema: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: 'CSS selector to wait for (e.g. ".modal-content", "#results-list").',
          },
          timeout: {
            type: "number",
            description: "Max wait time in ms. Default: 5000, max: 30000.",
            default: 5000,
          },
          state: {
            type: "string",
            enum: ["attached", "visible"],
            description:
              '"attached" = exists in DOM (may be hidden). "visible" = exists and is visible. Default: "visible".',
            default: "visible",
          },
          session: sessionParam,
        },
        required: ["selector"],
      },
    },
    handler: async (args, ctx) => {
      throw new Error("Not implemented");
    },
  },
];
```

---

## Ревью-чеклист

- [x] Все 14 инструментов специфицированы с полным JSON Schema
- [x] `required` массивы минимальны (только действительно обязательные параметры)
- [x] `session` -- опциональный везде, default "default" на уровне handler
- [x] `description` для каждого property написан для LLM (кратко, с примерами значений)
- [x] Приоритет ref > selector > text задокументирован в description browser_click
- [x] browser_snapshot формат вывода показан с конкретным примером
- [x] browser_evaluate сериализация всех типов описана
- [x] Ошибки типизированы (7 новых BrowserError подклассов)
- [x] Идемпотентность указана для каждого инструмента
- [x] Интеграция с flow_tools задокументирована
- [x] Делегация generic инструментов в BrowserAdapter описана
- [x] Формат value вместо text в browser_fill обоснован
- [x] Граничные случаи из parent spec покрыты ошибками
