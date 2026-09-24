import { getConfigSnippet } from "../client-adapter.js";
import type { ClientType } from "../client-adapter.js";
import { sanitizeErrorMessage } from "../utils/sanitize.js";

export const INIT_CLIENTS = ["opencode", "cursor", "claude-code", "grok"] as const;

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
stdio child of an MCP-capable client (${INIT_CLIENTS.join(", ")}, …) — it
speaks JSON-RPC on stdin/stdout and is not intended for direct interactive
use.

Usage
  mcp-devices               start the MCP stdio server (default)
  mcp-devices platforms     list enabled + available platforms
  mcp-devices install <p>...
                                 enable platform(s): android | ios | web |
                                 desktop | aurora | harmony | all
  mcp-devices uninstall <p>...
                                 disable platform(s)
  mcp-devices plugin list
                                 list enabled + available tool plugins
  mcp-devices plugin enable <p>...
                                 enable tool plugins: debug | all
  mcp-devices plugin disable <p>...
                                 disable tool plugins
  mcp-devices plugin external <action>
                                 list | enable | disable | status
  mcp-devices plugin install <package|path>
                                 install and lock an external plugin
  mcp-devices plugin update [id...]
                                 update installed external plugins
  mcp-devices plugin remove <id>...
                                 remove external plugins
  mcp-devices plugin verify [id...]
                                 verify installed plugin integrity
  mcp-devices plugin grant <id> <permission>...
                                 grant declared external permissions
  mcp-devices plugin revoke <id> [permission]...
                                 revoke external permissions
  mcp-devices --version     print version and exit
  mcp-devices --help        print this message and exit

Platforms
  The base install is slim — no platforms are loaded by default. Enable
  what you need with 'install', or 'install all'. Selection persists in
  ~/.mcp-devices/config.json and can be overridden per-run with the
  MCP_DEVICES_PLATFORMS env (csv / all / none).
  Tool plugins use 'plugin enable' / 'plugin disable' and persist in the same
  config file. MCP_DEVICES_TOOL_PLUGINS overrides that persisted selection.

Environment
  MCP_DEVICES_PLATFORMS     csv / all / none — overrides enabled set
  MCP_DEVICES_TOOL_PLUGINS  csv / all / none — overrides enabled tool plugins
  MCP_DEVICES_EXTERNAL_PLUGINS  1/true — enables managed external plugins
  MCP_DEVICES_PLUGIN_ROOT   external plugin directory override
  MCP_DEVICES_PLUGIN_LOCKFILE plugins.lock path override
  MCP_DEVICES_PLUGIN_PERMISSIONS permission policy path override
  MOBILE_PROFILE                 minimal | core | android | web | full
                                 (default: core)
  DEVICE_ID, ANDROID_SERIAL      preselect Android device
  IOS_DEVICE_ID                  preselect iOS Simulator
  HARMONY_DEVICE_ID              preselect HarmonyOS device
  HDC_PATH                       absolute path to the HDC executable
  MCP_DEVICES_BIN                absolute path to the Rust companion binary
                                 (default: mcp-devices-cli)

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
      console.error(`Supported clients: ${INIT_CLIENTS.join(", ")}`);
      process.exit(1);
    }
    try {
      const snippet = getConfigSnippet(client as ClientType);
      console.log(snippet);
      process.exit(0);
    } catch (e: unknown) {
      console.error(sanitizeErrorMessage(e));
      process.exit(1);
    }
  }

  return false;
}
