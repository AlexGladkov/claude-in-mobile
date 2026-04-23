import type { ToolDefinition } from "../registry.js";
import { systemTools } from "../system-tools.js";
import { clipboardTools } from "../clipboard-tools.js";
import { permissionTools } from "../permission-tools.js";
import { auroraTools } from "../aurora-tools.js";
import { UnknownActionError } from "../../errors.js";

const handlers = new Map<string, ToolDefinition["handler"]>();

// system_activity -> "activity", system_shell -> "shell", etc.
for (const t of systemTools) {
  handlers.set(t.tool.name.replace(/^system_/, ""), t.handler);
}
// clipboard_select -> "clipboard_select", clipboard_copy -> "clipboard_copy", etc.
for (const t of clipboardTools) {
  // clipboard_get_android -> "clipboard_get" (shorter action name)
  const action = t.tool.name === "clipboard_get_android" ? "clipboard_get" : t.tool.name;
  handlers.set(action, t.handler);
}
// permission_grant -> "permission_grant", etc.
for (const t of permissionTools) {
  handlers.set(t.tool.name, t.handler);
}
// file_push -> "file_push", file_pull -> "file_pull"
for (const t of auroraTools) {
  handlers.set(t.tool.name, t.handler);
}

export const systemMeta: ToolDefinition = {
  tool: {
    name: "system",
    description:
      "System operations, clipboard, permissions, files. shell: run command. logs: device logs. clipboard_*: Android clipboard. permission_*: app permissions. file_*: Aurora file transfer.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "activity", "shell", "wait", "open_url", "logs", "clear_logs", "info", "webview",
            "clipboard_select", "clipboard_copy", "clipboard_paste", "clipboard_get",
            "permission_grant", "permission_revoke", "permission_reset",
            "file_push", "file_pull",
            "metrics", "reset_metrics",
          ],
        },
        command: { type: "string", description: "Shell command to execute (shell)" },
        url: { type: "string", description: "URL to open (open_url)" },
        ms: { type: "number", description: "Duration in milliseconds (wait, default: 1000)" },
        level: { type: "string", description: "Log level filter (logs)" },
        tag: { type: "string", description: "Filter by tag (logs, Android only)" },
        lines: { type: "number", description: "Number of log lines (logs, default: 100)" },
        package: { type: "string", description: "Package name (logs, permissions)" },
        permission: { type: "string", description: "Permission to grant/revoke (permission_grant/revoke)" },
        fieldText: { type: "string", description: "Find input field by text before paste (clipboard_paste)" },
        fieldId: { type: "string", description: "Find input field by resource ID before paste (clipboard_paste)" },
        localPath: { type: "string", description: "Local file path (file_push/pull)" },
        remotePath: { type: "string", description: "Remote file path (file_push/pull)" },
        platform: {
          type: "string",
          enum: ["android", "ios", "desktop", "aurora", "browser"],
          description: "Target platform. If not specified, uses the active target.",
        },
      },
      required: ["action"],
    },
  },
  handler: async (args, ctx, depth) => {
    const action = args.action as string;

    // Metrics actions (handled inline, not via systemTools)
    if (action === "metrics") {
      const { getGlobalMetrics } = await import("../../utils/metrics.js");
      return { text: getGlobalMetrics().getFormatted() };
    }
    if (action === "reset_metrics") {
      const { getGlobalMetrics } = await import("../../utils/metrics.js");
      getGlobalMetrics().reset();
      return { text: "Metrics reset." };
    }

    const handler = handlers.get(action);
    if (!handler) throw new UnknownActionError("system", action, ["activity", "shell", "wait", "open_url", "logs", "clear_logs", "info", "webview", "clipboard_select", "clipboard_copy", "clipboard_paste", "clipboard_get", "permission_grant", "permission_revoke", "permission_reset", "file_push", "file_pull", "metrics", "reset_metrics"]);
    return handler(args, ctx, depth);
  },
};

export const systemAliases: Record<string, { tool: string; defaults: Record<string, unknown> }> = {
  // system tools
  system_activity: { tool: "system", defaults: { action: "activity" } },
  system_shell: { tool: "system", defaults: { action: "shell" } },
  system_wait: { tool: "system", defaults: { action: "wait" } },
  system_open_url: { tool: "system", defaults: { action: "open_url" } },
  system_logs: { tool: "system", defaults: { action: "logs" } },
  system_clear_logs: { tool: "system", defaults: { action: "clear_logs" } },
  system_info: { tool: "system", defaults: { action: "info" } },
  system_webview: { tool: "system", defaults: { action: "webview" } },
  // clipboard tools
  clipboard_select: { tool: "system", defaults: { action: "clipboard_select" } },
  clipboard_copy: { tool: "system", defaults: { action: "clipboard_copy" } },
  clipboard_paste: { tool: "system", defaults: { action: "clipboard_paste" } },
  clipboard_get_android: { tool: "system", defaults: { action: "clipboard_get" } },
  // permission tools
  permission_grant: { tool: "system", defaults: { action: "permission_grant" } },
  permission_revoke: { tool: "system", defaults: { action: "permission_revoke" } },
  permission_reset: { tool: "system", defaults: { action: "permission_reset" } },
  // aurora file tools
  file_push: { tool: "system", defaults: { action: "file_push" } },
  file_pull: { tool: "system", defaults: { action: "file_pull" } },
};
