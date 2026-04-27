import type { ToolDefinition } from "./registry.js";
import type { ToolContext } from "./context.js";
import { validatePath, validateJvmArg, validateBundleId } from "../utils/sanitize.js";

export const desktopTools: ToolDefinition[] = [
  {
    tool: {
      name: "desktop_launch",
      description: "Start desktop automation and optionally launch an app. Supports three modes: 'bundle' (launch a native macOS app by bundle ID or path), 'attach' (attach to an already-running process by PID), 'gradle' (launch a Compose Desktop app via Gradle). If no mode is specified, infers from the provided fields.",
      inputSchema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["gradle", "bundle", "attach", "companion-only"],
            description: "Launch mode. 'bundle': launch native macOS app; 'attach': attach to running process; 'gradle': launch Compose Desktop via Gradle; 'companion-only': start companion only.",
          },
          projectPath: { type: "string", description: "Gradle mode: path to the Gradle project directory." },
          task: { type: "string", description: "Gradle mode: Gradle task to run (auto-detected if not specified)." },
          jvmArgs: { type: "array", items: { type: "string" }, description: "Gradle mode: JVM arguments to pass to the app." },
          bundleId: { type: "string", description: "Bundle mode: macOS bundle ID, e.g. 'com.apple.TextEdit'." },
          appPath: { type: "string", description: "Bundle mode: absolute path to .app bundle, e.g. '/Applications/TextEdit.app'." },
          pid: { type: "number", description: "Attach mode: PID of an already-running process to attach to." },
          env: { type: "object", additionalProperties: { type: "string" }, description: "Bundle/Gradle mode: environment variables to set for the launched app (e.g. {RELAY_UITEST_MODE:'1'})." },
        },
      },
    },
    handler: async (args, ctx) => {
      const mode = args.mode as string | undefined;

      // Boundary format validation (presence/conflict checks are in normalizeLaunchOptions)
      if (args.bundleId) {
        validateBundleId(args.bundleId as string);
      }
      if (args.projectPath) {
        validatePath(args.projectPath as string, "projectPath");
      }
      if (args.jvmArgs) {
        for (const arg of args.jvmArgs as string[]) {
          validateJvmArg(arg);
        }
      }

      const result = await ctx.deviceManager.launchDesktopApp({
        mode: mode as any,
        projectPath: args.projectPath as string | undefined,
        task: args.task as string | undefined,
        jvmArgs: args.jvmArgs as string[] | undefined,
        bundleId: args.bundleId as string | undefined,
        appPath: args.appPath as string | undefined,
        pid: args.pid as number | undefined,
        env: args.env as Record<string, string> | undefined,
      });
      return { text: result };
    },
  },
  {
    tool: {
      name: "desktop_stop",
      description: "Stop running desktop application",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler: async (_args, ctx) => {
      await ctx.deviceManager.stopDesktopApp();
      return { text: "Desktop app stopped" };
    },
  },
  {
    tool: {
      name: "desktop_windows",
      description: "Get desktop window info",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler: async (_args, ctx) => {
      if (!ctx.deviceManager.isDesktopRunning()) {
        return { text: "Desktop app is not running. Use desktop(action:'launch') first." };
      }
      const windowInfo = await ctx.deviceManager.getDesktopClient().getWindowInfo();
      if (windowInfo.windows.length === 0) {
        return { text: "No windows found" };
      }
      let result = "Desktop windows:\n";
      for (const w of windowInfo.windows) {
        const focused = w.focused ? " [FOCUSED]" : "";
        const pid = (w as any).processId ? ` PID:${(w as any).processId}` : "";
        result += `  • ${w.id} - ${w.title}${focused}${pid} (${w.bounds.width}x${w.bounds.height})\n`;
      }
      return { text: result.trim() };
    },
  },
  {
    tool: {
      name: "desktop_focus",
      description: "Focus a desktop window",
      inputSchema: {
        type: "object",
        properties: {
          windowId: { type: "string", description: "Window ID from desktop(action:'windows')" },
        },
        required: ["windowId"],
      },
    },
    handler: async (args, ctx) => {
      if (!ctx.deviceManager.isDesktopRunning()) {
        return { text: "Desktop app is not running. Use desktop(action:'launch') first." };
      }
      await ctx.deviceManager.getDesktopClient().focusWindow(args.windowId as string);
      return { text: `Focused window: ${args.windowId}` };
    },
  },
  {
    tool: {
      name: "desktop_resize",
      description: "Resize a desktop window",
      inputSchema: {
        type: "object",
        properties: {
          windowId: { type: "string", description: "Window ID (optional, uses focused window if not specified)" },
          width: { type: "number", description: "New window width in pixels" },
          height: { type: "number", description: "New window height in pixels" },
        },
        required: ["width", "height"],
      },
    },
    handler: async (args, ctx) => {
      if (!ctx.deviceManager.isDesktopRunning()) {
        return { text: "Desktop app is not running. Use desktop(action:'launch') first." };
      }
      await ctx.deviceManager.getDesktopClient().resizeWindow(
        args.width as number,
        args.height as number,
        args.windowId as string | undefined
      );
      return { text: `Resized window to ${args.width}x${args.height}` };
    },
  },
  {
    tool: {
      name: "clipboard_get",
      description: "Get clipboard text (Desktop only)",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler: async (_args, ctx) => {
      if (!ctx.deviceManager.isDesktopRunning()) {
        return { text: "Desktop app is not running. Use desktop(action:'launch') first." };
      }
      const clipboardText = await ctx.deviceManager.getDesktopClient().getClipboard();
      return { text: clipboardText || "(empty)" };
    },
  },
  {
    tool: {
      name: "clipboard_set",
      description: "Set clipboard text (Desktop only)",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to set in clipboard" },
        },
        required: ["text"],
      },
    },
    handler: async (args, ctx) => {
      if (!ctx.deviceManager.isDesktopRunning()) {
        return { text: "Desktop app is not running. Use desktop(action:'launch') first." };
      }
      await ctx.deviceManager.getDesktopClient().setClipboard(args.text as string);
      return { text: "Clipboard set" };
    },
  },
  {
    tool: {
      name: "desktop_performance",
      description: "Get memory and CPU metrics (Desktop only)",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler: async (_args, ctx) => {
      if (!ctx.deviceManager.isDesktopRunning()) {
        return { text: "Desktop app is not running. Use desktop(action:'launch') first." };
      }
      const metrics = await ctx.deviceManager.getDesktopClient().getPerformanceMetrics();
      let result = "Performance metrics:\n";
      result += `  Memory: ${metrics.memoryUsageMb} MB\n`;
      if (metrics.cpuPercent !== undefined) {
        result += `  CPU: ${metrics.cpuPercent}%\n`;
      }
      return { text: result.trim() };
    },
  },
  {
    tool: {
      name: "desktop_monitors",
      description: "List connected monitors (Desktop only)",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler: async (_args, ctx) => {
      if (!ctx.deviceManager.isDesktopRunning()) {
        return { text: "Desktop app is not running. Use desktop(action:'launch') first." };
      }
      const monitors = await ctx.deviceManager.getDesktopClient().getMonitors();
      if (monitors.length === 0) {
        return { text: "No monitors found" };
      }
      let result = `Connected monitors (${monitors.length}):\n`;
      for (const m of monitors) {
        const primary = m.isPrimary ? " [PRIMARY]" : "";
        result += `  • Monitor ${m.index}${primary}: ${m.width}x${m.height} at (${m.x}, ${m.y}) - ${m.name}\n`;
      }
      return { text: result.trim() };
    },
  },
  {
    tool: {
      name: "desktop_get_target_pid",
      description: "Get the PID of the native app set by the last desktop_launch (bundle or attach mode). Returns null if no target PID is set.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler: async (_args, ctx) => {
      if (!ctx.deviceManager.isDesktopRunning()) {
        return { text: "Desktop companion is not running. Use desktop_launch first." };
      }
      const pid = ctx.deviceManager.getDesktopClient().getTargetPid();
      if (pid === null) {
        return { text: "No target PID set. Use desktop_launch with mode:'bundle' or mode:'attach' to set a target." };
      }
      return { text: `Target PID: ${pid}` };
    },
  },
];
