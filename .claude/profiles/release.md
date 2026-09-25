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

1. `gh issue list --state open --limit 1000` — снять полный список.
   Если достигнут лимит, получить остальные страницы через GitHub API до
   последней страницы; не считать лимит концом списка.
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
5. **Проверить внешние release prerequisites до любой irreversible
   publication:**
   - **GitHub immutable releases.** Поддерживаемый API:
     `GET /repos/AlexGladkov/claude-in-mobile/immutable-releases` возвращает
     `enabled` и `enforced_by_owner` (200 — включено, 404 — выключено).
     `github-immutable-preflight` вызывает этот endpoint до npm-публикации и
     требует `enabled == true`. Job также требует защищённое GitHub
     Environment `release-immutable-policy` с required reviewers; при 403
     от `GITHUB_TOKEN` это reviewer gate является компенсирующим контролем.
     Аппрувер обязан проверить
     `Settings → General → Releases → Enable release immutability`;
     это компенсирующий human gate, а не machine proof. Финализация всё равно
     проверяет `.immutable == true` у опубликованного Release.
   - **npm Trusted Publishing (OIDC).** У npm есть поддерживаемый
     `GET https://registry.npmjs.org/-/package/{urlencoded-package}/trust`,
     но он требует npm access token с package-write и свежий `npm-otp`.
     OIDC exchange token действует для publish/stage и не может читать Trust,
     а `npm whoami` проверяет только classic-token identity. Поэтому workflow
     не хранит TOTP/privileged npm token и не делает ложного machine assertion:
     до `publish-npm` требуется защищённое Environment
     `npm-trusted-publisher-policy` с required reviewers. Аппрувер сверяет
     Trust-конфигурацию каждого из 11 пакетов (все значения должны совпасть):
     owner/repository `AlexGladkov/claude-in-mobile`, workflow filename
     `release.yml`, environment пустой, `Allowed Actions` разрешает прямой
     `npm publish` (не только `npm stage publish`). Список в порядке `PUBLISH_ORDER`:
     `@mcp-devices/plugin-api`, `mcp-devices`,
     `@mcp-devices/plugin-android`, `@mcp-devices/plugin-ios`,
     `@mcp-devices/plugin-web`, `@mcp-devices/plugin-desktop`,
     `@mcp-devices/plugin-aurora`, `@mcp-devices/plugin-harmony`,
     `@mcp-devices/plugin-debug`, `@mcp-devices/plugin-all`,
     `claude-in-mobile`. Если npm предоставит безопасный non-interactive
     read credential, gate можно заменить точным API-проверяющим job; до этого
     approval обязателен и не считается API-доказательством.
   - Если возможен retry с непустым `REPAIR_PLAN`, обеспечить `NPM_TOKEN`
     с write-доступом для `npm dist-tag add` на затрагиваемые пакеты.
     `npm-token-preflight` проверяет только identity через `npm whoami`;
     read-only token тоже проходит и не подтверждает право repair. OIDC
     publisher не получает этот токен.
   - **Homebrew stable gate.** `homebrew-token-preflight` до любого public
     channel вызывает `GET /repos/AlexGladkov/homebrew-tap` с
     `HOMEBREW_TAP_TOKEN` и требует `.full_name` exact и
     `.permissions.push == true` — machine-readable effective repository
     push, соответствующий Contents: write. Safe write probe не выполняется,
     поскольку он изменил бы tap. Для prerelease job skipped; для stable
     отсутствие token/permission блокирует npm и GitHub publication, а не
     оставляет Homebrew на старой версии.
   - **Residual risk:** администратор может изменить GitHub immutable policy
     после preflight, а reviewer может ошибиться. Finalization перепроверит
     `.immutable` и остановится, но уже опубликованные npm-версии не
     откатываются; изменения release settings должны быть ограничены владельцами.

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
   - `npm run build` должен билдить workspace `@mcp-devices/plugin-api`
     перед main tsc. См. 3.11.1.
   - publish-npm job должен иметь `id-token: write` permission, если
     `npm publish --provenance` используется. См. 3.11.2.

### Стадия 2 — Версии и манифесты (44 проверки — обязательно ВСЕ)

`release.yml` job `verify-plugin-versions` сверяет 44 версии и dependency pins:
ошибка в любой из них останавливает релиз до npm-публикации. В число проверок входят:

- [ ] `package.json` `"version"`
- [ ] `cli/Cargo.toml` `version = "..."`
- [ ] `.claude-plugin/marketplace.json` `plugins[0].version`
- [ ] `.grok-plugin/marketplace.json` `plugins[0].version`
- [ ] `cli/plugin/.claude-plugin/plugin.json` `version`
- [ ] `cli/plugin/.grok-plugin/plugin.json` `version`

