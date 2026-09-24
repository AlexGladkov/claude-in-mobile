# Security Policy

## Supported versions

Security fixes are applied to the current release line. Upgrade to the latest release before reporting an issue when possible.

## Reporting a vulnerability

Do not open a public GitHub issue for a suspected vulnerability. Email **alex@gladkov.dev** with:

- a concise description and impact;
- affected version or commit;
- reproduction steps or a minimal proof of concept;
- whether the issue requires a connected device, external plugin, or special configuration.

Please do not include real credentials, private device data, screenshots containing personal information, or production tokens. Replace them with synthetic values.

The maintainer target is acknowledgement within 48 hours and a fix or mitigation within two business weeks for high-severity issues. Timelines can change when coordinated disclosure requires upstream fixes.

## High-risk surfaces

The project can execute commands through local device bridges and terminal tooling. External plugins are arbitrary local JavaScript and must be treated as trusted code. Remote or shared deployments must add authentication and network isolation; local installation alone is not a sandbox.

## Existing protections

- external plugins are opt-in;
- managed plugins are integrity-checked against `plugins.lock`;
- declared sensitive permissions require explicit grants;
- package and entry paths are validated and confined;
- plugin and artifact storage uses private file permissions and size limits;
- MCP responses and REPL output use redaction and bounded output paths;
- CI runs dependency and Rust audits.

## Disclosure

After a fix is available, the maintainer may publish a coordinated advisory with affected versions, impact, mitigation, and credit to the reporter unless anonymity is requested.
