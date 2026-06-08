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

import { registerTools, registerAliases, registerAliasesWithDefaults, setToolListChangedNotifier, getTools, resolveToolCall, freezeRegistry } from "./tools/registry.js";
import type { ToolDefinition } from "./tools/registry.js";
import { createToolContext, MAX_RECURSION_DEPTH } from "./tools/context.js";
import { detectClient, getConfigSnippet, type ClientType } from "./client-adapter.js";
import { MobileError, isRetryable, getRecoveryHints } from "./errors.js";
import { getGlobalMetrics } from "./utils/metrics.js";
import { PROFILE_VISIBLE, VALID_PROFILES, ALL_HIDEABLE_MODULES, type MobileProfile } from "./profiles.js";
import { recordCall, detectAntiPattern } from "./utils/anti-patterns.js";
import { bootstrapKernel, bootstrapKernelAsync, type KernelHandle } from "./runtime/bootstrap.js";
import type { ToolDefinition as PluginToolDefinition } from "@claude-in-mobile/plugin-api";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { captureStep } from "./tools/recorder-tools.js";

// Read version from package.json — single source of truth
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8")) as { version: string };

/** Build dynamic MCP instructions based on active profile and turbo setting */
function buildInstructions(profile: MobileProfile, turbo: boolean): string {
  const lines: string[] = [
    "Mobile, desktop, browser automation + store management.",
    "",
    "TOKEN COST (cheapest→expensive): ui(action:'tree',format:'semantic') ~60 tokens | ui(action:'tree',compact:true) ~100 tokens | ui(action:'tree') ~200 tokens | ui(action:'find') ~150 tokens | screen(action:'capture',preset:'low') ~1500 tokens | screen(action:'capture') ~3000 tokens | screen(action:'annotate') ~4000 tokens.",
    "",
    "EFFICIENT PATTERNS: 1) ui_tree first — text-based, ~10x cheaper than screenshots. 2) hints are ON by default — input actions return UI diff, no follow-up needed. Set hints:false only for rapid sequences. 3) screen(preset:'low') for quick visual checks. 4) flow(action:'batch')/flow(action:'run') for multi-step sequences (2-4x faster). 5) screen(diff:true) after actions — returns only changes. 6) ui(action:'tree',compact:true) — interactive elements only, shortest format.",
    "",
    "ANTI-PATTERNS: 1) screenshot after every tap (use hints instead). 2) ui_tree + screenshot together (pick one). 3) Full ui_tree when you only need one element (use ui(action:'find')). 4) screen(preset:'high') unless user requests visual detail.",
    "",
    "ERROR RECOVERY: On errors, [RECOVERY: ...] block contains suggested next tool calls as JSON.",
  ];

  // Hidden modules hint
  const hiddenCount = ALL_HIDEABLE_MODULES.length - PROFILE_VISIBLE[profile].length;
  if (hiddenCount > 0) {
    lines.push(
      "",
      `Optional modules (${hiddenCount} hidden) — device(action:'enable_module',module:'browser') to load. device(action:'enable_module',category:'platform') for batch. device(action:'list_modules') to see all.`,
    );
  }

  if (profile === "minimal") {
    lines.push(
      "",
      "MINIMAL profile active — only device+screen loaded. Use device(action:'enable_module') to load modules as needed.",
    );
  }

  if (turbo) {
    lines.push(
      "",
      "TURBO MODE (experimental): flow(action:'run') returns rich UI context per step. For multi-step operations (E2E testing, navigation sequences, form filling), ALWAYS use flow(action:'run', steps:[...]) instead of calling tools individually. One flow call replaces 10-50 individual calls.",
    );
  }

  return lines.join("\n");
}

// Dispatch function (needed by batch_commands / run_flow for recursion)

/** Retry config for transient errors. Only at depth=0 (top-level MCP calls). */
const RETRY_CONFIG: Record<string, { maxAttempts: number; delayMs: number[] }> = {
  DEVICE_OFFLINE: { maxAttempts: 3, delayMs: [300, 900, 2700] },
  COMMAND_TIMEOUT: { maxAttempts: 2, delayMs: [500, 1500] },
  ADB_ERROR: { maxAttempts: 2, delayMs: [300, 900] },
  SYNC_BARRIER_TIMEOUT: { maxAttempts: 2, delayMs: [500, 1500] },
};

