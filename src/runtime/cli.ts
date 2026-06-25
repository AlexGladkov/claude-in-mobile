import { getConfigSnippet, type ClientType } from "../client-adapter.js";

/**
 * Handle short-circuit CLI flags (--help / --version / --init <client>).
 * Returns true if a flag was handled (caller should exit / skip server boot).
 *
 * NOTE: this function calls `process.exit()` on its own for the matched
 * flag — historically the index.ts entry point did the same to keep
 * `npx -y mcp-devices --help` from blocking on the stdio MCP loop
 * (see issue #44). The boolean return is for typing convenience; in
 * practice control never reaches the caller when a flag is matched.
 */
export function runCliIfRequested(argv: readonly string[], version: string): boolean {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`mcp-devices ${version}

MCP server for mobile, desktop and browser automation. Designed to run as a
stdio child of an MCP-capable client (Claude Code, Cursor, opencode, …) — it
speaks JSON-RPC on stdin/stdout and is not intended for direct interactive
use.

Usage
  mcp-devices               start the MCP stdio server (default)
  mcp-devices platforms     list enabled + available platforms
  mcp-devices install <p>...
                                 enable platform(s): android | ios | web |
                                 desktop | aurora | all
  mcp-devices uninstall <p>...
                                 disable platform(s)
  mcp-devices doctor [p...] check external toolchains for platforms
  mcp-devices --init <client>
                                 print the configuration snippet for a
                                 supported client (opencode | cursor |
                                 claude-code) and exit
  mcp-devices --version     print version and exit
  mcp-devices --help        print this message and exit

Platforms
  The base install is slim — no platforms are loaded by default. Enable
  what you need with 'install', or 'install all'. Selection persists in
  ~/.mcp-devices/config.json and can be overridden per-run with the
  MCP_DEVICES_PLATFORMS env (csv / all / none).

Environment
  MCP_DEVICES_PLATFORMS     csv / all / none — overrides enabled set
  MOBILE_PROFILE                 minimal | core | android | web | full
                                 (default: full)
  DEVICE_ID, ANDROID_SERIAL      preselect Android device
  IOS_DEVICE_ID                  preselect iOS Simulator
  MCP_DEVICES_BIN           absolute path to the Rust companion binary
                                 used by the REPL plugin

Docs
  https://github.com/AlexGladkov/claude-in-mobile
`);
    process.exit(0);
  }

  if (argv.includes("--version") || argv.includes("-V")) {
    console.log(version);
    process.exit(0);
  }

  const initIndex = argv.indexOf("--init");
  if (initIndex !== -1) {
    const client = argv[initIndex + 1];
    if (!client) {
      console.error("Usage: mcp-devices --init <client>");
      console.error("Supported clients: opencode, cursor, claude-code");
      process.exit(1);
    }
    try {
      const snippet = getConfigSnippet(client as ClientType);
      console.log(snippet);
      process.exit(0);
    } catch (e: unknown) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }

  return false;
}
