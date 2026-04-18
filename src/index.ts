#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { registerTools, registerAliases, registerAliasesWithDefaults, getTools, resolveToolCall } from "./tools/registry.js";
import { createToolContext, MAX_RECURSION_DEPTH } from "./tools/context.js";
import { deviceTools } from "./tools/device-tools.js";
import { screenshotTools } from "./tools/screenshot-tools.js";
import { interactionTools } from "./tools/interaction-tools.js";
import { uiTools } from "./tools/ui-tools.js";
import { appTools } from "./tools/app-tools.js";
import { permissionTools } from "./tools/permission-tools.js";
import { systemTools } from "./tools/system-tools.js";
import { desktopTools } from "./tools/desktop-tools.js";
import { auroraTools } from "./tools/aurora-tools.js";
import { flowTools } from "./tools/flow-tools.js";
import { clipboardTools } from "./tools/clipboard-tools.js";
import { browserTools } from "./tools/browser-tools.js";
import { storeTools } from "./tools/store-tools.js";
import { huaweiTools } from "./tools/huawei-tools.js";
import { ruStoreTools } from "./tools/rustore-tools.js";
import { detectClient, getConfigSnippet } from "./client-adapter.js";

// Dispatch function (needed by batch_commands / run_flow for recursion)
async function handleTool(name: string, args: Record<string, unknown>, depth: number = 0): Promise<unknown> {
  if (depth > MAX_RECURSION_DEPTH) {
    throw new Error(`Maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded. Nested batch_commands/run_flow calls are limited to prevent stack overflow.`);
  }

  const resolved = resolveToolCall(name, args);
  if (!resolved) {
    throw new Error(`Unknown tool: ${name}`);
  }

  return resolved.handler(resolved.args, ctx, depth);
}

// Shared context (wired after handleTool is defined)
const ctx = createToolContext(handleTool);

// Register all tool groups
registerTools([
  ...deviceTools,
  ...screenshotTools,
  ...interactionTools,
  ...uiTools,
  ...appTools,
  ...permissionTools,
  ...systemTools,
  ...desktopTools,
  ...auroraTools,
  ...flowTools,
  ...clipboardTools,
  ...browserTools,
  ...storeTools,
  ...huaweiTools,
  ...ruStoreTools,
]);

// Backward compat: v3.0.x names → v3.1.x canonical names
registerAliases({
  // device
  "list_devices": "device_list",
  "set_device": "device_set",
  "set_target": "device_set_target",
  "get_target": "device_get_target",
  // interaction
  "tap": "input_tap",
  "double_tap": "input_double_tap",
  "long_press": "input_long_press",
  "swipe": "input_swipe",
  "press_key": "input_key",
  // ui
  "get_ui": "ui_tree",
  "find_element": "ui_find",
  "find_and_tap": "ui_find_tap",
  "tap_by_text": "ui_tap_text",
  "analyze_screen": "ui_analyze",
  "wait_for_element": "ui_wait",
  "assert_visible": "ui_assert_visible",
  "assert_not_exists": "ui_assert_gone",
  // system
  "get_current_activity": "system_activity",
  "shell": "system_shell",
  "wait": "system_wait",
  "open_url": "system_open_url",
  "get_logs": "system_logs",
  "clear_logs": "system_clear_logs",
  "get_system_info": "system_info",
  "get_webview": "system_webview",
  // app
  "launch_app": "app_launch",
  "stop_app": "app_stop",
  "install_app": "app_install",
  "list_apps": "app_list",
  // screenshot
  "screenshot": "screen_capture",
  "annotate_screenshot": "screen_annotate",
  // desktop
  "launch_desktop_app": "desktop_launch",
  "stop_desktop_app": "desktop_stop",
  "get_window_info": "desktop_windows",
  "focus_window": "desktop_focus",
  "resize_window": "desktop_resize",
  "get_clipboard": "clipboard_get",
  "set_clipboard": "clipboard_set",
  "get_performance_metrics": "desktop_performance",
  "get_monitors": "desktop_monitors",
  // clipboard
  "select_text": "clipboard_select",
  "copy_text": "clipboard_copy",
  "paste_text": "clipboard_paste",
  "get_clipboard_android": "clipboard_get_android",
  // flow
  "batch_commands": "flow_batch",
  "run_flow": "flow_run",
  // permissions
  "grant_permission": "permission_grant",
  "revoke_permission": "permission_revoke",
  "reset_permissions": "permission_reset",
  // file (aurora)
  "push_file": "file_push",
  "pull_file": "file_pull",
  // viewport
  "get_viewport_size": "device_viewport",
  "screen_size": "device_viewport",
  "viewport_size": "device_viewport",
  "get_viewport": "device_viewport",
  "get_resolution": "device_viewport",
  // LLM misnaming helpers
  "press_button": "input_key",
  "type_text": "input_text",
  "type": "input_text",
  "click": "input_tap",
  "long_tap": "input_long_press",
  "take_screenshot": "screen_capture",
});

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
    const snippet = getConfigSnippet(client as any);
    console.log(snippet);
    process.exit(0);
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }
}

// Create MCP server
const server = new Server(
  {
    name: "claude-mobile",
    version: "3.3.0",
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: "Mobile, desktop, browser automation + store management (Google Play, Huawei AppGallery, RuStore). IMPORTANT: Always use 'ui_tree' first to inspect the screen — it is text-based and ~10x cheaper than screenshots. Use 'screen_capture' only as fallback when visual verification is required or ui_tree is insufficient. Use 'input_tap' to interact. For stores: 'store_upload' → 'store_set_notes' → 'store_submit' (Google Play), 'huawei_upload' → 'huawei_set_notes' → 'huawei_submit' (Huawei), 'rustore_upload' → 'rustore_set_notes' → 'rustore_submit' (RuStore). Use 'device_list' to see connected devices.",
  }
);

// Detect client after MCP handshake and apply per-client adaptations
server.oninitialized = () => {
  const clientInfo = server.getClientVersion();
  const adapter = detectClient(clientInfo);
  console.error(`Client detected: ${adapter.clientType} (${adapter.clientName} v${adapter.clientVersion})`);

  // Register client-specific aliases
  const additionalAliases = adapter.getAdditionalAliases();
  if (Object.keys(additionalAliases).length > 0) {
    registerAliases(additionalAliases);
    console.error(`Registered ${Object.keys(additionalAliases).length} additional aliases for ${adapter.clientType}`);
  }

  // Register aliases with default arguments (e.g., swipe_up → swipe with direction: "up")
  const aliasesWithDefaults = adapter.getAliasesWithDefaults();
  if (Object.keys(aliasesWithDefaults).length > 0) {
    registerAliasesWithDefaults(aliasesWithDefaults);
    console.error(`Registered ${Object.keys(aliasesWithDefaults).length} aliases with defaults for ${adapter.clientType}`);
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
    const result = await handleTool(name, args ?? {});

    // Handle image response (optionally with text)
    if (typeof result === "object" && result !== null && "image" in result) {
      const img = (result as { image: { data: string; mimeType: string }; text?: string }).image;
      const text = (result as { text?: string }).text;
      const content: Array<{ type: string; data?: string; mimeType?: string; text?: string }> = [
        {
          type: "image",
          data: img.data,
          mimeType: img.mimeType,
        },
      ];
      if (text) {
        content.push({ type: "text", text });
      }
      return { content };
    }

    // Handle text response
    const text = typeof result === "object" && result !== null && "text" in result
      ? (result as { text: string }).text
      : JSON.stringify(result);

    return {
      content: [
        {
          type: "text",
          text,
        },
      ],
    };
  } catch (error: any) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`,
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
