import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  lstat,
  mkdtemp,
  rename,
  rm,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type {
  PluginManifest,
  PluginPermission,
  SourcePlugin,
} from "@mcp-devices/plugin-api";
import { isPluginPermission } from "@mcp-devices/plugin-api";
import { InMemoryRegistry } from "../kernel/registry.js";
import {
  assertPluginId,
  entryRelativePath,
  hashPluginDirectory,
  pluginLockPath,
  pluginRootPath,
  readPluginLockfile,
  type PluginLockEntry,
  writePluginLockfile,
} from "../kernel/plugin-lock.js";
import {
  permissionsFor,
  pluginPermissionPath,
  readPluginPermissionPolicy,
  writePluginPermissionPolicy,
} from "../kernel/plugin-policy.js";
import {
  loadExternalPluginFactory,
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
const SAFE_SPEC_RE = /^[^\u0000-\u001f\u007f]+$/;

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
  readonly plugin: SourcePlugin;
  readonly manifest: PluginManifest;
}

interface NpmPackRecord {
  readonly filename?: unknown;
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
    const spec = validateSpec(rawSpec);
    await ensurePrivateDirectory(this.pluginRoot);
    const source = isLocalSpec(spec) ? normalizeLocalSpec(spec) : spec;
    const stagingRoot = await mkdtemp(join(dirname(this.pluginRoot), ".mcp-devices-plugin-install-"));
    let incomingPath: string | undefined;
    try {
      const packageDir = await this.fetchPackage(source, stagingRoot);
      const packageJson = await this.readPackageOrThrow(packageDir);
      await this.installDependencies(packageDir, packageJson);
      const inspected = await this.inspectDirectory(packageDir);
      const pluginId = inspected.manifest.id;
      assertPluginId(pluginId);
      const integrity = await hashPluginDirectory(packageDir);
      const entry = this.buildLockEntry(
        source,
        packageDir,
        inspected,
        integrity,
      );

      const lockfile = await readPluginLockfile(this.lockPath);
      if (lockfile.plugins[pluginId] && !options.replace) {
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

      incomingPath = join(this.pluginRoot, `.${pluginId}.${randomUUID()}.incoming`);
      await rename(packageDir, incomingPath);
      let backupPath: string | undefined;
      try {
        if (currentExists) {
          backupPath = join(this.pluginRoot, `.${pluginId}.${randomUUID()}.backup`);
          await rename(finalPath, backupPath);
        }
        await rename(incomingPath, finalPath);
        incomingPath = undefined;

        const plugins = { ...lockfile.plugins, [pluginId]: entry };
        await writePluginLockfile(
          { version: lockfile.version, plugins },
          this.lockPath,
        );
        // The lockfile is committed before best-effort backup cleanup. A
        // cleanup failure must not roll the directory back to a stale lock.
        if (backupPath) await rm(backupPath, { recursive: true, force: true }).catch(() => {});
      } catch (error) {
        if (await pathExists(finalPath)) await rm(finalPath, { recursive: true, force: true });
        if (backupPath && await pathExists(backupPath)) await rename(backupPath, finalPath);
        if (incomingPath && await pathExists(incomingPath)) await rename(incomingPath, packageDir);
        throw error;
      }
      return entry;
    } finally {
      if (incomingPath && await pathExists(incomingPath)) {
        await rm(incomingPath, { recursive: true, force: true });
      }
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }

  async list(): Promise<readonly InstalledPluginInfo[]> {
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
        permissions: entry.permissions,
        grantedPermissions: permissionsFor(policy, entry.id),
        source: entry.source,
        integrity: entry.integrity,
      }));
  }

  async verify(ids?: readonly string[]): Promise<readonly PluginVerification[]> {
    const lockfile = await readPluginLockfile(this.lockPath);
    const selected = ids && ids.length > 0
      ? ids
      : Object.keys(lockfile.plugins).sort();
    const results: PluginVerification[] = [];
    for (const id of selected) {
      assertPluginId(id);
      const expected = lockfile.plugins[id];
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
  }

  async remove(id: string): Promise<void> {
    assertPluginId(id);
    const lockfile = await readPluginLockfile(this.lockPath);
    if (!lockfile.plugins[id]) throw new Error(`Plugin '${id}' is not installed.`);
    const directory = join(this.pluginRoot, id);
    if (await pathExists(directory)) {
      const details = await lstat(directory);
      if (!details.isDirectory() || details.isSymbolicLink()) {
        throw new Error(`Plugin path '${id}' is not a real directory.`);
      }
      await rm(directory, { recursive: true, force: true });
    }
    const plugins = { ...lockfile.plugins };
    delete plugins[id];
    await writePluginLockfile({ version: lockfile.version, plugins }, this.lockPath);

    const policy = await readPluginPermissionPolicy(this.permissionPath);
    const grants = { ...policy.grants };
    delete grants[id];
    await writePluginPermissionPolicy(
      { version: policy.version, grants },
      this.permissionPath,
    );
  }

  async update(ids?: readonly string[]): Promise<readonly PluginLockEntry[]> {
    const lockfile = await readPluginLockfile(this.lockPath);
    const selected = ids && ids.length > 0
      ? ids
      : Object.keys(lockfile.plugins).sort();
    const updated: PluginLockEntry[] = [];
    for (const id of selected) {
      assertPluginId(id);
      const entry = lockfile.plugins[id];
      if (!entry) throw new Error(`Plugin '${id}' is not installed.`);
      const source = isLocalSpec(entry.source) ? entry.source : entry.packageName;
      updated.push(await this.install(source, { replace: true }));
    }
    return updated;
  }

  async grant(id: string, permissions: readonly string[]): Promise<readonly PluginPermission[]> {
    assertPluginId(id);
    const lockfile = await readPluginLockfile(this.lockPath);
    if (!lockfile.plugins[id]) throw new Error(`Plugin '${id}' is not installed.`);
    const inspected = await this.inspectDirectory(join(this.pluginRoot, id));
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
    const grants = {
      ...policy.grants,
      [id]: asSortedPermissions([
        ...(policy.grants[id] ?? []),
        ...requested,
      ]),
    };
    await writePluginPermissionPolicy(
      { version: policy.version, grants },
      this.permissionPath,
    );
    return grants[id]!;
  }

  async revoke(id: string, permissions: readonly string[]): Promise<readonly PluginPermission[]> {
    assertPluginId(id);
    const lockfile = await readPluginLockfile(this.lockPath);
    if (!lockfile.plugins[id]) throw new Error(`Plugin '${id}' is not installed.`);
    const policy = await readPluginPermissionPolicy(this.permissionPath);
    const current = [...(policy.grants[id] ?? [])];
    const next = permissions.length === 0
      ? []
      : current.filter((permission) => !permissions.includes(permission));
    const grants = { ...policy.grants, [id]: asSortedPermissions(next) };
    await writePluginPermissionPolicy(
      { version: policy.version, grants },
      this.permissionPath,
    );
    return grants[id]!;
  }

  private async validateArchive(archive: string, stagingRoot: string): Promise<void> {
    const listing = await execFileAsync(
      this.tarCommand,
      ["-tzf", archive],
      { cwd: stagingRoot, timeout: NPM_TIMEOUT_MS, maxBuffer: MAX_NPM_OUTPUT_BYTES },
    );
    for (const rawMember of String(listing.stdout).split(/\r?\n/u)) {
      if (!rawMember) continue;
      const member = rawMember.startsWith("./") ? rawMember.slice(2) : rawMember;
      if (
        !member.startsWith("package/")
        || member.includes("\0")
        || member.split(/[\\/]/u).includes("..")
      ) {
        throw new Error("npm package archive contains an unsafe path.");
      }
    }

    const details = await execFileAsync(
      this.tarCommand,
      ["-tvzf", archive],
      { cwd: stagingRoot, timeout: NPM_TIMEOUT_MS, maxBuffer: MAX_NPM_OUTPUT_BYTES },
    );
    for (const line of String(details.stdout).split(/\r?\n/u)) {
      if (line && line[0] !== "-" && line[0] !== "d") {
        throw new Error("npm package archive contains a symbolic link or special file.");
      }
    }
  }

  private async fetchPackage(source: string, stagingRoot: string): Promise<string> {
    const result = await execFileAsync(
      this.npmCommand,
      [
        "pack",
        source,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--json",
        "--pack-destination",
        stagingRoot,
      ],
      {
        cwd: stagingRoot,
        timeout: NPM_TIMEOUT_MS,
        maxBuffer: MAX_NPM_OUTPUT_BYTES,
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
  ): Promise<void> {
    if (!packageDependencies(packageJson)) return;
    await execFileAsync(
      this.npmCommand,
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--omit=dev"],
      { cwd: packageDir, timeout: NPM_TIMEOUT_MS, maxBuffer: MAX_NPM_OUTPUT_BYTES },
    );
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
    const factory = await loadExternalPluginFactory(entry);
    if (!factory) throw new Error("Plugin must export default or createPlugin factory.");
    const plugin = factory();
    const registry = new InMemoryRegistry();
    registry.register(plugin);
    return {
      packageJson,
      entry,
      plugin,
      manifest: plugin.manifest,
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
