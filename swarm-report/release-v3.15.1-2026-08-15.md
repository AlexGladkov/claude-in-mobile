# Release v3.15.1 — 2026-08-15 (hotfix)

## Включено
- #57 — tool schemas: draft-07 → draft-2020-12 (defineTool). z.tuple
  (input.waypoints) больше не даёт array-form items → API не 400-ит.
  + регресс-тест (schema-draft.test.ts).
- #56 — screen(capture) honours preset (maxWidth/height/quality → optional,
  precedence explicit→preset→default). + preset-тест.

## Закрытые issues
- #57 (CLOSED), #56 (CLOSED) — оба auto-closed через Closes.

## CI runs
- release.yml run 31891190411 — success (7/7 jobs). Actions-минуты были.

## Channels verification
- npm: 3.15.1, dist-tag latest → 3.15.1. Публичная установка + проверка:
  published define-tool.js target="draft-2020-12", input.waypoints=prefixItems
  → фикс LIVE для реальных юзеров.
- GitHub: 2 darwin tar.gz + sidecars.
- Homebrew: update-homebrew + verify-checksums success.

## Root cause / severity
- Прод-инцидент на зарелиженной 3.15.0: каждый Claude API-запрос 400 в сессии
  с core-тулом input. Регрессия из 3.15.0 (drag/z.tuple вскрыл латентный
  draft-07 таргет в defineTool).

## Lessons learned
- Release Стадия 5 (runtime smoke) НЕ ловила это: --version/--help не гоняют
  tool-схемы против реального требования Claude API (draft 2020-12).
  Консилиумы ревьюили логику/протокол, не JSON-schema draft.
- ФИКС ПРОЦЕССА: добавить в release.md Стадию 5 проверку «все тулы эмитят
  валидный 2020-12» (нет array-form items). Регресс-тест schema-draft.test.ts
  теперь это ловит в CI, но профиль стоит обновить явно.
