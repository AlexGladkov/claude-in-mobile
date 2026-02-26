#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { registerTools, registerAliases, getTools, getHandler } from "./tools/registry.js";
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
import { detectClient, getConfigSnippet } from "./client-adapter.js";

// Dispatch function (needed by batch_commands / run_flow for recursion)
async function handleTool(name: string, args: Record<string, unknown>, depth: number = 0): Promise<unknown> {
  if (depth > MAX_RECURSION_DEPTH) {
    throw new Error(`Maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded. Nested batch_commands/run_flow calls are limited to prevent stack overflow.`);
  }

  const handler = getHandler(name);
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }

  return handler(args, ctx, depth);
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
]);

// Register hidden aliases for common LLM misnaming
registerAliases({
  "press_button": "press_key",
  "type_text": "input_text",
  "type": "input_text",
  "click": "tap",
  "long_tap": "long_press",
  "take_screenshot": "screenshot",
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
    version: "2.13.0",
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: "Mobile and desktop automation server. Use 'screenshot' to see the screen, 'tap' to interact, 'get_ui' for the element tree. Use 'list_devices' to see connected devices.",
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

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Claude Mobile MCP server running (Android + iOS + Desktop + Aurora)");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