**+ 8 scoped plugin-пакетов** (mcp-devices edition — их легко забыть, именно так
сломался 4.0.1: 4 манифеста забампили, scoped-плагины остались на предыдущей
версии, `verify-plugin-versions` упал, npm publish пропущен, homebrew/GitHub уже
ушли на новую версию → десинк каналов). Каждый `packages/<p>/package.json` `.version`
обязан == тег:

- [ ] `packages/plugin-android/package.json`
- [ ] `packages/plugin-ios/package.json`
- [ ] `packages/plugin-web/package.json`
- [ ] `packages/plugin-desktop/package.json`
- [ ] `packages/plugin-aurora/package.json`
- [ ] `packages/plugin-harmony/package.json`
- [ ] `packages/plugin-debug/package.json`
- [ ] `packages/plugin-all/package.json`

**+ 9 runtime plugin-манифестов**. Их `version` виден потребителям через
plugin registry и тоже обязан == тег:

- [ ] `packages/plugin-android/src/index.ts`
- [ ] `packages/plugin-ios/src/index.ts`
- [ ] `packages/plugin-web/src/index.ts`
- [ ] `packages/plugin-desktop/src/index.ts`
- [ ] `packages/plugin-aurora/src/index.ts`
- [ ] `packages/plugin-harmony/src/index.ts`
- [ ] `packages/plugin-debug/src/plugin.ts`
- [ ] `src/plugins/builtin-tools/index.ts`
- [ ] `src/plugins/repl/index.ts`

**+ 7 статических полей `mcpDevicesPlugin.version`** в манифестах платформенных пакетов:

- [ ] `packages/plugin-android/package.json`
- [ ] `packages/plugin-ios/package.json`
- [ ] `packages/plugin-web/package.json`
- [ ] `packages/plugin-desktop/package.json`
- [ ] `packages/plugin-aurora/package.json`
- [ ] `packages/plugin-harmony/package.json`
- [ ] `packages/plugin-debug/package.json`


Одной командой:
`for p in android ios web desktop aurora harmony debug all; do jq --arg v "X.Y.Z" '.version=$v | if has("mcpDevicesPlugin") then .mcpDevicesPlugin.version=$v else . end' packages/plugin-$p/package.json > /tmp/pp && mv /tmp/pp packages/plugin-$p/package.json; done`

`packages/plugin-api/package.json` версионируется независимо и должен оставаться
на pinned `1.1.0`. Workflow также проверяет два root lockfile fields,
10 workspace lockfile versions и локальную ссылку на `mcp-devices`.
`compat/claude-in-mobile/package.json` — это исходный шаблон совместимого
пакета; его имя `claude-in-mobile` не меняется, а `npm-build` временно
переписывает версию и exact pins на `mcp-devices` и
`@mcp-devices/plugin-all`. Перед публикацией artifact gate проверяет эти
идентичности и зависимости; не публиковать исходный template напрямую.

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

Все обязательны. Любой fail останавливает продвижение релиза; исправить
причину на ветке, сохранив незакоммиченные данные. Не использовать `git reset`.

- [ ] **Branch CI зелёный.** `gh run list --branch <release-branch> --limit 3`
  — если последние прогоны красные, разобраться ДО тега. Урок v3.12.0:
  ci.yml падал с Phase 5 (tsc без сборки workspace plugin-api), заметили
  только после пуша тега.
- [ ] **После любого `npm audit fix` / правки зависимостей:** полный
  rebuild lockfile в disposable-копии рабочей директории — не удалять
  `package-lock.json` или другие tracked-файлы в checkout:
  ```sh
  TMP_REPO="$(mktemp -d)"
  trap 'rm -rf "$TMP_REPO"' EXIT
  tar --exclude='./.git' --exclude='./node_modules' -cf - . |
    tar -xf - -C "$TMP_REPO"
  (
    cd "$TMP_REPO"
    rm -f package-lock.json
    npm install --no-audit --no-fund
  )
  cp "$TMP_REPO/package-lock.json" package-lock.json
  ```
  НЕ использовать `--package-lock-only` — он сохраняет стейловые
  резолюции и теряет optional-dep ветки других платформ; восстановить
  postinstall-симлинк `node_modules/mcp-devices`, затем прогнать `npm ci`
  в той же disposable-копии (`cd "$TMP_REPO" && npm ci --no-audit --no-fund`).
