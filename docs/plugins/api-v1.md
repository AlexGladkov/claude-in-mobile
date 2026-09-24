# Plugin API v1 — Reference

Public contract between the claude-in-mobile microkernel and built-in /
external plugins. The contract lives in the standalone package
`@mcp-devices/plugin-api`.

Companion documents:

- ADR 0001 — Microkernel architecture
- ADR 0002 — Plugin API v1 contract
- [Authoring guide](./authoring.md)
- [Capability reference](./capability-reference.md)

## Module entrypoint

```ts
import type {
  Capability,
  EventBus,
  PluginContext,
  PluginManifest,
  PluginPermission,
  SourcePlugin,
  ToolDefinition,
} from "@mcp-devices/plugin-api";
```

## `SourcePlugin`

```ts
interface SourcePlugin {
  readonly manifest: PluginManifest;
  init(ctx: PluginContext): Promise<void> | void;
  dispose?(): Promise<void> | void;
}
```

A plugin is a value (usually a class instance). The kernel never inspects
fields beyond `manifest`, `init`, `dispose`.

## `PluginManifest`

interface PluginManifest {
  readonly id: string;            // /^[a-z0-9][a-z0-9._-]*$/
  readonly name: string;
  readonly version: string;       // plugin own semver
  readonly apiVersion: "1";       // contract major
  readonly capabilities: readonly Capability[];
  readonly permissions?: readonly PluginPermission[];
  readonly tools?: readonly string[];
  readonly description?: string;
  readonly homepage?: string;
}
```

Validation is performed by the registry on `register(plugin)`. A failure
throws `PluginContractError` (or one of its subclasses
`ApiVersionMismatchError`, `CapabilityMissingError`).


### External plugin permissions

`permissions` is a declaration, not a sandbox. The host refuses to load an
external plugin unless every declared permission has an explicit user grant in
`~/.mcp-devices/plugin-permissions.json` (or the path from
`MCP_DEVICES_PLUGIN_PERMISSIONS`).

| Permission | Intended use |
|------------|--------------|
| `device:read` | Read device state or screen data |
| `device:write` | Send input or mutate device state |
| `filesystem:read` | Read host files |
| `filesystem:write` | Write host files |
| `network` | Make network requests |
| `subprocess` | Spawn host processes |
| `credentials:read` | Read configured credentials |

## `PluginContext`

Passed to `init`. Plugins must not capture it; the kernel may rebuild it
between runs.

```ts
interface PluginContext {
  readonly logger: Logger;
  readonly config: Readonly<Record<string, unknown>>;
  readonly eventBus: EventBus;
  registerTool(def: ToolDefinition): void;
}
```

- `logger` — stderr-only structured logger. Never write to stdout (reserved
  for MCP JSON-RPC framing).
- `config` — frozen slice of user config scoped to this plugin's id.
- `eventBus` — typed pub/sub over `CoreTopics`. Use it to coordinate with
  other plugins **without importing them**.
- `registerTool(def)` — register an MCP tool. Names should be `<pluginId>_<verb>`.

## Lifecycle FSM

```
unregistered → registered → initializing → active → disposing → disposed
                                  │
                                  └── failed (isolated, kernel survives)
```

- `init` runs under a 10s timeout.
- A throw in `init` or in any user handler is caught by the kernel; the plugin
  enters `failed` while the registry keeps serving the rest.
- `dispose` runs under a 5s timeout and is idempotent.

## Event bus (`CoreTopics`)

| Topic                  | Payload                                                |
|------------------------|--------------------------------------------------------|
| `plugin.registered`    | `{ pluginId }`                                         |
| `plugin.initialized`   | `{ pluginId }`                                         |
| `plugin.failed`        | `{ pluginId, error }`                                  |
| `plugin.disposed`      | `{ pluginId }`                                         |
| `session.spawned`      | `{ pluginId, sessionId }`                              |
| `session.died`         | `{ pluginId, sessionId, exitCode? }`                   |
| `device.connected`     | `{ pluginId, deviceId }`                               |
| `device.disconnected`  | `{ pluginId, deviceId }`                               |
| `tool.invoked`         | `{ tool, args }`                                       |

Plugins MAY declare additional topics through TypeScript module augmentation
of `CoreTopics`. A new topic added by one plugin must be considered public to
all other plugins running in the same kernel.

## Versioning rules

- The package `@mcp-devices/plugin-api` follows semver independently of
  the product.
- Minor releases may add optional fields, capabilities, topics. Plugins
  written against an earlier minor continue to work.
- Patch releases are documentation / type-fixing only.
- Major bumps may remove or rename anything. The previous major is supported
  for at least one minor of the product following the bump.

## External plugin loading

The host supports managed npm/local package installation through
`mcp-devices plugin install`. Installation is script-free, records package
metadata and a SHA-256 directory digest in `plugins.lock`, and requires
explicit permission grants before loading. External loading is disabled unless
`plugin external enable` or `MCP_DEVICES_EXTERNAL_PLUGINS=true` is set.

## Not in v1

- Process or VM sandboxing for plugin code.
- Hot reload.
- Bidirectional communication between plugin runtimes (Node ↔ Rust).
