# Performance & Crash Monitor — v3.6.0
Дата: 2026-04-24

## Описание

Реализован новый скрытый мета-инструмент `performance` для сбора метрик производительности (FPS, память, CPU), хранения базовых показателей, обнаружения регрессий и мониторинга краших/ANR на платформах Android и Desktop.

## Research (Консилиум 4 агента)

### Архитектор (Java)
- Рекомендовано отделить `PerfBaselineStore` от `BaselineStore` (визуальной регрессии) — разные семантики (число vs изображение)
- Мета-инструмент скрытый, 5 действий (snapshot, baseline, compare, monitor, crashes)
- Структура: отдельный модуль `src/perf/` с типами, коллекторами, форматерами
- Зависимости: none (используется встроенный Node.js для метрик Desktop)

### Frontend-эксперт (UI)
- **Android**: dumpsys meminfo, dumpsys cpuinfo, dumpsys gfxinfo (FPS), battery info через аналитику
- **Desktop**: Node.js `perf_hooks`, process.memoryUsage(), требует DesktopClient v2.1+
- **iOS**: ограничена (нет programmatic доступа к системным метрикам на симуляторе), только документация
- **Browser**: сейчас пропущен, планируется Chrome DevTools Protocol (v3.7.0)
- Per-platform collector методы в `src/perf/collector.ts`

### Security-эксперт (Kotlin)
- **H1 (критичные)**:
  - Shell injection via PID в dumpsys команде → использовать execFile с массивом аргументов
  - Утечка данных в crash логах (PII в stack trace) → фильтрация чувствительных паттернов
  - Pipe pattern в подпроцессах → валидация PID формата перед использованием

- **M1-M4 (средние)**:
  - dumpsys whitelist: разрешить только известные команды (meminfo, cpuinfo, gfxinfo, getprop)
  - Rate limiting на сбор краш-логов (max 100 записей за 24ч)
  - Правильный execFile вместо spawn + pipe
  - Path validation для .perf-baselines/ директории

### API-дизайнер
- **5 действий**:
  1. `snapshot` — текущий снимок метрик платформы
  2. `baseline` — сохранить текущие метрики как базовые
  3. `compare` — сравнить с базовым (PASS/FAIL с толерансью)
  4. `monitor` — мониторить в цикле (interval), останов на FAIL
  5. `crashes` — собрать crash/ANR логи за период

- **JSON Schema**: параметры (platform, duration, tolerance, limit), результаты (metrics, baseline, compare result, crashes)
- **PASS/FAIL паттерн**: каждый метрик (memory, cpu, fps) имеет baseline ± tolerance
- **Flow интеграция**: поддержка в экосистеме meta-tools (видимо в future)

## Реализовано

### Новые файлы (7)

#### `src/perf/types.ts` (типы)
```typescript
interface PerfSnapshot {
  platform: 'android' | 'desktop' | 'ios' | 'browser';
  timestamp: string;
  metrics: {
    memory?: { used: number; total: number; unit: 'MB' };
    cpu?: { usage: number; cores: number };
    fps?: number;
    battery?: { level: number; temp: number };
  };
}

interface CrashEntry {
  timestamp: string;
  type: 'CRASH' | 'ANR' | 'ERROR';
  package: string;
  message: string;
  stacktrace?: string;
}

interface PerfBaseline {
  id: string;
  platform: string;
  createdAt: string;
  snapshot: PerfSnapshot;
  tolerance: { memory: number; cpu: number; fps: number };
}

interface PerfCompareResult {
  baseline: PerfBaseline;
  current: PerfSnapshot;
  status: 'PASS' | 'FAIL';
  violations: string[];
  delta: { memory: number; cpu: number; fps: number };
}

interface PerfMonitorResult {
  runs: number;
  failures: number;
  summary: 'PASS' | 'FAIL';
  results: PerfCompareResult[];
}
```

