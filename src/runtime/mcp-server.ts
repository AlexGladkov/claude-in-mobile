import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { CompatibleStdioServerTransport } from "./stdio-transport.js";
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
import { sanitizeErrorMessage, sanitizeResourceUri } from "../utils/sanitize.js";

export interface McpServerDeps {
  name: string;
  version: string;
  instructions: string;
  turboEnabled: boolean;
  handleTool: (
    name: string,
    args: Record<string, unknown>,
    depth?: number,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

export interface McpServerHandle {
  server: Server;
  start(): Promise<void>;
}

/** Deterministic MCP response bounds shared by ordinary and multi-content results. */
export const MCP_MAX_RESPONSE_TEXT_CHARS = 20_000;
export const MCP_MAX_RESPONSE_CONTENT_ITEMS = 20;
export const MCP_MAX_RESPONSE_DATA_CHARS = 1_000_000;
export const MCP_MAX_RESPONSE_CONTENT_ITEM_CHARS = MCP_MAX_RESPONSE_DATA_CHARS + 4_096;
export const MCP_MAX_RESPONSE_SERIALIZED_CHARS = 8 * 1024 * 1024;

type McpContentBlock = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
};

type ContentOverrides = {
  text?: string;
  resourceText?: string;
};

const MCP_MAX_RESPONSE_TYPE_CHARS = 128;
const MCP_MAX_RESPONSE_URI_CHARS = 8_192;
const MCP_MAX_RESPONSE_METADATA_CHARS = 4_096;

function asContentBlock(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const block = value as Record<string, unknown>;
  return typeof block.type === "string" ? block : undefined;
}

function projectString(value: unknown, maxChars: number): string | undefined {
  return typeof value === "string" ? value.slice(0, maxChars) : undefined;
}

function projectTextString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return sanitizeErrorMessage(value).slice(0, maxChars);
}

function truncateAggregateText(value: string, available: number): string {
  if (available <= 0) return "";
  if (value.length <= available) return value;

  const marker = `\n\n[truncated, ${value.length - available} chars remaining]`;
  if (marker.length >= available) return marker.slice(0, available);
  return value.slice(0, available - marker.length) + marker;
}

function serializedLength(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : serialized.length;
  } catch {
    return undefined;
  }
}

type FallbackProjection =
  | { supported: true; value: unknown }
  | { supported: false };

type FallbackProjectionState = {
  nodes: number;
  ancestors: WeakSet<object>;
};

const MCP_MAX_FALLBACK_DEPTH = 6;
const MCP_MAX_FALLBACK_NODES = 256;
const MCP_MAX_FALLBACK_ENTRIES = 32;
const MCP_MAX_FALLBACK_STRING_CHARS = 4_096;
const MCP_MAX_FALLBACK_KEY_CHARS = 128;
const MCP_SENSITIVE_FALLBACK_KEY_RE =
  /(?:password|passwd|secret|token|api[_-]?key|client[_-]?secret|authorization|credential|private[_-]?key|(?:^|[_-])(?:pin|otp)(?:$|[_-]|code|value|number)|one[_-]?time[_-]?code|verification[_-]?code|security[_-]?code|cvv|cvc|credit[_-]?card[_-]?(?:number|code)|card[_-]?number|^key$)/iu;

