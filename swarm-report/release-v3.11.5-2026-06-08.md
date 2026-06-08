# Release v3.11.5 — 2026-06-08

## Включено

- **fix(kernel):** REPL plugin tools (`repl_spawn`, `repl_send`, `repl_key`,
  `repl_expect`, `repl_snapshot`, `repl_list`, `repl_kill`) теперь реально
  surfaced через MCP. До 3.11.5 `bootstrapKernel()` существовал в коде но
  не вызывался из `src/index.ts` — kernel инстанциировался только
  bootstrap.test.ts. Production-MCP клиенты видели 0 repl_* tools, хотя
  3.11.4 release notes их обещали.

  Изменения:
  - `src/index.ts`: `bootstrapKernel({ builtins: [() => createReplPlugin()] })`
    + `await kernel.initAll()`
  - Adapter: `PluginToolDefinition` (plugin-api) → MCP `ToolDefinition`
    (handler-сигнатуры различаются)
  - `kernel.disposeAll()` в shutdown — Rust supervisor умирает корректно
  - Platform-плагины (android/ios/desktop/web/aurora) остаются на legacy
    meta-tool layer — полная kernel-миграция отложена в 3.12

## Закрытые issues

Open issues = 0 на момент Stage 0. Регрессия зафиксирована из
пользовательского репорта в чате (не было issue в трекере).

## CI runs

- Release run `27127464725` — все 6 jobs зелёные:
  - build (arm64 + x86_64)
  - verify-plugin-versions (4 манифеста синхронны)
  - release (GH Release создан)
  - publish-npm (provenance, id-token OK)
  - update-homebrew (formula патчена)
  - verify-checksums (sha256 совпадают)

## Channels verification

- **GitHub:** v3.11.5 + 2 assets (darwin-arm64 3.8 MB, darwin-x86_64 4.0 MB)
- **npm:** `claude-in-mobile@3.11.5` published, `latest` dist-tag поднят
- **npm smoke:** `npx -y claude-in-mobile@3.11.5 --version` →
  `3.11.5` + `[kernel] registered 7 plugin tools: repl_spawn, repl_send,
  repl_key, repl_expect, repl_snapshot, repl_list, repl_kill`
- **Homebrew:** `brew upgrade claude-in-mobile` → 3.11.5

## Local smoke (Stage 5)

- `npm run build` — zero TS errors
- `vitest`: 1107 passed / 0 failed
- `cargo build --release` + `cargo test --lib` — 87 passed
- `node dist/index.js --version|--help` — exit 0
- MCP stdio probe `tools/list` — 27 tools, 7 из них `repl_*`
- `repl-supervisor` — `{"event":"ready"}` + `{"id":"r1","result":"ok"}`
- Tarball install в чистом /tmp без workspace → 3.11.5 + repl tools

## Известные ограничения / отложено

- Platform plugins (android/ios/desktop/web/aurora) пока не идут через
  kernel — двойная регистрация (legacy meta-tools + plugin manifest)
  избегается за счёт того, что `bootstrapKernel` получает только
  REPL в `builtins`. Полная миграция — v3.12.

## Lessons learned

- **Regression-классы.** Test coverage был, но bootstrap.test.ts проверял
  только сам kernel. Нет интеграционного теста на `src/index.ts` →
  `tools/list`. Добавить smoke "после старта entry point — все
  заявленные tools видны через MCP tools/list". Сейчас roadmap-item
  для 3.12.
- **Release notes ≠ работа.** 3.11.4 обещал repl_*, не surfaced.
  Добавить в release.md профиль: для каждого нового manifest.tools
  пункта — runtime smoke `tools/list | grep <name>` обязателен перед
  публикацией.
- **Microkernel split.** Когда есть параллельные системы (legacy
  registry + kernel), нужна single source of truth. Текущий патч —
  bridge, но это техдолг. 3.12 должен унифицировать.
