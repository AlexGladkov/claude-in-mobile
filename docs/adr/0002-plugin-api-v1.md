# ADR 0002: Plugin API v1 Contract

- Status: Accepted
- Date: 2026-06-07
- Release: 3.11.0

## Context

ADR 0001 фиксирует microkernel-архитектуру. Этот документ закрепляет публичный
контракт между ядром и плагинами.

Контракт живёт в отдельном workspace-пакете `@claude-in-mobile/plugin-api`,
версионируется независимо от продукта. Это даёт:

- стабильный API surface для авторов плагинов;
- защиту от breaking change при минорных релизах продукта;
- возможность поддерживать несколько версий контракта одновременно (по мере
  расширения).

## Decision

### Capability enum (исчерпывающий список v1)

```ts
type Capability =
  | "screen"        // screenshot, screen recording
  | "input"         // tap/swipe/text/key
  | "ui"            // ui hierarchy / accessibility tree
  | "shell"         // exec arbitrary shell command
  | "appLifecycle"  // launch/stop/install/uninstall
  | "permissions"   // grant/revoke/reset
  | "logs"          // streaming log source
  | "terminal"      // interactive PTY (REPL, SSH)
  | "fileTransfer"  // push/pull files
  | "deviceMgmt";   // list/select devices
```

Расширение enum = minor bump `plugin-api`. Удаление = major.

### Core types

```ts
interface PluginManifest {
  id: string;                       // "android", "repl", "ssh"
  name: string;
  version: string;                  // plugin own semver
  apiVersion: "1";                  // contract major
  capabilities: Capability[];
  tools?: string[];                 // MCP tool ids exposed by plugin
}

interface PluginContext {
  logger: Logger;
  config: Record<string, unknown>;
  eventBus: EventBus;
  registerTool(def: ToolDefinition): void;
}

interface SourcePlugin {
  readonly manifest: PluginManifest;
  init(ctx: PluginContext): Promise<void> | void;
  dispose?(): Promise<void> | void;
}
```

### Lifecycle FSM

```
unregistered → registered → initializing → active → disposing → disposed
                                  │
                                  └── failed (isolated, kernel остаётся жив)
```

- `init` под таймаутом 10s. Просрочка → плагин в `failed`.
- `dispose` идемпотентен; вызывается даже после `failed`.
- Crash одного плагина не валит другие (`try/catch` на стороне ядра).

### Event bus topics (v1)

```ts
type CoreTopics = {
  "plugin.registered":   { pluginId: string };
  "plugin.initialized":  { pluginId: string };
  "plugin.failed":       { pluginId: string; error: string };
  "plugin.disposed":     { pluginId: string };
  "session.spawned":     { pluginId: string; sessionId: string };
  "session.died":        { pluginId: string; sessionId: string; exitCode?: number };
  "device.connected":    { pluginId: string; deviceId: string };
  "device.disconnected": { pluginId: string; deviceId: string };
  "tool.invoked":        { tool: string; args: unknown };
};
```

Плагины могут декларировать собственные топики через `declare module`.

### Versioning rules

- `plugin-api` semver независим от `claude-in-mobile`.
- v1.x — minor добавляет необязательные поля, capabilities, событийные топики.
- v1.x — patch только баг-фиксы документации/типов.
- v2.0 — любое breaking. Старый контракт поддерживается ещё один minor продукта.

Плагин декларирует `apiVersion: "1"` в манифесте. Ядро отказывает в регистрации, если
major не совпадает с поддерживаемыми.

### Что НЕ входит в v1

- runtime-loading сторонних плагинов из произвольных путей (in-tree only);
- sandbox/permissions модель (отложено до отдельного ADR);
- hot reload (потенциально через `notifyToolListChanged`, но не в 3.11);
- кодогенерация tool-handler-ов из манифеста (manifest пока только метаданные).

## Consequences

- Авторы плагинов (включая собственных) пишут против стабильного импорта
  `@claude-in-mobile/plugin-api`, а не против внутренней структуры продукта.
- Внутренний рефакторинг ядра не ломает плагины, пока публичные типы стабильны.
- Любая новая capability требует обсуждения и ADR-дополнения.

## References

- ADR 0001 — Microkernel Architecture
- semver.org
