import { defineTool, z } from "../define-tool.js";
import { textResult } from "../../utils/tool-result.js";
import { activeGroups } from "./common.js";

export const syncList = defineTool({
  name: "sync_list",
  description: "List all active sync groups.",
  schema: z.object({}),
  handler: async () => {
    if (activeGroups.size === 0) {
      return textResult("No active sync groups.");
    }

    const lines = ["Sync groups:"];
    for (const group of activeGroups.values()) {
      const status = group.lastRun
        ? (group.lastRun.success ? "idle (last: OK)" : "idle (last: FAILED)")
        : "idle";
      lines.push(`  ${group.name} — ${group.roles.length} devices (${status})`);
    }

    return textResult(lines.join("\n"));
  },
});
