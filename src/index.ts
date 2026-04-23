#!/usr/bin/env node

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { registerTools, registerToolsHidden, registerAliases, registerAliasesWithDefaults, setToolListChangedNotifier, getTools, resolveToolCall, freezeRegistry } from "./tools/registry.js";
import { createToolContext, MAX_RECURSION_DEPTH } from "./tools/context.js";
import { detectClient, getConfigSnippet, type ClientType } from "./client-adapter.js";
import { MobileError, isRetryable } from "./errors.js";
import { getGlobalMetrics } from "./utils/metrics.js";

// Read version from package.json — single source of truth
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8")) as { version: string };

// Meta tools
import { deviceMeta, deviceAliases } from "./tools/meta/device-meta.js";
import { inputMeta, inputAliases } from "./tools/meta/input-meta.js";
import { screenMeta, screenAliases } from "./tools/meta/screen-meta.js";
import { uiMeta, uiAliases } from "./tools/meta/ui-meta.js";
import { appMeta, appAliases } from "./tools/meta/app-meta.js";
import { systemMeta, systemAliases } from "./tools/meta/system-meta.js";
import { browserMeta, browserAliases } from "./tools/meta/browser-meta.js";
import { desktopMeta, desktopAliases } from "./tools/meta/desktop-meta.js";
import { storeMeta, storeAliases } from "./tools/meta/store-meta.js";
import { flowMeta, flowAliases } from "./tools/meta/flow-meta.js";

// Dispatch function (needed by batch_commands / run_flow for recursion)
async function handleTool(name: string, args: Record<string, unknown>, depth: number = 0): Promise<unknown> {
  if (depth > MAX_RECURSION_DEPTH) {
    throw new MobileError(`Maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded.`, "MAX_RECURSION");
  }

  const resolved = resolveToolCall(name, args);
  if (!resolved) {
    throw new MobileError(`Unknown tool: ${name}`, "UNKNOWN_TOOL");
  }

  const start = Date.now();
  try {
    const result = await resolved.handler(resolved.args, ctx, depth);
    getGlobalMetrics().record(name, Date.now() - start, false);
    return result;
  } catch (error) {
    getGlobalMetrics().record(name, Date.now() - start, true);
    throw error;
  }
}

// Shared context (wired after handleTool is defined)
const ctx = createToolContext(handleTool);

// Register core meta tools (always visible)
registerTools([
  deviceMeta,
  inputMeta,
  screenMeta,
  uiMeta,
  appMeta,
  systemMeta,
  flowMeta,
]);

// Register optional modules as hidden (loaded on demand via device enable_module)
registerToolsHidden([browserMeta, desktopMeta, storeMeta]);

