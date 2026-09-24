# Security Baseline

`mcp-devices` runs locally under the user's account and drives interactive sources such as Android, iOS, desktop, browser, and terminal REPLs. The local process therefore has the permissions of the user who starts it. The primary protection goal is preventing accidental disclosure to MCP clients, transcripts, artifacts, and other plugins.

## Threat model

- A tool invocation can control a connected device or execute a local command.
- REPL output can contain credentials and private source code.
- External plugins are arbitrary JavaScript loaded into the server process. They are trusted local code, not a sandbox.
- A remote or shared deployment needs a separate network and authentication boundary; local defaults do not make it safe to expose publicly.

## Runtime controls

1. **External plugins are opt-in.** Enable them with `mcp-devices plugin external enable` or `MCP_DEVICES_EXTERNAL_PLUGINS=1`.
2. **Managed plugins are locked.** Installed plugins live under `~/.mcp-devices/plugins/` and are recorded in `~/.mcp-devices/plugins.lock`. The loader verifies package metadata, manifest metadata, entry containment, and a deterministic SHA-256 directory digest before importing a plugin.
3. **Sensitive permissions are explicit.** A plugin may declare `device:read`, `device:write`, `filesystem:read`, `filesystem:write`, `network`, `subprocess`, or `credentials:read`. Declared permissions are denied until the user grants them with `mcp-devices plugin grant <id> <permission>...`.
4. **Permission declarations are a load gate, not a sandbox.** A plugin can still perform arbitrary JavaScript operations after it is trusted. Do not install untrusted packages; process isolation remains a future hardening option.
5. **Package and entry paths are confined.** Package metadata is bounded, entry paths must remain inside the plugin directory, symbolic links are rejected, and malformed plugins are skipped without stopping the host.
6. **REPL output is redacted.** Credential-like values are filtered before MCP responses or optional asciicast recording. Scrollback is not persisted by default.
7. **Persistent state is private.** Configuration, lockfiles, grants, and runtime artifacts use bounded reads, atomic writes, and private file permissions.
8. **Tool output is bounded.** MCP responses and diagnostic artifacts have size limits and use sanitized error messages.

## Plugin installation policy

Prefer npm packages or local package directories that you can audit. Installation uses `npm pack` and dependency installation with lifecycle scripts disabled. Verify the resulting lock entry before enabling a plugin:

```sh
mcp-devices plugin install <package>
mcp-devices plugin verify
mcp-devices plugin grant <id> <declared-permission>
mcp-devices plugin external enable
```

The loader rejects tampered files, changed manifests, unsupported API versions, missing lock entries, and missing permission grants.

## CI and release controls

- npm publishing uses OIDC Trusted Publishing rather than a long-lived npm token.
- Release actions are pinned to commit SHAs.
- CI runs npm and Cargo audits.
- CodeQL and OpenSSF Scorecard run in GitHub Actions.
- Release binaries receive GitHub artifact attestations.
- Security policy and vulnerability reporting are available from the repository root.

## Reporting

Do not open a public issue for a suspected vulnerability. Follow the private reporting process in [`SECURITY.md`](../SECURITY.md).
