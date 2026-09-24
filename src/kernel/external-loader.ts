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

import { lstat, opendir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import type {
  Logger,
  PluginManifest,
  PluginPermission,
  SourcePlugin,
} from "@mcp-devices/plugin-api";
import { sanitizeErrorMessage } from "../utils/sanitize.js";
import { readJsonOrDefault } from "../utils/json-file.js";
import {
  entryRelativePath,
  hashPluginDirectory,
  pluginLockPath,
  pluginRootPath,
  readPluginLockfile,
} from "./plugin-lock.js";
import {
  missingPermissions,
  readPluginPermissionPolicy,
} from "./plugin-policy.js";
export interface ExternalLoaderOptions {
  /** Extra search roots in addition to `~/.mcp-devices/plugins/`. */
  additionalRoots?: ReadonlyArray<string>;
  /** API versions the host understands. Plugins outside this set are skipped. */
  supportedApiVersions?: ReadonlyArray<string>;
  /** Lockfile used to verify managed plugin directories. */
  lockPath?: string;
  /** Require every discovered plugin to have a matching lock entry (default true). */
  requireLockfile?: boolean;
  /** Explicit permission grants. When omitted, the user policy file is read. */
  permissionGrants?: Readonly<Record<string, readonly PluginPermission[]>>;
  /** Disable permission gating only for diagnostics and package inspection. */
  enforcePermissions?: boolean;
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
const MAX_PLUGIN_ROOTS = 32;
const MAX_PLUGINS_PER_ROOT = 1000;
const MAX_TOTAL_PLUGINS = 256;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;


async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
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
 * the plugin sandbox. We resolve both sides and require the entry to be the
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

export async function loadExternalPluginFactory(
  entry: string,
): Promise<(() => SourcePlugin) | null> {
  const mod = (await import(pathToFileURL(entry).href)) as {
    default?: () => SourcePlugin;
    createPlugin?: () => SourcePlugin;
  };
  const factory = mod.default ?? mod.createPlugin;
  return typeof factory === "function" ? factory : null;
}


export class ExternalPluginLoader {
  private readonly roots: ReadonlyArray<string>;
  private readonly apiVersions: ReadonlySet<string>;
  private readonly lockPath: string;
  private readonly requireLockfile: boolean;
  private readonly permissionGrants?: Readonly<Record<string, readonly PluginPermission[]>>;
  private readonly enforcePermissions: boolean;
  private readonly logger: Logger;

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
    this.requireLockfile = opts.requireLockfile ?? true;
    this.permissionGrants = opts.permissionGrants;
    this.enforcePermissions = opts.enforcePermissions ?? true;
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
    const found: DiscoveredPlugin[] = [];
    const lockfile = await this.readLockfile();
    const permissionGrants = await this.readPermissionGrants();

    for (const root of this.roots) {
      if (found.length >= MAX_TOTAL_PLUGINS) {
        this.logger.warn?.("external plugin global limit reached");
        break;
      }
      if (!(await exists(root))) continue;
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
        const lockEntry = lockfile?.plugins[e.name];
        if (this.requireLockfile && !lockEntry) {
          this.logger.warn?.("plugin is not present in the lockfile — skipped", { id: e.name });
          continue;
        }

        const pkg = await readExternalPackageJson(dir);
        if (!pkg) {
          this.logger.warn?.("missing or invalid package.json", { id: e.name });
          continue;
        }
        const entry = resolveExternalPluginEntry(dir, pkg);
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
            const entryPath = entryRelativePath(dir, entry);
            if (
              lockEntry.entry !== entryPath
              || lockEntry.packageName !== pkg.name
              || lockEntry.packageVersion !== pkg.version
            ) {
              this.logger.warn?.("plugin metadata does not match the lockfile — skipped", {
                id: e.name,
              });
              continue;
            }
            const integrity = await hashPluginDirectory(dir);
            if (integrity !== lockEntry.integrity) {
              this.logger.warn?.("plugin integrity mismatch — skipped", { id: e.name });
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

        let factory: (() => SourcePlugin) | null;
        try {
          factory = await loadExternalPluginFactory(entry);
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

        let plugin: SourcePlugin;
        try {
          const candidate = factory();
          if (typeof candidate !== "object" || candidate === null) {
            throw new Error("plugin factory returned an invalid value");
          }
          plugin = candidate;
          const manifest = plugin.manifest;
          if (
            typeof manifest !== "object"
            || manifest === null
            || manifest.id !== e.name
            || typeof manifest.version !== "string"
            || typeof manifest.apiVersion !== "string"
          ) {
            throw new Error("plugin manifest is invalid or does not match its directory");
          }
          if (!this.apiVersions.has(manifest.apiVersion)) {
            this.logger.warn?.("apiVersion mismatch — plugin skipped", { id: e.name });
            continue;
          }

          const requested = manifest.permissions ?? [];
          if (lockEntry) {
            const declared = [...requested].sort().join("\\0");
            const locked = [...lockEntry.permissions].sort().join("\\0");
            if (
              lockEntry.pluginVersion !== manifest.version
              || lockEntry.apiVersion !== manifest.apiVersion
              || declared !== locked
            ) {
              this.logger.warn?.("plugin manifest does not match the lockfile — skipped", {
                id: e.name,
              });
              continue;
            }
          }
          if (this.enforcePermissions) {
            const grants = permissionGrants?.[manifest.id] ?? [];
            const missing = missingPermissions(requested, grants);
            if (missing.length > 0) {
              this.logger.warn?.("plugin permissions are not granted — skipped", {
                id: manifest.id,
                missing,
              });
              continue;
            }
          }
        } catch (error: unknown) {
          this.logger.error?.("plugin factory threw", {
            id: e.name,
            error: sanitizeErrorMessage(
              error instanceof Error ? error.message : String(error),
            ).slice(0, 1000),
          });
          continue;
        }

        const discoveredPlugin = plugin;
        found.push({
          factory: () => discoveredPlugin,
          manifest: discoveredPlugin.manifest,
          source: dir,
        });
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

  private async readPermissionGrants(): Promise<
    Readonly<Record<string, readonly PluginPermission[]>> | undefined
  > {
    if (!this.enforcePermissions) return undefined;
    if (this.permissionGrants) return this.permissionGrants;
    try {
      return (await readPluginPermissionPolicy()).grants;
    } catch (error: unknown) {
      this.logger.error?.("plugin permission policy cannot be read — external plugins disabled", {
        error: sanitizeErrorMessage(
          error instanceof Error ? error.message : String(error),
        ).slice(0, 1000),
      });
      return {};
    }
  }
}
