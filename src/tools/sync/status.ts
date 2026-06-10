import { defineTool, z } from "../define-tool.js";
import { textResult } from "../../utils/tool-result.js";
import { SYNC_TTL_MS, getGroup } from "./common.js";

export const syncStatus = defineTool({
  name: "sync_status",
  description: "Show details of a sync group and its last run result.",
  schema: z.object({
    group: z.string().describe("Sync group name"),
  }),
  handler: async (args) => {
    const group = getGroup(args.group);
    const ageMs = Date.now() - group.createdAt;
    const ageSec = Math.round(ageMs / 1000);
    const ttlRemaining = Math.max(0, Math.round((SYNC_TTL_MS - ageMs) / 1000));

    const lines = [
      `Sync group: "${group.name}"`,
      `  Roles: ${group.roles.map(r => `${r.name}=${r.deviceId}`).join(", ")}`,
      `  Created: ${ageSec}s ago (TTL: ${ttlRemaining}s remaining)`,
    ];

    if (group.lastRun) {
      const lr = group.lastRun;
      const allResults = Array.from(lr.results.values()).flat();
      const okCount = allResults.filter(r => r.status === "OK").length;
      const totalSteps = allResults.filter(r => !r.action.startsWith("barrier:")).length;
      lines.push(`  Last run: ${lr.success ? "OK" : "FAILED"} — ${okCount}/${totalSteps} steps (${lr.totalMs}ms)`);
    } else {
      lines.push("  Last run: none");
    }

    return textResult(lines.join("\n"));
  },
});