// Register all backward-compat aliases (v3.1.x canonical names -> meta tools)
registerAliasesWithDefaults({
  // v3.1.x canonical -> meta tool aliases
  ...deviceAliases,
  ...inputAliases,
  ...screenAliases,
  ...uiAliases,
  ...appAliases,
  ...systemAliases,
  ...browserAliases,
  ...desktopAliases,
  ...storeAliases,
  ...flowAliases,

  // v3.0.x backward compat aliases -> meta tools
  // device
  list_devices: { tool: "device", defaults: { action: "list" } },
  set_device: { tool: "device", defaults: { action: "set" } },
  set_target: { tool: "device", defaults: { action: "set_target" } },
  get_target: { tool: "device", defaults: { action: "get_target" } },
  // interaction
  tap: { tool: "input", defaults: { action: "tap" } },
  double_tap: { tool: "input", defaults: { action: "double_tap" } },
  long_press: { tool: "input", defaults: { action: "long_press" } },
  swipe: { tool: "input", defaults: { action: "swipe" } },
  press_key: { tool: "input", defaults: { action: "key" } },
  // ui
  get_ui: { tool: "ui", defaults: { action: "tree" } },
  find_element: { tool: "ui", defaults: { action: "find" } },
  find_and_tap: { tool: "ui", defaults: { action: "find_tap" } },
  tap_by_text: { tool: "ui", defaults: { action: "tap_text" } },
  analyze_screen: { tool: "ui", defaults: { action: "analyze" } },
  wait_for_element: { tool: "ui", defaults: { action: "wait" } },
  assert_visible: { tool: "ui", defaults: { action: "assert_visible" } },
  assert_not_exists: { tool: "ui", defaults: { action: "assert_gone" } },
  // system
  get_current_activity: { tool: "system", defaults: { action: "activity" } },
  shell: { tool: "system", defaults: { action: "shell" } },
  wait: { tool: "system", defaults: { action: "wait" } },
  open_url: { tool: "system", defaults: { action: "open_url" } },
  get_logs: { tool: "system", defaults: { action: "logs" } },
  clear_logs: { tool: "system", defaults: { action: "clear_logs" } },
  get_system_info: { tool: "system", defaults: { action: "info" } },
  get_webview: { tool: "system", defaults: { action: "webview" } },
  // app
  launch_app: { tool: "app", defaults: { action: "launch" } },
  stop_app: { tool: "app", defaults: { action: "stop" } },
  install_app: { tool: "app", defaults: { action: "install" } },
  list_apps: { tool: "app", defaults: { action: "list" } },
  // screenshot
  screenshot: { tool: "screen", defaults: { action: "capture" } },
  annotate_screenshot: { tool: "screen", defaults: { action: "annotate" } },
  // desktop
  launch_desktop_app: { tool: "desktop", defaults: { action: "launch" } },
  stop_desktop_app: { tool: "desktop", defaults: { action: "stop" } },
  get_window_info: { tool: "desktop", defaults: { action: "windows" } },
  focus_window: { tool: "desktop", defaults: { action: "focus" } },
  resize_window: { tool: "desktop", defaults: { action: "resize" } },
  get_clipboard: { tool: "desktop", defaults: { action: "clipboard_get" } },
  set_clipboard: { tool: "desktop", defaults: { action: "clipboard_set" } },
  get_performance_metrics: { tool: "desktop", defaults: { action: "performance" } },
  get_monitors: { tool: "desktop", defaults: { action: "monitors" } },
  // clipboard (Android)
  select_text: { tool: "system", defaults: { action: "clipboard_select" } },
  copy_text: { tool: "system", defaults: { action: "clipboard_copy" } },
  paste_text: { tool: "system", defaults: { action: "clipboard_paste" } },
  get_clipboard_android: { tool: "system", defaults: { action: "clipboard_get" } },
  // flow
  batch_commands: { tool: "flow", defaults: { action: "batch" } },
  run_flow: { tool: "flow", defaults: { action: "run" } },
  parallel: { tool: "flow", defaults: { action: "parallel" } },
  // permissions
  grant_permission: { tool: "system", defaults: { action: "permission_grant" } },
  revoke_permission: { tool: "system", defaults: { action: "permission_revoke" } },
  reset_permissions: { tool: "system", defaults: { action: "permission_reset" } },
  // file (aurora)
  push_file: { tool: "system", defaults: { action: "file_push" } },
  pull_file: { tool: "system", defaults: { action: "file_pull" } },

  // LLM misnaming helpers
  press_button: { tool: "input", defaults: { action: "key" } },
  type_text: { tool: "input", defaults: { action: "text" } },
  type: { tool: "input", defaults: { action: "text" } },
  click: { tool: "input", defaults: { action: "tap" } },
  long_tap: { tool: "input", defaults: { action: "long_press" } },
  take_screenshot: { tool: "screen", defaults: { action: "capture" } },
});

// Freeze tool registration — no new tools can be registered after this point.
// Alias registration remains open for client-specific aliases in oninitialized.
freezeRegistry();

