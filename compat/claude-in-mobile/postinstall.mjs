#!/usr/bin/env node
/**
 * One-time, non-fatal install notice. Silent in CI to avoid log noise.
 */
if (!process.env.CI && process.stderr.isTTY) {
  process.stderr.write(
    "\n" +
      "  \x1b[1mclaude-in-mobile\x1b[0m — all-in-one edition of mcp-devices.\n" +
      "  Every platform (Android, iOS, Web, Desktop, Aurora) is bundled and\n" +
      "  enabled out of the box — nothing else to install.\n" +
      "  Prefer a slim base with platforms on demand? Use: npm i -g mcp-devices\n" +
      "\n",
  );
}
