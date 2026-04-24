import { createMetaTool } from "./create-meta-tool.js";
import { syncTools } from "../sync-tools.js";

const { meta, aliases } = createMetaTool({
  name: "sync",
  description:
    "Multi-device sync testing. create_group: bind devices to roles. run: coordinated steps with barriers. assert_cross: act on A, verify on B. status: group details. list: all groups. destroy: cleanup.",
  tools: syncTools,
  prefix: "sync_",
  extraSchema: {
    group: { type: "string", description: "Sync group name" },
    roles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Role name (e.g. 'sender', 'receiver')" },
          deviceId: { type: "string", description: "Device ID for this role" },
        },
        required: ["name", "deviceId"],
      },
      description: "Role-to-device mapping",
    },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          role: { type: "string" },
          action: { type: "string" },
          args: { type: "object" },
          barrier: { type: "string", description: "Barrier name — all roles with this barrier wait for each other" },
          label: { type: "string" },
          on_error: { type: "string", enum: ["stop", "skip", "retry"] },
        },
        required: ["role", "action"],
      },
    },
    source_role: { type: "string", description: "Source role (assert_cross)" },
    source_action: { type: "string", description: "Action on source device (assert_cross)" },
    source_args: { type: "object", description: "Source action args (assert_cross)" },
    target_role: { type: "string", description: "Target role for verification (assert_cross)" },
    target_action: { type: "string", description: "Verification action (assert_cross)" },
    target_args: { type: "object", description: "Target action args (assert_cross)" },
    delay_ms: { type: "number", description: "Delay between source and target ms (assert_cross, default: 1000)" },
    retries: { type: "number", description: "Target assertion retry count (assert_cross, default: 3)" },
    maxDuration: { type: "number", description: "Max total run duration ms (run, default: 60000)" },
    label: { type: "string", description: "Step or assertion label" },
    name: { type: "string", description: "Group name (create_group)" },
  },
});

export const syncMeta = meta;
export const syncAliases = aliases;
