#!/usr/bin/env node
/**
 * `claude-in-mobile` — the all-in-one edition of mcp-devices.
 *
 * This package bundles the `mcp-devices` engine plus every platform plugin
 * (via `@mcp-devices/plugin-all`) and runs it with ALL platforms enabled by
 * default, so `npm i -g claude-in-mobile` gives you everything out of the box —
 * no `mcp-devices install <platform>` step. It loads the mcp-devices CLI
 * in-process, so `process.argv`, stdio and the exit code all pass through
 * unchanged.
 *
 * A user who has explicitly set MCP_DEVICES_PLATFORMS keeps their choice; we
 * only default it to "all" when unset.
 */
if (!process.env.MCP_DEVICES_PLATFORMS) {
  process.env.MCP_DEVICES_PLATFORMS = "all";
}

// Uses the package's "." export (→ dist/index.js); a deep subpath isn't exported.
import("mcp-devices").catch((err) => {
  process.stderr.write(
    `[claude-in-mobile] failed to load the mcp-devices CLI: ${err?.message ?? err}\n` +
      "Try reinstalling: npm i -g claude-in-mobile\n",
  );
  process.exit(1);
});
