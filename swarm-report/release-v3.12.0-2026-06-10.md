# Release v3.12.0 — 2026-06-10

## Включено

- **Phases 1-7 + D1-D7** (подготовлены 06-08): shared tool-layer helpers,
  defineTool+zod (24 файла), capability-narrowing API, kernel plugin set,
  external plugin loader, plugin-api 1.0.0, scoring table extraction,
  per-platform npm shims.
- **D8** (06-09): common-schema (platformEnum из BUILTIN_PLATFORMS),
  dispatchByPlatform, meta-tool descriptor barrel, RuntimeContext,
  ui-parser split.
- **D9 iter1-3** (06-09): 15 god-object splits — device-manager,
  recorder, element-builder, image, sandbox/sensor/ui-tools, index
  bootstrap, errors, adb/ios/desktop/browser client helpers.
- **Security hardening** (06-10): 6 pre-existing фиксов по итогам
  3-консилиумного аудита (CDP listener leak, URL allowlist, desktop
  process disposal, loader path containment, prefs-write escaping).
- **E2E harness**: scripts/smoke-e2e.mjs — 16/16 на Android emu + iOS
  sim + Chrome.

## Закрытые issues

Нет открытых issues на момент релиза (Stage 0 — 0 open).

## CI runs

| Run | Результат |
|---|---|
| Release CLI (27292791839, tag v3.12.0) | build×2 ✅, verify-plugin-versions ✅, release ✅, publish-npm ✅, **update-homebrew ✗** (наш баг — multiline jq в GITHUB_OUTPUT), verify-checksums skipped |
| CI main 27292789593 (merge commit) | ✗ — те же 3 пре-существующих причины branch CI |
| CI main 27293801881 (ci-фиксы) | lint/test ✗ — package-lock out of sync после npm audit fix |
| CI main 27294088016 (lock v1) | lint/test ✗ — lock всё ещё без linux-ветки @emnapi |
| CI main (0c5e7cb, lock v2) | **✅ все 6 jobs зелёные** |

## Hotfix-цепочка после тега

1. `ccd9501` ci: workspace tsc + jq -c + npm/cargo audit fixes + audit.toml
2. `00b69e0` fix(ci): package-lock regen (недостаточный)
3. `0c5e7cb` fix(ci): полный rebuild lock с нуля → CI зелёный

Homebrew formula обновлена вручную (job упал): tap commit `3f8e06c`,
SHA сверены с release-ассетами напрямую.

## Channels verification

| Канал | Проверка | Результат |
|---|---|---|
| GitHub | `gh release view` — 2 ассета (arm64 3.8MB, x86_64 4.1MB) | ✅ |
| npm | `npm view claude-in-mobile@3.12.0` + dist-tags latest | ✅ 3.12.0 |
| npm (runtime) | `npx -y claude-in-mobile@3.12.0 --version` из чистой папки | ✅ 3.12.0 |
| Homebrew | `brew upgrade` → Cellar 3.12.0; `brew trust` понадобился (новое требование brew для third-party taps) | ✅ |
| Локальный PATH | `/opt/homebrew/bin/claude-in-mobile` оказался npm-g симлинком 3.11.5 поверх brew — обновлён `npm i -g @3.12.0` | ✅ 3.12.0 |

## Известные ограничения / отложено

- 4.0.0 breaking items: вынос платформенных плагинов в shim-пакеты,
  удаление deprecated get*Client, нативные image content blocks в
  ToolResult, transport-level multi-session.
- imageproc 0.27 — semver bump отложен.
- cargo audit ignores (audit.toml): rsa Marvin (нет фикса), core2/paste
  (transitive rav1e), rand 0.8.5 — ревизить каждый релиз.
- Node 20 actions deprecation warning в workflows — обновить до
  2026-06-16.

## Lessons learned

1. **Branch CI должен быть зелёным ДО старта релиза.** ci.yml падал с
   Phase 5 (workspace tsc), это заметили только при релизном пуше.
   В профиль: добавить в Stage 4 проверку `gh run list --branch
   release/X` на красноту.
2. **GITHUB_OUTPUT принимает только однострочные значения** — jq без
   `-c` ломает шаг молча на этапе вывода. Класс бага воспроизводим в
   любом workflow со structured output.
3. **`npm audit fix` портит lock в workspace-репо** — записывает
   неполные optional-dep ветки и сносит postinstall-симлинк. После него
   обязательны: полный rebuild lock с нуля + `npm ci` симуляция на
   чистом клоне + восстановление симлинка.
4. **`--package-lock-only` недостаточен** для починки рассинхронённого
   lock — он сохраняет стейловые резолюции. Только `rm lock +
   node_modules && npm install`.
5. **brew trust** теперь требуется для third-party taps — добавить в
   README инструкцию установки.
6. **npm -g симлинк перекрывает brew binary** при совпадении prefix —
   у пользователей с обоими каналами `--version` может врать. Стоит
   задокументировать.
