# Plugin Template

This directory is a copy-and-edit starting point for a new claude-in-mobile
plugin. It is documentation, not production code — nothing here is loaded at
runtime.

## Use

1. Copy `docs/plugins/template/src/` into `src/plugins/<your-id>/`.
2. Replace `template` everywhere with your plugin id.
3. Update `manifest.capabilities` to truthfully describe what the plugin
   provides — see [`capability-reference.md`](../capability-reference.md).
4. Implement `init` (register MCP tools) and `dispose` (release resources).
5. Append `createYourPlugin` to `DEFAULT_BUILTINS` in
   `src/runtime/bootstrap.ts`.
6. Run `npm run test -- src/plugins/<your-id>` and fix any contract failures.

See [`authoring.md`](../authoring.md) for the full walkthrough and
architecture rules.
