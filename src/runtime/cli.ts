import { getConfigSnippet, type ClientType } from "../client-adapter.js";

/**
 * Handle short-circuit CLI flags (--help / --version / --init <client>).
 * Returns true if a flag was handled (caller should exit / skip server boot).
 *
 * NOTE: this function calls `process.exit()` on its own for the matched
 * flag — historically the index.ts entry point did the same to keep
 * `npx -y claude-in-mobile --help` from blocking on the stdio MCP loop
 * (see issue #44). The boolean return is for typing convenience; in
 * practice control never reaches the caller when a flag is matched.
 */
export function runCliIfRequested(argv: readonly string[], version: string): boolean {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`claude-in-mobile ${version}

MCP server for mobile, desktop and browser automation. Designed to run as a
stdio child of an MCP-capable client (Claude Code, Cursor, opencode, …) — it
speaks JSON-RPC on stdin/stdout and is not intended for direct interactive
use.

Usage
  claude-in-mobile               start the MCP stdio server (default)
  claude-in-mobile --init <client>
                                 print the configuration snippet for a
                                 supported client (opencode | cursor |
                                 claude-code) and exit
  claude-in-mobile --version     print version and exit
  claude-in-mobile --help        print this message and exit

Environment
  MOBILE_PROFILE                 minimal | core | android | web | full
                                 (default: full)
  DEVICE_ID, ANDROID_SERIAL      preselect Android device
  IOS_DEVICE_ID                  preselect iOS Simulator
  CLAUDE_IN_MOBILE_BIN           absolute path to the Rust companion binary
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
      console.error("Usage: claude-in-mobile --init <client>");
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
