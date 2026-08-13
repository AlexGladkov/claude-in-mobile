#!/usr/bin/env node
/**
 * `claude-in-mobile` → `mcp-devices` compatibility shim.
 *
 * The project was renamed to `mcp-devices` in 4.0. This thin package keeps the
 * old `claude-in-mobile` command installable and updatable; it depends on
 * `mcp-devices` and simply loads its CLI in-process, so `process.argv`, stdio
 * and the exit code all pass through unchanged.
 */
// Uses the package's "." export (→ dist/index.js); a deep subpath isn't exported.
import("mcp-devices").catch((err) => {
  process.stderr.write(
    `[claude-in-mobile] failed to load the mcp-devices CLI: ${err?.message ?? err}\n` +
      "Try reinstalling: npm i -g mcp-devices\n",
  );
  process.exit(1);
});
