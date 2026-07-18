import type { ToolDefinition } from "./registry.js";
import { defineTool, z } from "./define-tool.js";
import { textResult } from "../utils/tool-result.js";
import { validatePackageName, validatePath } from "../utils/sanitize.js";

const auroraPlatform = z.literal("aurora").optional();
const packageField = z.string().describe("Aurora application package ID");
const json = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value, null, 2);
const client = (ctx: Parameters<ToolDefinition["handler"]>[1]) => ctx.deviceManager.getAuroraClient();

export const auroraDeviceCapabilityTools: ToolDefinition[] = [
  defineTool({
    name: "device_emulator_status",
    description: "Get Aurora Emulator process status",
    schema: z.object({ platform: auroraPlatform }),
    handler: async (_args, ctx) => textResult(json(client(ctx).execute(["emulator", "status"]))),
  }),
  defineTool({
    name: "device_emulator_start",
    description: "Start Aurora Emulator explicitly",
    schema: z.object({
      timeout: z.number().default(90).describe("Startup timeout in seconds"),
      platform: auroraPlatform,
    }),
    handler: async (args, ctx) => textResult(json(client(ctx).execute(["emulator", "start", "--timeout", String(args.timeout)], (args.timeout + 10) * 1000))),
  }),
  defineTool({
    name: "device_emulator_stop",
    description: "Stop Aurora Emulator explicitly",
    schema: z.object({ platform: auroraPlatform }),
    handler: async (_args, ctx) => textResult(json(client(ctx).execute(["emulator", "stop"], 45_000))),
  }),
  defineTool({
    name: "device_aurora_setup_status",
    description: "Inspect audb QEMU wrapper/setup status without changing it",
    schema: z.object({ platform: auroraPlatform }),
    handler: async (_args, ctx) => textResult(json(client(ctx).execute(["setup-status"]))),
  }),
];

export const auroraAppCapabilityTools: ToolDefinition[] = [
  defineTool({
    name: "app_uninstall",
    description: "Uninstall an application package (Aurora supported)",
    schema: z.object({ package: packageField, platform: auroraPlatform }),
    handler: async (args, ctx) => {
      validatePackageName(args.package);
      return textResult(client(ctx).uninstallApp(args.package));
    },
  }),
  defineTool({
    name: "app_list_running",
    description: "List running Aurora applications",
    schema: z.object({ platform: auroraPlatform }),
    handler: async (_args, ctx) => textResult(json(client(ctx).execute(["app", "list-running"]))),
  }),
  ...(["pid", "is_running"] as const).map((action) => defineTool({
    name: `app_${action}`,
    description: `${action === "pid" ? "Get PID of" : "Check whether running"} an Aurora application`,
    schema: z.object({ package: packageField, platform: auroraPlatform }),
    handler: async (args, ctx) => {
      validatePackageName(args.package);
      try {
        const result = client(ctx).execute<{ pid: number }>(["app", "pid", args.package]);
        return textResult(action === "pid" ? String(result.pid) : `true (pid=${result.pid})`);
      } catch (error: unknown) {
        if (action === "is_running" && error && typeof error === "object" && "code" in error && error.code === "APP_NOT_RUNNING") return textResult("false");
        throw error;
      }
    },
  })),
  ...(["running", "stopped"] as const).map((state) => defineTool({
    name: `app_wait_${state}`,
    description: `Wait until an Aurora application is ${state}`,
    schema: z.object({
      package: packageField,
      timeout: z.number().default(15).describe("Timeout in seconds"),
      interval: z.number().default(0.25).describe("Polling interval in seconds"),
      platform: auroraPlatform,
    }),
    handler: async (args, ctx) => {
      validatePackageName(args.package);
      const result = client(ctx).execute(
        ["app", `wait-${state}`, args.package, "--timeout", String(args.timeout), "--interval", String(args.interval)],
        (args.timeout + 5) * 1000,
      );
      return textResult(json(result));
    },
  })),
  defineTool({
    name: "app_clear_data",
    description: "Preview or clear Aurora private app data. Destructive mode requires confirm:true.",
    schema: z.object({ package: packageField, confirm: z.boolean().default(false), platform: auroraPlatform }),
    handler: async (args, ctx) => {
      validatePackageName(args.package);
      return textResult(json(client(ctx).clearAppData(args.package, args.confirm)));
    },
  }),
  defineTool({
    name: "app_sign",
    description: "Sign an Aurora RPM using audb Build Tools integration",
    schema: z.object({ path: z.string(), key: z.string().optional(), cert: z.string().optional(), platform: auroraPlatform }),
    handler: async (args, ctx) => {
      validatePath(args.path, "path");
      const argv = ["package", "sign", args.path];
      if (args.key) argv.push("--key", args.key);
      if (args.cert) argv.push("--cert", args.cert);
      return textResult(json(client(ctx).execute(argv, 120_000)));
    },
  }),
  defineTool({
    name: "app_validate",
    description: "Validate an Aurora RPM",
    schema: z.object({ path: z.string(), platform: auroraPlatform }),
    handler: async (args, ctx) => {
      validatePath(args.path, "path");
      return textResult(json(client(ctx).execute(["package", "validate", args.path], 120_000)));
    },
  }),
];

