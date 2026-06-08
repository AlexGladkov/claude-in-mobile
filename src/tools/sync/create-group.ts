import { ValidationError, SyncGroupExistsError } from "../../errors.js";
import { validateBaselineName, validateDeviceId } from "../../utils/sanitize.js";
import { defineTool, z } from "../define-tool.js";
import { textResult } from "../../utils/tool-result.js";
import {
  SYNC_MAX_GROUPS,
  SYNC_MAX_ROLES,
  SYNC_TTL_MS,
  SyncGroup,
  SyncGroupRole,
  activeGroups,
  destroyGroupInternal,
  roleSchema,
} from "./common.js";

export const syncCreateGroup = defineTool({
  name: "sync_create_group",
  description: "Create a sync group of 2+ devices with named roles for coordinated testing.",
  schema: z.object({
    name: z.string().describe("Group name (e.g. 'chat-test')"),
    roles: z.array(roleSchema).describe("Role-to-device mapping (min 2, max 10)"),
  }),
  handler: async (args) => {
    const name = args.name;
    const roles = args.roles as SyncGroupRole[];

    validateBaselineName(name, "sync group name");

    if (activeGroups.has(name)) {
      throw new SyncGroupExistsError(name);
    }

    if (activeGroups.size >= SYNC_MAX_GROUPS) {
      throw new ValidationError(
        `Maximum sync groups (${SYNC_MAX_GROUPS}) reached. Destroy existing groups first.`
      );
    }

    if (!roles || roles.length < 2) {
      throw new ValidationError("Sync group requires at least 2 roles.");
    }

    if (roles.length > SYNC_MAX_ROLES) {
      throw new ValidationError(`Too many roles (${roles.length}). Maximum is ${SYNC_MAX_ROLES}.`);
    }

    // Validate role names and deviceIds
    const roleNames = new Set<string>();
    for (const role of roles) {
      validateBaselineName(role.name, "role name");
      validateDeviceId(role.deviceId);
      if (roleNames.has(role.name)) {
        throw new ValidationError(`Duplicate role name: "${role.name}"`);
      }
      roleNames.add(role.name);
    }

    const ttlTimer = setTimeout(() => destroyGroupInternal(name), SYNC_TTL_MS);

    const group: SyncGroup = {
      name,
      roles,
      createdAt: Date.now(),
      ttlTimer,
      lastRun: null,
    };

    activeGroups.set(name, group);

    const roleLines = roles.map(r => `  ${r.name}: ${r.deviceId}`).join("\n");
    return textResult(`Sync group "${name}" created (${roles.length} devices)\n${roleLines}`);
  },
});
