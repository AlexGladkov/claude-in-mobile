/**
 * External plugin loader (Phase 5 of the 3.12.0 abstraction refactor).
 *
 * Discovers and loads third-party plugins from the filesystem so the kernel
 * can accept new platforms without a fork.
 *
 * Discovery rule:
 *   - Scan `<dir>/<plugin-id>/` directories under each search root.
 *   - Each directory must contain a `package.json` whose `main` (or `module`)
 *     points to a JS file exporting `default: () => SourcePlugin` OR a named
 *     export `createPlugin: () => SourcePlugin`.
 *   - The plugin manifest's `apiVersion` is verified against the host's
 *     supported list before registration; mismatches are reported and the
 *     plugin is skipped (never thrown — one bad plugin must not kill the host).
 *
 * Search roots default to `~/.mcp-devices/plugins/`. Callers can pass
 * additional directories via `additionalRoots` for tests or vendoring.
 *
 * The loader is intentionally side-effect-free at construction; call `discover`
 * to walk the filesystem and return loadable plugin factories.
 */

import { lstat, opendir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import type {
  Logger,
  PluginManifest,
  PluginPermission,
  SourcePlugin,
} from "@mcp-devices/plugin-api";
import { validateManifest, validateSourcePlugin } from "./registry.js";
import { sanitizeErrorMessage } from "../utils/sanitize.js";
import { readJsonOrDefault } from "../utils/json-file.js";
import {
  entryRelativePath,
  MAX_PLUGIN_BYTES,
  hashPluginDirectory,
  pluginLockPath,
  pluginRootPath,
  readPluginLockfile,
  snapshotPluginDirectory,
  type PluginLockEntry,
  withPluginStateLock,
} from "./plugin-lock.js";
import {
  grantMatchesIdentity,
  missingPermissions,
  pluginPermissionPath,
  readPluginPermissionPolicy,
  type PluginPermissionPolicy,
} from "./plugin-policy.js";
export interface ExternalLoaderOptions {
  /** Extra search roots in addition to `~/.mcp-devices/plugins/`. */
  additionalRoots?: ReadonlyArray<string>;
  /** API versions the host understands. Plugins outside this set are skipped. */
  supportedApiVersions?: ReadonlyArray<string>;
  /** Lockfile used to verify managed plugin directories. */
  lockPath?: string;
  /** Permission policy path; defaults to MCP_DEVICES_PLUGIN_PERMISSIONS. */
  permissionPath?: string;
  /** Require every discovered plugin to have a matching lock entry (default true). */
  requireLockfile?: boolean;
  /** Explicit permission grants. When omitted, the user policy file is read. */
  permissionGrants?: Readonly<Record<string, readonly PluginPermission[]>>;
  /** Maximum time allowed for an external plugin module import, in milliseconds. */
  moduleImportTimeoutMs?: number;
  /** Disable permission gating only for diagnostics and package inspection. */
  enforcePermissions?: boolean;
  /** Maximum bytes this loader may reserve for snapshots being admitted concurrently. */
  snapshotCacheMaxBytes?: number;
  /** Maximum snapshot entries this loader may reserve concurrently. */
  snapshotCacheMaxEntries?: number;
  /** Logger; defaults to stderr-only console. */
  logger?: Logger;
}

export interface DiscoveredPlugin {
  factory: () => SourcePlugin;
  manifest: PluginManifest;
  /** Directory the plugin was loaded from — useful for diagnostics. */
  source: string;
}
const DEFAULT_API_VERSIONS = ["1"] as const;
export const DEFAULT_MODULE_IMPORT_TIMEOUT_MS = 10_000;
const DEFAULT_PROBE_DISPOSE_TIMEOUT_MS = 5_000;
const MAX_PLUGIN_ROOTS = 32;
const MAX_PLUGINS_PER_ROOT = 1000;
const MAX_TOTAL_PLUGINS = 256;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
export const MAX_PLUGIN_SNAPSHOT_CACHE_BYTES = 1024 * 1024 * 1024;
export const MAX_PLUGIN_SNAPSHOT_CACHE_ENTRIES = 256;

interface VerifiedSnapshot {
  readonly directory: string;
  readonly integrity: `sha256-${string}`;
  readonly bytes: number;
}

interface SnapshotRecord extends VerifiedSnapshot {
  readonly key: string;
  refs: number;
  retained: boolean;
  reservedBytes: number;
  reservedEntry: boolean;
}

/**
 * Verified snapshots are shared across loader instances in this process. They
 * remain available until process teardown because factories may resolve assets
 * lazily relative to their module URL.
 */
const verifiedSnapshots = new Map<string, SnapshotRecord>();
const inFlightSnapshots = new Map<string, Promise<SnapshotRecord>>();
let verifiedSnapshotBytes = 0;
let pendingSnapshotBytes = 0;
let pendingSnapshotEntries = 0;

function reserveSnapshotAdmission(maxBytes: number, maxEntries: number): number | undefined {
  const remainingBytes = Math.min(
    maxBytes - pendingSnapshotBytes,
    MAX_PLUGIN_SNAPSHOT_CACHE_BYTES - verifiedSnapshotBytes - pendingSnapshotBytes,
  );
  const remainingEntries = Math.min(
    maxEntries - pendingSnapshotEntries,
    MAX_PLUGIN_SNAPSHOT_CACHE_ENTRIES - verifiedSnapshots.size - pendingSnapshotEntries,
  );
  if (remainingBytes < 1 || remainingEntries < 1) return undefined;
  const reservedBytes = Math.min(remainingBytes, MAX_PLUGIN_BYTES);
  pendingSnapshotBytes += reservedBytes;
  pendingSnapshotEntries += 1;
  return reservedBytes;
}

async function acquireSnapshot(
  key: string,
  directory: string,
  parent: string,
  maxBytes: number,
  maxEntries: number,
): Promise<SnapshotRecord | undefined> {
  const cached = verifiedSnapshots.get(key);
  if (cached) {
    cached.refs += 1;
    return cached;
  }

  let task = inFlightSnapshots.get(key);
  if (!task) {
    const reservedBytes = reserveSnapshotAdmission(maxBytes, maxEntries);
    if (reservedBytes === undefined) return undefined;
    task = (async () => {
      try {
        const snapshot = await snapshotPluginDirectory(directory, parent, reservedBytes);
        pendingSnapshotBytes -= reservedBytes - snapshot.bytes;
        return {
          ...snapshot,
          key,
          refs: 0,
          retained: false,
          reservedBytes: snapshot.bytes,
          reservedEntry: true,
        };
      } catch (error) {
        pendingSnapshotBytes -= reservedBytes;
        pendingSnapshotEntries -= 1;
        throw error;
      }
    })();
    inFlightSnapshots.set(key, task);
  }

  try {
    const snapshot = await task;
    snapshot.refs += 1;
    return snapshot;
  } catch (error) {
    if (inFlightSnapshots.get(key) === task) inFlightSnapshots.delete(key);
    throw error;
  }
}

function retainSnapshot(snapshot: SnapshotRecord): void {
  if (snapshot.retained) return;
  const cacheKey = verifiedSnapshots.has(snapshot.key)
    ? `${snapshot.key}\0${snapshot.directory}`
    : snapshot.key;
  verifiedSnapshots.set(cacheKey, snapshot);
  verifiedSnapshotBytes += snapshot.bytes;
  pendingSnapshotBytes -= snapshot.reservedBytes;
  if (snapshot.reservedEntry) {
    pendingSnapshotEntries -= 1;
    snapshot.reservedEntry = false;
  }
  snapshot.reservedBytes = 0;
  snapshot.retained = true;
  if (inFlightSnapshots.get(snapshot.key)) inFlightSnapshots.delete(snapshot.key);
}

function invalidateSnapshot(snapshot: SnapshotRecord): void {
  for (const [key, value] of verifiedSnapshots) {
    if (value !== snapshot) continue;
    verifiedSnapshots.delete(key);
    verifiedSnapshotBytes -= snapshot.bytes;
  }
  snapshot.retained = false;
  if (snapshot.refs === 0) {
    void rm(snapshot.directory, { recursive: true, force: true }).catch(() => {});
  }
}
async function releaseSnapshot(snapshot: SnapshotRecord): Promise<void> {
  if (snapshot.refs < 1) return;
  snapshot.refs -= 1;
  if (snapshot.refs > 0 || snapshot.retained) return;
  if (inFlightSnapshots.get(snapshot.key)) inFlightSnapshots.delete(snapshot.key);
  if (snapshot.reservedBytes > 0) {
    pendingSnapshotBytes -= snapshot.reservedBytes;
    snapshot.reservedBytes = 0;
  }
  if (snapshot.reservedEntry) {
    pendingSnapshotEntries -= 1;
    snapshot.reservedEntry = false;
  }
  await rm(snapshot.directory, { recursive: true, force: true }).catch(() => {});
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

type Disposer = () => void | Promise<void>;

function findDisposer(value: unknown): { disposer?: Disposer; error?: unknown } {
  if (!isObjectLike(value)) return {};

  let pluginDispose: unknown;
  let pluginLookupError: unknown;
  try {
    pluginDispose = Reflect.get(value, "dispose");
  } catch (error: unknown) {
    pluginLookupError = error ?? new Error("plugin dispose lookup failed");
  }
  if (typeof pluginDispose === "function") {
    return { disposer: () => Reflect.apply(pluginDispose, value, []) };
  }

  let adapter: unknown;
  try {
    adapter = Reflect.get(value, "adapter");
  } catch (error: unknown) {
    return {
      error: pluginLookupError ?? error ?? new Error("plugin adapter lookup failed"),
    };
  }
  if (!isObjectLike(adapter)) {
    return pluginLookupError === undefined ? {} : { error: pluginLookupError };
  }
  try {
    const adapterDispose = Reflect.get(adapter, "dispose");
    if (typeof adapterDispose === "function") {
      return { disposer: () => Reflect.apply(adapterDispose, adapter, []) };
    }
    return pluginLookupError === undefined ? {} : { error: pluginLookupError };
  } catch (error: unknown) {
    return { error: error ?? new Error("adapter dispose lookup failed") };
  }
}

async function disposeProbe(
  value: unknown,
  pluginId: string,
  logger: Logger,
): Promise<void> {
  const { disposer, error } = findDisposer(value);
  if (error !== undefined) {
    logger.warn?.("plugin probe disposal lookup failed", {
      id: pluginId,
      error: sanitizeErrorMessage(error).slice(0, 1000),
    });
    return;
  }
  if (!disposer) return;

  let disposal: void | Promise<void>;
  try {
    disposal = disposer();
  } catch (error: unknown) {
    logger.warn?.("plugin probe disposal failed", {
      id: pluginId,
      error: sanitizeErrorMessage(error).slice(0, 1000),
    });
    return;
  }

  let timer!: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      Promise.resolve(disposal),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(
            `plugin probe disposal timed out after ${DEFAULT_PROBE_DISPOSE_TIMEOUT_MS}ms`,
          ));
        }, DEFAULT_PROBE_DISPOSE_TIMEOUT_MS);
      }),
    ]);
  } catch (error: unknown) {
    logger.warn?.("plugin probe disposal failed", {
      id: pluginId,
      error: sanitizeErrorMessage(error).slice(0, 1000),
    });
  } finally {
    clearTimeout(timer);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isSafePluginRoot(path: string): Promise<boolean> {
  try {
    const details = await lstat(path);
    return (
      details.isDirectory()
      && !details.isSymbolicLink()
      && (
        process.platform === "win32"
        || (details.mode & 0o022) === 0
      )
    );
  } catch {
    return false;
  }
}

const packageNameSchema = z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/);
const packageVersionSchema = z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/);
const packageEntrySchema = z.string().min(1).max(1024).regex(/^[^\u0000-\u001f\u007f]+$/);
const externalPackageJsonSchema = z.object({
  name: packageNameSchema,
  version: packageVersionSchema,
  main: packageEntrySchema.optional(),
  module: packageEntrySchema.optional(),
  type: z.enum(["module", "commonjs"]).optional(),
  mcpDevicesPlugin: z.unknown(),
}).passthrough();
export type ExternalPackageJson = z.infer<typeof externalPackageJsonSchema>;

