# Security Baseline (3.11.0)

claude-in-mobile runs locally under the user's account and drives interactive
sources (Android, iOS, desktop, browser, terminal REPL). Because it is granted
the trust of the user it impersonates, any input flowing through it is
sensitive — including, in particular, the output of REPL sessions, which is
the most likely place developer credentials surface.

This document is the baseline the 3.11.0 release commits to. It is not the
final permission model — third-party plugin loading and capability-based
sandboxing arrive in 4.0 with their own ADR.

## Threat model (summary)

- Local user trust boundary. Anything Claude does locally inherits the
  user's filesystem, env, and network access. We do not attempt to defend
  against the user attacking themselves; we defend against unintentional
  leakage to MCP clients and downstream LLM transcripts.
- Two material risks:
  - **Credential exfiltration through MCP responses.** A REPL session prints
    a token; the LLM reads it; the transcript persists it.
  - **Arbitrary command execution.** `repl_spawn` accepts a free-form
    command. Equivalent to `system_shell`; same trust posture.

## Controls in 3.11.0

1. **Redaction layer on plugin output.** All `repl_snapshot` responses pass
   through `src/plugins/repl/redaction.ts` before leaving the plugin. The
   patterns cover AWS keys, GitHub PATs, OpenAI/Anthropic keys, Bearer
   headers, JWTs, Google API keys, Slack tokens. False positives are
   acceptable; false negatives are not. Update the pattern list whenever a
   new credential shape appears in incident reports.
2. **ENV allowlist.** The REPL supervisor process inherits only
   `PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ` from the MCP server (see
   `minimalEnv()` in `src/plugins/repl/client.ts`). Per-session environment
   is passed explicitly through `repl_spawn.env` and never sourced from
   `process.env`.
3. **In-process REPL state.** Session scrollback is never persisted to disk.
   The supervisor process dies with the MCP server (parent close → child
   reader EOF → exit), so secrets cannot linger across restarts.
4. **No third-party plugins.** Plugins are in-tree only. There is no plugin
   loader for arbitrary directories; manifests are not consumed from
   userland. The runtime contract is published as a separate package
   (`@claude-in-mobile/plugin-api`) so out-of-tree plugins can be developed,
   but registering them requires changes to `src/runtime/bootstrap.ts`.
5. **Audited dependency graph.** `ci.yml` runs `npm audit --omit=dev
   --audit-level=high` and `cargo audit --deny warnings` on every push. A
   high or critical advisory in production deps fails the build.
6. **Architecture isolation tests.** `src/architecture.test.ts` blocks
   cross-plugin imports and protects the kernel from picking up plugin
   knowledge. Reduces blast radius if a plugin needs urgent removal.

## What is NOT done in 3.11.0

- Per-plugin permission grants (`requires: ["subprocess:bash"]`, etc.).
- `plugins.lock` with sha256-pinned third-party plugins.
- Sandboxing / WASM isolation for plugins.
- Signature verification (Sigstore / minisign).

These are tracked under the v4 security ADR.

## Disclosure

Security issues — please report to **alex@gladkov.dev** rather than filing a
public GitHub issue. Acknowledgement within 48 hours, fix or mitigation
within two business weeks for high severity.
