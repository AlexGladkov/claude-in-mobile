import type { ToolDefinition } from "./registry.js";
import { defineTool, z } from "./define-tool.js";
import type { LaunchMode } from "../desktop/types.js";
import { validatePath, validateJvmArg, validateBundleId } from "../utils/sanitize.js";
import { textResult } from "../utils/tool-result.js";

export const desktopTools: ToolDefinition[] = [
  defineTool({
    name: "desktop_launch",
    description:
      "Start desktop automation and optionally launch an app. Supports three modes: 'bundle' (launch a native macOS app by bundle ID or path), 'attach' (attach to an already-running process by PID), 'gradle' (launch a Compose Desktop app via Gradle). If no mode is specified, infers from the provided fields.",
    schema: z.object({
      mode: z
        .enum(["gradle", "bundle", "attach", "companion-only"])
        .optional()
        .describe(
          "Launch mode. 'bundle': launch native macOS app; 'attach': attach to running process; 'gradle': launch Compose Desktop via Gradle; 'companion-only': start companion only.",
        ),
      projectPath: z.string().optional().describe("Gradle mode: path to the Gradle project directory."),
      task: z.string().optional().describe("Gradle mode: Gradle task to run (auto-detected if not specified)."),
      jvmArgs: z
        .array(z.string())
        .optional()
        .describe("Gradle mode: JVM arguments to pass to the app."),
      bundleId: z.string().optional().describe("Bundle mode: macOS bundle ID, e.g. 'com.apple.TextEdit'."),
      appPath: z
        .string()
        .optional()
        .describe("Bundle mode: absolute path to .app bundle, e.g. '/Applications/TextEdit.app'."),
      pid: z.number().optional().describe("Attach mode: PID of an already-running process to attach to."),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          "Bundle/Gradle mode: environment variables to set for the launched app (e.g. {RELAY_UITEST_MODE:'1'}).",
        ),
    }),
    handler: async (args, ctx) => {
      // Boundary format validation (presence/conflict checks are in normalizeLaunchOptions)
      if (args.bundleId) {
        validateBundleId(args.bundleId);
      }
      if (args.projectPath) {
        validatePath(args.projectPath, "projectPath");
      }
      if (args.appPath) {
        validatePath(args.appPath, "appPath");
      }
      if (args.pid !== undefined && (args.pid <= 0 || !Number.isInteger(args.pid))) {
        return textResult("Error: pid must be a positive integer");
      }
      if (args.jvmArgs) {
        for (const arg of args.jvmArgs) {
          validateJvmArg(arg);
        }
      }

      const result = await ctx.deviceManager.launchDesktopApp({
        mode: args.mode as LaunchMode | undefined,
        projectPath: args.projectPath,
        task: args.task,
        jvmArgs: args.jvmArgs,
        bundleId: args.bundleId,
        appPath: args.appPath,
        pid: args.pid,
        env: args.env,
      });
      return textResult(result);
    },
  }),

  defineTool({
    name: "desktop_stop",
    description: "Stop running desktop application",
    schema: z.object({}),
    handler: async (_args, ctx) => {
      await ctx.deviceManager.stopDesktopApp();
      return textResult("Desktop app stopped");
    },
  }),

  defineTool({
    name: "desktop_windows",
    description: "Get desktop window info",
    schema: z.object({}),
    handler: async (_args, ctx) => {
      if (!ctx.deviceManager.isDesktopRunning()) {
        return textResult("Desktop app is not running. Use desktop(action:'launch') first.");
      }
      const windowInfo = await ctx.deviceManager.getDesktopClient().getWindowInfo();
      if (windowInfo.windows.length === 0) {
        return textResult("No windows found");
      }
      let result = "Desktop windows:\n";
      for (const w of windowInfo.windows) {
        const focused = w.focused ? " [FOCUSED]" : "";
        const pid = w.processId ? ` PID:${w.processId}` : "";
        result += `  • ${w.id} - ${w.title}${focused}${pid} (${w.bounds.width}x${w.bounds.height})\n`;
      }
      return textResult(result.trim());
    },
  }),

  defineTool({
    name: "desktop_focus",
    description: "Focus a desktop window",
    schema: z.object({
      windowId: z.string().describe("Window ID from desktop(action:'windows')"),
    }),
    handler: async (args, ctx) => {
      if (!ctx.deviceManager.isDesktopRunning()) {
        return textResult("Desktop app is not running. Use desktop(action:'launch') first.");
      }
      await ctx.deviceManager.getDesktopClient().focusWindow(args.windowId);
      return textResult(`Focused window: ${args.windowId}`);
    },
  }),

  defineTool({
    name: "desktop_resize",
    description: "Resize a desktop window",
    schema: z.object({
      windowId: z.string().optional().describe("Window ID (optional, uses focused window if not specified)"),
      width: z.number().describe("New window width in pixels"),
      height: z.number().describe("New window height in pixels"),
    }),
    handler: async (args, ctx) => {
      if (!ctx.deviceManager.isDesktopRunning()) {
        return textResult("Desktop app is not running. Use desktop(action:'launch') first.");
      }
      await ctx.deviceManager
        .getDesktopClient()
        .resizeWindow(args.width, args.height, args.windowId);
      return textResult(`Resized window to ${args.width}x${args.height}`);
    },
  }),

  defineTool({
    name: "clipboard_get",
    description: "Get clipboard text (Desktop only)",
    schema: z.object({}),
    handler: async (_args, ctx) => {
      if (!ctx.deviceManager.isDesktopRunning()) {
        return textResult("Desktop app is not running. Use desktop(action:'launch') first.");
      }
      const clipboardText = await ctx.deviceManager.getDesktopClient().getClipboard();
      return textResult(clipboardText || "(empty)");
    },
  }),

  defineTool({
    name: "clipboard_set",
    description: "Set clipboard text (Desktop only)",
    schema: z.object({
      text: z.string().describe("Text to set in clipboard"),
    }),
    handler: async (args, ctx) => {
      if (!ctx.deviceManager.isDesktopRunning()) {
        return textResult("Desktop app is not running. Use desktop(action:'launch') first.");
      }
      await ctx.deviceManager.getDesktopClient().setClipboard(args.text);
      return textResult("Clipboard set");
    },
  }),

  defineTool({
    name: "desktop_performance",
    description: "Get memory and CPU metrics (Desktop only)",
    schema: z.object({}),
    handler: async (_args, ctx) => {
      if (!ctx.deviceManager.isDesktopRunning()) {
        return textResult("Desktop app is not running. Use desktop(action:'launch') first.");
      }
      const metrics = await ctx.deviceManager.getDesktopClient().getPerformanceMetrics();
      let result = "Performance metrics:\n";
      result += `  Memory: ${metrics.memoryUsageMb} MB\n`;
      if (metrics.cpuPercent !== undefined) {
        result += `  CPU: ${metrics.cpuPercent}%\n`;
      }
      return textResult(result.trim());
    },
  }),

  defineTool({
    name: "desktop_monitors",
    description: "List connected monitors (Desktop only)",
    schema: z.object({}),
    handler: async (_args, ctx) => {
      if (!ctx.deviceManager.isDesktopRunning()) {
        return textResult("Desktop app is not running. Use desktop(action:'launch') first.");
      }
      const monitors = await ctx.deviceManager.getDesktopClient().getMonitors();
      if (monitors.length === 0) {
        return textResult("No monitors found");
      }
      let result = `Connected monitors (${monitors.length}):\n`;
      for (const m of monitors) {
        const primary = m.isPrimary ? " [PRIMARY]" : "";
        result += `  • Monitor ${m.index}${primary}: ${m.width}x${m.height} at (${m.x}, ${m.y}) - ${m.name}\n`;
      }
      return textResult(result.trim());
    },
  }),

  defineTool({
    name: "desktop_get_target_pid",
    description:
      "Get the PID of the native app set by the last desktop_launch (bundle or attach mode). Returns null if no target PID is set.",
    schema: z.object({}),
    handler: async (_args, ctx) => {
      if (!ctx.deviceManager.isDesktopRunning()) {
        return textResult("Desktop companion is not running. Use desktop_launch first.");
      }
      const pid = ctx.deviceManager.getDesktopClient().getTargetPid();
      if (pid === null) {
        return textResult(
          "No target PID set. Use desktop_launch with mode:'bundle' or mode:'attach' to set a target.",
        );
      }
      return textResult(`Target PID: ${pid}`);
    },
  }),
];