function projectMcpFallbackValue(
  value: unknown,
  depth: number,
  state: FallbackProjectionState,
): FallbackProjection {
  if (state.nodes >= MCP_MAX_FALLBACK_NODES) return { supported: false };
  state.nodes++;

  if (value === undefined) return { supported: true, value: undefined };
  if (value === null || typeof value === "boolean") {
    return { supported: true, value };
  }
  if (typeof value === "string") {
    return {
      supported: true,
      value: truncateAggregateText(value, MCP_MAX_FALLBACK_STRING_CHARS),
    };
  }
  if (typeof value === "number") {
    return { supported: true, value: Number.isFinite(value) ? value : null };
  }
  if (typeof value !== "object") return { supported: false };
  if (state.ancestors.has(value)) {
    return { supported: true, value: "[Circular]" };
  }
  if (depth >= MCP_MAX_FALLBACK_DEPTH) {
    return { supported: true, value: "[Depth limit]" };
  }

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const projected: unknown[] = [];
      const length = Math.min(value.length, MCP_MAX_FALLBACK_ENTRIES);
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) {
          projected.push(null);
          continue;
        }
        const child = projectMcpFallbackValue(descriptor.value, depth + 1, state);
        projected.push(child.supported ? child.value : null);
      }
      return { supported: true, value: projected };
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return { supported: false };
    }

    const projected: Record<string, unknown> = Object.create(null);
    let examined = 0;
    for (const key in value) {
      if (examined >= MCP_MAX_FALLBACK_ENTRIES) break;
      examined++;
      if (!Object.hasOwn(value, key) || key === "toJSON") continue;
      const safeKey = key.slice(0, MCP_MAX_FALLBACK_KEY_CHARS);
      if (MCP_SENSITIVE_FALLBACK_KEY_RE.test(key)) {
        projected[safeKey] = "[REDACTED]";
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) continue;
      const child = projectMcpFallbackValue(descriptor.value, depth + 1, state);
      if (child.supported) projected[safeKey] = child.value;
    }
    return { supported: true, value: projected };
  } catch {
    return { supported: false };
  } finally {
    state.ancestors.delete(value);
  }
}

function summarizeMcpFallbackResult(value: unknown): string | undefined {
  const projection = projectMcpFallbackValue(value, 0, {
    nodes: 0,
    ancestors: new WeakSet<object>(),
  });
  if (!projection.supported) return "[structured result omitted]";
  try {
    const serialized = JSON.stringify(projection.value);
    return serialized === undefined ? undefined : serialized;
  } catch {
    return "[structured result omitted]";
  }
}

function isValidBase64(value: string): boolean {
  return value.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value);
}

function boundContentBlock(
  raw: Record<string, unknown>,
  overrides: ContentOverrides = {},
): McpContentBlock | undefined {
  const type = projectTextString(raw.type, MCP_MAX_RESPONSE_TYPE_CHARS);
  if (!type) return undefined;

  if (type === "text") {
    const text = (overrides.text ?? (
      typeof raw.text === "string" ? sanitizeErrorMessage(raw.text) : ""
    )).slice(0, MCP_MAX_RESPONSE_TEXT_CHARS);
    return { type, text };
  }

  if (type === "image" || type === "audio") {
    const data = projectString(raw.data, MCP_MAX_RESPONSE_DATA_CHARS);
    const mimeType = projectTextString(raw.mimeType, 256);
    if (data === undefined || mimeType === undefined || !isValidBase64(data)) return undefined;
    return { type, data, mimeType };
  }

  if (type === "resource") {
    const rawResource = raw.resource;
    if (typeof rawResource !== "object" || rawResource === null || Array.isArray(rawResource)) {
      return undefined;
    }
    const resourceRecord = rawResource as Record<string, unknown>;
    const resource: Record<string, unknown> = {};
    const uri = sanitizeResourceUri(resourceRecord.uri, MCP_MAX_RESPONSE_URI_CHARS);
    const mimeType = projectTextString(resourceRecord.mimeType, 256);
    const rawText = resourceRecord.text;
    const resourceText = overrides.resourceText ?? (
      typeof rawText === "string" ? sanitizeErrorMessage(rawText) : undefined
    );
    const rawBlob = projectString(resourceRecord.blob, MCP_MAX_RESPONSE_DATA_CHARS);
    const blob = rawBlob !== undefined && isValidBase64(rawBlob) ? rawBlob : undefined;
    if (uri === undefined || (resourceText === undefined && blob === undefined)) {
      return undefined;
    }
    resource.uri = uri;
    if (mimeType !== undefined) resource.mimeType = mimeType;
    if (resourceText !== undefined) {
      resource.text = resourceText.slice(0, MCP_MAX_RESPONSE_DATA_CHARS);
    }
    if (blob !== undefined) resource.blob = blob;
    return { type, resource };
  }

  if (type === "resource_link") {
    const uri = sanitizeResourceUri(raw.uri, MCP_MAX_RESPONSE_URI_CHARS);
    const name = projectTextString(raw.name, MCP_MAX_RESPONSE_METADATA_CHARS);
    if (uri === undefined || name === undefined) return undefined;
    const projected: McpContentBlock = { type, uri, name };
    const description = projectTextString(raw.description, MCP_MAX_RESPONSE_METADATA_CHARS);
    const mimeType = projectTextString(raw.mimeType, 256);
    if (description !== undefined) projected.description = description;
    if (mimeType !== undefined) projected.mimeType = mimeType;
    return projected;
  }


  // Unknown content types retain only a bounded discriminator. Arbitrary
  // metadata is intentionally not copied into the MCP response.
  return { type };
}

