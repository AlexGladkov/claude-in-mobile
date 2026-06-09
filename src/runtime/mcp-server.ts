import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  registerAliases,
  registerAliasesWithDefaults,
  setToolListChangedNotifier,
  getTools,
  resolveToolCall,
} from "../tools/registry.js";
import { detectClient } from "../client-adapter.js";
import { MobileError, isRetryable, getRecoveryHints } from "../errors.js";
import { detectAntiPattern } from "../utils/anti-patterns.js";

export interface McpServerDeps {
  name: string;
  version: string;
  instructions: string;
  turboEnabled: boolean;
  handleTool: (name: string, args: Record<string, unknown>, depth?: number) => Promise<unknown>;
}

export interface McpServerHandle {
  server: Server;
  start(): Promise<void>;
}

/**
 * Create an MCP server pre-wired with:
 *  - ListTools / CallTool handlers
 *  - tool-list-changed notifier hooked into the registry
 *  - client detection on `oninitialized` (adds per-client aliases)
 *
 * The server is returned along with a `start()` helper that opens a stdio
 * transport. Lifecycle (signal handlers, kernel.disposeAll) stays in the
 * caller so the server module is pure plumbing.
 */
export function createMcpServer(deps: McpServerDeps): McpServerHandle {
  const { name, version, instructions, turboEnabled, handleTool } = deps;

  const server = new Server(
    { name, version },
    {
      capabilities: { tools: { listChanged: true } },
      instructions,
    },
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

    const aliasesWithDefaults = adapter.getAliasesWithDefaults();
    if (Object.keys(aliasesWithDefaults).length > 0) {
      registerAliasesWithDefaults(aliasesWithDefaults);
      console.error(`Registered ${Object.keys(aliasesWithDefaults).length} aliases with defaults for ${adapter.clientType}`);
    }

    const additionalAliases = adapter.getAdditionalAliases();
    if (Object.keys(additionalAliases).length > 0) {
      registerAliases(additionalAliases);
      console.error(`Registered ${Object.keys(additionalAliases).length} additional aliases for ${adapter.clientType}`);
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: getTools() };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: toolName, arguments: args } = request.params;

    try {
      // Pre-resolve to detect auto-enabled modules (resolveToolCall is idempotent for auto-enable:
      // once unhidden, a second call returns autoEnabled: null)
      const preResolve = resolveToolCall(toolName, args ?? {});
      const autoEnabledModule = preResolve?.autoEnabled ?? null;

      const result = await handleTool(toolName, args ?? {});

      const moduleNotice = autoEnabledModule
        ? `[Module "${autoEnabledModule}" auto-enabled]\n`
        : "";

      // Multi-content response (turbo mode: array of text/image blocks)
      if (typeof result === "object" && result !== null && "content" in result && Array.isArray((result as { content: unknown }).content)) {
        const blocks = (result as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }).content;
        const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [];
        let noticePrepended = false;
        for (const block of blocks) {
          if (block.type === "text") {
            const prefix = (!noticePrepended && moduleNotice) ? moduleNotice : "";
            noticePrepended = true;
            content.push({ type: "text", text: prefix + (block.text ?? "") });
          } else if (block.type === "image" && block.data && block.mimeType) {
            content.push({ type: "image", data: block.data, mimeType: block.mimeType });
          }
        }
        if (moduleNotice && !content.some(b => b.type === "text")) {
          content.unshift({ type: "text", text: moduleNotice });
        }
        return { content };
      }

      // Image response (optionally with text)
      if (typeof result === "object" && result !== null && "image" in result) {
        const img = (result as { image: { data: string; mimeType: string }; text?: string }).image;
        const rawText = (result as { text?: string }).text;
        const content: Array<{ type: string; data?: string; mimeType?: string; text?: string }> = [
          { type: "image", data: img.data, mimeType: img.mimeType },
        ];
        const combinedText = moduleNotice + (rawText ?? "");
        if (combinedText) {
          content.push({ type: "text", text: combinedText });
        }
        return { content };
      }

      // Text response
      let text = typeof result === "object" && result !== null && "text" in result
        ? (result as { text: string }).text
        : JSON.stringify(result);

      const handlerIsError = typeof result === "object" && result !== null && "isError" in result
        ? (result as { isError?: boolean }).isError === true
        : false;

      // Global safety net: truncate oversized text responses
      const MAX_RESPONSE_CHARS = 20_000;
      if (text.length > MAX_RESPONSE_CHARS) {
        const remaining = text.length - MAX_RESPONSE_CHARS;
        text = text.slice(0, MAX_RESPONSE_CHARS) + `\n\n[truncated, ${remaining} chars remaining]`;
      }

      // Anti-pattern detection (only at top level, not on errors; skipped in turbo — flow manages feedback)
      const hint = turboEnabled ? null : detectAntiPattern();
      const hintBlock = hint ? `\n[HINT: ${hint}]` : "";

      return {
        content: [
          { type: "text", text: moduleNotice + text + hintBlock },
        ],
        ...(handlerIsError ? { isError: true } : {}),
      };
    } catch (error: unknown) {
      const code = error instanceof MobileError ? error.code : "UNKNOWN";
      const message = error instanceof Error ? error.message : String(error);
      const retryHint = isRetryable(error) ? "\nRetry: yes" : "";
      const recoveryHints = getRecoveryHints(error);
      const recoveryBlock = recoveryHints.length > 0
        ? `\n[RECOVERY: ${JSON.stringify(recoveryHints)}]`
        : "";
      const retryInfo = error instanceof MobileError && error.retryInfo ? `\n${error.retryInfo}` : "";
      return {
        content: [
          { type: "text", text: `[${code}] ${message}${retryHint}${retryInfo}${recoveryBlock}` },
        ],
        isError: true,
      };
    }
  });

  async function start(): Promise<void> {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Claude Mobile MCP server running (Android + iOS + Desktop + Aurora + Browser)");
  }

  return { server, start };
}