export const auroraSystemCapabilityTools: ToolDefinition[] = [
  ...(["status", "on", "off", "dim", "lock", "wake"] as const).map((action) => defineTool({
    name: `system_display_${action}`,
    description: `${action === "status" ? "Get" : "Set"} Aurora display state${action === "status" ? "" : `: ${action}`}`,
    schema: z.object({ timeout: z.number().default(5), platform: auroraPlatform }),
    handler: async (args, ctx) => {
      const argv = ["display", action];
      if (action !== "status") argv.push("--timeout", String(args.timeout));
      return textResult(json(client(ctx).execute(argv, (args.timeout + 5) * 1000)));
    },
  })),
  defineTool({
    name: "system_clipboard_status",
    description: "Report Aurora global clipboard capability status",
    schema: z.object({ platform: auroraPlatform }),
    handler: async (_args, ctx) => textResult(json(client(ctx).execute(["clipboard", "status"]))),
  }),
];

export const auroraPerformanceCapabilityTools: ToolDefinition[] = [
  defineTool({
    name: "performance_visual_fps",
    description: "Measure visual FPS and freezes from Aurora Emulator screenshots",
    schema: z.object({ duration: z.number().default(5000), interval: z.number().default(200), freezeThreshold: z.number().default(1000), platform: auroraPlatform }),
    handler: async (args, ctx) => textResult(json(client(ctx).execute([
      "perf", "visual-fps", "--duration", String(args.duration / 1000), "--interval", String(args.interval / 1000), "--freeze-threshold", String(args.freezeThreshold / 1000),
    ], args.duration + 10_000))),
  }),
  defineTool({
    name: "performance_crash_watch",
    description: "Wait for an Aurora application crash",
    schema: z.object({ packageName: packageField, timeout: z.number().default(30), interval: z.number().default(0.5), platform: auroraPlatform }),
    handler: async (args, ctx) => {
      validatePackageName(args.packageName);
      return textResult(json(client(ctx).execute(["crash", "watch", args.packageName, "--timeout", String(args.timeout), "--interval", String(args.interval)], (args.timeout + 5) * 1000)));
    },
  }),
  defineTool({
    name: "performance_crash_clear",
    description: "Clear audb crash observation state for Aurora",
    schema: z.object({ packageName: z.string().optional(), platform: auroraPlatform }),
    handler: async (args, ctx) => {
      const argv = ["crash", "clear"];
      if (args.packageName) { validatePackageName(args.packageName); argv.push(args.packageName); }
      return textResult(json(client(ctx).execute(argv)));
    },
  }),
];