export async function readExternalPackageJson(
  dir: string,
): Promise<ExternalPackageJson | null> {
  const pkgPath = join(dir, "package.json");
  try {
    const details = await lstat(pkgPath);
    if (
      !details.isFile()
      || details.isSymbolicLink()
      || details.size > MAX_PACKAGE_JSON_BYTES
    ) {
      return null;
    }
    const result = externalPackageJsonSchema.safeParse(
      await readJsonOrDefault(
        pkgPath,
        () => null,
        "external plugin package.json",
      ),
    );
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}


/**
 * Resolve the plugin entry file and assert it stays inside the plugin dir.
 *
 * A malicious `package.json` could set `main` / `module` to something like
 * `"../../../etc/something.js"` to coerce the loader into importing JS outside
 * the plugin directory. We resolve both sides and require the entry to be the
 * dir itself or a descendant of it. Returns `null` when containment is
 * violated — callers MUST treat that as "skip this plugin" (fail closed).
 */
export function resolveExternalPluginEntry(
  dir: string,
  pkg: ExternalPackageJson,
): string | null {
  const entry = pkg.module ?? pkg.main ?? "index.js";
  const resolvedDir = resolve(dir);
  const resolvedEntry = resolve(dir, entry);
  if (resolvedEntry !== resolvedDir && !resolvedEntry.startsWith(resolvedDir + sep)) {
    return null;
  }
  return resolvedEntry;
}

/**
 * Import one plugin module with a bounded wait. Promise timeout does not
 * cancel the underlying import; it only prevents startup from waiting forever.
 */
export async function loadExternalPluginFactory(
  entry: string,
  timeoutMs = DEFAULT_MODULE_IMPORT_TIMEOUT_MS,
): Promise<(() => SourcePlugin) | null> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error("Invalid external plugin import timeout.");
  }
  const modulePromise = import(pathToFileURL(entry).href) as Promise<{
    default?: unknown;
    createPlugin?: unknown;
  }>;
  let timer!: ReturnType<typeof setTimeout>;
  try {
    const mod = await Promise.race([
      modulePromise,
      new Promise<{
        default?: unknown;
        createPlugin?: unknown;
      }>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(
            `Plugin module import timed out after ${timeoutMs}ms; the import was not cancelled.`,
          ));
        }, timeoutMs);
      }),
    ]);
    const defaultExport = mod.default;
    const commonJsFactory = typeof defaultExport === "object"
      && defaultExport !== null
      ? (defaultExport as Record<string, unknown>).createPlugin
      : undefined;
    for (const candidate of [mod.createPlugin, commonJsFactory, defaultExport]) {
      if (typeof candidate === "function") {
        return candidate as () => SourcePlugin;
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
  }

}