async function handleTool(name: string, args: Record<string, unknown>, depth: number = 0): Promise<unknown> {
  if (depth > MAX_RECURSION_DEPTH) {
    throw new MobileError(`Maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded.`, "MAX_RECURSION");
  }

  // Record step if recording is active (no-op if idle, depth>0, or blocklisted)
  captureStep(name, args, depth);
  // Skip anti-pattern tracking for nested calls (flow sub-steps) in turbo — reduces overhead
  if (!(turboEnabled && depth > 0)) {
    recordCall(name, depth);
  }

  const resolved = resolveToolCall(name, args);
  if (!resolved) {
    throw new MobileError(`Unknown tool: ${name}`, "UNKNOWN_TOOL");
  }

  let lastError: unknown;
  const maxAttempts = depth === 0 ? undefined : 1; // Only retry at top level

  for (let attempt = 1; ; attempt++) {
    const start = Date.now();
    try {
      const result = await resolved.handler(resolved.args, ctx, depth);
      getGlobalMetrics().record(name, Date.now() - start, false);
      return result;
    } catch (error) {
      getGlobalMetrics().record(name, Date.now() - start, true);
      lastError = error;

      // Check if retryable and at top level
      if (depth !== 0) throw error;

      const code = error instanceof MobileError ? error.code : "";
      const config = RETRY_CONFIG[code];
      if (!config || attempt >= config.maxAttempts) {
        // Attach retry count info to error for the catch block in CallToolRequestSchema
        if (config && error instanceof MobileError) {
          error.retryInfo = `Retried: ${attempt}/${config.maxAttempts}`;
        }
        throw error;
      }

      const delay = config.delayMs[attempt - 1] ?? config.delayMs[config.delayMs.length - 1];
      console.error(`[retry] ${code} on ${name}, attempt ${attempt}/${config.maxAttempts}, waiting ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// Resolve MOBILE_TURBO env — server-wide turbo default for flow tools
const turboEnabled = process.env.MOBILE_TURBO === "true";
if (turboEnabled) console.error("[turbo] MOBILE_TURBO=true — flow(run) turbo mode enabled by default");

// Shared context (wired after handleTool is defined)
const ctx = createToolContext(handleTool, { turboDefault: turboEnabled });

// Resolve profile from MOBILE_PROFILE env for use in MCP instructions only —
// the actual registration of meta tools / aliases / module metadata happens
// inside BuiltinToolsPlugin.init() during kernel.initAll() below.
const rawProfile = process.env.MOBILE_PROFILE ?? "core";
const activeProfile: MobileProfile = VALID_PROFILES.includes(rawProfile as MobileProfile)
  ? (rawProfile as MobileProfile)
  : "core";

// Kernel bootstrap — surface microkernel plugin tools (e.g. REPL) through MCP.
// Prior to 3.11.5 the plugin system was wired but never instantiated from the
// MCP entry point, so repl_* tools never showed up despite shipping in dist/.
// See issue: REPL tools missing in 3.11.4.
//
// We only bootstrap REPL here — platform plugins (android/ios/desktop/web/
// aurora) are still served by the legacy meta-tool layer; switching them over
// is a 3.12.x scope item.
// Phase 4 (3.12.0): load the full set of first-party plugins through the
// kernel. Their `init()` is currently a no-op for android/ios/desktop/web/
// aurora — tools still register via the legacy meta-tool path below — but
// the lifecycle is now in place so each plugin can move its tools into
// `init(ctx).registerTool()` incrementally without touching this file.
// `CLAUDE_IN_MOBILE_EXTERNAL_PLUGINS=1` opts in to filesystem discovery from
// `~/.claude-in-mobile/plugins/`. Off by default in 3.12.0 — third-party
// authors can already publish plugins against `@claude-in-mobile/plugin-api`,
// the env flag avoids surprising existing installs while the contract settles.
const enableExternal = process.env.CLAUDE_IN_MOBILE_EXTERNAL_PLUGINS === "1";
const kernel: KernelHandle = enableExternal
  ? await bootstrapKernelAsync({ externalPlugins: true })
  : bootstrapKernel({});
await kernel.initAll();

const kernelToolDefs: ToolDefinition[] = [];
for (const def of kernel.tools.values()) {
  const pluginDef: PluginToolDefinition = def;
  const mcpTool: Tool = {
    name: pluginDef.name,
    description: pluginDef.description,
    inputSchema: pluginDef.inputSchema as Tool["inputSchema"],
  };
  kernelToolDefs.push({
    tool: mcpTool,
    handler: async (args) => pluginDef.handler(args),
  });
}
if (kernelToolDefs.length > 0) {
  registerTools(kernelToolDefs);
  console.error(`[kernel] registered ${kernelToolDefs.length} plugin tools: ${kernelToolDefs.map((d) => d.tool.name).join(", ")}`);
}

// Freeze tool registration — no new tools can be registered after this point.
// Alias registration remains open for client-specific aliases in oninitialized.
freezeRegistry();

// --help / --version short-circuit. Without these flags, agents that probe
// `npx -y claude-in-mobile --help` (notably Gemini) cause the MCP server to
// start its stdio JSON-RPC loop and block forever waiting on stdin, which
// looks like a deadlock from the agent's side. See issue #44.
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`claude-in-mobile ${pkg.version}

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

if (process.argv.includes("--version") || process.argv.includes("-V")) {
  console.log(pkg.version);
  process.exit(0);
}

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
    instructions: buildInstructions(activeProfile, turboEnabled),
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

    // Handle multi-content response (turbo mode: array of text/image blocks)
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
      // If moduleNotice was not prepended (no text blocks), add it
      if (moduleNotice && !content.some(b => b.type === "text")) {
        content.unshift({ type: "text", text: moduleNotice });
      }
      return { content };
    }

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

    // Anti-pattern detection (only at top level, not on errors; skipped in turbo — flow manages feedback)
    const hint = turboEnabled ? null : detectAntiPattern();
    const hintBlock = hint ? `\n[HINT: ${hint}]` : "";

    return {
      content: [
        {
          type: "text",
          text: moduleNotice + text + hintBlock,
        },
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
        {
          type: "text",
          text: `[${code}] ${message}${retryHint}${retryInfo}${recoveryBlock}`,
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
  try {
    await kernel.disposeAll();
  } catch (e) {
    console.error("Kernel dispose error:", e);
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
