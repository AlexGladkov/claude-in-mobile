#!/usr/bin/env node

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import { registerTools, freezeRegistry } from "./tools/registry.js";
import type { ToolDefinition } from "./tools/registry.js";
import { createToolContext, MAX_RECURSION_DEPTH } from "./tools/context.js";
import { MobileError } from "./errors.js";
import { getGlobalMetrics } from "./utils/metrics.js";
import { VALID_PROFILES, type MobileProfile } from "./profiles.js";
import { recordCall } from "./utils/anti-patterns.js";
import { bootstrapKernel, bootstrapKernelAsync, type KernelHandle } from "./runtime/bootstrap.js";
import type { ToolDefinition as PluginToolDefinition } from "@claude-in-mobile/plugin-api";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { captureStep } from "./tools/recorder-tools.js";
import { resolveToolCall } from "./tools/registry.js";
import { buildInstructions } from "./runtime/mcp-instructions.js";
import { runCliIfRequested } from "./runtime/cli.js";
import { createMcpServer } from "./runtime/mcp-server.js";

// Read version from package.json — single source of truth
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8")) as { version: string };

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
  for (let attempt = 1; ; attempt++) {
    const start = Date.now();
    try {
      const result = await resolved.handler(resolved.args, ctx, depth);
      getGlobalMetrics().record(name, Date.now() - start, false);
      return result;
    } catch (error) {
      getGlobalMetrics().record(name, Date.now() - start, true);
      lastError = error;

      // Only retry at top level
      if (depth !== 0) throw error;

      const code = error instanceof MobileError ? error.code : "";
      const config = RETRY_CONFIG[code];
      if (!config || attempt >= config.maxAttempts) {
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

// Kernel bootstrap — see runtime/bootstrap.ts. `CLAUDE_IN_MOBILE_EXTERNAL_PLUGINS=1`
// opts in to filesystem discovery from `~/.claude-in-mobile/plugins/`.
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

// --help / --version / --init short-circuit. Without these flags, agents that
// probe `npx -y claude-in-mobile --help` (notably Gemini) cause the MCP server
// to start its stdio JSON-RPC loop and block forever waiting on stdin, which
// looks like a deadlock from the agent's side. See issue #44.
runCliIfRequested(process.argv, pkg.version);

// Create + wire MCP server
const { server, start } = createMcpServer({
  name: "claude-mobile",
  version: pkg.version,
  instructions: buildInstructions(activeProfile, turboEnabled),
  turboEnabled,
  handleTool,
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

// Keep `server` referenced for debuggers / tools that introspect global state.
void server;

start().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
