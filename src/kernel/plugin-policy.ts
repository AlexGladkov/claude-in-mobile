import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";
import type { PluginPermission } from "@mcp-devices/plugin-api";
import { writeJsonAtomic } from "../utils/json-file.js";
import {
  ensurePrivateDirectory,
  readPrivateFile,
} from "../utils/private-storage.js";

const POLICY_VERSION = 1 as const;
const MAX_POLICY_BYTES = 256 * 1024;
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export interface PluginPermissionPolicy {
  readonly version: typeof POLICY_VERSION;
  readonly grants: Readonly<Record<string, readonly PluginPermission[]>>;
}

const permissionSchema = z.enum([
  "device:read",
  "device:write",
  "filesystem:read",
  "filesystem:write",
  "network",
  "subprocess",
  "credentials:read",
]);

const policySchema = z.object({
  version: z.literal(POLICY_VERSION),
  grants: z.record(
    z.string().regex(PLUGIN_ID_RE),
    z.array(permissionSchema).max(32),
  ),
}).superRefine((policy, ctx) => {
  for (const [id, permissions] of Object.entries(policy.grants)) {
    if (new Set(permissions).size !== permissions.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate permissions for plugin ${id}`,
        path: ["grants", id],
      });
    }
  }
});

export class PluginPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginPolicyError";
  }
}

export function pluginPermissionPath(): string {
  return process.env.MCP_DEVICES_PLUGIN_PERMISSIONS
    ?? join(homedir(), ".mcp-devices", "plugin-permissions.json");
}

function emptyPolicy(): PluginPermissionPolicy {
  return { version: POLICY_VERSION, grants: {} };
}

function validatePath(path: string): void {
  if (!path || path.length > 4096 || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw new PluginPolicyError("Invalid plugin permission policy path.");
  }
}

export async function readPluginPermissionPolicy(
  path = pluginPermissionPath(),
): Promise<PluginPermissionPolicy> {
  validatePath(path);
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new PluginPolicyError("Plugin permission policy must be a regular file.");
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyPolicy();
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(
      (await readPrivateFile(path, MAX_POLICY_BYTES, "plugin permission policy")).toString("utf8"),
    );
  } catch (error: unknown) {
    if (error instanceof PluginPolicyError) throw error;
    throw new PluginPolicyError(
      `Unable to read plugin permission policy: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = policySchema.safeParse(value);
  if (!parsed.success) throw new PluginPolicyError("Plugin permission policy is invalid.");
  return parsed.data as PluginPermissionPolicy;
}

export async function writePluginPermissionPolicy(
  policy: PluginPermissionPolicy,
  path = pluginPermissionPath(),
): Promise<void> {
  validatePath(path);
  const parsed = policySchema.safeParse(policy);
  if (!parsed.success) throw new PluginPolicyError("Cannot write an invalid plugin permission policy.");
  await ensurePrivateDirectory(dirname(path));
  await writeJsonAtomic(path, parsed.data, 0o600);
}

export function permissionsFor(
  policy: PluginPermissionPolicy,
  pluginId: string,
): readonly PluginPermission[] {
  return policy.grants[pluginId] ?? [];
}

export function missingPermissions(
  requested: readonly PluginPermission[],
  granted: readonly PluginPermission[],
): PluginPermission[] {
  const grantedSet = new Set(granted);
  return requested.filter((permission) => !grantedSet.has(permission));
}