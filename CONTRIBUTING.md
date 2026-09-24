# Contributing

Thanks for contributing to `mcp-devices`.

## Before opening a change

1. Search existing issues and pull requests.
2. Keep platform-specific code inside its plugin package or adapter.
3. Do not import one plugin package from another.
4. Do not add credentials, device dumps, screenshots, or generated build output.
5. For a new external plugin, use the public `@mcp-devices/plugin-api` contract and declare every required permission in its manifest.

## Local checks

```sh
npm ci
npm run build
npx tsc --noEmit
npx vitest run
cd cli && cargo test --locked --lib
```

The desktop companion and macOS-only helpers require their platform toolchains. The CI workflow is the source of truth for those checks.

## External plugin checklist

An external plugin should:

- publish a regular npm package with `main` or `module` pointing at the built entry;
- export `default: () => SourcePlugin` or `createPlugin: () => SourcePlugin`;
- keep the plugin manifest `id` equal to the installed plugin directory id;
- declare `apiVersion: "1"`;
- declare only the capabilities and permissions it actually needs;
- include a contract test using the plugin API;
- avoid importing another plugin package directly;
- document external binaries, operating-system requirements, and data handling.

Install a local package while developing:

```sh
node dist/index.js plugin install ./path/to/plugin
node dist/index.js plugin verify
MCP_DEVICES_EXTERNAL_PLUGINS=1 node dist/index.js --help
```

The runtime remains opt-in for external plugins. Installation writes a per-user `plugins.lock`; loading also requires integrity verification and permission grants for declared sensitive permissions.

## Pull requests

- Explain the user-visible behavior and security impact.
- Include focused tests for new contracts and failure paths.
- Update the relevant documentation and changelog entry.
- Keep commits small enough to review.
- Do not bypass checks by weakening types, removing limits, or broadening permissions.

## Commit and review expectations

Reviewers should be able to verify the change from the diff and the documented checks. Changes that affect the plugin API, manifests, lockfiles, release workflows, or security policy require explicit compatibility and migration notes.
