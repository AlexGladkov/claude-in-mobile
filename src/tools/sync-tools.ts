import type { ToolDefinition } from "./registry.js";
import { syncCreateGroup } from "./sync/create-group.js";
import { syncRun } from "./sync/run.js";
import { syncAssertCross } from "./sync/assert-cross.js";
import { syncStatus } from "./sync/status.js";
import { syncList } from "./sync/list.js";
import { syncDestroy } from "./sync/destroy.js";
import { activeGroups } from "./sync/common.js";

export const syncTools: ToolDefinition[] = [
  syncCreateGroup,
  syncRun,
  syncAssertCross,
  syncStatus,
  syncList,
  syncDestroy,
];

// ── Cleanup (for testing) ──

export function _resetSyncState(): void {
  for (const group of activeGroups.values()) {
    clearTimeout(group.ttlTimer);
  }
  activeGroups.clear();
}
