import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  lstat,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type {
  PluginManifest,
  PluginPermission,
} from "@mcp-devices/plugin-api";
import { isPluginPermission } from "@mcp-devices/plugin-api";
import { validateManifest } from "../kernel/registry.js";
import {
  MAX_PLUGIN_BYTES,
  MAX_PLUGIN_FILES,
  assertPluginId,
  entryRelativePath,
  hashPluginDirectory,
  pluginLockPath,
  pluginRootPath,
  readPluginLockfile,
  type PluginLockEntry,
  type PluginLockfile,
  withPluginStateLock,
  writePluginLockfile,
} from "../kernel/plugin-lock.js";
import {
  grantForIdentity,
  grantMatchesIdentity,
  permissionsFor,
  pluginPermissionPath,
  readPluginPermissionPolicy,
  type PluginPermissionPolicy,
  writePluginPermissionPolicy,
} from "../kernel/plugin-policy.js";

import {
  readExternalPackageJson,
  resolveExternalPluginEntry,
  type ExternalPackageJson,
} from "../kernel/external-loader.js";
import { ensurePrivateDirectory } from "../utils/private-storage.js";
import { sanitizeErrorMessage } from "../utils/sanitize.js";

const execFileAsync = promisify(execFile);
const MAX_SPEC_LENGTH = 512;
const NPM_TIMEOUT_MS = 180_000;
const MAX_NPM_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = MAX_PLUGIN_BYTES;
const MAX_ARCHIVE_MEMBERS = 16_384;
const MAX_INSTALL_CACHE_BYTES = MAX_PLUGIN_BYTES;
const MAX_INSTALL_CACHE_FILES = MAX_PLUGIN_FILES;
const MAX_INSTALL_STAGING_BYTES = MAX_PLUGIN_BYTES;
const MAX_INSTALL_STAGING_FILES = MAX_PLUGIN_FILES;
const INSTALL_FOOTPRINT_POLL_MS = 100;
const SAFE_SPEC_RE = /^[^\u0000-\u001f\u007f]+$/u;

export interface PluginManagerOptions {
  pluginRoot?: string;
  lockPath?: string;
  permissionPath?: string;
  npmCommand?: string;
  tarCommand?: string;
}

export interface InstalledPluginInfo {
  readonly id: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly pluginVersion: string;
  readonly apiVersion: string;
  readonly permissions: readonly PluginPermission[];
  readonly grantedPermissions: readonly PluginPermission[];
  readonly source: string;
  readonly integrity: string;
}

export interface PluginVerification {
  readonly id: string;
  readonly ok: boolean;
  readonly reason?: string;
}

interface InspectedPlugin {
  readonly packageJson: ExternalPackageJson;
  readonly entry: string;
  readonly manifest: PluginManifest;
}

interface NpmPackRecord {
  readonly filename?: unknown;
}
 
interface DirectoryFootprintLimits {
  readonly label: string;
  readonly maxFiles: number;
  readonly maxBytes: number;
}

function validateSpec(spec: string): string {
  if (
    !spec
    || spec.length > MAX_SPEC_LENGTH
    || !SAFE_SPEC_RE.test(spec)
    || spec.startsWith("-")
    || (!isLocalSpec(spec) && /\s/u.test(spec))
  ) {
    throw new Error("Plugin package spec is invalid.");
  }
  return spec;
}

function isLocalSpec(spec: string): boolean {
  return (
    spec.startsWith("./")
    || spec.startsWith("../")
    || spec.startsWith("/")
    || spec.startsWith("file:")
    || isAbsolute(spec)
  );
}

function normalizeLocalSpec(spec: string): string {
  const withoutScheme = spec.startsWith("file:") ? spec.slice("file:".length) : spec;
  return resolve(process.cwd(), withoutScheme);
}

