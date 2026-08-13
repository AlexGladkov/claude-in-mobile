#!/usr/bin/env node
/**
 * One-time, non-fatal migration notice. Silent in CI to avoid log noise.
 */
if (!process.env.CI && process.stderr.isTTY) {
  process.stderr.write(
    "\n" +
      "  \x1b[1mclaude-in-mobile\x1b[0m is now \x1b[1mmcp-devices\x1b[0m.\n" +
      "  Both names keep working and updating — nothing to do.\n" +
      "  The canonical name going forward:\n" +
      "    npm i -g mcp-devices      brew install mcp-devices\n" +
      "\n",
  );
}