function sameArray(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  const leftValues = left ?? [];
  const rightValues = right ?? [];
  return leftValues.length === rightValues.length
    && leftValues.every((value, index) => value === rightValues[index]);
}

function manifestsMatch(left: PluginManifest, right: PluginManifest): boolean {
  return (
    left.id === right.id
    && left.name === right.name
    && left.version === right.version
    && left.apiVersion === right.apiVersion
    && sameArray(left.capabilities, right.capabilities)
    && sameArray(left.permissions, right.permissions)
    && sameArray(left.tools, right.tools)
    && left.description === right.description
    && left.homepage === right.homepage
  );
}

function manifestMatchesLock(manifest: PluginManifest, entry: PluginLockEntry): boolean {
  return (
    manifest.id === entry.id
    && manifest.version === entry.pluginVersion
    && manifest.apiVersion === entry.apiVersion
    && [...(manifest.permissions ?? [])].sort().join("\0") === [...entry.permissions].sort().join("\0")
  );
}

function staticManifest(packageJson: ExternalPackageJson): PluginManifest {
  const value = packageJson.mcpDevicesPlugin;
  validateManifest(value);
  return value;
}

export class ExternalPluginLoader {
  private readonly roots: ReadonlyArray<string>;
  private readonly apiVersions: ReadonlySet<string>;
  private readonly lockPath: string;
  private readonly snapshotRoot: string;
  private readonly permissionPath: string;
  private readonly requireLockfile: boolean;
  private readonly permissionGrants?: Readonly<Record<string, readonly PluginPermission[]>>;
  private readonly enforcePermissions: boolean;
  private readonly moduleImportTimeoutMs: number;
  private readonly logger: Logger;
  private readonly snapshotCacheMaxBytes: number;
  private readonly snapshotCacheMaxEntries: number;
  private readonly createdPlugins = new WeakSet<object>();