// Handle --init CLI flag (generate config snippet and exit)
const initIndex = process.argv.indexOf("--init");
if (initIndex !== -1) {
  const client = process.argv[initIndex + 1];
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

// Create MCP server
const server = new Server(
  {
    name: "claude-mobile",
    version: pkg.version,
  },
  {
    capabilities: {
      tools: { listChanged: true },
    },
    instructions: [
      "Mobile, desktop, browser automation + store management.",
      "",
      "TOKEN COST (cheapest→expensive): ui(action:'tree') ~200 tokens | ui(action:'tree',compact:true) ~100 tokens | ui(action:'find') ~150 tokens | screen(action:'capture',preset:'low') ~1500 tokens | screen(action:'capture') ~3000 tokens | screen(action:'annotate') ~4000 tokens.",
      "",
      "EFFICIENT PATTERNS: 1) ui_tree first — text-based, ~10x cheaper than screenshots. 2) hints are ON by default — input actions return UI diff, no follow-up needed. Set hints:false only for rapid sequences. 3) screen(preset:'low') for quick visual checks. 4) flow(action:'batch')/flow(action:'run') for multi-step sequences (2-4x faster). 5) screen(diff:true) after actions — returns only changes. 6) ui(action:'tree',compact:true) — interactive elements only, shortest format.",
      "",
      "ANTI-PATTERNS: 1) screenshot after every tap (use hints instead). 2) ui_tree + screenshot together (pick one). 3) Full ui_tree when you only need one element (use ui(action:'find')). 4) screen(preset:'high') unless user requests visual detail.",
      "",
      "Optional modules (browser, desktop, store) hidden by default — device(action:'enable_module',module:'browser') to load.",
    ].join("\n"),
  }
);

// Wire up tool list change notifications
setToolListChangedNotifier(() => {
  server.notification({ method: "notifications/tools/list_changed" }).catch(() => {});
});

// Detect client after MCP handshake and apply per-client adaptations
server.oninitialized = () => {
  const clientInfo = server.getClientVersion();
  const adapter = detectClient(clientInfo);
  console.error(`Client detected: ${adapter.clientType} (${adapter.clientName} v${adapter.clientVersion})`);

  // Register client-specific aliases with defaults pointing to meta tools
  const aliasesWithDefaults = adapter.getAliasesWithDefaults();
  if (Object.keys(aliasesWithDefaults).length > 0) {
    registerAliasesWithDefaults(aliasesWithDefaults);
    console.error(`Registered ${Object.keys(aliasesWithDefaults).length} aliases with defaults for ${adapter.clientType}`);
  }

  // Register client-specific simple aliases (chain resolution handles alias -> aliasWithDefaults -> meta tool)
  const additionalAliases = adapter.getAdditionalAliases();
  if (Object.keys(additionalAliases).length > 0) {
    registerAliases(additionalAliases);
    console.error(`Registered ${Object.keys(additionalAliases).length} additional aliases for ${adapter.clientType}`);
  }
};

// Handle tool list request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: getTools() };
});

// Handle tool call request
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // Pre-resolve to detect auto-enabled modules (resolveToolCall is idempotent for auto-enable:
    // once unhidden, a second call returns autoEnabled: null)
    const preResolve = resolveToolCall(name, args ?? {});
    const autoEnabledModule = preResolve?.autoEnabled ?? null;

    const result = await handleTool(name, args ?? {});

    // Build auto-enable notice prefix
    const moduleNotice = autoEnabledModule
      ? `[Module "${autoEnabledModule}" auto-enabled]\n`
      : "";

    // Handle image response (optionally with text)
    if (typeof result === "object" && result !== null && "image" in result) {
      const img = (result as { image: { data: string; mimeType: string }; text?: string }).image;
      const rawText = (result as { text?: string }).text;
      const content: Array<{ type: string; data?: string; mimeType?: string; text?: string }> = [
        {
          type: "image",
          data: img.data,
          mimeType: img.mimeType,
        },
      ];
      const combinedText = moduleNotice + (rawText ?? "");
      if (combinedText) {
        content.push({ type: "text", text: combinedText });
      }
      return { content };
    }

    // Handle text response
    let text = typeof result === "object" && result !== null && "text" in result
      ? (result as { text: string }).text
      : JSON.stringify(result);

    // Check if handler signaled an error (e.g. assert_visible / assert_gone)
    const handlerIsError = typeof result === "object" && result !== null && "isError" in result
      ? (result as { isError?: boolean }).isError === true
      : false;

    // Global safety net: truncate oversized text responses
    const MAX_RESPONSE_CHARS = 20_000;
    if (text.length > MAX_RESPONSE_CHARS) {
      const remaining = text.length - MAX_RESPONSE_CHARS;
      text = text.slice(0, MAX_RESPONSE_CHARS) + `\n\n[truncated, ${remaining} chars remaining]`;
    }

    return {
      content: [
        {
          type: "text",
          text: moduleNotice + text,
        },
      ],
      ...(handlerIsError ? { isError: true } : {}),
    };
  } catch (error: unknown) {
    const code = error instanceof MobileError ? error.code : "UNKNOWN";
    const message = error instanceof Error ? error.message : String(error);
    const retryHint = isRetryable(error) ? "\nRetry: yes" : "";
    return {
      content: [
        {
          type: "text",
          text: `[${code}] ${message}${retryHint}`,
        },
      ],
      isError: true,
    };
  }
});

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  console.error(`MCP server received ${signal}, shutting down...`);
  try {
    await ctx.deviceManager.cleanup();
  } catch (e) {
    console.error("Cleanup error:", e);
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGHUP", () => shutdown("SIGHUP"));
process.stdin.on("close", () => shutdown("stdin-close"));

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Claude Mobile MCP server running (Android + iOS + Desktop + Aurora + Browser)");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
