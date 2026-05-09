import type { ToolDefinition } from "./registry.js";
import type { ToolContext } from "./context.js";
import type { Platform } from "../device-manager.js";
import { truncateOutput } from "../utils/truncate.js";
import { validateShellCommand, validateUrl, sanitizeForShell } from "../utils/sanitize.js";

export const systemTools: ToolDefinition[] = [
  {
    tool: {
      name: "system_activity",
      description: "Get current foreground activity (Android only)",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();

      if (currentPlatform !== "android") {
        return { text: "activity is only available for Android." };
      }

      const activity = ctx.deviceManager.getAndroidClient().getCurrentActivity();
      return { text: `Current activity: ${activity}` };
    },
  },
  {
    tool: {
      name: "system_shell",
      description: "Execute shell command on device",
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
      const command = args.command as string;
      validateShellCommand(command);
      const output = ctx.deviceManager.shell(command, platform);
      return { text: truncateOutput(output || "(no output)") };
    },
  },
  {
    tool: {
      name: "system_wait",
      description: "Wait for specified duration (ms)",
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

      validateUrl(url);
      const sanitizedUrl = sanitizeForShell(url);

      if (currentPlatform === "android") {
        ctx.deviceManager.getAndroidClient().shell(`am start -a android.intent.action.VIEW -d '${sanitizedUrl}'`);
      } else if (currentPlatform === "ios") {
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
      description: "Get device logs with optional filters",
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
      const logs = ctx.deviceManager.getLogs({
        platform,
        level: args.level as string | undefined,
        tag: args.tag as string | undefined,
        lines: Math.min((args.lines as number) ?? 100, 500),
        package: args.package as string | undefined,
      });
      return { text: truncateOutput(logs || "(no logs)", { maxLines: 500 }) };
    },
  },
  {
    tool: {
      name: "system_wait_log",
      description: "Wait until a regex pattern appears in device logs. Polls the log buffer at regular intervals; returns the matching line(s) plus optional context, or times out. Use after an action to wait for a known marker (e.g., 'NavigationCompleted', a custom Debug.WriteLine tag) instead of fixed system_wait + system_logs polling. Android only.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript regex pattern matched against each log line. Inline flags like (?i) are NOT supported — use the caseSensitive option for case-insensitive matching." },
          caseSensitive: { type: "boolean", description: "Case-sensitive matching (default: true). Set false for case-insensitive.", default: true },
          timeoutMs: { type: "number", description: "Max wait in ms (default: 10000, max: 30000)", default: 10000 },
          pollIntervalMs: { type: "number", description: "Polling interval in ms (default: 250, min: 100)", default: 250 },
          contextLines: { type: "number", description: "Extra lines after each match to return for context (default: 0, max: 20)", default: 0 },
          level: { type: "string", description: "Pre-filter by log level. Android: V/D/I/W/E/F" },
          tag: { type: "string", description: "Pre-filter by tag (Android only)" },
          package: { type: "string", description: "Pre-filter by package" },
          clearFirst: { type: "boolean", description: "Clear log buffer before polling so only new lines are scanned. Default false (scan from current buffer head).", default: false },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
        required: ["pattern"],
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();
      if (currentPlatform !== "android") {
        return { text: "system_wait_log is only available for Android." };
      }

      const patternStr = args.pattern as string;
      if (!patternStr || typeof patternStr !== "string") {
        return { text: "pattern is required and must be a non-empty string." };
      }
      const caseSensitive = (args.caseSensitive as boolean) ?? true;
      let regex: RegExp;
      try {
        regex = new RegExp(patternStr, caseSensitive ? "" : "i");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { text: `Invalid regex pattern: ${msg}` };
      }

      const timeoutMs = Math.max(0, Math.min((args.timeoutMs as number) ?? 10000, 30_000));
      const pollIntervalMs = Math.max(100, Math.min((args.pollIntervalMs as number) ?? 250, timeoutMs || 30_000));
      const contextLines = Math.max(0, Math.min((args.contextLines as number) ?? 0, 20));
      const clearFirst = (args.clearFirst as boolean) ?? false;

      if (clearFirst) {
        try { ctx.deviceManager.clearLogs(platform); } catch { /* best-effort */ }
      }

      const filterArgs = {
        platform,
        level: args.level as string | undefined,
        tag: args.tag as string | undefined,
        lines: 500,
        package: args.package as string | undefined,
      };
      const seen = new Set<string>();
      const start = Date.now();
      while (true) {
        let dump = "";
        try { dump = ctx.deviceManager.getLogs(filterArgs); } catch { /* keep looping */ }
        const lines = dump.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line || seen.has(line)) continue;
          seen.add(line);
          if (regex.test(line)) {
            const elapsed = Date.now() - start;
            const context = contextLines > 0
              ? lines.slice(i + 1, i + 1 + contextLines).filter(Boolean).join("\n")
              : "";
            return {
              text: `Match found after ${elapsed}ms:\n${line}${context ? `\n${context}` : ""}`,
            };
          }
        }
        if (Date.now() - start >= timeoutMs) {
          return { text: `Timeout after ${timeoutMs}ms — pattern not found. Scanned ${seen.size} unique lines.` };
        }
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      }
    },
  },
  {
    tool: {
      name: "system_clear_logs",
      description: "Clear device log buffer (Android only)",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const result = ctx.deviceManager.clearLogs(platform);
      return { text: result };
    },
  },
  {
    tool: {
      name: "system_info",
      description: "Get battery and memory info",
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
      description: "Inspect WebView via Chrome DevTools Protocol (Android only)",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();

      if (currentPlatform !== "android") {
        return { text: "webview is only available for Android." };
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
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { text: `WebView inspection failed: ${msg}` };
      }
    },
  },
];
