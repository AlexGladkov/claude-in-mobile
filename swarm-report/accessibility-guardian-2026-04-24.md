# Accessibility Guardian — v3.6.0

**Дата:** 2026-04-24

## Описание

Новый скрытый мета-инструмент `accessibility` для WCAG 2.2 аудита доступности (a11y) на всех платформах: Android, iOS, Desktop, Browser, Aurora.

Инструмент анализирует UI-элементы, проверяет соответствие стандартам доступности и выдаёт отчёт с разбором нарушений по критичности.

---

## Research (Консилиум)

6 экспертов параллельно проанализировали задачу:

| Роль | Вывод |
|------|--------|
| **Архитектор** | Решение: отдельный скрытый мета-инструмент с Registry паттерном для правил. Независимый от других tooling, легко расширяемый. |
| **Фронтенд** | Проанализировал UiElement по всем платформам. A11y атрибуты (label, role, state, hint) уже парсятся. Достаточно добавить правила валидации. |
| **UI-дизайнер** | Определил уровни критичности (Critical, Serious, Moderate), output format совместим с visual-tools (PASS/FAIL pattern). |
| **Безопасность** | ⚠️ Найдено 2 High issue: текст пароля утекает в UI tree. Рекомендован редакционный слой для маскирования. |
| **DevOps** | Новых зависимостей не требуется. Vitest автоматически подхватит тесты в `**.test.ts`. |
| **API-дизайнер** | Полная JSON Schema (4 экшена: audit/check/summary/rules), совместимо с flow-системой. |

---

## План

**9 этапов реализации:**

1. ✅ Типы и структуры (A11yIssue, A11yRule, A11yReport)
2. ✅ Система критичности (Severity enum + weights)
3. ✅ Формула оценки (score = 100 - Σ(weights), диапазон [0, 100])
4. ✅ 6 правил (WCAG 1.1.1, 2.5.8, 4.1.2, 2.1.1, 1.3.1, 4.1.2)
5. ✅ Форматер (PASS/FAIL отчёт)
6. ✅ Обработчики ошибок (A11yAuditError, A11yRuleNotFoundError)
7. ✅ Tool handlers (4 экшена: audit/check/summary/rules)
8. ✅ Мета-инструмент (скрытый модуль + aliases)
9. ✅ Тесты (39 unit tests)

---

## Реализовано

### Новые файлы (14)

#### Типы и структуры
- **`src/a11y/types.ts`** — A11yIssue, A11yRule, A11yReport, A11ySeverity, A11yRuleType
- **`src/a11y/severity.ts`** — Enum Severity (Critical=40pt, Serious=25pt, Moderate=10pt)
- **`src/a11y/score.ts`** — Функция scoreReport() с формулой и clamping [0, 100]

#### Правила (WCAG 2.2)
- **`src/a11y/rules/missing-label.ts`** — WCAG 1.1.1 (Text Alternatives) — **Critical**
  - Проверяет что интерактивные элементы имеют label или contentDescription

- **`src/a11y/rules/touch-target.ts`** — WCAG 2.5.8 (Target Size) — **Serious**
  - Валидирует что clickable элементы имеют размер ≥ 48x48 dp (Android) / 44x44 pt (iOS)

- **`src/a11y/rules/interactive-labels.ts`** — WCAG 4.1.2 (Name, Role, Value) — **Critical**
  - Проверяет role и state для интерактивных элементов (кнопки, чекбоксы, переключатели)

- **`src/a11y/rules/focus-order.ts`** — WCAG 2.1.1 (Keyboard) — **Serious**
  - Проверяет что tabIndex в логическом порядке (Android: accessibilityTraversalBefore/After, Web: tabIndex)

- **`src/a11y/rules/duplicate-descriptions.ts`** — WCAG 1.3.1 (Info & Relationships) — **Moderate**
  - Детектирует дублирующиеся contentDescription + label для одного элемента

- **`src/a11y/rules/state-description.ts`** — WCAG 4.1.2 (Status Messages) — **Moderate**
  - Проверяет что элементы с изменяемым состоянием имеют stateDescription

- **`src/a11y/rules/index.ts`** — Rule registry (map правил по типам)

#### Форматирование и обработчики
- **`src/a11y/formatter.ts`** — formatReport() → PASS/FAIL блоки с nested issues
- **`src/tools/accessibility-tools.ts`** — 4 handler'а:
  - `audit()` — полный аудит элементов, возвращает A11yReport
  - `check()` — быстрая проверка конкретного элемента
  - `summary()` — агрегированная статистика (score, counts по severity)
  - `rules()` — вывод всех доступных правил + описания

- **`src/tools/meta/accessibility-meta.ts`** — мета-инструмент wrapper (скрытый модуль)
- **`src/tools/accessibility-tools.test.ts`** — 39 unit тестов

### Изменённые файлы (2)

- **`src/errors.ts`**
  ```typescript
  export class A11yAuditError extends ToolError { ... }
  export class A11yRuleNotFoundError extends ToolError { ... }
  ```

- **`src/index.ts`**
  - Зарегистрирован скрытый модуль `accessibility`
  - Добавлены aliases: `a11y_audit`, `a11y_check`, `a11y_summary`, `a11y_rules`
  - Экспортированы типы (A11yIssue, A11yReport, A11ySeverity)

---

## Validation

✅ **TypeScript:** 0 ошибок компиляции

✅ **Unit-тесты:** 594/594 passed (18 файлов)
- 39 новых a11y тестов покрывают:
  - Все 6 правил (happy path + edge cases)
  - Scoring formula (sum, clamping, rounding)
  - Formatter (PASS/FAIL блоки, nested issues)
  - Error handling (invalid rules, empty reports)

✅ **Регрессия:** нет

---

## Статус

✅ **Done**

Инструмент готов к использованию в v3.6.0.

---

## Следующие шаги (v3.7.0+)

### Визуальные компоненты
- [ ] Annotated screenshots с маркерами нарушений a11y (красные боксы вокруг проблемных элементов)
- [ ] Color contrast checks на основе скриншотов (WCAG 1.4.3, WCAG 1.4.11)

### Платформа Android
- [ ] Иерархический парсинг UI tree для связи label ↔ элемента
- [ ] Проверка accessibilityLiveRegion (WCAG 4.1.3)

### Платформа iOS
- [ ] Поддержка accessibilityTraits через расширенный WDA API
- [ ] accessibilityElement, accessibilityHint парсинг

### CLI (Rust)
- [ ] Подкоманда `a11y` в CLI инструмента
- [ ] Интеграция с CI/CD pipeline
- [ ] Exit codes для WCAG conformance levels (A, AA, AAA)

---

## Примеры использования

### Полный аудит
```json
POST /tools/accessibility
{
  "action": "audit",
  "uiElements": [ /* UiElement array */ ]
}
```

### Быстрая проверка элемента
```json
POST /tools/accessibility
{
  "action": "check",
  "element": { /* UiElement */ },
  "rules": ["missing-label", "touch-target"]
}
```

### Сводка результатов
```json
POST /tools/accessibility
{
  "action": "summary",
  "report": { /* A11yReport */ }
}
```

### Список доступных правил
```json
POST /tools/accessibility
{
  "action": "rules"
}
```

---

**Автор:** Claude Code (Opus 4.6)
**Версия:** 3.6.0
**Branch:** release/v3.6.0
