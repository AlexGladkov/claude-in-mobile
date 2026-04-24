#!/usr/bin/env node

/**
 * claude-in-mobile-lite — lightweight MCP server for small local LLMs.
 *
 * 12 atomic tools, ~600 tokens schema overhead.
 * No meta-dispatch, no hints, no diff, no recorder, no hidden modules.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { MobileError } from "claude-in-mobile/errors";
import { createLiteDeviceManager } from "./context.js";
import { createLiteTools, type LiteToolDefinition } from "./tools/definitions.js";
import { truncateResponse, formatLiteError, MAX_RESPONSE_CHARS } from "./tools/formatter.js";

const VERSION = "1.0.0";

// ============ CLI flags ============

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(`claude-in-mobile-lite v${VERSION}`);
  process.exit(0);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`claude-in-mobile-lite v${VERSION}
Lightweight MCP server for local LLMs (Llama 3, Mistral, Phi-3, Gemma).

Usage:
  claude-in-mobile-lite              Start MCP server (stdio)
  claude-in-mobile-lite --init <client>  Generate MCP config snippet
  claude-in-mobile-lite --version    Show version
  claude-in-mobile-lite --help       Show this help

Supported --init clients: claude-code, cursor, opencode

12 atomic tools: tap, tap_text, swipe, type_text, press_key,
screenshot, get_ui, find_element, launch_app, go_back, wait, device_info

Platforms: Android, iOS, Desktop
Schema overhead: ~540 tokens (vs ~2300 in full version)`);
  process.exit(0);
}

const initIndex = process.argv.indexOf("--init");
if (initIndex !== -1) {
  const client = process.argv[initIndex + 1];
  const LITE_CONFIGS: Record<string, object> = {
    opencode: {
      mcp: {
        mobile: {
          type: "local",
          command: ["npx", "-y", "claude-in-mobile-lite"],
          enabled: true,
        },
      },
    },
    cursor: {
      mcpServers: {
        mobile: {
          command: "npx",
          args: ["-y", "claude-in-mobile-lite"],
        },
      },
    },
    "claude-code": {
      mcpServers: {
        mobile: {
          command: "npx",
          args: ["-y", "claude-in-mobile-lite"],
        },
      },
    },
  };

  if (!client || !LITE_CONFIGS[client]) {
    console.error(`Usage: claude-in-mobile-lite --init <client>`);
    console.error(`Supported clients: ${Object.keys(LITE_CONFIGS).join(", ")}`);
    process.exit(1);
  }
  console.log(JSON.stringify(LITE_CONFIGS[client], null, 2));
  process.exit(0);
}

// ============ Server setup ============

// Create lite device manager (3 adapters: Android, iOS, Desktop)
const deviceManager = createLiteDeviceManager();

// Create 12 atomic tools
const liteTools = createLiteTools();
const toolMap = new Map<string, LiteToolDefinition>();
for (const t of liteTools) {
  toolMap.set(t.tool.name, t);
}

// Create MCP server
const server = new Server(
  { name: "claude-mobile-lite", version: VERSION },
  {
    capabilities: { tools: {} },
    instructions:
      "Mobile automation for Android, iOS, Desktop. " +
      "Use get_ui to see screen elements, tap/tap_text to interact, screenshot for visual check. " +
      "12 tools available. All responses are plain text.",
  },
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: liteTools.map((t) => t.tool) };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const def = toolMap.get(name);

  if (!def) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  try {
    const result = await def.handler(args ?? {}, deviceManager);

    // Image response
    if (typeof result === "object" && result !== null && "image" in result) {
      const img = (result as { image: { data: string; mimeType: string }; text?: string }).image;
      const text = (result as { text?: string }).text;
      const content: Array<{ type: string; data?: string; mimeType?: string; text?: string }> = [
        { type: "image", data: img.data, mimeType: img.mimeType },
      ];
      if (text) content.push({ type: "text", text });
      return { content };
    }

    // Text response
    const handlerIsError =
      typeof result === "object" && result !== null && "isError" in result
        ? (result as { isError?: boolean }).isError === true
        : false;

    let text =
      typeof result === "object" && result !== null && "text" in result
        ? (result as { text: string }).text
        : JSON.stringify(result);

    text = truncateResponse(text);

    return {
      content: [{ type: "text", text }],
      ...(handlerIsError ? { isError: true } : {}),
    };
  } catch (error: unknown) {
    const code = error instanceof MobileError ? error.code : "UNKNOWN";
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: formatLiteError(code, message) }],
      isError: true,
    };
  }
});

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  console.error(`Lite MCP server received ${signal}, shutting down...`);
  try {
    await deviceManager.cleanup();
  } catch {}
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
  console.error("Claude Mobile Lite MCP server running (Android + iOS + Desktop)");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
