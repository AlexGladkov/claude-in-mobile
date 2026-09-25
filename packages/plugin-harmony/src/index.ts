import type {
  PluginContext,
  PluginManifest,
  SourcePlugin,
  ToolDefinition,
} from "@mcp-devices/plugin-api";

import { HarmonyAdapter } from "./harmony-adapter.js";

const TOOL_NAMES = [
  "harmony_launch_ability",
  "harmony_arkweb_inspect",
  "harmony_arkweb_close",
  "harmony_sandbox_list",
  "harmony_sandbox_read",
  "harmony_sandbox_push",
  "harmony_sandbox_pull",
  "harmony_test",
] as const;

export const HARMONY_PLUGIN_MANIFEST: PluginManifest = {
  id: "harmony",
  name: "HarmonyOS Next",
  version: "4.4.1",
  apiVersion: "1",
  capabilities: [
    "screen",
    "input",
    "ui",
    "shell",
    "permissions",
    "appLifecycle",
    "logs",
    "url",
    "fileTransfer",
    "deviceMgmt",
  ],
  tools: TOOL_NAMES,
  description:
    "HarmonyOS Next automation via HDC and ArkXTest (screen, input, UI, apps, permissions, shell, logs, files, ArkWeb, app sandbox, tests)",
};

interface HarmonyToolArgs {
  deviceId?: string;
  bundleId?: string;
  ability?: string;
  moduleName?: string;
  socket?: string;
  path?: string;
  localPath?: string;
  remotePath?: string;
  runner?: string;
  className?: string;
  notClass?: string;
  localPort?: number;
  maxBytes?: number;
  timeoutMs?: number;
  dryRun?: boolean;
}

const STRING_FIELDS = [
  "deviceId",
  "bundleId",
  "ability",
  "moduleName",
  "socket",
  "path",
  "localPath",
  "remotePath",
  "runner",
  "className",
  "notClass",
] as const;
const NUMBER_FIELDS = ["localPort", "maxBytes", "timeoutMs"] as const;
const BOOLEAN_FIELDS = ["dryRun"] as const;

function toolArgs(value: unknown): HarmonyToolArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Harmony tool arguments must be an object");
  }
  const args: HarmonyToolArgs = {};
  for (const key of STRING_FIELDS) {
    const field = Reflect.get(value, key);
    if (field !== undefined && typeof field !== "string") {
      throw new TypeError(`${key} must be a string`);
    }
    if (typeof field === "string") args[key] = field;
  }
  for (const key of NUMBER_FIELDS) {
    const field = Reflect.get(value, key);
    if (field !== undefined && typeof field !== "number") {
      throw new TypeError(`${key} must be a number`);
    }
    if (typeof field === "number") args[key] = field;
  }
  for (const key of BOOLEAN_FIELDS) {
    const field = Reflect.get(value, key);
    if (field !== undefined && typeof field !== "boolean") {
      throw new TypeError(`${key} must be a boolean`);
    }
    if (typeof field === "boolean") args[key] = field;
  }
  return args;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}

export class HarmonyPlugin implements SourcePlugin {
  readonly manifest = HARMONY_PLUGIN_MANIFEST;
  readonly adapter: HarmonyAdapter;

  constructor(adapter: HarmonyAdapter = new HarmonyAdapter()) {
    this.adapter = adapter;
  }

  init(ctx: PluginContext): void {
    for (const definition of this.toolDefinitions()) ctx.registerTool(definition);
  }

  dispose(): void {
    this.adapter.dispose();
  }

