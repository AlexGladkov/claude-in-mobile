import { defineTool, z } from "../define-tool.js";
import { platformEnum, deviceIdField } from "../common-schema.js";
import { truncateOutput } from "../../utils/truncate.js";
import { validatePackageName } from "../../utils/sanitize.js";
import { parseCommonArgs } from "../../utils/parse-common-args.js";
import { textResult } from "../../utils/tool-result.js";
import { parseNotifications } from "./notifications-parser.js";

export const sensorNotificationsTool = defineTool({
  name: "sensor_notifications",
  description:
    "Read the notification shade from Android. Returns a parsed list of active notifications with title, text, package, and time. iOS: not supported.",
  schema: z.object({
    package: z
      .string()
      .optional()
      .describe("Filter notifications by package name (e.g. com.example.app). Optional."),
    platform: platformEnum,
    deviceId: deviceIdField,
  }),
  handler: async (args, ctx) => {
    const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);

    if (platform !== "android") {
      return textResult(
        `sensor_notifications is only supported on Android. Current platform: ${platform}.\n\nNote: iOS does not provide a public ADB/shell API for reading the notification shade.`,
      );
    }

    const packageFilter = args.package;
    if (packageFilter) {
      validatePackageName(packageFilter);
    }

    const raw = ctx.deviceManager.shell("dumpsys notification --noredact", "android", deviceId);
    if (!raw) {
      return textResult("No output from dumpsys notification.");
    }

    const notifications = parseNotifications(raw, packageFilter);

    if (notifications.length === 0) {
      const filterNote = packageFilter ? ` matching package "${packageFilter}"` : "";
      return textResult(`No active notifications found${filterNote}.`);
    }

    const limited = notifications.slice(0, 20);
    const lines: string[] = [`Notifications (${limited.length} shown${notifications.length > 20 ? `, ${notifications.length} total` : ""}):`];

    for (let i = 0; i < limited.length; i++) {
      const n = limited[i];
      lines.push(`\n[${i + 1}] ${n.pkg}`);
      if (n.title) lines.push(`  Title:    ${n.title}`);
      if (n.text) lines.push(`  Text:     ${n.text}`);
      if (n.when) lines.push(`  When:     ${n.when}`);
      if (n.priority !== undefined) lines.push(`  Priority: ${n.priority}`);
    }

    return textResult(truncateOutput(lines.join("\n"), { maxLines: 200, maxChars: 8000 }));
  },
});
