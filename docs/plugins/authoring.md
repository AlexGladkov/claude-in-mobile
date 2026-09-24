# Authoring a Plugin

A plugin is a TypeScript class implementing
[`SourcePlugin`](./api-v1.md#sourceplugin). Built-in plugins and external
plugins use the same contract. External packages are installed and verified by
the `mcp-devices plugin` lifecycle commands before the runtime imports them.

This guide walks through writing a minimal plugin from scratch. The same
shape applies whether the plugin wraps a CLI tool, a long-lived process, or
a remote API.

## 1. Pick an id and the capability set

The id must match `/^[a-z0-9][a-z0-9._-]*$/`. It appears in MCP tool names
(`<id>_<verb>`), in the registry, and in user-visible diagnostics.

Pick the smallest capability set the plugin truthfully provides. A bigger set
means more callers route work to you; if your `shell` is actually a thin
unsafe wrapper, declaring `shell` will mislead them. Use
[`capability-reference.md`](./capability-reference.md) to align with existing
plugins.

## 2. Lay out the directory

```
src/plugins/<id>/
  index.ts          # manifest + SourcePlugin class
  contract.test.ts  # invokes runPluginContract(factory)
  …                 # adapter, client, helpers
```

Tests live next to the source. Each plugin MUST ship a `contract.test.ts`
that calls `runPluginContract(factory)` (see
`src/plugins/contract-suite.ts`). The CI architecture test blocks plugins
that import other plugins or the legacy `device-manager.ts`.

## 3. Write the manifest

```ts
import type { PluginManifest, SourcePlugin, PluginContext } from "@mcp-devices/plugin-api";

export const MY_PLUGIN_MANIFEST: PluginManifest = {
  id: "myplugin",
  name: "My Plugin",
  version: "0.1.0",
  apiVersion: "1",
  capabilities: ["screen", "input"],
  permissions: ["device:read"],
  tools: ["myplugin_action"],
};

export class MyPlugin implements SourcePlugin {
  readonly manifest = MY_PLUGIN_MANIFEST;

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "myplugin_action",
      description: "Do something.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({ ok: true }),
    });
  }

  async dispose() {
    // close handles, kill children, etc.
  }
}

export function createMyPlugin(): SourcePlugin {
  return new MyPlugin();
}
```

`init` may be async; the kernel awaits it under a 10s timeout.

## 4. Package the plugin

External plugins must publish a regular npm package or provide a local package
directory with `main` or `module` pointing at the built entry. The entry must
export `default: () => SourcePlugin` or `createPlugin`.

The manifest id becomes the managed installation directory id. Keep it stable
and lower-case. Declare every sensitive permission the plugin needs; undeclared
permissions cannot be granted by the host.

Built-in plugins are wired into `src/runtime/bootstrap.ts` instead. External
plugins must not be added to the built-in bootstrap list.

## 5. Write the contract test

```ts
import { runPluginContract } from "../contract-suite.js";
import { createMyPlugin } from "./index.js";

runPluginContract(createMyPlugin);
```

This automatically verifies manifest shape, lifecycle behavior, and tool
registration. Add plugin-specific tests in the same file for behavior unique
to your plugin.

## 6. Install and verify

```sh
npm run build
node dist/index.js plugin install ./path/to/plugin
node dist/index.js plugin verify
node dist/index.js plugin grant myplugin device:read
node dist/index.js plugin external enable
```

`plugin install` disables npm lifecycle scripts, validates the manifest, writes
an integrity entry to `plugins.lock`, and leaves declared permissions denied
until an explicit grant. `plugin verify` detects modified files or metadata.

## 7. Respect the architecture rules

The architecture test (`src/architecture.test.ts`) enforces:

1. `kernel/**` must not import from `plugins/**`.
2. `kernel/**` must not import from platform modules (`adapters/`, `adb/`,
   `ios/`, `desktop/`, `browser/`, `aurora/`) or from `device-manager.ts`.
3. `plugins/<a>/**` must not import from `plugins/<b>/**`.
4. `plugins/**` must not import from `device-manager.ts`.

If you need a value from another plugin, use the [event bus](./api-v1.md#event-bus-coretopics).

## 8. Run

```sh
npm run test -- src/plugins/myplugin
```

A passing contract suite + your behavior tests is the bar for merge.

## Template

A copy-and-edit skeleton lives under [`docs/plugins/template/`](./template/).
