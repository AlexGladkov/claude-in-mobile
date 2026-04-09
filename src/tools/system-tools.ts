import type { ToolDefinition } from "./registry.js";
import type { ToolContext } from "./context.js";
import type { Platform } from "../device-manager.js";

export const systemTools: ToolDefinition[] = [
  {
    tool: {
      name: "system_activity",
      description: "Get the currently active app/activity (Android only)",
      inputSchema: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
      },
    },
    handler: async (args, ctx) => {
      if (ctx.deviceManager.isSonicMode()) {
        return { content: [{ type: "text", text: "system_activity is not supported in Sonic mode" }] };
      }

      const platform = args.platform as Platform | undefined;
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();

      if (currentPlatform !== "android") {
        return { text: "get_current_activity is only available for Android." };
      }

      const activity = ctx.deviceManager.getAndroidClient().getCurrentActivity();
      return { text: `Current activity: ${activity}` };
    },
  },
  {
    tool: {
      name: "system_shell",
      description: "Execute shell command. ADB shell for Android, simctl for iOS",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
        required: ["command"],
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const output = await ctx.deviceManager.shell(args.command as string, platform);
      return { text: output || "(no output)" };
    },
  },
  {
    tool: {
      name: "system_wait",
      description: "Wait for specified duration",
      inputSchema: {
        type: "object",
        properties: {
          ms: { type: "number", description: "Duration in milliseconds (default: 1000, max: 30000)", default: 1000 },
        },
      },
    },
    handler: async (args) => {
      const ms = Math.max(0, Math.min((args.ms as number) ?? 1000, 30_000));
      await new Promise(resolve => setTimeout(resolve, ms));
      return { text: `Waited ${ms}ms` };
    },
  },
  {
    tool: {
      name: "system_open_url",
      description: "Open URL in device browser",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to open" },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
        required: ["url"],
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();
      const url = args.url as string;

      const sanitizedUrl = url.replace(/'/g, "'\\''");

      if (currentPlatform === "android") {
        if (ctx.deviceManager.isSonicMode()) {
          return { content: [{ type: "text", text: "system_open_url is not supported in Sonic mode" }] };
        }
        ctx.deviceManager.getAndroidClient().shell(`am start -a android.intent.action.VIEW -d '${sanitizedUrl}'`);
      } else if (currentPlatform === "ios") {
        if (ctx.deviceManager.isSonicMode()) {
          return { content: [{ type: "text", text: "system_open_url is not supported in Sonic mode" }] };
        }
        ctx.deviceManager.getIosClient().openUrl(url);
      } else {
        return { text: `open_url is not supported for ${currentPlatform} platform. Supported: android, ios.` };
      }
      return { text: `Opened URL: ${url}` };
    },
  },
  {
    tool: {
      name: "system_logs",
      description: "Get device logs (logcat for Android, system log for iOS). Useful for debugging app issues, crashes, and errors.",
      inputSchema: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
          level: { type: "string", description: "Log level filter. Android: V/D/I/W/E/F (Verbose/Debug/Info/Warning/Error/Fatal). iOS: debug/info/default/error/fault" },
          tag: { type: "string", description: "Filter by tag (Android only)" },
          lines: { type: "number", description: "Number of lines to return (default: 100)", default: 100 },
          package: { type: "string", description: "Filter by package/bundle ID" },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const logs = await ctx.deviceManager.getLogs({
        platform,
        level: args.level as string | undefined,
        tag: args.tag as string | undefined,
        lines: (args.lines as number) ?? 100,
        package: args.package as string | undefined,
      });
      return { text: logs || "(no logs)" };
    },
  },
  {
    tool: {
      name: "system_clear_logs",
      description: "Clear device log buffer (Android only)",
      inputSchema: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const result = await ctx.deviceManager.clearLogs(platform);
      return { text: result };
    },
  },
  {
    tool: {
      name: "system_info",
      description: "Get device system info: battery level, memory usage (Android only)",
      inputSchema: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const info = await ctx.deviceManager.getSystemInfo(platform);
      return { text: info };
    },
  },
  {
    tool: {
      name: "system_webview",
      description: "Inspect WebView content in the current Android app via Chrome DevTools Protocol. Lists available WebView pages with their URLs and titles. (Android only)",
      inputSchema: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
      },
    },
    handler: async (args, ctx) => {
      if (ctx.deviceManager.isSonicMode()) {
        return { content: [{ type: "text", text: "system_webview is not supported in Sonic mode" }] };
      }

      const platform = args.platform as Platform | undefined;
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();

      if (currentPlatform !== "android") {
        return { text: "get_webview is only available for Android." };
      }

      try {
        const inspector = ctx.deviceManager.getWebViewInspector();
        const result = await inspector.inspect();

        let output = `WebView sockets found: ${result.sockets.join(", ")}\n`;
        output += `Forwarded to port: ${result.forwardedPort}\n\n`;

        if (result.targets.length === 0) {
          output += "No active pages found in WebView.";
        } else {
          output += `Pages (${result.targets.length}):\n`;
          for (const target of result.targets) {
            output += `  • [${target.type}] "${target.title}"\n`;
            output += `    URL: ${target.url}\n`;
            output += `    ID: ${target.id}\n`;
          }
        }

        return { text: output };
      } catch (error: any) {
        return { text: `WebView inspection failed: ${error.message}` };
      }
    },
  },
];
