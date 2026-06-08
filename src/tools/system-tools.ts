import type { ToolDefinition } from "./registry.js";
import { defineTool, z } from "./define-tool.js";
import { truncateOutput } from "../utils/truncate.js";
import {
  validateShellCommand,
  validateUrl,
  sanitizeForShell,
  validatePackageName,
} from "../utils/sanitize.js";
import { parseCommonArgs } from "../utils/parse-common-args.js";
import { textResult } from "../utils/tool-result.js";
import { sleep } from "../utils/sleep.js";
import { AM, PIDOF } from "../adb/commands.js";

const platformEnum = z
  .enum(["android", "ios", "desktop", "aurora", "browser"])
  .describe("Target platform. If not specified, uses the active target.")
  .optional();

const deviceIdField = z
  .string()
  .describe("Target device ID for multi-device. If omitted, uses active device.")
  .optional();

const commonFields = {
  platform: platformEnum,
  deviceId: deviceIdField,
} as const;

export const systemTools: ToolDefinition[] = [
  defineTool({
    name: "system_activity",
    description: "Get current foreground activity (Android only)",
    schema: z.object({ deviceId: deviceIdField }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      if (platform !== "android") {
        return textResult("activity is only available for Android.");
      }
      const activity = ctx.deviceManager.getAndroidClient(deviceId).getCurrentActivity();
      return textResult(`Current activity: ${activity}`);
    },
  }),

  defineTool({
    name: "system_shell",
    description:
      "Execute a shell command on the device. SECURITY: shell metacharacters " +
      "(`& | ; $ \\` ' \\\\ ( ) < > { } * ? [ ] tab newline`) are REJECTED — " +
      "the command is NOT passed through /bin/sh and chaining/expansion does not work. " +
      "Prefer these alternatives when applicable: ui_tap/ui_swipe for input, " +
      "app_launch for starting apps, system_open_url for opening URLs " +
      "(URLs with `&` in query string MUST go through system_open_url, not here). " +
      "For multi-step operations, invoke this tool once per step.",
    schema: z.object({
      command: z
        .string()
        .describe(
          "Single shell command, no chaining or shell metacharacters. " +
            "Example: 'pm list packages -3' (valid), 'pm list packages | grep foo' (rejected).",
        ),
      ...commonFields,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      validateShellCommand(args.command);
      const output = ctx.deviceManager.shell(args.command, platform, deviceId);
      return textResult(truncateOutput(output || "(no output)"));
    },
  }),

  defineTool({
    name: "system_wait",
    description: "Wait for specified duration (ms)",
    schema: z.object({
      ms: z
        .number()
        .default(1000)
        .describe("Duration in milliseconds (default: 1000, max: 30000)"),
    }),
    handler: async (args) => {
      const ms = Math.max(0, Math.min(args.ms, 30_000));
      await sleep(ms);
      return textResult(`Waited ${ms}ms`);
    },
  }),

  defineTool({
    name: "system_open_url",
    description: "Open URL in device browser",
    schema: z.object({
      url: z.string().describe("URL to open"),
      ...commonFields,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      validateUrl(args.url);
      const sanitizedUrl = sanitizeForShell(args.url);

      if (platform === "android") {
        ctx.deviceManager.shell(AM.START_VIEW(sanitizedUrl), "android", deviceId);
      } else if (platform === "ios") {
        ctx.deviceManager.getIosClient(deviceId).openUrl(args.url);
      } else {
        return textResult(
          `open_url is not supported for ${platform} platform. Supported: android, ios.`,
        );
      }
      return textResult(`Opened URL: ${args.url}`);
    },
  }),

  defineTool({
    name: "system_logs",
    description: "Get device logs with optional filters",
    schema: z.object({
      ...commonFields,
      level: z
        .string()
        .optional()
        .describe(
          "Log level filter. Android: V/D/I/W/E/F (Verbose/Debug/Info/Warning/Error/Fatal). iOS: debug/info/default/error/fault",
        ),
      tag: z.string().optional().describe("Filter by tag (Android only)"),
      lines: z
        .number()
        .default(100)
        .describe("Number of lines to return (default: 100)"),
      package: z.string().optional().describe("Filter by package/bundle ID"),
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const logs = ctx.deviceManager.getLogs({
        platform,
        deviceId,
        level: args.level,
        tag: args.tag,
        lines: Math.min(args.lines, 500),
        package: args.package,
      });
      return textResult(truncateOutput(logs || "(no logs)", { maxLines: 500 }));
    },
  }),

  defineTool({
    name: "system_wait_log",
    description:
      "Wait until a regex pattern appears in device logs. Polls the log buffer at regular intervals; returns the matching line(s) plus optional context, or times out. Use after an action to wait for a known marker (e.g., 'NavigationCompleted', a custom Debug.WriteLine tag) instead of fixed system_wait + system_logs polling. Android only.",
    schema: z.object({
      pattern: z
        .string()
        .min(1, "pattern is required and must be a non-empty string.")
        .describe(
          "JavaScript regex pattern matched against each log line. Inline flags like (?i) are NOT supported — use the caseSensitive option for case-insensitive matching.",
        ),
      caseSensitive: z
        .boolean()
        .default(true)
        .describe("Case-sensitive matching (default: true). Set false for case-insensitive."),
      timeoutMs: z
        .number()
        .default(10_000)
        .describe("Max wait in ms (default: 10000, max: 30000)"),
      pollIntervalMs: z
        .number()
        .default(250)
        .describe("Polling interval in ms (default: 250, min: 100)"),
      contextLines: z
        .number()
        .default(0)
        .describe("Extra lines after each match to return for context (default: 0, max: 20)"),
      level: z.string().optional().describe("Pre-filter by log level. Android: V/D/I/W/E/F"),
      tag: z.string().optional().describe("Pre-filter by tag (Android only)"),
      package: z.string().optional().describe("Pre-filter by package"),
      clearFirst: z
        .boolean()
        .default(false)
        .describe(
          "Clear log buffer before polling so only new lines are scanned. Default false (scan from current buffer head).",
        ),
      ...commonFields,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      if (platform !== "android") {
        return textResult("system_wait_log is only available for Android.");
      }

      let regex: RegExp;
      try {
        regex = new RegExp(args.pattern, args.caseSensitive ? "" : "i");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return textResult(`Invalid regex pattern: ${msg}`);
      }

      const timeoutMs = Math.max(0, Math.min(args.timeoutMs, 30_000));
      const pollIntervalMs = Math.max(
        100,
        Math.min(args.pollIntervalMs, timeoutMs || 30_000),
      );
      const contextLines = Math.max(0, Math.min(args.contextLines, 20));

      if (args.clearFirst) {
        try {
          ctx.deviceManager.clearLogs(platform, deviceId);
        } catch {
          /* best-effort */
        }
      }

      const filterArgs = {
        platform,
        deviceId,
        level: args.level,
        tag: args.tag,
        lines: 500,
        package: args.package,
      };
      const seen = new Set<string>();
      const start = Date.now();
      while (true) {
        let dump = "";
        try {
          dump = ctx.deviceManager.getLogs(filterArgs);
        } catch {
          /* keep looping */
        }
        const lines = dump.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line || seen.has(line)) continue;
          seen.add(line);
          if (regex.test(line)) {
            const elapsed = Date.now() - start;
            const context =
              contextLines > 0
                ? lines.slice(i + 1, i + 1 + contextLines).filter(Boolean).join("\n")
                : "";
            return textResult(
              `Match found after ${elapsed}ms:\n${line}${context ? `\n${context}` : ""}`,
            );
          }
        }
        if (Date.now() - start >= timeoutMs) {
          return textResult(
            `Timeout after ${timeoutMs}ms — pattern not found. Scanned ${seen.size} unique lines.`,
          );
        }
        await sleep(pollIntervalMs);
      }
    },
  }),

  defineTool({
    name: "system_clear_logs",
    description: "Clear device log buffer (Android only)",
    schema: z.object({ deviceId: deviceIdField }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const result = ctx.deviceManager.clearLogs(platform, deviceId);
      return textResult(result);
    },
  }),

  defineTool({
    name: "system_pid_of",
    description:
      "Get the PID of a running app process by package name (Android only). Returns 0 when the package is not running. Useful for verifying app launch / crash detection without parsing the full ps output.",
    schema: z.object({
      package: z.string().describe("Package name, e.g., com.android.settings"),
      ...commonFields,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      if (platform !== "android") {
        return textResult("system_pid_of is only available for Android.");
      }
      validatePackageName(args.package);
      const raw = ctx.deviceManager.shell(PIDOF(args.package), platform, deviceId).trim();
      const pid = raw === "" ? 0 : parseInt(raw, 10);
      if (Number.isNaN(pid) || pid <= 0) {
        return textResult("0 (not running)");
      }
      return textResult(`${pid}`);
    },
  }),

  defineTool({
    name: "system_is_running",
    description:
      "Check whether an app process is currently running by package name (Android only). Returns 'true' or 'false'. Convenience wrapper around system_pid_of for quick assertions.",
    schema: z.object({
      package: z.string().describe("Package name, e.g., com.android.settings"),
      ...commonFields,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      if (platform !== "android") {
        return textResult("system_is_running is only available for Android.");
      }
      validatePackageName(args.package);
      const raw = ctx.deviceManager.shell(PIDOF(args.package), platform, deviceId).trim();
      const pid = raw === "" ? 0 : parseInt(raw, 10);
      const running = !Number.isNaN(pid) && pid > 0;
      return textResult(running ? `true (pid=${pid})` : "false");
    },
  }),

  defineTool({
    name: "system_info",
    description: "Get battery and memory info",
    schema: z.object({ ...commonFields }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const info = await ctx.deviceManager.getSystemInfo(platform, deviceId);
      return textResult(info);
    },
  }),

  defineTool({
    name: "system_webview",
    description: "Inspect WebView via Chrome DevTools Protocol (Android only)",
    schema: z.object({ deviceId: deviceIdField }),
    handler: async (args, ctx) => {
      const { platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      if (platform !== "android") {
        return textResult("webview is only available for Android.");
      }

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
      return textResult(output);
    },
  }),
];
