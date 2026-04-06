import type { ToolDefinition } from "./registry.js";
import type { ToolContext } from "./context.js";

export const desktopTools: ToolDefinition[] = [
  {
    tool: {
      name: "desktop_launch",
      description: "Start desktop automation. Optionally also launches a Compose Desktop application via Gradle.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath: { type: "string", description: "Path to the Gradle project directory. If provided, also launches the user's app." },
          task: { type: "string", description: "Gradle task to run (e.g., ':desktopApp:run'). Auto-detected if not specified." },
          jvmArgs: { type: "array", items: { type: "string" }, description: "JVM arguments to pass to the app" },
        },
      },
    },
    handler: async (args, ctx) => {
      const result = await ctx.deviceManager.launchDesktopApp({
        projectPath: args.projectPath as string | undefined,
        task: args.task as string | undefined,
        jvmArgs: args.jvmArgs as string[] | undefined,
      });
      return { text: result };
    },
  },
  {
    tool: {
      name: "desktop_stop",
      description: "Stop the running desktop application",
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
      description: "Get information about desktop windows (Desktop only)",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler: async (_args, ctx) => {
      if (!ctx.deviceManager.isDesktopRunning()) {
        return { text: "Desktop app is not running. Use launch_desktop_app first." };
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
      description: "Focus a specific desktop window (Desktop only)",
      inputSchema: {
        type: "object",
        properties: {
          windowId: { type: "string", description: "Window ID from get_window_info" },
        },
        required: ["windowId"],
      },
    },
    handler: async (args, ctx) => {
      if (!ctx.deviceManager.isDesktopRunning()) {
        return { text: "Desktop app is not running. Use launch_desktop_app first." };
      }
      await ctx.deviceManager.getDesktopClient().focusWindow(args.windowId as string);
      return { text: `Focused window: ${args.windowId}` };
    },
  },
  {
    tool: {
      name: "desktop_resize",
      description: "Resize a desktop window (Desktop only)",
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
        return { text: "Desktop app is not running. Use launch_desktop_app first." };
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
      description: "Get clipboard text content (Desktop only)",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler: async (_args, ctx) => {
      if (!ctx.deviceManager.isDesktopRunning()) {
        return { text: "Desktop app is not running. Use launch_desktop_app first." };
      }
      const clipboardText = await ctx.deviceManager.getDesktopClient().getClipboard();
      return { text: clipboardText || "(empty)" };
    },
  },
  {
    tool: {
      name: "clipboard_set",
      description: "Set clipboard text content (Desktop only)",
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
        return { text: "Desktop app is not running. Use launch_desktop_app first." };
      }
      await ctx.deviceManager.getDesktopClient().setClipboard(args.text as string);
      return { text: "Clipboard set" };
    },
  },
  {
    tool: {
      name: "desktop_performance",
      description: "Get memory and CPU usage metrics (Desktop only)",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler: async (_args, ctx) => {
      if (!ctx.deviceManager.isDesktopRunning()) {
        return { text: "Desktop app is not running. Use launch_desktop_app first." };
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
      description: "Get list of all connected monitors with their dimensions and positions (Desktop only, multi-monitor support)",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler: async (_args, ctx) => {
      if (!ctx.deviceManager.isDesktopRunning()) {
        return { text: "Desktop app is not running. Use launch_desktop_app first." };
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
];
