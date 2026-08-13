# Release v3.15.0 — 2026-08-13

## Включено
- Android runtime debugger — новый MCP-модуль `debug` (off by default).
  Нативный TS JDWP-клиент поверх `adb forward jdwp:`. 12 действий: attach/break/
  remove_break/poll/pause_state/threads/eval/set_var/step/resume/detach/sessions.
- iOS/LLDB-сайдкар — код в дереве, но `platform:'ios'` отклоняется (в 3.16).

## Закрытые issues
- Нет (0 open на момент релиза; Стадия 0 gate чист).

## Процесс (2 фича-консилиума + 1 release-safety консилиум)
- 1-й консилиум: 12 blocker'ов → закрыты (`7cf2c48`).
- 2-й консилиум: Android lifecycle-майоры → закрыты, iOS gated в 3.16 (`cf8d3c5`).
- 3-й (release-safety): единогласный GO — аддитивно, off-by-default, ноль
  import-side-effects, graceful degradation, publish пройдёт.

## CI runs
- release.yml run 31703780949 — **success** (7/7 jobs): build arm64/x86_64,
  verify-plugin-versions, publish-npm, release, update-homebrew, verify-checksums.
- Первый релиз с активным #54-фиксом: CI сам залил `.sha256` sidecar'ы,
  verify-checksums прошёл (совпадают).

## Channels verification
- GitHub: 2 darwin tar.gz (arm64+x86_64) по ~3MB + sidecars.
- npm: 3.15.0, dist-tag `latest` → 3.15.0; npx-smoke публично → 3.15.0.
- Homebrew: tap-формула на 3.15.0 с реальным sha256.

## Известные ограничения / отложено (3.16)
- iOS/Simulator LLDB: attach-launch timeout+reconcile, single-thread Detach
  isolation, poll-queue/object memory bounds, fd-level stdout redirect.
- JDWP deferred breakpoints; watchpoint/exception-trap verbs; eval overload
  resolution по полной сигнатуре (сейчас по arity).
- Deviation: профильный порог `@emnapi/runtime` ≥4 устарел после sharp-0.35 +
  overrides — фактический count=3, publish-npm зелёный (sharp optional,
  linux-x64 не тянет emnapi). Обновить порог в release.md.

## Lessons learned
- Release-safety консилиум ПЕРЕД пушем тега дал уверенность и снял ложный
  emnapi-блокер. Стоит закрепить как часть Стадии 4/5 для крупных фич.
