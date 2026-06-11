# Release v3.13.0 — 2026-06-11

## Включено

- **App Store Connect / TestFlight pipeline** — provider `apple` в store
  meta-tool: build / upload / get_releases / set_notes / promote / submit
  + 6 `testflight_*` алиасов.
- ASC REST client (ES256 JWT zero-dep, env-only key material), iOS build
  pipeline (detect Flutter/RN/KMP/Xcode → archive → cloud signing →
  export → validate → upload), typed errors + recovery hints.
- Hardening по итогам реального прогона: validate-гейт перед upload
  (Apple молча дропает невалидные пакеты), classifier вытаскивает
  `error:`/`e: ` строки, хинты для UILaunchScreen / CFBundleIconName /
  orientations.

## Release gate — реальный E2E

Релиз гейтился отгрузкой настоящего KMP-приложения **SwarmHost**
(langchain-kotlin) в TestFlight: build 1.0(1), processingState VALID,
What to Test записан, internal beta group создана. Путь вскрыл 7
дефектов (3 тихих реджекта Apple, KT-70202 SIGBUS ld, OOM K/N линка,
забитый диск, сломанная компиляция) — все устранены, уроки вшиты в код.

## Закрытые issues

0 open на стадии 0.

## CI runs

| Run | Результат |
|---|---|
| Release CLI (27360647399, v3.13.0) | build×2 ✅, verify-plugin-versions ✅, release ✅, **update-homebrew ✅ (jq -c фикс 3.12.0 работает)**, verify-checksums ✅, **publish-npm ✗** (lock desync) |
| CI main (lock fix, 27361101143) | все 6 jobs ✅ |

### publish-npm hotfix

`npm install` после version-бампа на macOS снова выпилил linux-only
`@emnapi/*` ветки из lock → `npm ci` на ubuntu упал. Полный rebuild
lock (`6402359`) + **ручной `npm publish`** с того же дерева (tarball
не содержит lock — артефакт идентичен tag). Provenance у 3.13.0
отсутствует (ручная публикация) — вернётся в 3.13.1+.

**Класс бага хронический (двое релизов подряд):** локальная macOS
`npm ci`-симуляция его не ловит принципиально — linux-ветка optional
deps проверяется только linux-джобой. Фикс процесса: после ЛЮБОГО
`npm install` проверять `grep '"@emnapi/runtime"' package-lock.json`
на наличие обеих версий (см. обновление профиля).

## Channels verification

| Канал | Результат |
|---|---|
| GitHub Release | 2 ассета (arm64 3.8MB, x86_64 4.1MB), notes опубликованы ✅ |
| npm | 3.13.0, latest поднят, `npx -y claude-in-mobile@3.13.0` → 3.13.0 ✅ |
| Homebrew | `brew upgrade` 3.12.0 → 3.13.0, бинарь печатает 3.13.0 ✅ |
| npm -g локально | 3.13.0 ✅ |

## Известные ограничения / отложено

- Rust CLI parity для apple provider (`cli/src/store/app_store.rs`).
- App Store release flow (не TestFlight): App Review submit, phased
  release.
- Авто-bump CFBundleVersion (`manageAppVersionAndBuildNumber`).
- npm provenance для 3.13.0 отсутствует (ручная публикация).
- langchain-kotlin фиксы (REVIEW_NEEDED when, -ld_classic KT-70202,
  heap, иконка/plist) — не закоммичены в том репо.

## Lessons learned

1. **macOS-симуляция `npm ci` не ловит linux-lock-desync.** Грепать
   lock на `@emnapi` после каждого `npm install`, либо гонять
   `npm ci` в linux-контейнере перед push.
2. **Validate-гейт перед store-upload обязателен** — "accepted" от
   altool ничего не гарантирует; уже в коде 3.13.0.
3. **Реальный E2E как release gate работает** — нашёл 7 дефектов
   которые ни один unit/smoke не видел.
