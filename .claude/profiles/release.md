# Профиль: Подготовка релиза claude-in-mobile

Локальный проектный профиль. Используется при выпуске любой версии (major /
minor / patch / hotfix). Полностью заменяет глобальный профиль для этой
задачи — глобальный CLAUDE.md делегирует сюда любую релизную работу в этом
репозитории.

## Когда использовать

Триггеры:

- "релиз", "выпустить релиз", "release", "выпустить 3.X.Y"
- "хотфикс", "patch release"
- "опубликовать на npm / в Homebrew"
- запросы вида "погнали в публикацию" / "пушим релиз"

Не использовать для:

- обычной разработки фичи (это `business-feature` или `bug-hunting`)
- подготовки release/* ветки без публикации (используй `business-feature`
  до момента, когда нужно реально публиковать)

## Жёсткий чеклист — без пропусков

Каждая стадия — отдельный этап. Пропустить можно только с явным
текстовым согласием пользователя ("ок, пропусти X", не системным напоминанием).

### Стадия 0 — Аудит открытых issues (НИКОГДА не пропускается)

**Это причина, по которой профиль существует. Без этой стадии релиз не
запускается.**

1. `gh issue list --state open --limit 50` — снять полный список.
2. Для каждого open issue:
   - Прочитать `gh issue view <N>`.
   - Принять решение из трёх:
     - **(a) Фиксим в этом релизе.** Записать номер в список включаемых.
     - **(b) Известный, не блокирующий — переносим.** Прокомментировать
       issue: "Не входит в vX.Y.Z, перенесено в roadmap. Причина: …".
     - **(c) Не баг / уже решён.** Закрыть с комментарием.
3. Если есть issue (a), сначала их закрыть кодом — *вернуться к стадии 0*
   после фикса, чтобы убедиться что новых тикетов не появилось.
4. Получить от пользователя явное "ок, все опены разобраны" прежде чем
   идти дальше. Если пользователь хочет публиковать поверх open issue —
   зафиксировать это явным сообщением и записать в Report как
   осознанный techdebt.

**Антипаттерн:** "issues — отдельная задача, релиз отдельно". Так нельзя:
issue #43 ERR_REQUIRE_ESM пролежал между 3.10.3 и 3.11.2 и сломал
всех, кто ставил из npm. Пользователи репортят на текущей версии — это
явный сигнал что в продакшене есть боль, которая мерджится в каждый
новый релиз.

### Стадия 1 — Согласование скоупа

1. Подтвердить тип релиза: major / minor / patch — по semver, исходя
   из изменений.
2. Подтвердить целевую версию `vX.Y.Z`.
3. Если предыдущий релиз провалил CI (3.11.0 / 3.11.1 — оба
   потенциально) — обязательно прочитать их changelog-entries и убедиться
   что не повторим причины. Конкретно для этого проекта:
   - `npm run build` должен билдить workspace `@claude-in-mobile/plugin-api`
     перед main tsc. См. 3.11.1.
   - publish-npm job должен иметь `id-token: write` permission, если
     `npm publish --provenance` используется. См. 3.11.2.

### Стадия 2 — Версии и манифесты (4 файла — обязательно ВСЕ)

`.github/workflows/release.yml` сверяет 4 версии и провалит job
`verify-plugin-versions` если хоть одна не совпадает:

- [ ] `package.json` `"version"`
- [ ] `cli/Cargo.toml` `version = "..."`
- [ ] `.claude-plugin/marketplace.json` `plugins[0].version`
- [ ] `cli/plugin/.claude-plugin/plugin.json` `version`

После bump-а: синхронизировать lockfile-ы.

- [ ] `npm install --no-audit --no-fund` (обновит `package-lock.json`)
- [ ] `cd cli && cargo check` (обновит `cli/Cargo.lock`)

### Стадия 3 — CHANGELOG.md

- [ ] Добавить новую секцию `## [X.Y.Z] — YYYY-MM-DD` поверх предыдущей.
- [ ] Структура: `### Added` / `### Fixed` / `### Changed` / `### Security` /
  `### Removed`. Только используемые секции.
- [ ] Для fix-релиза обязательно ссылка на номер issue и краткое
  объяснение root cause + что именно изменили. Пример из 3.11.3:
  `#43 — Browser module fails with ERR_REQUIRE_ESM. BrowserClient.launch
  now uses await import() instead of createRequire(...)`.

### Стадия 4 — Локальная сборка и тесты (Pre-flight)

Все обязательны. Любой fail = `git reset` и обратно на стадию 1.

- [ ] `npm run build` — zero TypeScript errors. Если падает на
  `@claude-in-mobile/plugin-api` — это регрессия workspace build script
  (см. 3.11.1).
- [ ] `npx vitest run` — все TS тесты зелёные. Известные pre-existing
  падения (например, vite-resolve в store-tools) допустимы при условии
  что они уже были на main до релиза. Зафиксировать в report.
- [ ] `cd cli && cargo build --release` — чисто.
- [ ] `cd cli && cargo test --lib` — все Rust тесты зелёные.

### Стадия 5 — Smoke-тесты бинарей (защита от регрессий типа #43, #44)

Запускаются на собранных артефактах. Цель — поймать класс ошибок,
которые tsc / vitest не видят, потому что они runtime-only.

- [ ] `node dist/index.js --version` → печатает версию и **выходит 0**
  без таймаута. Если зависает — регрессия #44.
- [ ] `node dist/index.js --help` → печатает usage и **выходит 0**.
- [ ] Если изменился `src/browser/**` или `dist/browser/**`:
  `node -e 'import("./dist/browser/client.js").then(m => console.log("ok"))'`
  → должно вывести `ok` без `ERR_REQUIRE_ESM`. Защита от #43.
- [ ] Если изменился `cli/src/plugins/repl/**`: запустить
  `printf '{"id":"r1","method":"shutdown"}\n' | cli/target/release/claude-in-mobile repl-supervisor`
  → должно прийти `{"event":"ready"}` и `{"id":"r1","result":"ok"}`.

### Стадия 5b — Tarball install smoke (защита от регрессий типа #45)

**ОБЯЗАТЕЛЬНО.** Локальный workspace + symlink маскируют отсутствие
публикуемых dependency-package-ов. Без этой стадии #45 повторится.

- [ ] `npm pack` — создать тарбол.
- [ ] `tar -tzf claude-in-mobile-X.Y.Z.tgz | grep -E 'plugin-api|node_modules'` —
  проверить, что bundled workspace-пакеты реально лежат в тарболе.
- [ ] Установить тарбол в чистую директорию **БЕЗ доступа к workspace**:
  ```sh
  (cd /tmp && rm -rf install-smoke && mkdir install-smoke && cd install-smoke \
    && npm init -y >/dev/null \
    && npm install /absolute/path/to/claude-in-mobile-X.Y.Z.tgz)
  ```
  Зелёный результат = `added N packages`. Любой `npm ERR! 404` или
  `code E404` для `@claude-in-mobile/*` — релиз останавливается, идёт
  на стадию 1. Workspace в `bundledDependencies` обязателен пока
  плагинный API не опубликован отдельно.
- [ ] `cd /tmp/install-smoke && ./node_modules/.bin/claude-in-mobile --version`
  → версия совпадает с тегом.
- [ ] **После публикации** — повторить через публичный npm:
  ```sh
  (cd /tmp && rm -rf npx-smoke && mkdir npx-smoke && cd npx-smoke \
    && npx -y claude-in-mobile@X.Y.Z --version)
  ```
  Это последняя стадия post-release smoke (см. стадия 9). Если падает с
  404 — публикация сломана, hotfix обязателен.

### Стадия 6 — Коммиты и тег

- [ ] Коммиты разбить по логическим слоям (kernel / cli / repl / docs /
  release). См. 3.11.0 как образец. Один большой "feat: release"
  коммит — антипаттерн, мешает блейму.
- [ ] Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `ci:`,
  `refactor:`.
- [ ] Если fix закрывает issue — добавить `Closes #N` в тело коммита.
  GitHub auto-закроет issue при merge / push в main.
- [ ] Co-Authored-By trailer для Claude — формат как в существующей
  истории.
- [ ] `git tag -a vX.Y.Z -m "..."` — аннотированный тег.

### Стадия 7 — Push (только с явным подтверждением)

**Глобальное правило: `git push` НИКОГДА не выполняется без явного
текстового подтверждения пользователя.**

- [ ] Запросить: "Готов пушить main + tag vX.Y.Z. Подтверди."
- [ ] Дождаться явного "да" / "пушь" / "go" в сообщении пользователя.
- [ ] `git push origin main && git push origin vX.Y.Z`.

### Стадия 8 — Мониторинг CI

`release.yml` запускается на push тега. Жанры jobs:

| Job                       | Что делает                          | Что может упасть                              |
|---------------------------|--------------------------------------|------------------------------------------------|
| build (arm64, x86_64)     | `cargo build --release`              | Rust compile error                             |
| verify-plugin-versions    | сверка 4 манифестов                  | Не bump-нули один из манифестов (стадия 2)     |
| release                   | создаёт GitHub Release с tar.gz      | Permissions                                    |
| publish-npm               | `npm publish --provenance`           | Build script / id-token permission (3.11.1-2)  |
| update-homebrew           | патчит Formula в внешнем tap         | `HOMEBREW_TAP_TOKEN` истёк                     |
| verify-checksums          | сверка sha256 формулы и тарбола      | Скачивание провалилось                         |

- [ ] `gh run watch <run_id> --exit-status` — ждать завершения.
- [ ] При падении: остановить релиз, исправить hotfix (`X.Y.Z+1`),
  начать с **стадии 0** заново. Не "перезапускать" неудачный job —
  rerun использует тот же commit SHA, фиксы не подхватятся.

### Стадия 9 — Post-release валидация (все 3 канала)

- [ ] **GitHub:** `gh release view vX.Y.Z --json assets` — 2 ассета
  (darwin-arm64 + darwin-x86_64), размер 3-9 MB каждый. Если ~20 MB —
  это случайно собрали Node-бандл, удалить релиз и пересобрать.
- [ ] **npm:** `npm view claude-in-mobile@X.Y.Z version` — версия
  опубликована. `npm view claude-in-mobile dist-tags` — `latest` поднят
  на новую версию.
- [ ] **Homebrew:** `brew update && brew upgrade claude-in-mobile` —
  переходит на новую версию. `claude-in-mobile --version` → `X.Y.Z`.
- [ ] **Smoke новой установки:**
  `claude-in-mobile repl-supervisor < /dev/null` (если REPL plugin
  затронут) → `{"event":"ready","apiVersion":"1"}`.

### Стадия 10 — Release notes и issue cleanup

- [ ] `gh release edit vX.Y.Z --notes-file <path>` — заменить
  автогенерированные ноты на содержательные. Формат: краткое summary +
  bullet-list изменений + ссылки на issue/PR.
- [ ] Для каждой issue, закрытой через `Closes #N`: добавить
  follow-up комментарий с install-снippetом (`brew upgrade …` /
  `npm i -g …@X.Y.Z`). Помогает репортёру убедиться что фикс доехал.
- [ ] Если issue auto-закрылась пустым — добавить публичный комментарий
  с описанием фикса.

### Стадия 11 — Отчёт

- [ ] Записать отчёт в `./swarm-report/release-vX.Y.Z-YYYY-MM-DD.md`.
- [ ] Структура:
  ```
  # Release vX.Y.Z — YYYY-MM-DD
  ## Включено
  ## Закрытые issues
  ## CI runs
  ## Channels verification
  ## Известные ограничения / отложено
  ## Lessons learned (если были hotfix-ы)
  ```
- [ ] Если была цепочка hotfix-ов (как 3.11.0 → 3.11.2) — обязательно
  раздел "Lessons learned" с пунктами для добавления в этот профиль.

## Принципы

1. **Open issues — гейт релиза.** Если есть отчёт пользователя на
   текущей или предыдущей версии — релиз не выходит, пока он не
   разобран. Это причина появления профиля.
2. **Версии в 4 файлах, всегда.** `verify-plugin-versions` — наш страж.
3. **Smoke runtime ≠ tsc/vitest.** Runtime smoke (`--help`, `import()`,
   binary spawn) ловит классы багов которые не видны на этапе
   компиляции и unit-тестов. Класс #43 (ESM) и класс #44 (deadlock на
   аргументе) — runtime-only.
4. **Hotfix не "перезапускается".** Новый тег, новый коммит. Иначе
   ассеты в GitHub release уходят рассинхрон с homebrew.
5. **CHANGELOG — обязательная часть кода.** Не "потом дополню". Без
   него release notes пустые, и пользователь не знает что
   обновлять.

## Маппинг роль → агент (для консилиума если нужен)

| Роль        | Агент                              |
|-------------|------------------------------------|
| architect   | voltagent-lang:typescript-pro      |
| developer   | voltagent-lang:typescript-pro      |
| security    | voltagent-infra:security-engineer  |
| devops      | devops-orchestrator                |
| diagnostics | kotlin-diagnostics                 |

Соответствует проектному CLAUDE.md.
