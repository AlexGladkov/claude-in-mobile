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
 * Search roots default to `~/.claude-in-mobile/plugins/`. Callers can pass
 * additional directories via `additionalRoots` for tests or vendoring.
 *
 * The loader is intentionally side-effect-free at construction; call `discover`
 * to walk the filesystem and return loadable plugin factories.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type { Logger, SourcePlugin } from "@claude-in-mobile/plugin-api";

export interface ExternalLoaderOptions {
  /** Extra search roots in addition to `~/.claude-in-mobile/plugins/`. */
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

const defaultRoot = (): string => join(homedir(), ".claude-in-mobile", "plugins");

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

interface PackageJson {
  name?: string;
  main?: string;
  module?: string;
  type?: "module" | "commonjs";
}

async function readPkg(dir: string): Promise<PackageJson | null> {
  const pkgPath = join(dir, "package.json");
  if (!(await exists(pkgPath))) return null;
  try {
    return JSON.parse(await readFile(pkgPath, "utf8")) as PackageJson;
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
    this.roots = [defaultRoot(), ...(opts.additionalRoots ?? [])];
    this.apiVersions = new Set(opts.supportedApiVersions ?? DEFAULT_API_VERSIONS);
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
      if (!(await exists(root))) continue;
      const entries = await readdir(root, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const dir = join(root, e.name);
        const pkg = await readPkg(dir);
        if (!pkg) {
          this.logger.warn?.("missing package.json", { dir });
          continue;
        }
        const entry = resolveEntry(dir, pkg);
        if (!entry) {
          this.logger.warn?.("entry escapes plugin directory — plugin skipped", {
            dir,
            entry: pkg.module ?? pkg.main,
          });
          continue;
        }
        if (!(await exists(entry))) {
          this.logger.warn?.("entry file not found", { entry });
          continue;
        }
        let factory: (() => SourcePlugin) | null;
        try {
          factory = await loadFactory(entry);
        } catch (err) {
          this.logger.error?.("plugin import failed", {
            dir,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        if (!factory) {
          this.logger.warn?.("no default/createPlugin export", { entry });
          continue;
        }

        // Probe manifest once to gate by apiVersion before registration.
        let probe: SourcePlugin;
        try {
          probe = factory();
        } catch (err) {
          this.logger.error?.("plugin factory threw", {
            dir,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        const api = probe.manifest.apiVersion;
        if (!this.apiVersions.has(api)) {
          this.logger.warn?.("apiVersion mismatch — plugin skipped", {
            id: probe.manifest.id,
            api,
            supported: Array.from(this.apiVersions),
          });
          continue;
        }

        found.push({ factory, source: dirname(entry) });
      }
    }
    return found;
  }
}