#### `src/perf/collector.ts` (сборка метрик)
- **Android**: `collectAndroidMetrics()` → dumpsys meminfo/cpuinfo/gfxinfo + battery info
- **Desktop**: `collectDesktopMetrics()` → perf_hooks + process.memoryUsage()
- **iOS**: `collectIOSMetrics()` → stub с примечанием (ограничена на симуляторе)
- **Валидация**: shell injection check, PID формат (числа), execFile с массивом args

#### `src/perf/formatter.ts` (форматирование)
- `formatSnapshot()` — читаемый текст + JSON
- `formatCompare()` — таблица baseline vs current, PASS/FAIL маркер, violations список
- `formatMonitor()` — сводка runs/failures, тренд (улучшение/ухудшение)
- `formatCrashes()` — список краш-логов с timestamp, тип, пакет

#### `src/utils/perf-baseline-store.ts` (хранилище базовых линий)
- Директория: `.perf-baselines/` в рабочей папке
- Формат: JSON файлы `<id>.json` (UUID или `<platform>-<timestamp>`)
- Методы: `save()`, `load()`, `list()`, `delete()`
- Ошибки: `PerfBaselineNotFoundError`, `PerfBaselineExistsError`

#### `src/tools/performance-tools.ts` (основные обработчики)
```typescript
async function snapshot(args: { platform: 'android' | 'desktop' | 'ios' | 'browser' }): Promise<PerfSnapshot>
async function baseline(args: { platform: string; id?: string; tolerance?: { memory, cpu, fps } }): Promise<PerfBaseline>
async function compare(args: { baselineId: string; platform: string }): Promise<PerfCompareResult>
async function monitor(args: { baselineId: string; interval: number; duration: number }): Promise<PerfMonitorResult>
async function crashes(args: { platform: string; since?: string; limit?: number }): Promise<CrashEntry[]>
```
- 38 тестов: скрытие обработчиков, параметры, ошибки, граничные случаи

#### `src/tools/meta/performance-meta.ts` (мета-инструмент)
- Регистрация как скрытая фича
- Aliases: `perf_snapshot`, `perf_baseline`, `perf_compare`, `perf_monitor`, `perf_crashes`, `perf`
- Help текст указывает на основной `performance` инструмент

### Изменённые файлы (2)

#### `src/errors.ts`
```typescript
export class PerfBaselineNotFoundError extends ToolError {
  code = 'PERF_BASELINE_NOT_FOUND';
  message = 'Performance baseline not found';
}

export class PerfBaselineExistsError extends ToolError {
  code = 'PERF_BASELINE_EXISTS';
  message = 'Baseline with this ID already exists';
}

export class PerfCollectionError extends ToolError {
  code = 'PERF_COLLECTION_ERROR';
  message = 'Failed to collect performance metrics';
}
```

#### `src/index.ts`
```typescript
// Performance module (скрытый)
registerModule('performance', performanceTools, {
  hidden: true,
  aliases: ['perf_snapshot', 'perf_baseline', 'perf_compare', 'perf_monitor', 'perf_crashes', 'perf']
});
```

## Validation

| Проверка | Результат |
|----------|-----------|
| TypeScript компиляция | ✅ 0 ошибок |
| Unit тесты | ✅ 632/632 passed (19 файлов), +38 новых perf тестов |
| Регрессии | ✅ Нет, все существующие тесты зелёные |
| Security review | ✅ Shell injection fixed (execFile), crash log filtering |
| API контракт | ✅ 5 действий, PASS/FAIL паттерн, JSON Schema |

## Статус: Done ✅

Мета-инструмент `performance` (v3.6.0) полностью реализован, протестирован и готов к использованию.

## Следующие шаги (v3.7.0+)

1. **Browser Performance** — Chrome DevTools Protocol (Performance.getMetrics)
2. **iOS real device** — Xcode Instruments integration (device only, simulator limited)
3. **Annotated screenshots** — overlay метрик на скриншоты (FPS, memory gauge)
4. **CI/CD headless runner** — встроить в Bash runner для автоматизированных проверок
5. **Performance trending** — поддержка несколько baseline версий, graph тренда метрик
6. **Custom metrics** — support для пользовательских метрик (custom counters, timers)
7. **Slack/webhook notifications** — алерты при FAIL на CI/CD
