import { SyncGroupNotFoundError } from "../../errors.js";
import { defineTool, z } from "../define-tool.js";
import { textResult } from "../../utils/tool-result.js";
import { activeGroups, destroyGroupInternal } from "./common.js";

export const syncDestroy = defineTool({
  name: "sync_destroy",
  description: "Destroy a sync group and release resources.",
  schema: z.object({
    group: z.string().describe("Sync group name"),
  }),
  handler: async (args) => {
    const name = args.group;
    if (!activeGroups.has(name)) {
      throw new SyncGroupNotFoundError(name);
    }
    destroyGroupInternal(name);
    return textResult(`Sync group "${name}" destroyed.`);
  },
});