function npmExecutable(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function tarExecutable(): string {
  return "tar";
}

function asSortedPermissions(value: readonly PluginPermission[]): PluginPermission[] {
  return [...new Set(value)].sort();
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join("\0") === [...right].sort().join("\0");
}

type PersistedCommitState = "before" | "after" | "unknown";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function persistedCommitState<T>(
  actual: T,
  before: T,
  after: T,
): PersistedCommitState {
  const actualJson = canonicalJson(actual);
  if (actualJson === canonicalJson(after)) return "after";
  if (actualJson === canonicalJson(before)) return "before";
  return "unknown";
}

async function lockCommitState(
  path: string,
  before: PluginLockfile,
  after: PluginLockfile,
): Promise<PersistedCommitState> {
  try {
    return persistedCommitState(await readPluginLockfile(path), before, after);
  } catch {
    return "unknown";
  }
}

async function policyCommitState(
  path: string,
  before: PluginPermissionPolicy,
  after: PluginPermissionPolicy,
): Promise<PersistedCommitState> {
  try {
    return persistedCommitState(await readPluginPermissionPolicy(path), before, after);
  } catch {
    return "unknown";
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function packageDependencies(packageJson: ExternalPackageJson): boolean {
  const candidate = packageJson as ExternalPackageJson & {
    dependencies?: unknown;
    optionalDependencies?: unknown;
  };
  for (const field of [candidate.dependencies, candidate.optionalDependencies]) {
    if (typeof field === "object" && field !== null && Object.keys(field).length > 0) {
      return true;
    }
  }
  return false;
}

async function assertDirectoryFootprint(
  root: string,
  limits: DirectoryFootprintLimits,
): Promise<void> {
  let fileCount = 0;
  let totalBytes = 0;

  async function visit(current: string): Promise<void> {
    let details;
    try {
      details = await lstat(current);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (details.isSymbolicLink()) {
      throw new Error(`${limits.label} contains a symbolic link.`);
    }
    if (details.isFile()) {
      fileCount += 1;
      if (fileCount > limits.maxFiles) {
        throw new Error(`${limits.label} exceeds the ${limits.maxFiles}-file limit.`);
      }
      if (!Number.isSafeInteger(details.size) || details.size < 0) {
        throw new Error(`${limits.label} contains an invalid file size.`);
      }
      totalBytes += details.size;
      if (totalBytes > limits.maxBytes) {
        throw new Error(`${limits.label} exceeds the ${limits.maxBytes}-byte limit.`);
      }
      return;
    }
    if (!details.isDirectory()) {
      throw new Error(`${limits.label} contains an unsupported filesystem entry.`);
    }
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      await visit(join(current, entry.name));
    }
  }

  await visit(root);
}

async function assertInstallFootprint(
  stagingRoot: string,
  cacheRoot: string,
): Promise<void> {
  await assertDirectoryFootprint(stagingRoot, {
    label: "npm dependency staging",
    maxFiles: MAX_INSTALL_STAGING_FILES,
    maxBytes: MAX_INSTALL_STAGING_BYTES,
  });
  await assertDirectoryFootprint(cacheRoot, {
    label: "npm dependency cache",
    maxFiles: MAX_INSTALL_CACHE_FILES,
    maxBytes: MAX_INSTALL_CACHE_BYTES,
  });
}

function npmEnvironment(
  cacheRoot: string,
  userConfig: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    npm_config_cache: cacheRoot,
    NPM_CONFIG_CACHE: cacheRoot,
    npm_config_userconfig: userConfig,
    NPM_CONFIG_USERCONFIG: userConfig,
    npm_config_ignore_scripts: "true",
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
  };
}

export class ExternalPluginManager {
  private readonly pluginRoot: string;
  private readonly lockPath: string;
  private readonly permissionPath: string;
  private readonly npmCommand: string;
  private readonly tarCommand: string;

  constructor(options: PluginManagerOptions = {}) {
    this.pluginRoot = options.pluginRoot ?? pluginRootPath();
    this.lockPath = options.lockPath ?? pluginLockPath();
    this.permissionPath = options.permissionPath ?? pluginPermissionPath();
    this.npmCommand = options.npmCommand ?? npmExecutable();
    this.tarCommand = options.tarCommand ?? tarExecutable();
  }

  async install(
    rawSpec: string,
    options: { replace?: boolean } = {},
  ): Promise<PluginLockEntry> {
    return this.installInternal(rawSpec, options);
  }

  private async installInternal(
    rawSpec: string,
    options: { replace?: boolean; expected?: PluginLockEntry } = {},
  ): Promise<PluginLockEntry> {
    const spec = validateSpec(rawSpec);
    await ensurePrivateDirectory(this.pluginRoot);
    const source = isLocalSpec(spec) ? normalizeLocalSpec(spec) : spec;
    const stagingRoot = await mkdtemp(join(dirname(this.pluginRoot), ".mcp-devices-plugin-install-"));
    let cacheRoot: string | undefined;
    let incomingPath: string | undefined;
    try {
      const installCacheRoot = await mkdtemp(join(dirname(this.pluginRoot), ".mcp-devices-plugin-cache-"));
      cacheRoot = installCacheRoot;
      const npmConfigPath = join(installCacheRoot, ".npmrc");
      await writeFile(
        npmConfigPath,
        "ignore-scripts=true\naudit=false\nfund=false\n",
        { mode: 0o600 },
      );
      const packageDir = await this.fetchPackage(
        source,
        stagingRoot,
        installCacheRoot,
        npmConfigPath,
      );
      await assertInstallFootprint(stagingRoot, installCacheRoot);
      const packageJson = await this.readPackageOrThrow(packageDir);
      await this.installDependencies(
        packageDir,
        packageJson,
        stagingRoot,
        installCacheRoot,
        npmConfigPath,
      );
      const inspected = await this.inspectDirectory(packageDir);
      const pluginId = inspected.manifest.id;
      assertPluginId(pluginId);
      const integrity = await hashPluginDirectory(packageDir);
      const entry = this.buildLockEntry(source, packageDir, inspected, integrity);

      return await withPluginStateLock(this.lockPath, async () => {
        const lockfile = await readPluginLockfile(this.lockPath);
        const policy = await readPluginPermissionPolicy(this.permissionPath);
        const existing = Object.hasOwn(lockfile.plugins, pluginId)
          ? lockfile.plugins[pluginId]
          : undefined;
        if (
          options.expected
          && (!existing || canonicalJson(existing) !== canonicalJson(options.expected))
        ) {
          throw new Error(`Plugin '${pluginId}' changed while update was preparing; retry the update.`);
        }
        if (existing && !options.replace) {
          throw new Error(`Plugin '${pluginId}' is already installed; use plugin update or --replace.`);
        }

        const finalPath = join(this.pluginRoot, pluginId);
        const currentExists = await pathExists(finalPath);
        if (currentExists && !options.replace) {
          throw new Error(`Plugin directory '${pluginId}' already exists; use plugin update or --replace.`);
        }
        if (currentExists) {
          const details = await lstat(finalPath);
          if (!details.isDirectory() || details.isSymbolicLink()) {
            throw new Error(`Plugin path '${pluginId}' is not a real directory.`);
          }
        }

        const currentGrant = Object.hasOwn(policy.grants, pluginId)
          ? policy.grants[pluginId]
          : undefined;
        const revokeExistingGrant = Boolean(
          currentGrant
          && (!existing || !grantMatchesIdentity(currentGrant, entry)),
        );
        const nextPolicy = revokeExistingGrant
          ? {
            version: policy.version,
            grants: Object.fromEntries(
              Object.entries(policy.grants).filter(([id]) => id !== pluginId),
            ),
          }
          : policy;
        const nextLockfile: PluginLockfile = {
          version: lockfile.version,
          plugins: { ...lockfile.plugins, [pluginId]: entry },
        };

        incomingPath = join(this.pluginRoot, `.${pluginId}.${randomUUID()}.incoming`);
        await rename(packageDir, incomingPath);
        let backupPath: string | undefined;
        let installedPath = false;
        let lockState: PersistedCommitState = "before";
        try {
          if (currentExists) {
            backupPath = join(this.pluginRoot, `.${pluginId}.${randomUUID()}.backup`);
            await rename(finalPath, backupPath);
          }
          await rename(incomingPath, finalPath);
          incomingPath = undefined;
          installedPath = true;

          let commitError: unknown;
          try {
            await writePluginLockfile(nextLockfile, this.lockPath);
            lockState = "after";
          } catch (error) {
            lockState = await lockCommitState(this.lockPath, lockfile, nextLockfile);
            if (lockState !== "after") throw error;
            commitError = error;
          }

          if (revokeExistingGrant) {
            try {
              await writePluginPermissionPolicy(nextPolicy, this.permissionPath);
            } catch (error) {
              const policyState = await policyCommitState(this.permissionPath, policy, nextPolicy);
              if (policyState === "before") {
                try {
                  await writePluginLockfile(lockfile, this.lockPath);
                  lockState = "before";
                } catch {
                  lockState = await lockCommitState(this.lockPath, lockfile, nextLockfile);
                }
              } else if (policyState === "unknown") {
                lockState = "unknown";
              }
              throw error;
            }
          }
          if (backupPath) await rm(backupPath, { recursive: true, force: true }).catch(() => {});
          if (commitError !== undefined) throw commitError;
          return entry;
        } catch (error) {
          if (lockState === "before") {
            if (installedPath && await pathExists(finalPath)) {
              await rm(finalPath, { recursive: true, force: true });
            }
            if (backupPath && await pathExists(backupPath)) {
              await rename(backupPath, finalPath);
            }
          } else if (lockState === "after" && backupPath) {
            await rm(backupPath, { recursive: true, force: true }).catch(() => {});
          }
          throw error;
        }
      });
    } finally {
      if (incomingPath && await pathExists(incomingPath)) {
        await rm(incomingPath, { recursive: true, force: true });
      }
      if (cacheRoot) {
        await rm(cacheRoot, { recursive: true, force: true }).catch(() => {});
      }
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  async list(): Promise<readonly InstalledPluginInfo[]> {
    return await withPluginStateLock(this.lockPath, async () => {
      const lockfile = await readPluginLockfile(this.lockPath);
      const policy = await readPluginPermissionPolicy(this.permissionPath);
      return Object.values(lockfile.plugins)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((entry) => ({
          id: entry.id,
          packageName: entry.packageName,
          packageVersion: entry.packageVersion,
          pluginVersion: entry.pluginVersion,
          apiVersion: entry.apiVersion,
          grantedPermissions: Object.hasOwn(policy.grants, entry.id)
            && grantMatchesIdentity(policy.grants[entry.id], entry)
            ? permissionsFor(policy, entry.id)
            : [],
          permissions: entry.permissions,
          source: entry.source,
          integrity: entry.integrity,
        }));
    });
  }

  async verify(ids?: readonly string[]): Promise<readonly PluginVerification[]> {
    return await withPluginStateLock(this.lockPath, async () => {
      const lockfile = await readPluginLockfile(this.lockPath);
      const selected = ids && ids.length > 0
        ? ids
        : Object.keys(lockfile.plugins).sort();
      const results: PluginVerification[] = [];
      for (const id of selected) {
        assertPluginId(id);
        const expected = Object.hasOwn(lockfile.plugins, id)
          ? lockfile.plugins[id]
          : undefined;
        if (!expected) {
          results.push({ id, ok: false, reason: "not present in plugins.lock" });
          continue;
        }
        try {
          const directory = join(this.pluginRoot, id);
          const inspected = await this.inspectDirectory(directory);
          const integrity = await hashPluginDirectory(directory);
          const declared = asSortedPermissions(inspected.manifest.permissions ?? []);
          const valid = (
            integrity === expected.integrity
            && inspected.packageJson.name === expected.packageName
            && inspected.packageJson.version === expected.packageVersion
            && inspected.manifest.id === expected.id
            && inspected.manifest.version === expected.pluginVersion
            && inspected.manifest.apiVersion === expected.apiVersion
            && entryRelativePath(directory, inspected.entry) === expected.entry
            && sameStringSet(declared, expected.permissions)
          );
          results.push({
            id,
            ok: valid,
            reason: valid ? undefined : "installed files or manifest differ from plugins.lock",
          });
        } catch (error: unknown) {
          results.push({
            id,
            ok: false,
            reason: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
          });
        }
      }
      return results;
    });
  }

  async remove(id: string): Promise<void> {
    assertPluginId(id);
    await withPluginStateLock(this.lockPath, async () => {
      const lockfile = await readPluginLockfile(this.lockPath);
      const existing = Object.hasOwn(lockfile.plugins, id)
        ? lockfile.plugins[id]
        : undefined;
      if (!existing) throw new Error(`Plugin '${id}' is not installed.`);
      const policy = await readPluginPermissionPolicy(this.permissionPath);
      const directory = join(this.pluginRoot, id);
      let backupPath: string | undefined;
      if (await pathExists(directory)) {
        const details = await lstat(directory);
        if (!details.isDirectory() || details.isSymbolicLink()) {
          throw new Error(`Plugin path '${id}' is not a real directory.`);
        }
        backupPath = join(this.pluginRoot, `.${id}.${randomUUID()}.removing`);
        await rename(directory, backupPath);
      }

      const plugins = { ...lockfile.plugins };
      delete plugins[id];
      const nextLockfile: PluginLockfile = { version: lockfile.version, plugins };
      const policyHasGrant = Object.hasOwn(policy.grants, id);
      const grants = { ...policy.grants };
      delete grants[id];
      const nextPolicy = {
        version: policy.version,
        grants,
      };
      let lockState: PersistedCommitState = "before";
      try {
        let commitError: unknown;
        try {
          await writePluginLockfile(nextLockfile, this.lockPath);
          lockState = "after";
        } catch (error) {
          lockState = await lockCommitState(this.lockPath, lockfile, nextLockfile);
          if (lockState !== "after") throw error;
          commitError = error;
        }

        if (policyHasGrant) {
          try {
            await writePluginPermissionPolicy(nextPolicy, this.permissionPath);
          } catch (error) {
            const policyState = await policyCommitState(this.permissionPath, policy, nextPolicy);
            if (policyState === "before") {
              try {
                await writePluginLockfile(lockfile, this.lockPath);
                lockState = "before";
              } catch {
                lockState = await lockCommitState(this.lockPath, lockfile, nextLockfile);
              }
            } else if (policyState === "unknown") {
              lockState = "unknown";
            }
            throw error;
          }
        }
        if (backupPath) await rm(backupPath, { recursive: true, force: true });
        if (commitError !== undefined) throw commitError;
      } catch (error) {
        const finalLockState: string = lockState;
        if (finalLockState === "before" && backupPath && await pathExists(backupPath)) {
          await rename(backupPath, directory);
        } else if (finalLockState === "after" && backupPath) {
          await rm(backupPath, { recursive: true, force: true }).catch(() => {});
        }
        throw error;
      }
    });
  }

  async update(ids?: readonly string[]): Promise<readonly PluginLockEntry[]> {
    const lockfile = await readPluginLockfile(this.lockPath);
    const selected = ids && ids.length > 0
      ? ids
      : Object.keys(lockfile.plugins).sort();
    const updated: PluginLockEntry[] = [];
    for (const id of selected) {
      assertPluginId(id);
      const entry = Object.hasOwn(lockfile.plugins, id)
        ? lockfile.plugins[id]
        : undefined;
      if (!entry) throw new Error(`Plugin '${id}' is not installed.`);
      const source = isLocalSpec(entry.source) ? entry.source : entry.packageName;
      updated.push(await this.installInternal(source, { replace: true, expected: entry }));
    }
    return updated;
  }

  async grant(id: string, permissions: readonly string[]): Promise<readonly PluginPermission[]> {
    assertPluginId(id);
    return await withPluginStateLock(this.lockPath, async () => {
      const lockfile = await readPluginLockfile(this.lockPath);
      const expected = Object.hasOwn(lockfile.plugins, id)
        ? lockfile.plugins[id]
        : undefined;
      if (!expected) throw new Error(`Plugin '${id}' is not installed.`);
      const directory = join(this.pluginRoot, id);
      const inspected = await this.inspectDirectory(directory);
      const integrity = await hashPluginDirectory(directory);
      if (
        integrity !== expected.integrity
        || inspected.packageJson.name !== expected.packageName
        || inspected.packageJson.version !== expected.packageVersion
        || inspected.manifest.id !== expected.id
        || inspected.manifest.version !== expected.pluginVersion
        || inspected.manifest.apiVersion !== expected.apiVersion
        || entryRelativePath(directory, inspected.entry) !== expected.entry
        || !sameStringSet(
          asSortedPermissions(inspected.manifest.permissions ?? []),
          expected.permissions,
        )
      ) {
        throw new Error(`Plugin '${id}' does not match plugins.lock.`);
      }

      const requested: PluginPermission[] = [];
      for (const raw of permissions) {
        if (!isPluginPermission(raw)) throw new Error(`Unknown plugin permission: ${raw}`);
        if (!(inspected.manifest.permissions ?? []).includes(raw)) {
          throw new Error(`Plugin '${id}' did not declare permission '${raw}'.`);
        }
        if (!requested.includes(raw)) requested.push(raw);
      }
      if (requested.length === 0) throw new Error("At least one permission is required.");
      const policy = await readPluginPermissionPolicy(this.permissionPath);
      const current = Object.hasOwn(policy.grants, id)
        ? policy.grants[id]
        : undefined;
      const currentPermissions = current && grantMatchesIdentity(current, expected)
        ? current.permissions
        : [];
      const grant = grantForIdentity(
        expected,
        asSortedPermissions([...currentPermissions, ...requested]),
      );
      const grants = { ...policy.grants, [id]: grant };
      await writePluginPermissionPolicy(
        { version: policy.version, grants },
        this.permissionPath,
      );
      return grant.permissions;
    });
  }

  async revoke(id: string, permissions: readonly string[]): Promise<readonly PluginPermission[]> {
    assertPluginId(id);
    return await withPluginStateLock(this.lockPath, async () => {
      const lockfile = await readPluginLockfile(this.lockPath);
      const expected = Object.hasOwn(lockfile.plugins, id)
        ? lockfile.plugins[id]
        : undefined;
      if (!expected) throw new Error(`Plugin '${id}' is not installed.`);
      const policy = await readPluginPermissionPolicy(this.permissionPath);
      const current = Object.hasOwn(policy.grants, id)
        ? policy.grants[id]
        : undefined;
      if (!current || !grantMatchesIdentity(current, expected)) {
        if (current) {
          const grants = { ...policy.grants };
          delete grants[id];
          await writePluginPermissionPolicy(
            { version: policy.version, grants },
            this.permissionPath,
          );
        }
        return [];
      }
      for (const raw of permissions) {
        if (!isPluginPermission(raw)) throw new Error(`Unknown plugin permission: ${raw}`);
      }
      const next = permissions.length === 0
        ? []
        : current.permissions.filter((permission) => !permissions.includes(permission));
      const grants = { ...policy.grants };
      if (next.length === 0) {
        delete grants[id];
      } else {
        grants[id] = grantForIdentity(expected, asSortedPermissions(next));
      }
      await writePluginPermissionPolicy(
        { version: policy.version, grants },
        this.permissionPath,
      );
      return asSortedPermissions(next);
    });
  }

  private async validateArchive(archive: string, stagingRoot: string): Promise<void> {
    const archiveDetails = await lstat(archive);
    if (!archiveDetails.isFile() || archiveDetails.isSymbolicLink()) {
      throw new Error("npm package archive must be a regular file.");
    }
    if (archiveDetails.size > MAX_ARCHIVE_BYTES) {
      throw new Error(`npm package archive exceeds the ${MAX_ARCHIVE_BYTES}-byte limit.`);
    }

    const details = await execFileAsync(
      this.tarCommand,
      ["-tvzf", archive],
      {
        cwd: stagingRoot,
        timeout: NPM_TIMEOUT_MS,
        maxBuffer: MAX_NPM_OUTPUT_BYTES,
        env: { ...process.env, LC_ALL: "C" },
      },
    );
    let memberCount = 0;
    let expandedBytes = 0;
    for (const line of String(details.stdout).split(/\r?\n/u)) {
      if (!line) continue;
      memberCount += 1;
      if (memberCount > MAX_ARCHIVE_MEMBERS) {
        throw new Error(`npm package archive exceeds the ${MAX_ARCHIVE_MEMBERS}-member limit.`);
      }
      const kind = line[0];
      if (kind !== "-" && kind !== "d") {
        throw new Error("npm package archive contains a symbolic link or special file.");
      }
      const match = /^[-d]\S*\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.+)$/u.exec(line);
      if (!match) {
        throw new Error("npm package archive contains an unparsable member.");
      }
      const rawMember = match[2]!;
      const member = rawMember.startsWith("./") ? rawMember.slice(2) : rawMember;
      if (
        !member.startsWith("package/")
        || /[\u0000-\u001f\u007f]/u.test(member)
        || member.split(/[\\/]/u).includes("..")
      ) {
        throw new Error("npm package archive contains an unsafe path.");
      }
      const declaredBytes = Number(match[1]);
      if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
        throw new Error("npm package archive contains an invalid member size.");
      }
      if (kind === "-") {
        expandedBytes += declaredBytes;
        if (expandedBytes > MAX_PLUGIN_BYTES) {
          throw new Error(`npm package archive exceeds the ${MAX_PLUGIN_BYTES}-byte expanded limit.`);
        }
      }
    }
  }

  private async fetchPackage(
    source: string,
    stagingRoot: string,
    cacheRoot: string,
    npmConfigPath: string,
  ): Promise<string> {
    const result = await execFileAsync(
      this.npmCommand,
      [
        "pack",
        source,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--json",
        "--cache",
        cacheRoot,
        "--userconfig",
        npmConfigPath,
        "--pack-destination",
        stagingRoot,
      ],
      {
        cwd: stagingRoot,
        timeout: NPM_TIMEOUT_MS,
        maxBuffer: MAX_NPM_OUTPUT_BYTES,
        env: npmEnvironment(cacheRoot, npmConfigPath),
      },
    );
    const output = String(result.stdout).trim();
    const metadataStart = output.indexOf("[");
    if (metadataStart < 0) throw new Error("npm pack returned invalid metadata.");
    let metadata: unknown;
    try {
      metadata = JSON.parse(output.slice(metadataStart));
    } catch {
      throw new Error("npm pack returned invalid JSON metadata.");
    }
    const record = Array.isArray(metadata) ? metadata[0] as NpmPackRecord | undefined : undefined;
    const filename = record?.filename;
    if (typeof filename !== "string" || filename.includes("/") || filename.includes("\\")) {
      throw new Error("npm pack returned an unsafe archive name.");
    }
    const archive = join(stagingRoot, filename);
    await this.validateArchive(archive, stagingRoot);
    await execFileAsync(
      this.tarCommand,
      ["-xzf", archive, "-C", stagingRoot, "--no-same-owner", "--no-same-permissions"],
      { cwd: stagingRoot, timeout: NPM_TIMEOUT_MS, maxBuffer: MAX_NPM_OUTPUT_BYTES },
    );
    const packageDir = join(stagingRoot, "package");
    const details = await lstat(packageDir);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error("npm package archive did not contain a regular package directory.");
    }
    await rm(archive, { force: true });
    return packageDir;
  }

  private async installDependencies(
    packageDir: string,
    packageJson: ExternalPackageJson,
    stagingRoot: string,
    cacheRoot: string,
    npmConfigPath: string,
  ): Promise<void> {
    if (!packageDependencies(packageJson)) return;
    await assertInstallFootprint(stagingRoot, cacheRoot);

    let commandError: unknown;
    let footprintError: unknown;
    let monitorStopped = false;
    let child: ChildProcess | undefined;
    const commandComplete = new Promise<void>((resolve) => {
      try {
        child = execFile(
          this.npmCommand,
          [
            "install",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--no-package-lock",
            "--omit=dev",
            "--cache",
            cacheRoot,
            "--userconfig",
            npmConfigPath,
          ],
          {
            cwd: packageDir,
            timeout: NPM_TIMEOUT_MS,
            maxBuffer: MAX_NPM_OUTPUT_BYTES,
            env: npmEnvironment(cacheRoot, npmConfigPath),
          },
          (error) => {
            commandError = error ?? undefined;
            monitorStopped = true;
            resolve();
          },
        );
      } catch (error: unknown) {
        commandError = error;
        monitorStopped = true;
        resolve();
      }
    });
    const monitor = (async (): Promise<void> => {
      while (!monitorStopped) {
        try {
          await assertInstallFootprint(stagingRoot, cacheRoot);
        } catch (error: unknown) {
          footprintError = error;
          monitorStopped = true;
          child?.kill();
          return;
        }
        if (!monitorStopped) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, INSTALL_FOOTPRINT_POLL_MS);
          });
        }
      }
    })();

    await commandComplete;
    monitorStopped = true;
    await monitor;
    if (footprintError !== undefined) throw footprintError;
    await assertInstallFootprint(stagingRoot, cacheRoot);
    if (commandError !== undefined) throw commandError;
  }

  private async readPackageOrThrow(packageDir: string): Promise<ExternalPackageJson> {
    const packageJson = await readExternalPackageJson(packageDir);
    if (!packageJson) throw new Error("Plugin archive contains an invalid package.json.");
    return packageJson;
  }

  private async inspectDirectory(directory: string): Promise<InspectedPlugin> {
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error("Plugin directory must be a real directory.");
    }
    const packageJson = await this.readPackageOrThrow(directory);
    const entry = resolveExternalPluginEntry(directory, packageJson);
    if (!entry) throw new Error("Plugin entry escapes its package directory.");
    const entryDetails = await lstat(entry);
    if (!entryDetails.isFile() || entryDetails.isSymbolicLink()) {
      throw new Error("Plugin entry must be a regular file.");
    }
    const manifestValue = packageJson.mcpDevicesPlugin;
    validateManifest(manifestValue);
    return {
      packageJson,
      entry,
      manifest: manifestValue,
    };
  }

  private buildLockEntry(
    source: string,
    packageDir: string,
    inspected: InspectedPlugin,
    integrity: `sha256-${string}`,
  ): PluginLockEntry {
    return {
      id: inspected.manifest.id,
      packageName: inspected.packageJson.name,
      packageVersion: inspected.packageJson.version,
      pluginVersion: inspected.manifest.version,
      apiVersion: inspected.manifest.apiVersion,
      entry: entryRelativePath(packageDir, inspected.entry),
      integrity,
      permissions: asSortedPermissions(inspected.manifest.permissions ?? []),
      source,
      installedAt: new Date().toISOString(),
    };
  }
}

export function createExternalPluginManager(
  options: PluginManagerOptions = {},
): ExternalPluginManager {
  return new ExternalPluginManager(options);
}