- [ ] **После ЛЮБОГО `npm install` (включая version-бамп):** проверить,
  что lock сохранил минимум четыре linux-ветки optional deps sharp:
  `node -e 'const p=require("./package-lock.json").packages;const n=Object.keys(p).filter(k=>k.startsWith("node_modules/@img/sharp-linux"));if(n.length<4)throw Error("missing sharp linux optional deps: "+n.length)'`.
  macOS-локальный `npm ci` это НЕ ловит (linux-ветки не нужны на macOS) —
  ломается только ubuntu CI (publish-npm/lint). Хронический класс: ударил
  3.12.0 И 3.13.0. Инкрементальный `npm install` на macOS прунит
  linux-only entries; только полный rebuild их возвращает. Старый
  `@emnapi/runtime` count больше не является надёжным proxy начиная с sharp 0.35.

- [ ] `npm run build` — zero TypeScript errors. Если падает на
  `@mcp-devices/plugin-api` — это регрессия workspace build script
  (см. 3.11.1).
- [ ] `npx vitest run` — все TS тесты зелёные. Известные pre-existing
  падения (например, vite-resolve в store-tools) допустимы при условии
  что они уже были на main до релиза. Зафиксировать в report.
- [ ] `cd cli && cargo build --release` — чисто.
- [ ] `cd cli && cargo test --lib && cargo test --test setup_grok && cargo test --test repl_observability && cargo test --test repl_live_tui && cargo test --test harmony_cli` — все Rust тесты зелёные.

- [ ] **JDK 17 (Temurin).** `npm run build:desktop` собирает companion,
  включаемый в npm artifacts.
- [ ] `cd desktop-companion && ./gradlew test --no-daemon` — тесты desktop
  companion проходят на JDK 17 (та же команда, что в CI).


### Стадия 5 — Smoke-тесты бинарей (защита от регрессий типа #43, #44)

Запускаются на собранных артефактах. Цель — поймать класс ошибок,
которые tsc / vitest не видят, потому что они runtime-only.

- [ ] `node dist/index.js --version` → печатает версию и **выходит 0**
  без таймаута. Если зависает — регрессия #44.
- [ ] `node dist/index.js --help` → печатает usage и **выходит 0**.
- [ ] Если изменился `packages/plugin-web/src/browser/**` или `packages/plugin-web/dist/browser/**`:
  `node -e 'import("./packages/plugin-web/dist/browser/client.js").then(() => console.log("ok"))'`
  → должно вывести `ok` без `ERR_REQUIRE_ESM`. Защита от #43.
- [ ] Если изменился `cli/src/plugins/repl/**`: запустить
  `printf '{"id":"r1","method":"shutdown"}\n' | cli/target/release/mcp-devices repl-supervisor`
  → должно прийти `{"event":"ready"}` и `{"id":"r1","result":"ok"}`.

### Стадия 5b — Tarball install smoke (защита от регрессий типа #45)

**ОБЯЗАТЕЛЬНО.** Локальный workspace + symlink маскируют отсутствие
публикуемых dependency-package-ов. Без этой стадии #45 повторится.

- [ ] `npm pack` — создать тарбол.
- [ ] `tar -tzf mcp-devices-X.Y.Z.tgz | grep -E 'plugin-api|node_modules'` —
  проверить, что bundled workspace-пакеты реально лежат в тарболе.
- [ ] Установить тарбол в чистую директорию **БЕЗ доступа к workspace**:
  ```sh
  (cd /tmp && rm -rf install-smoke && mkdir install-smoke && cd install-smoke \
    && npm init -y >/dev/null \
    && npm install /absolute/path/to/mcp-devices-X.Y.Z.tgz)
  ```
  `code E404` для `@mcp-devices/*` — публикацию остановить и устранить
  причину до продолжения. Workflow публикует
  `@mcp-devices/plugin-api@1.1.0` отдельно, но root `mcp-devices`
  всё ещё bundle-ит pinned workspace copy через `bundledDependencies`;
  release workflow проверяет эти байты до upload.
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

`release.yml` запускается по SemVer-тегу на закреплённом commit SHA. Основные jobs:

