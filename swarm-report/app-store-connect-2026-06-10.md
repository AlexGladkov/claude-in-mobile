# Feature: App Store Connect / TestFlight — 2026-06-10

**Branch:** `feature/app-store-connect` (от main @ v3.12.0)
**Commit:** `df2ca1d`
**Target:** 3.13.0

## Задача

"Выложи релиз в testflight" — работа с магазином не только Google Play, но
и Apple: само собирает .ipa и выкладывает в TestFlight.

## Research (консилиум: architect / api / security / devops)

- **Architect:** store-слой = AbstractStoreClient + per-provider clients
  (google/huawei/rustore) + store-meta dispatch provider→action. Build
  orchestration в репо отсутствовал — новый слой. Рекомендация: mirror
  Google-паттерна, не platform plugin.
- **API:** ASC REST (JWT ES256, ≤20 мин TTL), .ipa не грузится через
  REST — нужен xcodebuild export destination=upload или altool.
  Zero-dep JWT через node:crypto (dsaEncoding ieee-p1363) — без jose
  (ERR_REQUIRE_ESM класс #43).
- **Security:** ключ .p8 — env-only (LLM-controlled путь = arbitrary
  file read + signed-exfil оракул), execFile argv-form, path
  containment, redaction подписей/JWT.
- **DevOps:** archive 3-10 мин + processing 5-15 мин ⇒ split actions
  (build/upload/status), polling по processingState ≥30s интервал.

## Реализовано

| Слой | Файлы | LOC |
|---|---|---|
| JWT | `src/store/asc-jwt.ts` | 86 |
| ASC client | `src/store/app-store-connect.ts` | 288 |
| Errors | `src/errors/asc.ts` (7 классов) | 77 |
| Build pipeline | `src/ios/build/` (7 файлов) | 1033 |
| Tools | `src/tools/appstore-tools.ts` (6 tools) | 339 |
| Meta | `store-meta.ts` provider apple + 6 testflight_* aliases | +51 |
| Validators | sanitize.ts: AscKeyId/IssuerId/XcodeScheme/VersionString + JWT redaction | +40 |
| Tests | app-store-connect (23) + build (35) + sanitize (18) + appstore-tools (27) | +103 |

## Контракт

```
store {provider: "apple", action: build|upload|status|set_notes|distribute|submit}
aliases: testflight_build / testflight_upload / testflight_status /
         testflight_set_notes / testflight_distribute / testflight_submit
env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_FILE (или ASC_PRIVATE_KEY)
     fallback: APP_STORE_CONNECT_API_KEY_* (fastlane-конвенция)
```

Сценарий «выложи в testflight»:
1. `testflight_build {projectPath}` — detect (Flutter/RN/KMP/Xcode) →
   archive → export ipa (4-11 мин)
2. `testflight_upload {ipaPath}` — altool upload (1-5 мин)
3. `testflight_status {bundleId}` — poll processingState (повтор ~30s
   пока PROCESSING)
4. `testflight_set_notes {bundleId, whatsNew}` — What to Test
5. `testflight_distribute {bundleId, groupName}` — в beta-группу;
   external → авто beta review submit

## Validation

- tsc clean, vitest **1210/1210** (baseline 1107 → +103)
- `npm run build` clean, `--version`/`--help` exit 0
- JSON-RPC smoke: store tool с provider enum
  `[google,huawei,rustore,apple]`, 11 actions; негативный путь без
  creds → typed `ASC_KEY_MISSING` с инструкцией; alias
  `testflight_status` резолвится.

## Граница валидации

Реальный аплоад в TestFlight требует: живой ASC API key + реальный iOS
проект + Xcode. Не проверялось в этой сессии — нужен прогон на проекте
пользователя перед 3.13.0 релизом.

## Отложено (follow-ups)

- Rust CLI parity (`cli/src/store/app_store.rs`, ES256 в jwt.rs) —
  CLI-пользователи пока покрыты MCP-сервером.
- App Store release (не TestFlight) — submit на App Review,
  phased release — отдельная фича.
- `manageAppVersionAndBuildNumber` авто-bump CFBundleVersion.

## Status: Done (TS-side), pending real-device E2E
