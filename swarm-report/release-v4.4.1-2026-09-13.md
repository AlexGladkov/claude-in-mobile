# Release v4.4.1 — 2026-09-13

## Включено

- Усилены границы локального хранения, subprocess/network output, JSON/NDJSON payloads, изображений, accessibility trees, debugger queues/caches и browser snapshots во всех TypeScript, Rust, Kotlin и Python runtime-компонентах.
- Добавлены строгие схемы и проверки идентификаторов/путей для CDP, desktop JSON-RPC, WebDriverAgent, simulator, store API, HarmonyOS, recorder и debugger trust boundaries; ошибки и terminal output очищаются от credentials и управляющих символов.
- Native CLI использует приватные collision-resistant пути, атомарную запись, bounded command output и отказ от symlinked screenshot targets.
- CI теперь запускает desktop-companion Gradle tests, компилирует Python debug daemon, typecheck-ит все Swift helpers и выполняет native Rust `cargo check --locked` на macOS.
- Версия `4.4.1` синхронизирована во всех 23 release-полях, npm lockfile и Cargo lockfile.

## Закрытые issues

- Stage 0 gate: открытых issues перед исходным релизом и повторным hotfix-проходом не было.
- Коммиты релиза не содержат `Closes #N`; follow-up комментарии не требовались.
- PR #49 с миграцией Aurora `audb` 0.2 не включён: ветка конфликтует, требует исправления boolean CLI flags, platform guards, документации и проверяемого `audb` 0.2 contract. Отложено до 4.5.0.

## CI runs

- Initial coverage branch CI: [34775221420](https://github.com/AlexGladkov/claude-in-mobile/actions/runs/34775221420) — success, включая новые Kotlin, Python и Swift jobs.
- Initial tag workflow `v4.4.0`: [34775642587](https://github.com/AlexGladkov/claude-in-mobile/actions/runs/34775642587) — failed до публикации: оба Darwin build job обнаружили отсутствующий macOS-only вызов `run_ok` в `doctor`.
- Hotfix branch CI: [34776277439](https://github.com/AlexGladkov/claude-in-mobile/actions/runs/34776277439) — success, 10/10 jobs; новый `macos-rust-check` подтвердил исправленный macOS compile path.
- Tag release workflow `v4.4.1`: [34776367120](https://github.com/AlexGladkov/claude-in-mobile/actions/runs/34776367120) — success, 8/8 jobs: setup, version verification, Darwin builds ×2, npm publish, GitHub Release, Homebrew update, checksum verification.
- Local TypeScript verification: build passed; Vitest 77 files / 1495 tests passed with bounded worker concurrency. Four tests, ранее истёкшие по timeout при одновременном полном Rust build, отдельно прошли 80/80 без resource contention.
- Local Rust verification: fmt/check/release build passed; aggregate Cargo run passed 233 tests with 2 ignored; mandatory setup, REPL observability, live TUI и Harmony suites passed 28/28.
- Local desktop Gradle tests and Python bytecode compilation passed. `npm audit --audit-level=low` returned 0 vulnerabilities; `cargo audit --deny warnings` passed.
- Runtime smoke: Node `--version` and `--help` exited normally; browser client ESM import succeeded; release native supervisor returned ready/shutdown.
- `npm pack` contained bundled `@mcp-devices/plugin-api`; installation into a clean `/tmp` project returned `4.4.1` through both `mcp-devices` and `claude-in-mobile` binary aliases.

## Channels verification

- **GitHub:** [v4.4.1](https://github.com/AlexGladkov/claude-in-mobile/releases/tag/v4.4.1) is published with two native assets:
  - `claude-in-mobile-4.4.1-darwin-arm64.tar.gz` — 3,621,470 bytes, SHA-256 `cd8e6a8bd81fd958c2808c4727558ebdf0af22bff9a322cc322f5e4a5345b341`.
  - `claude-in-mobile-4.4.1-darwin-x86_64.tar.gz` — 3,853,959 bytes, SHA-256 `2d5fc9b3cb2f06cfaf42db2545a1cc0f903eea5cdc4077b14758de183d57daf5`.
- **npm:** `mcp-devices@4.4.1` and `claude-in-mobile@4.4.1` are published; `mcp-devices` `latest` points to `4.4.1`; provenance metadata reports SLSA provenance. Public clean-directory `npx` smoke returned `4.4.1` for both packages.
- **Homebrew:** canonical `AlexGladkov/homebrew-tap/mcp-devices.rb` reports `4.4.1`; both formula checksums match independently downloaded GitHub assets; release job `verify-checksums` passed.

## Известные ограничения / отложено

- Фактические `brew update`, `brew upgrade` и installed-binary smoke не запускались на этой WSL/Linux workstation: Homebrew/macOS недоступны. Публикация формулы и целостность обоих Darwin-архивов подтверждены release workflow, чтением канонической формулы и локальной SHA-256 сверкой скачанных assets.
- Матрица релиза публикует только Darwin ARM64 и x86_64 assets; Linux release asset отсутствует по текущей конфигурации workflow.
- Неудачный аннотированный тег `v4.4.0` остаётся в GitHub для истории failed workflow; GitHub Release и npm package `4.4.0` не создавались.

## Lessons learned

- Linux Rust CI не компилирует функции под `#[cfg(target_os = "macos")]`. Удаление общего helper прошло Linux preflight и branch CI, но сломало оба Darwin release build. Постоянный `macos-rust-check` теперь компилирует native CLI до создания тега.
- Неудачный release workflow не перезапускался и тег `v4.4.0` не перемещался. Исправление прошло полный Stage 0–5 цикл, отдельные commits, новый аннотированный тег `v4.4.1` и новый release workflow, что сохранило согласованность GitHub, npm и Homebrew artifacts.
