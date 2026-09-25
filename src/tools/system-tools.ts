import type { ToolDefinition } from "./registry.js";
import { defineTool, z } from "./define-tool.js";
import { platformEnum, deviceIdField } from "./common-schema.js";
import { truncateOutput } from "../utils/truncate.js";
import {
  sanitizeResourceUri,
  sanitizeErrorMessage,
  validatePath,
  validateShellCommand,
  validateUrl,
  validatePackageName,
} from "../utils/sanitize.js";
import { safeTerminalText } from "../utils/terminal-controls.js";
import { parseCommonArgs } from "../utils/parse-common-args.js";
import { textResult } from "../utils/tool-result.js";
import { sleep } from "../utils/sleep.js";
import { BoundedRegexMatcher } from "../utils/bounded-regex.js";
import { PIDOF } from "../adb/commands.js";
import { hasShell, hasUrlOpening } from "../adapters/platform-adapter.js";

const commonFields = {
  platform: platformEnum,
  deviceId: deviceIdField,
} as const;
const MAX_SEEN_LOG_LINES = 2048;
const MAX_SEEN_LOG_CHARACTERS = 1_048_576;

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
    name: "system_file_push",
    description: "Upload a local file to a device with file transfer support",
    schema: z.object({
      localPath: z.string().describe("Local file path"),
      remotePath: z.string().describe("Remote destination path"),
      ...commonFields,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      validatePath(args.localPath, "localPath");
      validatePath(args.remotePath, "remotePath");
      const result = await ctx.deviceManager.pushFile(
        args.localPath,
        args.remotePath,
        platform,
        deviceId,
      );
      return textResult(result);
    },
  }),

  defineTool({
    name: "system_file_pull",
    description: "Download a file from a device with file transfer support",
    schema: z.object({
      remotePath: z.string().describe("Path to the remote file"),
      localPath: z.string().optional().describe("Optional local destination path"),
      ...commonFields,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      validatePath(args.remotePath, "remotePath");
      if (args.localPath) validatePath(args.localPath, "localPath");
      const result = await ctx.deviceManager.pullFile(
        args.remotePath,
        args.localPath,
        platform,
        deviceId,
      );
      return textResult(result);
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
      const adapter = ctx.deviceManager.getAdapter(platform, deviceId);
      if (!hasUrlOpening(adapter)) {
        return textResult(`open_url is not supported for ${platform} platform.`);
      }
      await adapter.openUrl(args.url, deviceId);
      return textResult("URL opened.");
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
          "Log level filter. Android: V/D/I/W/E/F. iOS: debug/info/default/error/fault. HarmonyOS: HiLog level text.",
        ),
      tag: z.string().optional().describe("Filter by tag (Android/HarmonyOS)"),
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
      "Wait until a regex pattern appears in device logs. Polls the log buffer at regular intervals; returns the matching line(s) plus optional context, or times out. Use after an action to wait for a known marker instead of fixed system_wait + system_logs polling. Available on platforms with logs support.",
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
      level: z.string().optional().describe("Pre-filter by log level"),
      tag: z.string().optional().describe("Pre-filter by tag (Android/HarmonyOS)"),
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
      const adapter = ctx.deviceManager.getAdapter(platform, deviceId);
      if (!hasShell(adapter)) {
        return textResult(`system_wait_log is not supported for ${platform}.`);
      }

      let matcher: BoundedRegexMatcher;
      try {
        matcher = new BoundedRegexMatcher(args.pattern, args.caseSensitive);
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error));
      }

      const timeoutMs = Math.max(0, Math.min(args.timeoutMs, 30_000));
      const pollIntervalMs = Math.max(
        100,
        Math.min(args.pollIntervalMs, timeoutMs || 30_000),
      );
      const contextLines = Math.max(0, Math.min(args.contextLines, 20));

      try {
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
        let seenCharacters = 0;
        const start = Date.now();
        while (true) {
          let dump = "";
          try {
            dump = ctx.deviceManager.getLogs(filterArgs);
          } catch {
            /* keep looping */
          }
          const lines = dump.split(/\r?\n/);
          const candidates: string[] = [];
          const candidateIndexes: number[] = [];
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line || seen.has(line)) continue;
            if (line.length <= MAX_SEEN_LOG_CHARACTERS) {
              seen.add(line);
              seenCharacters += line.length;
              while (seen.size > MAX_SEEN_LOG_LINES || seenCharacters > MAX_SEEN_LOG_CHARACTERS) {
                const oldest = seen.values().next().value;
                if (oldest === undefined) break;
                seen.delete(oldest);
                seenCharacters -= oldest.length;
              }
            }
            candidates.push(line);
            candidateIndexes.push(i);
          }
          const matchIndex = await matcher.findMatch(candidates);
          if (matchIndex >= 0) {
            const lineIndex = candidateIndexes[matchIndex];
            const line = lines[lineIndex];
            const elapsed = Date.now() - start;
            const context =
              contextLines > 0
                ? lines.slice(lineIndex + 1, lineIndex + 1 + contextLines).filter(Boolean).join("\n")
                : "";
            return textResult(
              `Match found after ${elapsed}ms:\n${line}${context ? `\n${context}` : ""}`,
            );
          }
          if (Date.now() - start >= timeoutMs) {
            return textResult(
              `Timeout after ${timeoutMs}ms — pattern not found. Scanned logs; retaining ${seen.size} recent unique lines for deduplication.`,
            );
          }
          await sleep(pollIntervalMs);
        }
      } finally {
        await matcher.close();
      }
    },
  }),

  defineTool({
    name: "system_clear_logs",
    description: "Clear the device log buffer",
    schema: z.object(commonFields),
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
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      if (platform !== "android") {
        return textResult("webview is only available for Android.");
      }

      const inspector = ctx.deviceManager.getWebViewInspector(deviceId);
      const result = await inspector.inspect();

      const lines = [
        `WebView sockets found: ${result.sockets.join(", ")}`,
        "",
      ];
      let formattedChars = lines.reduce((total, line) => total + line.length + 1, 0);
      if (result.targets.length === 0) {
        lines.push("No active pages found in WebView.");
      } else {
        lines.push(`Pages (${result.targets.length}):`);
        for (let index = 0; index < result.targets.length; index++) {
          const target = result.targets[index];
          const entry = [
            `  • [${target.type}] "${safeTerminalText(sanitizeErrorMessage(target.title))}"`,
            `    URL: ${safeTerminalText(sanitizeResourceUri(target.url) ?? "[REDACTED]")}`,
            `    ID: ${safeTerminalText(target.id)}`,
          ];
          const entryChars = entry.reduce((total, line) => total + line.length + 1, 0);
          if (formattedChars + entryChars > 12_000) {
            lines.push(`  [${result.targets.length - index} targets omitted]`);
            break;
          }
          lines.push(...entry);
          formattedChars += entryChars;
        }
      }
      return textResult(truncateOutput(lines.join("\n")));
    },
  }),
];
