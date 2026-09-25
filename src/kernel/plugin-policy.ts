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
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SAFE_TEXT_RE = /^[^\u0000-\u001f\u007f]+$/u;
const INTEGRITY_RE = /^sha256-[a-f0-9]{64}$/u;

export interface PluginPermissionGrantIdentity {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly pluginVersion: string;
  readonly apiVersion: "1";
  readonly integrity: `sha256-${string}`;
}

export interface PluginPermissionGrant extends PluginPermissionGrantIdentity {
  readonly permissions: readonly PluginPermission[];
}

export interface PluginPermissionPolicy {
  readonly version: typeof POLICY_VERSION;
  readonly grants: Readonly<Record<string, PluginPermissionGrant>>;
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

const grantSchema = z.object({
  permissions: z.array(permissionSchema).max(32),
  packageName: z.string().min(1).max(512).regex(SAFE_TEXT_RE),
  packageVersion: z.string().min(1).max(128).regex(SAFE_TEXT_RE),
  pluginVersion: z.string().min(1).max(128).regex(SAFE_TEXT_RE),
  apiVersion: z.literal("1"),
  integrity: z.string().regex(INTEGRITY_RE),
}).superRefine((grant, ctx) => {
  if (new Set(grant.permissions).size !== grant.permissions.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "duplicate permissions for plugin grant",
      path: ["permissions"],
    });
  }
});

const policySchema = z.object({
  version: z.literal(POLICY_VERSION),
  grants: z.record(
    z.string().regex(PLUGIN_ID_RE),
    grantSchema,
  ),
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
  return Object.hasOwn(policy.grants, pluginId)
    ? policy.grants[pluginId]?.permissions ?? []
    : [];
}

export function grantMatchesIdentity(
  grant: PluginPermissionGrant | undefined,
  identity: PluginPermissionGrantIdentity,
): boolean {
  return Boolean(
    grant
    && grant.packageName === identity.packageName
    && grant.packageVersion === identity.packageVersion
    && grant.pluginVersion === identity.pluginVersion
    && grant.apiVersion === identity.apiVersion
    && grant.integrity === identity.integrity
  );
}

export function grantForIdentity(
  identity: PluginPermissionGrantIdentity,
  permissions: readonly PluginPermission[],
): PluginPermissionGrant {
  return {
    packageName: identity.packageName,
    packageVersion: identity.packageVersion,
    pluginVersion: identity.pluginVersion,
    apiVersion: identity.apiVersion,
    integrity: identity.integrity,
    permissions: [...permissions],
  };
}

export function missingPermissions(
  requested: readonly PluginPermission[],
  granted: readonly PluginPermission[],
): PluginPermission[] {
  const grantedSet = new Set(granted);
  return requested.filter((permission) => !grantedSet.has(permission));
}