  private toolDefinitions(): ToolDefinition[] {
    const client = this.adapter.getClient();
    return [
      {
        name: "harmony_launch_ability",
        description:
          "Launch a HarmonyOS ability with an optional module name. Defaults to EntryAbility.",
        inputSchema: {
          type: "object",
          required: ["bundleId"],
          properties: {
            bundleId: { type: "string", description: "HarmonyOS bundle name" },
            ability: { type: "string", default: "EntryAbility" },
            moduleName: {
              type: "string",
              description: "Optional HAP module name, for example entry",
            },
            deviceId: { type: "string" },
          },
        },
        handler: async (value) => {
          const args = toolArgs(value);
          return {
            message: this.adapter.launchAbility(
              required(args.bundleId, "bundleId"),
              args.ability ?? "EntryAbility",
              args.moduleName,
              args.deviceId,
            ),
          };
        },
      },
      {
        name: "harmony_arkweb_inspect",
        description:
          "Discover an ArkWeb DevTools socket, forward it over HDC, and list inspectable pages.",
        inputSchema: {
          type: "object",
          properties: {
            socket: { type: "string", description: "Optional webview_devtools_remote_* socket" },
            localPort: { type: "number", default: 9222 },
            deviceId: { type: "string" },
          },
        },
        handler: async (value) => {
          const args = toolArgs(value);
          const result = await client.inspectArkWeb(
            args.socket,
            args.localPort ?? 9_222,
            args.deviceId,
          );
          return { message: JSON.stringify(result, null, 2) };
        },
      },
      {
        name: "harmony_arkweb_close",
        description: "Remove an ArkWeb HDC port-forward created for inspection.",
        inputSchema: {
          type: "object",
          required: ["socket"],
          properties: {
            socket: { type: "string" },
            localPort: { type: "number", default: 9222 },
            deviceId: { type: "string" },
          },
        },
        handler: async (value) => {
          const args = toolArgs(value);
          return {
            message: client.closeArkWeb(
              required(args.socket, "socket"),
              args.localPort ?? 9_222,
              args.deviceId,
            ),
          };
        },
      },
      {
        name: "harmony_sandbox_list",
        description:
          "List files in a running debug-signed HarmonyOS application's sandbox.",
        inputSchema: {
          type: "object",
          required: ["bundleId"],
          properties: {
            bundleId: { type: "string" },
            path: { type: "string", default: "." },
            deviceId: { type: "string" },
          },
        },
        handler: async (value) => {
          const args = toolArgs(value);
          return {
            message: client.sandboxList(
              required(args.bundleId, "bundleId"),
              args.path ?? ".",
              args.deviceId,
            ),
          };
        },
      },
      {
        name: "harmony_sandbox_read",
        description:
          "Read a text file from a running debug-signed HarmonyOS application's sandbox.",
        inputSchema: {
          type: "object",
          required: ["bundleId", "path"],
          properties: {
            bundleId: { type: "string" },
            path: { type: "string" },
            maxBytes: { type: "number", description: "Optional byte limit" },
            deviceId: { type: "string" },
          },
        },
        handler: async (value) => {
          const args = toolArgs(value);
          return {
            message: client.sandboxRead(
              required(args.bundleId, "bundleId"),
              required(args.path, "path"),
              args.maxBytes,
              args.deviceId,
            ),
          };
        },
      },
      {
        name: "harmony_sandbox_push",
        description:
          "Upload a file into a running debug-signed HarmonyOS application's sandbox.",
        inputSchema: {
          type: "object",
          required: ["bundleId", "localPath", "remotePath"],
          properties: {
            bundleId: { type: "string" },
            localPath: { type: "string" },
            remotePath: { type: "string" },
            deviceId: { type: "string" },
          },
        },
        handler: async (value) => {
          const args = toolArgs(value);
          return {
            message: client.sandboxPush(
              required(args.bundleId, "bundleId"),
              required(args.localPath, "localPath"),
              required(args.remotePath, "remotePath"),
              args.deviceId,
            ),
          };
        },
      },
      {
        name: "harmony_sandbox_pull",
        description:
          "Download a file from a running debug-signed HarmonyOS application's sandbox.",
        inputSchema: {
          type: "object",
          required: ["bundleId", "remotePath", "localPath"],
          properties: {
            bundleId: { type: "string" },
            remotePath: { type: "string" },
            localPath: { type: "string" },
            deviceId: { type: "string" },
          },
        },
        handler: async (value) => {
          const args = toolArgs(value);
          return {
            message: client.sandboxPull(
              required(args.bundleId, "bundleId"),
              required(args.remotePath, "remotePath"),
              required(args.localPath, "localPath"),
              args.deviceId,
            ),
          };
        },
      },
      {
        name: "harmony_test",
        description:
          "Run an ArkXTest module through `aa test`, with optional suite filters and dry-run.",
        inputSchema: {
          type: "object",
          required: ["bundleId", "moduleName"],
          properties: {
            bundleId: { type: "string" },
            moduleName: { type: "string" },
            runner: { type: "string", default: "OpenHarmonyTestRunner" },
            className: { type: "string", description: "describe or describe#it filter" },
            notClass: { type: "string", description: "describe or describe#it exclusion" },
            timeoutMs: { type: "number" },
            dryRun: { type: "boolean", default: false },
            deviceId: { type: "string" },
          },
        },
        handler: async (value) => {
          const args = toolArgs(value);
          return {
            message: client.runTests(
              required(args.bundleId, "bundleId"),
              required(args.moduleName, "moduleName"),
              args.runner ?? "OpenHarmonyTestRunner",
              {
                class: args.className,
                notClass: args.notClass,
                timeoutMs: args.timeoutMs,
                dryRun: args.dryRun,
              },
              args.deviceId,
            ),
          };
        },
      },
    ];
  }
}

export function createHarmonyPlugin(): SourcePlugin {
  return new HarmonyPlugin();
}

export { HdcClient } from "./client.js";
export { HarmonyAdapter } from "./harmony-adapter.js";
export const createPlugin = createHarmonyPlugin;
export default createHarmonyPlugin;