  constructor(opts: ExternalLoaderOptions = {}) {
    const additionalRoots = opts.additionalRoots ?? [];
    if (
      additionalRoots.length > MAX_PLUGIN_ROOTS
      || additionalRoots.some(
        (root) => root.length === 0 || root.length > 4096 || root.includes("\0"),
      )
    ) {
      throw new Error("Invalid external plugin search roots.");
    }
    this.roots = [pluginRootPath(), ...additionalRoots];
    this.lockPath = opts.lockPath ?? pluginLockPath();
    this.snapshotRoot = join(
      dirname(this.lockPath),
      `.mcp-devices-plugin-snapshots-${process.pid}`,
    );
    this.permissionPath = opts.permissionPath ?? pluginPermissionPath();
    this.requireLockfile = opts.requireLockfile ?? true;
    this.permissionGrants = opts.permissionGrants;
    this.enforcePermissions = opts.enforcePermissions ?? true;
    this.moduleImportTimeoutMs = opts.moduleImportTimeoutMs ?? DEFAULT_MODULE_IMPORT_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.moduleImportTimeoutMs)
      || this.moduleImportTimeoutMs < 1
      || this.moduleImportTimeoutMs > 120_000
    ) {
      throw new Error("Invalid external plugin import timeout.");
    }
    this.snapshotCacheMaxBytes = opts.snapshotCacheMaxBytes ?? MAX_PLUGIN_SNAPSHOT_CACHE_BYTES;
    this.snapshotCacheMaxEntries = opts.snapshotCacheMaxEntries ?? MAX_PLUGIN_SNAPSHOT_CACHE_ENTRIES;
    if (
      !Number.isSafeInteger(this.snapshotCacheMaxBytes)
      || this.snapshotCacheMaxBytes < 1
      || this.snapshotCacheMaxBytes > MAX_PLUGIN_SNAPSHOT_CACHE_BYTES
      || !Number.isSafeInteger(this.snapshotCacheMaxEntries)
      || this.snapshotCacheMaxEntries < 1
      || this.snapshotCacheMaxEntries > MAX_PLUGIN_SNAPSHOT_CACHE_ENTRIES
    ) {
      throw new Error("Invalid external plugin snapshot cache limits.");
    }
    const apiVersions = opts.supportedApiVersions ?? DEFAULT_API_VERSIONS;
    if (
      apiVersions.length === 0
      || apiVersions.length > 16
      || apiVersions.some((version) => !/^[A-Za-z0-9._-]{1,32}$/.test(version))
    ) {
      throw new Error("Invalid supported external plugin API versions.");
    }
    this.apiVersions = new Set(apiVersions);
    this.logger = opts.logger ?? {
      debug: () => {},
      info: () => {},
      warn: (m, meta) => console.error(`[external-loader] ${m}`, meta ?? ""),
      error: (m, meta) => console.error(`[external-loader] ${m}`, meta ?? ""),
    };
  }

  /**
   * Walk search roots and return loadable plugin factories.
   * Bad plugins are logged and skipped.
   */
  async discover(): Promise<ReadonlyArray<DiscoveredPlugin>> {
    return withPluginStateLock(this.lockPath, () => this.discoverUnlocked());
  }

  private async discoverUnlocked(): Promise<ReadonlyArray<DiscoveredPlugin>> {
    const found: DiscoveredPlugin[] = [];
    const lockfile = await this.readLockfile();
    const permissionPolicy = await this.readPermissionGrants();

    for (const root of this.roots) {
      if (found.length >= MAX_TOTAL_PLUGINS) {
        this.logger.warn?.("external plugin global limit reached");
        break;
      }
      if (!(await exists(root))) continue;
      if (!(await isSafePluginRoot(root))) {
        this.logger.warn?.("external plugin root is not a safe directory");
        continue;
      }
      let directory;
      try {
        directory = await opendir(root);
      } catch {
        this.logger.warn?.("external plugin root cannot be read");
        continue;
      }
      let entryCount = 0;
      for await (const e of directory) {
        entryCount += 1;
        if (entryCount > MAX_PLUGINS_PER_ROOT) {
          this.logger.warn?.("external plugin root entry limit reached");
          break;
        }
        if (found.length >= MAX_TOTAL_PLUGINS) {
          this.logger.warn?.("external plugin global limit reached");
          break;
        }
        if (!e.isDirectory()) continue;

        const dir = join(root, e.name);
        const lockEntry = lockfile && Object.hasOwn(lockfile.plugins, e.name)
          ? lockfile.plugins[e.name]
          : undefined;
        if (this.requireLockfile && !lockEntry) {
          this.logger.warn?.("plugin is not present in the lockfile — skipped", { id: e.name });
          continue;
        }

        let snapshotRecord: SnapshotRecord | undefined;
        try {
          let packageDirectory = dir;
          let verifiedIntegrity: `sha256-${string}` | undefined;
          if (lockEntry) {
            const snapshotKey = `${dir}\0${lockEntry.integrity}`;
            const cached = verifiedSnapshots.get(snapshotKey);
            if (cached || inFlightSnapshots.has(snapshotKey)) {
              let sourceIntegrity: `sha256-${string}`;
              try {
                sourceIntegrity = await hashPluginDirectory(dir);
              } catch (error: unknown) {
                this.logger.warn?.("plugin integrity check failed — skipped", {
                  id: e.name,
                  error: sanitizeErrorMessage(
                    error instanceof Error ? error.message : String(error),
                  ).slice(0, 1000),
                });
                continue;
              }
              if (sourceIntegrity !== lockEntry.integrity) {
                this.logger.warn?.("plugin integrity mismatch — skipped", { id: e.name });
                continue;
              }
              if (cached) {
                try {
                  if (await hashPluginDirectory(cached.directory) !== lockEntry.integrity) {
                    invalidateSnapshot(cached);
                  }
                } catch {
                  invalidateSnapshot(cached);
                }
              }
            }
            try {
              snapshotRecord = await acquireSnapshot(
                snapshotKey,
                dir,
                this.snapshotRoot,
                this.snapshotCacheMaxBytes,
                this.snapshotCacheMaxEntries,
              );
            } catch (error: unknown) {
              this.logger.warn?.("plugin integrity check failed — skipped", {
                id: e.name,
                error: sanitizeErrorMessage(
                  error instanceof Error ? error.message : String(error),
                ).slice(0, 1000),
              });
              continue;
            }
            if (!snapshotRecord) {
              this.logger.warn?.("plugin snapshot cache limit reached — skipped", { id: e.name });
              continue;
            }
            try {
              const snapshotIntegrity = await hashPluginDirectory(snapshotRecord.directory);
              if (snapshotIntegrity !== lockEntry.integrity) {
                throw new Error("snapshot integrity mismatch");
              }
              packageDirectory = snapshotRecord.directory;
              verifiedIntegrity = snapshotIntegrity;
            } catch (error: unknown) {
              invalidateSnapshot(snapshotRecord);
              this.logger.warn?.("plugin integrity check failed — skipped", {
                id: e.name,
                error: sanitizeErrorMessage(
                  error instanceof Error ? error.message : String(error),
                ).slice(0, 1000),
              });
              continue;
            }
          }

          const pkg = await readExternalPackageJson(packageDirectory);
          if (!pkg) {
            this.logger.warn?.("missing or invalid package.json", { id: e.name });
            continue;
          }

          let declaredManifest: PluginManifest;
          try {
            declaredManifest = staticManifest(pkg);
          } catch (error: unknown) {
            this.logger.warn?.("package mcpDevicesPlugin manifest is invalid — skipped", {
              id: e.name,
              error: sanitizeErrorMessage(
                error instanceof Error ? error.message : String(error),
              ).slice(0, 1000),
            });
            continue;
          }
          if (declaredManifest.id !== e.name) {
            this.logger.warn?.("plugin manifest id does not match its directory — skipped", {
              id: e.name,
            });
            continue;
          }
          if (!this.apiVersions.has(declaredManifest.apiVersion)) {
            this.logger.warn?.("apiVersion mismatch — plugin skipped", { id: e.name });
            continue;
          }

          const entry = resolveExternalPluginEntry(packageDirectory, pkg);
          if (!entry) {
            this.logger.warn?.("entry escapes plugin directory — plugin skipped", { id: e.name });
            continue;
          }
          try {
            const entryDetails = await lstat(entry);
            if (!entryDetails.isFile() || entryDetails.isSymbolicLink()) {
              this.logger.warn?.("entry file not found", { id: e.name });
              continue;
            }
          } catch {
            this.logger.warn?.("entry file not found", { id: e.name });
            continue;
          }

          if (lockEntry) {
            try {
              const entryPath = entryRelativePath(packageDirectory, entry);
              if (
                lockEntry.entry !== entryPath
                || lockEntry.id !== declaredManifest.id
                || lockEntry.packageName !== pkg.name
                || lockEntry.packageVersion !== pkg.version
                || !manifestMatchesLock(declaredManifest, lockEntry)
                || verifiedIntegrity !== lockEntry.integrity
              ) {
                this.logger.warn?.("plugin metadata does not match the lockfile — skipped", {
                  id: e.name,
                });
                continue;
              }
            } catch (error: unknown) {
              this.logger.warn?.("plugin integrity check failed — skipped", {
                id: e.name,
                error: sanitizeErrorMessage(
                  error instanceof Error ? error.message : String(error),
                ).slice(0, 1000),
              });
              continue;
            }
          }

          if (this.enforcePermissions) {
            let grants: readonly PluginPermission[] = [];
            if (this.permissionGrants) {
              grants = Object.hasOwn(this.permissionGrants, e.name)
                ? this.permissionGrants[e.name] ?? []
                : [];
            } else if (lockEntry && permissionPolicy) {
              const grant = Object.hasOwn(permissionPolicy.grants, e.name)
                ? permissionPolicy.grants[e.name]
                : undefined;
              grants = grant && grantMatchesIdentity(grant, lockEntry)
                ? grant.permissions
                : [];
            }
            const missing = missingPermissions(declaredManifest.permissions ?? [], grants);
            if (missing.length > 0) {
              this.logger.warn?.("plugin permissions are not granted — skipped", {
                id: declaredManifest.id,
                missing,
              });
              continue;
            }
          }

          let factory: (() => SourcePlugin) | null;
          try {
            factory = await loadExternalPluginFactory(entry, this.moduleImportTimeoutMs);
          } catch (error: unknown) {
            this.logger.error?.("plugin import failed", {
              id: e.name,
              error: sanitizeErrorMessage(
                error instanceof Error ? error.message : String(error),
              ).slice(0, 1000),
            });
            continue;
          }
          if (!factory) {
            this.logger.warn?.("no default/createPlugin export", { id: e.name });
            continue;
          }

          let probe: unknown = undefined;
          let probeOwned = false;
          let probeValid = false;
          try {
            probe = factory();
            if (isObjectLike(probe)) {
              if (this.createdPlugins.has(probe)) {
                throw new Error("plugin factory returned a previously used instance");
              }
              this.createdPlugins.add(probe);
              probeOwned = true;
            }
            validateSourcePlugin(probe);
            if (
              !manifestsMatch(probe.manifest, declaredManifest)
              || (lockEntry && !manifestMatchesLock(probe.manifest, lockEntry))
            ) {
              throw new Error("plugin manifest does not match package metadata");
            }
            probeValid = true;
          } catch (error: unknown) {
            this.logger.error?.("plugin factory threw", {
              id: e.name,
              error: sanitizeErrorMessage(
                error instanceof Error ? error.message : String(error),
              ).slice(0, 1000),
            });
          }
          if (probeOwned) {
            await disposeProbe(probe, declaredManifest.id, this.logger);
          }
          if (!probeValid) continue;

          found.push({
            factory: () => {
              let candidate: unknown;
              let candidateOwned = false;
              try {
                candidate = factory!();
                if (isObjectLike(candidate)) {
                  if (this.createdPlugins.has(candidate)) {
                    throw new Error("plugin factory returned a previously used instance");
                  }
                  this.createdPlugins.add(candidate);
                  candidateOwned = true;
                }
                validateSourcePlugin(candidate);
                if (
                  !manifestsMatch(candidate.manifest, declaredManifest)
                  || (lockEntry && !manifestMatchesLock(candidate.manifest, lockEntry))
                ) {
                  throw new Error("plugin manifest does not match package metadata");
                }
                return candidate;
              } catch (error: unknown) {
                if (candidateOwned) {
                  void disposeProbe(candidate, declaredManifest.id, this.logger);
                }
                throw error;
              }
            },
            manifest: declaredManifest,
            source: dir,
          });
          if (snapshotRecord) retainSnapshot(snapshotRecord);
        } finally {
          if (snapshotRecord) await releaseSnapshot(snapshotRecord);
        }
      }
    }
    return found;
  }

  private async readLockfile() {
    if (!this.requireLockfile) return undefined;
    try {
      return await readPluginLockfile(this.lockPath);
    } catch (error: unknown) {
      this.logger.error?.("plugin lockfile cannot be read — external plugins disabled", {
        error: sanitizeErrorMessage(
          error instanceof Error ? error.message : String(error),
        ).slice(0, 1000),
      });
      return null;
    }
  }

  private async readPermissionGrants(): Promise<PluginPermissionPolicy | undefined> {
    if (!this.enforcePermissions || this.permissionGrants) return undefined;
    try {
      return await readPluginPermissionPolicy(this.permissionPath);
    } catch (error: unknown) {
      this.logger.error?.("plugin permission policy cannot be read — external plugins disabled", {
        error: sanitizeErrorMessage(
          error instanceof Error ? error.message : String(error),
        ).slice(0, 1000),
      });
      return { version: 1 as const, grants: {} };
    }
  }
}
