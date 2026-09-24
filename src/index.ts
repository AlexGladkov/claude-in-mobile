#!/usr/bin/env node

import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { z } from "zod";


import {
  assertToolsAvailable,
  freezeRegistry,
  registerTools,
} from "./tools/registry.js";
import type { ToolDefinition } from "./tools/registry.js";
import { createToolContext, MAX_RECURSION_DEPTH } from "./tools/context.js";
import { MobileError } from "./errors.js";
import { getGlobalMetrics } from "./utils/metrics.js";
import { sanitizeErrorMessage } from "./utils/sanitize.js";
import { VALID_PROFILES } from "./profiles.js";
import type { MobileProfile } from "./profiles.js";
import { recordCall } from "./utils/anti-patterns.js";
import { bootstrapKernelAsync } from "./runtime/bootstrap.js";
import type { KernelHandle } from "./runtime/bootstrap.js";
import { DeviceManager } from "./device-manager.js";
import type { ToolDefinition as PluginToolDefinition } from "@mcp-devices/plugin-api";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { captureStep } from "./tools/recorder-tools.js";
import { resolveToolCall } from "./tools/registry.js";
import { buildInstructions } from "./runtime/mcp-instructions.js";
import { runCliIfRequested } from "./runtime/cli.js";
import { runPlatformCommand } from "./runtime/platform-cli.js";
import { runToolPluginCommand } from "./runtime/tool-plugin-cli.js";
import { runExternalPluginCommand } from "./runtime/external-plugin-cli.js";
import { resolveExternalPlugins } from "./runtime/external-plugin-config.js";
import { createMcpServer } from "./runtime/mcp-server.js";
import { readPrivateFileSync } from "./utils/private-storage.js";


// Read version from package.json — single source of truth.
const packageMetadataSchema = z.object({
  version: z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/),
}).passthrough();
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = packageMetadataSchema.parse(
  JSON.parse(readPrivateFileSync(
    join(__dirname, "../package.json"),
    1024 * 1024,
    "package metadata",
  ).toString("utf8")),
);

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

// Assigned after kernel initialization. No default adapter graph is created:
// the kernel plugins are the sole owners of platform resources.
let ctx: ReturnType<typeof createToolContext>;

// Resolve profile from MOBILE_PROFILE env for use in MCP instructions only —
// the actual registration of meta tools / aliases / module metadata happens
// inside BuiltinToolsPlugin.init() during kernel.initAll() below.
const rawProfile = process.env.MOBILE_PROFILE ?? "core";
const activeProfile: MobileProfile = VALID_PROFILES.includes(rawProfile as MobileProfile)
  ? (rawProfile as MobileProfile)
  : "core";

// Configuration commands short-circuit before any kernel/server boot.
await runExternalPluginCommand(process.argv);
runToolPluginCommand(process.argv);
runPlatformCommand(process.argv);

// Kernel bootstrap — see runtime/bootstrap.ts. External plugins require both
// explicit opt-in and a managed lockfile.
const enableExternal = resolveExternalPlugins();
const kernel: KernelHandle = await bootstrapKernelAsync(
  enableExternal ? { externalPlugins: true } : {},
);
await kernel.initAll();

// Route tools through the kernel-backed DeviceManager: its adapters come from
// the enabled platform plugins (slim base + on-demand platforms). Replaces the
// placeholder ctx so `getAdapter(platform)` resolves installed platforms and
// returns the actionable "install <platform>" error for disabled ones.
ctx = createToolContext(handleTool, {
  turboDefault: turboEnabled,
  deviceManager: DeviceManager.fromKernel(kernel),
});

const kernelToolDefs: ToolDefinition[] = [];
const kernelToolsByOwner = new Map<string, ToolDefinition[]>();
for (const def of kernel.tools.values()) {
  const pluginDef: PluginToolDefinition = def;
  const mcpTool: Tool = {
    name: pluginDef.name,
    description: pluginDef.description,
    inputSchema: pluginDef.inputSchema as Tool["inputSchema"],
  };
  const legacyDef: ToolDefinition = {
    tool: mcpTool,
    handler: async (args) => pluginDef.handler(args),
  };
  kernelToolDefs.push(legacyDef);
  const owner = kernel.toolOwners.get(pluginDef.name) ?? "kernel";
  const owned = kernelToolsByOwner.get(owner) ?? [];
  owned.push(legacyDef);
  kernelToolsByOwner.set(owner, owned);
}
for (const [owner, defs] of kernelToolsByOwner) {
  assertToolsAvailable(defs.map((def) => def.tool.name), owner);
  registerTools(defs, owner);
}
if (kernelToolDefs.length > 0) {
  console.error(`[kernel] registered ${kernelToolDefs.length} plugin tools: ${kernelToolDefs.map((d) => d.tool.name).join(", ")}`);
}

// Freeze tool registration — no new tools can be registered after this point.
// Alias registration remains open for client-specific aliases in oninitialized.
freezeRegistry();

// --help / --version / --init short-circuit. Without these flags, agents that
// probe `npx -y mcp-devices --help` (notably Gemini) cause the MCP server
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
    await kernel.disposeAll();
  } catch (e) {
    console.error("Kernel dispose error:", sanitizeErrorMessage(e));
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
  console.error("Fatal error:", sanitizeErrorMessage(error));
  process.exit(1);
});