/**
 * Sanitize every text content block while enforcing aggregate text, item-count,
 * media-data, serialized-item, and total serialized-content bounds. Nested
 * resource text participates in the same text budget; non-text MCP content is
 * preserved when it remains within the deterministic limits.
 */
export function sanitizeMcpContent(
  blocks: readonly unknown[],
  moduleNotice = "",
): McpContentBlock[] {
  const content: McpContentBlock[] = [];
  const safeNotice = moduleNotice ? sanitizeErrorMessage(moduleNotice) : "";
  let textChars = 0;
  let serializedChars = 2; // JSON array brackets
  let sawTextBlock = false;

  const appendBlock = (block: McpContentBlock): boolean => {
    const blockChars = serializedLength(block);
    if (blockChars === undefined) return false;
    const separatorChars = content.length > 0 ? 1 : 0;
    if (
      serializedChars + separatorChars + blockChars
      > MCP_MAX_RESPONSE_SERIALIZED_CHARS
    ) {
      return false;
    }
    content.push(block);
    serializedChars += separatorChars + blockChars;
    return true;
  };

  for (let index = 0; index < blocks.length && index < MCP_MAX_RESPONSE_CONTENT_ITEMS; index++) {
    const candidate = blocks[index];
    const block = asContentBlock(candidate);
    if (!block) continue;

    if (block.type === "text") {
      const rawText = typeof block.text === "string" ? block.text : "";
      const prefix = !sawTextBlock ? safeNotice : "";
      sawTextBlock = true;
      const text = truncateAggregateText(
        prefix + sanitizeErrorMessage(rawText),
        MCP_MAX_RESPONSE_TEXT_CHARS - textChars,
      );
      if (text.length === 0 && textChars >= MCP_MAX_RESPONSE_TEXT_CHARS) continue;
      const bounded = boundContentBlock(block, { text });
      if (bounded && appendBlock(bounded)) textChars += text.length;
      continue;
    }

    const overrides: ContentOverrides = {};
    let nestedTextChars = 0;
    const rawResource = block.resource;
    if (block.type === "resource" && typeof rawResource === "object"
        && rawResource !== null && !Array.isArray(rawResource)) {
      const rawResourceText = (rawResource as Record<string, unknown>).text;
      if (typeof rawResourceText === "string") {
        const text = truncateAggregateText(
          sanitizeErrorMessage(rawResourceText),
          MCP_MAX_RESPONSE_TEXT_CHARS - textChars,
        );
        overrides.resourceText = text;
        nestedTextChars = text.length;
      }
    }

    const bounded = boundContentBlock(block, overrides);
    if (bounded && appendBlock(bounded)) textChars += nestedTextChars;
  }

  if (safeNotice && !sawTextBlock && content.length < MCP_MAX_RESPONSE_CONTENT_ITEMS) {
    const text = truncateAggregateText(
      safeNotice,
      MCP_MAX_RESPONSE_TEXT_CHARS - textChars,
    );
    if (text) {
      const noticeBlock: McpContentBlock = { type: "text", text };
      const noticeChars = serializedLength(noticeBlock);
      const separatorChars = content.length > 0 ? 1 : 0;
      if (
        noticeChars !== undefined
        && serializedChars + separatorChars + noticeChars
          <= MCP_MAX_RESPONSE_SERIALIZED_CHARS
      ) {
        content.unshift(noticeBlock);
        serializedChars += separatorChars + noticeChars;
      }
    }
  }

  return content.slice(0, MCP_MAX_RESPONSE_CONTENT_ITEMS);
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

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name: toolName, arguments: args } = request.params;

    try {
      // Pre-resolve to detect auto-enabled modules (resolveToolCall is idempotent for auto-enable:
      // once unhidden, a second call returns autoEnabled: null)
      const preResolve = resolveToolCall(toolName, args ?? {});
      const autoEnabledModule = preResolve?.autoEnabled ?? null;

      const result = await handleTool(toolName, args ?? {}, undefined, extra.signal);

      const resultRecord =
        typeof result === "object" && result !== null
          ? result as Record<string, unknown>
          : undefined;
      const moduleNotice = autoEnabledModule
        ? `[Module "${autoEnabledModule}" auto-enabled]\n`
        : "";
      const handlerIsError = resultRecord?.isError === true;

      // Multi-content response (turbo mode: array of text/image blocks).
      // Every text block shares one aggregate budget, while media and unrelated
      // MCP content are retained only within deterministic item/data bounds.
      if (resultRecord && Array.isArray(resultRecord.content)) {
        const content = sanitizeMcpContent(resultRecord.content, moduleNotice);
        return {
          content,
          ...(handlerIsError ? { isError: true } : {}),
        };
      }

      // Image response (optionally with text).
      if (
        resultRecord
        && typeof resultRecord.image === "object"
        && resultRecord.image !== null
        && !Array.isArray(resultRecord.image)
      ) {
        const image = resultRecord.image as Record<string, unknown>;
        const contentBlocks: unknown[] = [];
        if (typeof image.data === "string" && typeof image.mimeType === "string") {
          contentBlocks.push({
            type: "image",
            data: image.data,
            mimeType: image.mimeType,
          });
        }
        const rawText = typeof resultRecord.text === "string" ? resultRecord.text : "";
        const combinedText = moduleNotice + rawText;
        if (combinedText) contentBlocks.push({ type: "text", text: combinedText });
        return {
          content: sanitizeMcpContent(contentBlocks),
          ...(handlerIsError ? { isError: true } : {}),
        };
      }

      const fallbackText = resultRecord && typeof resultRecord.text === "string"
        ? resultRecord.text
        : summarizeMcpFallbackResult(result);
      let text = sanitizeErrorMessage(fallbackText);

      // Global safety net: truncate oversized text responses.
      if (text.length > MCP_MAX_RESPONSE_TEXT_CHARS) {
        const remaining = text.length - MCP_MAX_RESPONSE_TEXT_CHARS;
        text = text.slice(0, MCP_MAX_RESPONSE_TEXT_CHARS) + `\n\n[truncated, ${remaining} chars remaining]`;
      }

      // Anti-pattern detection (only at top level, not on errors; skipped in turbo — flow manages feedback)
      const hint = turboEnabled ? null : detectAntiPattern();
      const hintBlock = hint ? `\n[HINT: ${hint}]` : "";

      return {
        content: [
          {
            type: "text",
            text: sanitizeErrorMessage(moduleNotice + text + hintBlock),
          },
        ],
        ...(handlerIsError ? { isError: true } : {}),
      };
    } catch (error: unknown) {
      const code = error instanceof MobileError ? error.code : "UNKNOWN";
      const message = sanitizeErrorMessage(
        error instanceof Error ? error.message : String(error),
      ).slice(0, 4_000);
      const retryHint = isRetryable(error) ? "\nRetry: yes" : "";
      const recoveryHints = getRecoveryHints(error);
      const recoveryBlock = recoveryHints.length > 0
        ? `\n[RECOVERY: ${JSON.stringify(recoveryHints)}]`
        : "";
      const retryInfo = error instanceof MobileError && error.retryInfo
        ? `\n${sanitizeErrorMessage(error.retryInfo).slice(0, 1_000)}`
        : "";
      return {
        content: [
          {
            type: "text",
            text: sanitizeErrorMessage(
              `[${code}] ${message}${retryHint}${retryInfo}${recoveryBlock}`,
            ).slice(0, 4_000),
          },
        ],
        isError: true,
      };
    }
  });

  async function start(): Promise<void> {
    const transport = new CompatibleStdioServerTransport();
    await server.connect(transport);
    console.error("Claude Mobile MCP server running (Android + iOS + Desktop + Aurora + HarmonyOS + Browser)");
  }

  return { server, start };
}