| Job | Что делает |
|---|---|
| `setup` | проверяет tag, SemVer и commit SHA |
| `ci-check` | требует успешный CI для того же commit |
| `build` | собирает `darwin-arm64`, `darwin-x86_64` и `linux-x86_64` |
| `verify-plugin-versions` | проверяет 44 version/dependency fields и static manifest identity |
| `npm-build` | собирает и проверяет immutable npm artifacts |
| `attest` | создаёт provenance attestations для CLI artifacts |
| `release` | создаёт draft GitHub Release с тремя архивами и sidecar-файлами |
| `npm-trusted-publisher-preflight` | требует защищённый reviewer gate для 11 npm Trust identities; OIDC/npm whoami не подменяют Trust API |
| `github-immutable-preflight` | проверяет `GET /immutable-releases`; при admin-read 403 требует protected reviewer gate, затем проверяет draft identity |
| `homebrew-token-preflight` | для stable проверяет secret и `.permissions.push` на `AlexGladkov/homebrew-tap`; prerelease skipped |
| `release-preflight` | агрегирует все pre-publication gates; без success `publish-npm` и finalization не запускаются |
| `npm-token-preflight` | проверяет identity classic token через `npm whoami`; не проверяет write-доступ |
| `publish-npm` | публикует OIDC-пакеты и до success сверяет все 11 registry versions с подготовленными bytes/provenance; отсутствующие версии публикует повторно |
| `repair-npm-tags` | применяет сохранённый preflight plan для известных dist-tag repair после полного npm reconciliation |
| `npm-smoke` | проверяет доступность и identity опубликованных npm-пакетов |
| `finalize-release` | публикует draft после успешных обязательных проверок |
| `update-homebrew` | обновляет Formula только для stable-релиза |
| `verify-checksums` | проверяет SHA-256 и attestations публичных архивов |
| `release-status` | сводит результаты всех jobs в итоговый gate |

- [ ] `gh run watch <run_id> --exit-status` — ждать завершения.
- [ ] При временном сбое `publish-npm` автоматически сверяет exact bytes/provenance
  всех 11 версий и повторно публикует только отсутствующие, сохраняя dependency
  order. При устойчивом сбое workflow остаётся красным для безопасного Actions
  rerun; тот же immutable release ID перепроверяется без замены release или
  переключения на новый commit.

- Ограничение npm registry: публикация 11 независимых пакетов не является
  атомарной транзакцией. Пока reconciliation выполняется или если ограниченные
  повторы исчерпаны, часть immutable versions может быть публично видна.
  Workflow останавливает дальнейшую финализацию, если точные bytes/provenance
  всех пакетов не подтверждены; rerun сверяет состояние и продолжает публикацию,
  но immutable npm versions нельзя откатить.

- [ ] Если требуется изменить код/workflow, начать Stage 0 заново с нового
  commit и следующего SemVer-тега. Не перезапускать tag workflow целиком:
  он попытается создать тот же immutable release.

### Стадия 9 — Post-release валидация (все применимые каналы)

- [ ] **GitHub:** `gh release view vX.Y.Z --json assets` — ровно 6 assets:
  `claude-in-mobile-X.Y.Z-{darwin-arm64,darwin-x86_64,linux-x86_64}.tar.gz`
  и соответствующий `.sha256` sidecar для каждого архива. Draft становится
  публичным только после `finalize-release`; не удалять и не пересоздавать release.
- [ ] **npm:** `npm view mcp-devices@X.Y.Z version` — версия опубликована.
  `npm view mcp-devices dist-tags` — stable-тег поднимает `latest`, prerelease
  должен присутствовать в dist-tag, вычисленном для его SemVer prerelease.
- [ ] **Homebrew:** только для stable-релиза; prerelease пропускает мутацию Formula.
  Для stable: `brew update && brew upgrade alexgladkov/tap/mcp-devices` —
  переходит на новую версию. `mcp-devices --version` → `X.Y.Z`.
  Первая установка: `brew install alexgladkov/tap/mcp-devices`.
  Старые установки из `AlexGladkov/homebrew-claude-in-mobile` не мигрируют
  автоматически: `oldname` не является Formula DSL, а cross-tap rename не
  поддерживается через `formula_renames.json`. Переустановить из unified tap;
  каноническая формула сохраняет бинарный alias `claude-in-mobile`.
  Формула лежит в корне tap (`mcp-devices.rb`), не в `Formula/`.
  Если brew просит trust — `brew trust alexgladkov/tap`.
  Если `--version` показывает старую версию при обновлённом Cellar —
  проверить `ls -la $(which mcp-devices)`: npm-g симлинк может
  перекрывать brew-бинарь (тот же prefix); обновить и npm-g копию.
- [ ] **Smoke новой установки:** `mcp-devices-cli repl-supervisor < /dev/null`
  (если REPL plugin затронут) → `{"event":"ready","apiVersion":"1"}`.


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
2. **44 проверки версий и dependency pins, всегда.** `verify-plugin-versions` — наш страж.
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
