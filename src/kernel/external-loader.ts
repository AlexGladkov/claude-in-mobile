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
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";


import type { Logger, SourcePlugin } from "@mcp-devices/plugin-api";
import { sanitizeErrorMessage } from "../utils/sanitize.js";
import { readJsonOrDefault } from "../utils/json-file.js";
export interface ExternalLoaderOptions {
  /** Extra search roots in addition to `~/.mcp-devices/plugins/`. */
  additionalRoots?: ReadonlyArray<string>;
  /** API versions the host understands. Plugins outside this set are skipped. */
  supportedApiVersions?: ReadonlyArray<string>;
  /** Logger; defaults to stderr-only console. */
  logger?: Logger;
}

export interface DiscoveredPlugin {
  factory: () => SourcePlugin;
  /** Directory the plugin was loaded from — useful for diagnostics. */
  source: string;
}

const DEFAULT_API_VERSIONS = ["1"] as const;
const MAX_PLUGIN_ROOTS = 32;
const MAX_PLUGINS_PER_ROOT = 1000;
const MAX_TOTAL_PLUGINS = 256;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

const defaultRoot = (): string => join(homedir(), ".mcp-devices", "plugins");

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const packageNameSchema = z.string().max(512).regex(/^[^\u0000-\u001f\u007f]*$/);
const packageEntrySchema = z.string().min(1).max(1024).regex(/^[^\u0000-\u001f\u007f]+$/);
const externalPackageJsonSchema = z.object({
  name: packageNameSchema.optional(),
  main: packageEntrySchema.optional(),
  module: packageEntrySchema.optional(),
  type: z.enum(["module", "commonjs"]).optional(),
}).passthrough();
type PackageJson = z.infer<typeof externalPackageJsonSchema>;

async function readPkg(dir: string): Promise<PackageJson | null> {
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
function resolveEntry(dir: string, pkg: PackageJson): string | null {
  const entry = pkg.module ?? pkg.main ?? "index.js";
  const resolvedDir = resolve(dir);
  const resolvedEntry = resolve(dir, entry);
  if (resolvedEntry !== resolvedDir && !resolvedEntry.startsWith(resolvedDir + sep)) {
    return null;
  }
  return resolvedEntry;
}

async function loadFactory(entry: string): Promise<(() => SourcePlugin) | null> {
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
    this.roots = [defaultRoot(), ...additionalRoots];
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
        const pkg = await readPkg(dir);
        if (!pkg) {
          this.logger.warn?.("missing or invalid package.json");
          continue;
        }
        const entry = resolveEntry(dir, pkg);
        if (!entry) {
          this.logger.warn?.("entry escapes plugin directory — plugin skipped");
          continue;
        }
        try {
          const entryDetails = await lstat(entry);
          if (!entryDetails.isFile() || entryDetails.isSymbolicLink()) {
            this.logger.warn?.("entry file not found");
            continue;
          }
        } catch {
          this.logger.warn?.("entry file not found");
          continue;
        }
        let factory: (() => SourcePlugin) | null;
        try {
          factory = await loadFactory(entry);
        } catch (error: unknown) {
          this.logger.error?.("plugin import failed", {
            error: sanitizeErrorMessage(
              error instanceof Error ? error.message : String(error),
            ).slice(0, 1000),
          });
          continue;
        }
        if (!factory) {
          this.logger.warn?.("no default/createPlugin export");
          continue;
        }

        let plugin: SourcePlugin | undefined;
        try {
          plugin = factory();
          if (typeof plugin !== "object" || plugin === null) {
            throw new Error("plugin factory returned an invalid value");
          }
          const manifest = Reflect.get(plugin, "manifest");
          if (typeof manifest !== "object" || manifest === null) {
            throw new Error("plugin manifest is invalid");
          }
          const api = Reflect.get(manifest, "apiVersion");
          if (typeof api !== "string" || !this.apiVersions.has(api)) {
            this.logger.warn?.("apiVersion mismatch — plugin skipped");
            continue;
          }
        } catch (error: unknown) {
          this.logger.error?.("plugin factory threw", {
            error: sanitizeErrorMessage(
              error instanceof Error ? error.message : String(error),
            ).slice(0, 1000),
          });
          continue;
        }

        const discoveredPlugin = plugin;
        found.push({ factory: () => discoveredPlugin, source: dirname(entry) });
      }
    }
    return found;
  }
}