export const auroraNetworkCapabilityTools: ToolDefinition[] = [
  defineTool({
    name: "network_interfaces",
    description: "List Aurora Emulator network interfaces",
    schema: z.object({ platform: auroraPlatform }),
    handler: async (_args, ctx) => textResult(json(client(ctx).execute(["network", "interfaces"]))),
  }),
  defineTool({
    name: "network_offline",
    description: "Toggle application network isolation while preserving audb SSH control",
    schema: z.object({ enabled: z.boolean(), platform: auroraPlatform }),
    handler: async (args, ctx) => textResult(json(client(ctx).execute(["network", "offline", args.enabled ? "on" : "off"]))),
  }),
];

export const auroraSensorCapabilityTools: ToolDefinition[] = [
  defineTool({
    name: "sensor_list",
    description: "List Aurora Emulator sensors",
    schema: z.object({ platform: auroraPlatform }),
    handler: async (_args, ctx) => textResult(json(client(ctx).execute(["sensor", "list"]))),
  }),
  ...(["enable", "disable"] as const).map((action) => defineTool({
    name: `sensor_${action}`,
    description: `${action} an Aurora Emulator sensor`,
    schema: z.object({ sensor: z.string(), platform: auroraPlatform }),
    handler: async (args, ctx) => textResult(json(client(ctx).execute(["sensor", action, args.sensor]))),
  })),
  defineTool({
    name: "sensor_set_vector",
    description: "Set a three-axis Aurora Emulator sensor value",
    schema: z.object({ sensor: z.string(), x: z.number(), y: z.number(), z: z.number(), platform: auroraPlatform }),
    handler: async (args, ctx) => textResult(json(client(ctx).execute(["sensor", "set-vector", args.sensor, String(args.x), String(args.y), String(args.z)]))),
  }),
  defineTool({
    name: "sensor_set_scalar",
    description: "Set a scalar Aurora Emulator sensor value",
    schema: z.object({ sensor: z.string(), value: z.number(), platform: auroraPlatform }),
    handler: async (args, ctx) => textResult(json(client(ctx).execute(["sensor", "set-scalar", args.sensor, String(args.value)]))),
  }),
  defineTool({
    name: "sensor_location_track",
    description: "Control an already loaded Aurora Emulator location track",
    schema: z.object({ actionName: z.enum(["start", "stop", "pause", "resume", "next", "previous", "clear"]), value: z.string().optional(), loop: z.boolean().optional(), speed: z.number().optional(), defaultInterval: z.boolean().optional(), platform: auroraPlatform }),
    handler: async (args, ctx) => {
      const argv = ["location", "track", args.actionName];
      if (args.value) argv.push(args.value);
      if (args.loop !== undefined) argv.push("--loop", String(args.loop));
      if (args.speed !== undefined) argv.push("--speed", String(args.speed));
      if (args.defaultInterval !== undefined) argv.push("--default-interval", String(args.defaultInterval));
      return textResult(json(client(ctx).execute(argv)));
    },
  }),
];

export const auroraSandboxCapabilityTools: ToolDefinition[] = [
  defineTool({
    name: "sandbox_paths",
    description: "Discover canonical Aurora private data roots for an app",
    schema: z.object({ package: packageField, platform: auroraPlatform }),
    handler: async (args, ctx) => {
      validatePackageName(args.package);
      return textResult(json(client(ctx).execute(["sandbox", "paths", args.package])));
    },
  }),
  defineTool({
    name: "sandbox_file_pull",
    description: "Pull a file from a canonical Aurora app sandbox root",
    schema: z.object({ package: packageField, root: z.enum(["config", "cache", "data"]), path: z.string(), output: z.string(), platform: auroraPlatform }),
    handler: async (args, ctx) => {
      validatePackageName(args.package);
      validatePath(args.path, "path");
      validatePath(args.output, "output");
      return textResult(json(client(ctx).execute(["sandbox", "pull", args.package, args.root, args.path, args.output])));
    },
  }),
];
