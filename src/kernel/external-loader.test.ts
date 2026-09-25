import { mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ExternalPluginLoader,
} from "./external-loader.js";
import {
  MAX_PLUGIN_BYTES,
  hashPluginDirectory,
  snapshotPluginDirectory,
  withPluginStateLock,
  writePluginLockfile,
} from "./plugin-lock.js";
import { writePluginPermissionPolicy } from "./plugin-policy.js";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createPlugin(
  root: string,
  permissions: readonly string[] = [],
  marker?: string,
  disposeMarker?: string,
  moduleSource?: string,
): Promise<string> {
  const directory = join(root, "demo");
  await mkdir(directory, { recursive: true });
  const imports = marker || disposeMarker
    ? `import { writeFileSync } from "node:fs";`
    : "";
  const sideEffect = marker
    ? `writeFileSync(${JSON.stringify(marker)}, "loaded");`
    : "";
  const source = moduleSource ?? `${imports}
${sideEffect}
export function createPlugin() {
      return {
        manifest: {
          id: "demo",
          name: "Demo",
          version: "1.0.0",
          apiVersion: "1",
          capabilities: ["screen"],
          permissions: ${JSON.stringify(permissions)},
        },
        init() {}${disposeMarker
          ? `,
        dispose() { writeFileSync(${JSON.stringify(disposeMarker)}, "disposed"); }`
          : ""}
      };
    }`;
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "demo-plugin",
      version: "1.0.0",
      type: "module",
      main: "index.js",
      mcpDevicesPlugin: {
        id: "demo",
        name: "Demo",
        version: "1.0.0",
        apiVersion: "1",
        capabilities: ["screen"],
        permissions,
      },
    }),
  );
  await writeFile(join(directory, "index.js"), source);
  return directory;
}

describe("ExternalPluginLoader", () => {
  it("loads a managed plugin only when its lock digest matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-loader-"));
    tempRoots.push(root);
    const directory = await createPlugin(root);
    const lockPath = join(root, "plugins.lock");
    const integrity = await hashPluginDirectory(directory);
    await writePluginLockfile({
      version: 1,
      plugins: {
        demo: {
          id: "demo",
          packageName: "demo-plugin",
          packageVersion: "1.0.0",
          pluginVersion: "1.0.0",
          apiVersion: "1",
          entry: "index.js",
          integrity,
          permissions: [],
          source: "demo-plugin",
          installedAt: new Date().toISOString(),
        },
      },
    }, lockPath);

    const loader = new ExternalPluginLoader({
      additionalRoots: [root],
      lockPath,
      logger,
    });
    expect((await loader.discover()).map((plugin) => plugin.manifest.id)).toEqual(["demo"]);

    await writeFile(join(directory, "index.js"), "export function createPlugin() { return null; }");
    expect(await loader.discover()).toEqual([]);
  });
  it("imports only the verified snapshot when a dependency changes during evaluation", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-loader-toctou-"));
    tempRoots.push(root);
    const readyMarker = join(root, "import-started");
    const safeMarker = join(root, "safe-dependency-loaded");
    const maliciousMarker = join(root, "malicious-dependency-loaded");
    const directory = await createPlugin(
      root,
      [],
      undefined,
      undefined,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(readyMarker)}, "ready");
await new Promise((resolve) => setTimeout(resolve, 100));
await import("./dependency.js");
export function createPlugin() {
  return {
    manifest: {
      id: "demo",
      name: "Demo",
      version: "1.0.0",
      apiVersion: "1",
      capabilities: ["screen"],
    },
    init() {},
  };
}`,
    );
    const dependencyPath = join(directory, "dependency.js");
    await writeFile(
      dependencyPath,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(safeMarker)}, "loaded");
export const dependency = "safe";`,
    );
    const lockPath = join(root, "plugins.lock");
    const integrity = await hashPluginDirectory(directory);
    await writePluginLockfile({
      version: 1,
      plugins: {
        demo: {
          id: "demo",
          packageName: "demo-plugin",
          packageVersion: "1.0.0",
          pluginVersion: "1.0.0",
          apiVersion: "1",
          entry: "index.js",
          integrity,
          permissions: [],
          source: "demo-plugin",
          installedAt: new Date().toISOString(),
        },
      },
    }, lockPath);

    const discovery = new ExternalPluginLoader({
      additionalRoots: [root],
      lockPath,
      logger,
    }).discover();
    let importStarted = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if (await readFile(readyMarker, "utf8") === "ready") {
          importStarted = true;
          break;
        }
      } catch {
        // The marker is written by the module after integrity verification.
      }
      // The real delay creates a marker-driven filesystem race; fake timers cannot
      // interleave an external mutation with the module's dynamic import.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(importStarted).toBe(true);
    await writeFile(
      dependencyPath,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(maliciousMarker)}, "loaded");
export const dependency = "malicious";`,
    );

    await expect(discovery).resolves.toHaveLength(1);
    await expect(readFile(safeMarker, "utf8")).resolves.toBe("loaded");
    await expect(readFile(maliciousMarker, "utf8")).rejects.toThrow();
  });
  it("reuses one verified snapshot across repeated discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-loader-cache-"));
    tempRoots.push(root);
    const directory = await createPlugin(root);
    const lockPath = join(root, "plugins.lock");
    const integrity = await hashPluginDirectory(directory);
    await writePluginLockfile({
      version: 1,
      plugins: {
        demo: {
          id: "demo",
          packageName: "demo-plugin",
          packageVersion: "1.0.0",
          pluginVersion: "1.0.0",
          apiVersion: "1",
          entry: "index.js",
          integrity,
          permissions: [],
          source: "demo-plugin",
          installedAt: new Date().toISOString(),
        },
      },
    }, lockPath);

    const loader = new ExternalPluginLoader({
      additionalRoots: [root],
      lockPath,
      logger,
    });
    await expect(loader.discover()).resolves.toHaveLength(1);
    const snapshotRoot = join(root, `.mcp-devices-plugin-snapshots-${process.pid}`);
    const firstSnapshots = await readdir(snapshotRoot);
    expect(firstSnapshots).toHaveLength(1);

    await expect(loader.discover()).resolves.toHaveLength(1);
    await expect(readdir(snapshotRoot)).resolves.toEqual(firstSnapshots);
  });
  it("coalesces identical in-flight snapshots across loaders", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-loader-parallel-"));
    tempRoots.push(root);
    const readyMarker = join(root, "parallel-import-started");
    const directory = await createPlugin(
      root,
      [],
      undefined,
      undefined,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(readyMarker)}, "ready");
await new Promise((resolve) => setTimeout(resolve, 100));
export function createPlugin() {
  return {
    manifest: {
      id: "demo",
      name: "Demo",
      version: "1.0.0",
      apiVersion: "1",
      capabilities: ["screen"],
    },
    init() {},
  };
}`,
    );
    const lock = {
      version: 1 as const,
      plugins: {
        demo: {
          id: "demo",
          packageName: "demo-plugin",
          packageVersion: "1.0.0",
          pluginVersion: "1.0.0",
          apiVersion: "1",
          entry: "index.js",
          integrity: await hashPluginDirectory(directory),
          permissions: [],
          source: "demo-plugin",
          installedAt: new Date().toISOString(),
        },
      },
    };
    const lockPathA = join(root, "plugins-a.lock");
    const lockPathB = join(root, "plugins-b.lock");
    await Promise.all([
      writePluginLockfile(lock, lockPathA),
      writePluginLockfile(lock, lockPathB),
    ]);

    const firstDiscovery = new ExternalPluginLoader({
      additionalRoots: [root],
      lockPath: lockPathA,
      logger,
    }).discover();
    let importStarted = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if (await readFile(readyMarker, "utf8") === "ready") {
          importStarted = true;
          break;
        }
      } catch {
        // The marker is written after the shared snapshot has been acquired.
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(importStarted).toBe(true);

    const secondDiscovery = new ExternalPluginLoader({
      additionalRoots: [root],
      lockPath: lockPathB,
      logger,
    }).discover();
    await expect(Promise.all([firstDiscovery, secondDiscovery])).resolves.toHaveLength(2);

    const snapshotRoot = join(root, `.mcp-devices-plugin-snapshots-${process.pid}`);
    await expect(readdir(snapshotRoot)).resolves.toHaveLength(1);
  });
  it("rejects a distinct in-flight snapshot when the entry budget is full", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "mcp-loader-budget-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "mcp-loader-budget-b-"));
    tempRoots.push(rootA, rootB);
    const readyMarker = join(rootA, "budget-import-started");
    const directoryA = await createPlugin(
      rootA,
      [],
      undefined,
      undefined,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(readyMarker)}, "ready");
await new Promise((resolve) => setTimeout(resolve, 100));
export function createPlugin() {
  return {
    manifest: {
      id: "demo",
      name: "Demo",
      version: "1.0.0",
      apiVersion: "1",
      capabilities: ["screen"],
    },
    init() {},
  };
}`,
    );
    const directoryB = await createPlugin(rootB);
    const lockPathA = join(rootA, "plugins.lock");
    const lockPathB = join(rootB, "plugins.lock");
    await Promise.all([
      writePluginLockfile({
        version: 1,
        plugins: {
          demo: {
            id: "demo",
            packageName: "demo-plugin",
            packageVersion: "1.0.0",
            pluginVersion: "1.0.0",
            apiVersion: "1",
            entry: "index.js",
            integrity: await hashPluginDirectory(directoryA),
            permissions: [],
            source: "demo-plugin",
            installedAt: new Date().toISOString(),
          },
        },
      }, lockPathA),
      writePluginLockfile({
        version: 1,
        plugins: {
          demo: {
            id: "demo",
            packageName: "demo-plugin",
            packageVersion: "1.0.0",
            pluginVersion: "1.0.0",
            apiVersion: "1",
            entry: "index.js",
            integrity: await hashPluginDirectory(directoryB),
            permissions: [],
            source: "demo-plugin",
            installedAt: new Date().toISOString(),
          },
        },
      }, lockPathB),
    ]);

    const firstDiscovery = new ExternalPluginLoader({
      additionalRoots: [rootA],
      lockPath: lockPathA,
      snapshotCacheMaxEntries: 1,
      logger,
    }).discover();
    let importStarted = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if (await readFile(readyMarker, "utf8") === "ready") {
          importStarted = true;
          break;
        }
      } catch {
        // The marker is written after the first pending reservation is admitted.
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(importStarted).toBe(true);

    const secondDiscovery = new ExternalPluginLoader({
      additionalRoots: [rootB],
      lockPath: lockPathB,
      snapshotCacheMaxEntries: 1,
      logger,
    }).discover();
    await expect(secondDiscovery).resolves.toEqual([]);
    await expect(firstDiscovery).resolves.toHaveLength(1);

    const snapshotRootA = join(rootA, `.mcp-devices-plugin-snapshots-${process.pid}`);
    const snapshotRootB = join(rootB, `.mcp-devices-plugin-snapshots-${process.pid}`);
    await expect(readdir(snapshotRootA)).resolves.toHaveLength(1);
    await expect(readdir(snapshotRootB)).rejects.toThrow();
  });
  it("releases empty snapshot reservations before admitting a valid plugin", async () => {
    const lockRoot = await mkdtemp(join(tmpdir(), "mcp-loader-empty-lock-"));
    const emptyRoot = await mkdtemp(join(tmpdir(), "mcp-loader-empty-root-"));
    const validRoot = await mkdtemp(join(tmpdir(), "mcp-loader-valid-root-"));
    tempRoots.push(lockRoot, emptyRoot, validRoot);
    const emptyDirectory = join(emptyRoot, "empty");
    await mkdir(emptyDirectory);
    const validDirectory = await createPlugin(validRoot);
    const lockPath = join(lockRoot, "plugins.lock");
    await writePluginLockfile({
      version: 1,
      plugins: {
        empty: {
          id: "empty",
          packageName: "empty-plugin",
          packageVersion: "1.0.0",
          pluginVersion: "1.0.0",
          apiVersion: "1",
          entry: "index.js",
          integrity: await hashPluginDirectory(emptyDirectory),
          permissions: [],
          source: "empty-plugin",
          installedAt: new Date().toISOString(),
        },
        demo: {
          id: "demo",
          packageName: "demo-plugin",
          packageVersion: "1.0.0",
          pluginVersion: "1.0.0",
          apiVersion: "1",
          entry: "index.js",
          integrity: await hashPluginDirectory(validDirectory),
          permissions: [],
          source: "demo-plugin",
          installedAt: new Date().toISOString(),
        },
      },
    }, lockPath);

    const discovered = await new ExternalPluginLoader({
      additionalRoots: [emptyRoot, validRoot],
      lockPath,
      snapshotCacheMaxEntries: 1,
      logger,
    }).discover();

    expect(discovered.map((plugin) => plugin.manifest.id)).toEqual(["demo"]);
    await expect(
      readdir(join(lockRoot, `.mcp-devices-plugin-snapshots-${process.pid}`)),
    ).resolves.toHaveLength(1);
  });
  it("fails closed before exceeding a small snapshot byte budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-loader-budget-"));
    tempRoots.push(root);
    const directory = await createPlugin(root);
    const lockPath = join(root, "plugins.lock");
    const integrity = await hashPluginDirectory(directory);
    await writePluginLockfile({
      version: 1,
      plugins: {
        demo: {
          id: "demo",
          packageName: "demo-plugin",
          packageVersion: "1.0.0",
          pluginVersion: "1.0.0",
          apiVersion: "1",
          entry: "index.js",
          integrity,
          permissions: [],
          source: "demo-plugin",
          installedAt: new Date().toISOString(),
        },
      },
    }, lockPath);

    const loader = new ExternalPluginLoader({
      additionalRoots: [root],
      lockPath,
      snapshotCacheMaxBytes: 1,
      logger,
    });
    await expect(loader.discover()).resolves.toEqual([]);
    const snapshotRoot = join(root, `.mcp-devices-plugin-snapshots-${process.pid}`);
    await expect(snapshotPluginDirectory(directory, snapshotRoot, 1)).rejects.toThrow(
      /snapshot limit/u,
    );
    await expect(readdir(snapshotRoot)).resolves.toEqual([]);
  });
  it("disposes the validation probe before returning a discovered factory", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-loader-probe-dispose-"));
    tempRoots.push(root);
    const marker = join(root, "probe-disposed");
    const directory = await createPlugin(root, [], undefined, marker);
    const lockPath = join(root, "plugins.lock");
    const integrity = await hashPluginDirectory(directory);
    await writePluginLockfile({
      version: 1,
      plugins: {
        demo: {
          id: "demo",
          packageName: "demo-plugin",
          packageVersion: "1.0.0",
          pluginVersion: "1.0.0",
          apiVersion: "1",
          entry: "index.js",
          integrity,
          permissions: [],
          source: "demo-plugin",
          installedAt: new Date().toISOString(),
        },
      },
    }, lockPath);

    const discovered = await new ExternalPluginLoader({
      additionalRoots: [root],
      lockPath,
      logger,
    }).discover();

    expect(discovered).toHaveLength(1);
    await expect(readFile(marker, "utf8")).resolves.toBe("disposed");
  });

  it("disposes a partially invalid factory product", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-loader-invalid-dispose-"));
    tempRoots.push(root);
    const marker = join(root, "invalid-disposed");
    const directory = await createPlugin(
      root,
      [],
      undefined,
      undefined,
      `import { writeFileSync } from "node:fs";
export function createPlugin() {
  return {
    manifest: {
      id: "demo",
      name: "Demo",
      version: "1.0.0",
      apiVersion: "1",
      capabilities: ["screen"],
    },
    dispose() { writeFileSync(${JSON.stringify(marker)}, "disposed"); },
  };
}`,
    );
    const lockPath = join(root, "plugins.lock");
    const integrity = await hashPluginDirectory(directory);
    await writePluginLockfile({
      version: 1,
      plugins: {
        demo: {
          id: "demo",
          packageName: "demo-plugin",
          packageVersion: "1.0.0",
          pluginVersion: "1.0.0",
          apiVersion: "1",
          entry: "index.js",
          integrity,
          permissions: [],
          source: "demo-plugin",
          installedAt: new Date().toISOString(),
        },
      },
    }, lockPath);

    await expect(new ExternalPluginLoader({
      additionalRoots: [root],
      lockPath,
      logger,
    }).discover()).resolves.toEqual([]);
    await expect(readFile(marker, "utf8")).resolves.toBe("disposed");
  });

  it("rejects A/B/A factory reuse rather than only consecutive reuse", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-loader-reuse-"));
    tempRoots.push(root);
    const directory = await createPlugin(
      root,
      [],
      undefined,
      undefined,
      `const manifest = {
  id: "demo",
  name: "Demo",
  version: "1.0.0",
  apiVersion: "1",
  capabilities: ["screen"],
};
const first = { manifest, init() {} };
const second = { manifest, init() {} };
let call = 0;
export function createPlugin() {
  return [first, second, first][call++] ?? first;
}`,
    );
    const lockPath = join(root, "plugins.lock");
    const integrity = await hashPluginDirectory(directory);
    await writePluginLockfile({
      version: 1,
      plugins: {
        demo: {
          id: "demo",
          packageName: "demo-plugin",
          packageVersion: "1.0.0",
          pluginVersion: "1.0.0",
          apiVersion: "1",
          entry: "index.js",
          integrity,
          permissions: [],
          source: "demo-plugin",
          installedAt: new Date().toISOString(),
        },
      },
    }, lockPath);

    const discovered = await new ExternalPluginLoader({
      additionalRoots: [root],
      lockPath,
      logger,
    }).discover();
    expect(discovered).toHaveLength(1);
    const plugin = discovered[0]!;
    expect(plugin.factory().manifest.id).toBe("demo");
    expect(() => plugin.factory()).toThrow("previously used instance");
  });

  it("waits for a lifecycle commit before reading lock and plugin directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-loader-snapshot-"));
    tempRoots.push(root);
    const directory = await createPlugin(root);
    const lockPath = join(root, "plugins.lock");
    const integrity = await hashPluginDirectory(directory);
    await writePluginLockfile({
      version: 1,
      plugins: {
        demo: {
          id: "demo",
          packageName: "demo-plugin",
          packageVersion: "1.0.0",
          pluginVersion: "1.0.0",
          apiVersion: "1",
          entry: "index.js",
          integrity,
          permissions: [],
          source: "demo-plugin",
          installedAt: new Date().toISOString(),
        },
      },
    }, lockPath);

    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired!: () => void;
    const acquiredPromise = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const held = withPluginStateLock(lockPath, async () => {
      acquired();
      await releasePromise;
    });
    await acquiredPromise;

    const loader = new ExternalPluginLoader({
      additionalRoots: [root],
      lockPath,
      logger,
    });
    let settled = false;
    const discovery = loader.discover().then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await held;
    await expect(discovery).resolves.toHaveLength(1);
  });

  it("does not load declared permissions without an explicit grant", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-permission-"));
    tempRoots.push(root);
    const marker = join(root, "plugin-imported");
    const directory = await createPlugin(root, ["network"], marker);
    const lockPath = join(root, "plugins.lock");
    const integrity = await hashPluginDirectory(directory);
    await writePluginLockfile({
      version: 1,
      plugins: {
        demo: {
          id: "demo",
          packageName: "demo-plugin",
          packageVersion: "1.0.0",
          pluginVersion: "1.0.0",
          apiVersion: "1",
          entry: "index.js",
          integrity,
          permissions: ["network"],
          source: "demo-plugin",
          installedAt: new Date().toISOString(),
        },
      },
    }, lockPath);

    const baseOptions = {
      additionalRoots: [root],
      lockPath,
      requireLockfile: true,
      logger,
    } as const;
    expect(await new ExternalPluginLoader(baseOptions).discover()).toEqual([]);
    await expect(readFile(marker)).rejects.toThrow();
    const discovered = await new ExternalPluginLoader({
      ...baseOptions,
      permissionGrants: { demo: ["network"] },
    }).discover();
    expect(discovered.map((plugin) => plugin.manifest.id)).toEqual(["demo"]);
    const first = discovered[0]!.factory();
    const second = discovered[0]!.factory();
    expect(first).not.toBe(second);
  });
  it("rejects permission grants bound to a replaced integrity", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-stale-grant-"));
    tempRoots.push(root);
    const marker = join(root, "plugin-imported");
    const directory = await createPlugin(root, ["network"], marker);
    const lockPath = join(root, "plugins.lock");
    const permissionPath = join(root, "plugin-permissions.json");
    const integrity = await hashPluginDirectory(directory);
    await writePluginLockfile({
      version: 1,
      plugins: {
        demo: {
          id: "demo",
          packageName: "demo-plugin",
          packageVersion: "1.0.0",
          pluginVersion: "1.0.0",
          apiVersion: "1",
          entry: "index.js",
          integrity,
          permissions: ["network"],
          source: "demo-plugin",
          installedAt: new Date().toISOString(),
        },
      },
    }, lockPath);
    await writePluginPermissionPolicy({
      version: 1,
      grants: {
        demo: {
          packageName: "demo-plugin",
          packageVersion: "1.0.0",
          pluginVersion: "1.0.0",
          apiVersion: "1",
          integrity: `sha256-${"0".repeat(64)}` as `sha256-${string}`,
          permissions: ["network"],
        },
      },
    }, permissionPath);
    expect(await new ExternalPluginLoader({
      additionalRoots: [root],
      lockPath,
      permissionPath,
      logger,
    }).discover()).toEqual([]);
    await expect(readFile(marker)).rejects.toThrow();
  });
  it("supports CommonJS createPlugin exports", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-cjs-"));
    tempRoots.push(root);
    const directory = join(root, "cjs");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: "cjs-plugin",
        version: "1.0.0",
        type: "commonjs",
        main: "index.js",
        mcpDevicesPlugin: {
          id: "cjs",
          name: "CJS",
          version: "1.0.0",
          apiVersion: "1",
          capabilities: ["screen"],
        },
      }),
    );
    await writeFile(
      join(directory, "index.js"),
      `exports.createPlugin = () => ({
        manifest: {
          id: "cjs",
          name: "CJS",
          version: "1.0.0",
          apiVersion: "1",
          capabilities: ["screen"],
        },
        init() {},
      });`,
    );
    const lockPath = join(root, "plugins.lock");
    const integrity = await hashPluginDirectory(directory);
    await writePluginLockfile({
      version: 1,
      plugins: {
        cjs: {
          id: "cjs",
          packageName: "cjs-plugin",
          packageVersion: "1.0.0",
          pluginVersion: "1.0.0",
          apiVersion: "1",
          entry: "index.js",
          integrity,
          permissions: [],
          source: "cjs-plugin",
          installedAt: new Date().toISOString(),
        },
      },
    }, lockPath);
    const discovered = await new ExternalPluginLoader({
      additionalRoots: [root],
      lockPath,
      requireLockfile: true,
      permissionGrants: {},
      logger,
    }).discover();
    expect(discovered.map((plugin) => plugin.manifest.id)).toEqual(["cjs"]);
  });
  it("rejects an oversized file before reading it", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-quota-"));
    await writeFile(join(root, "oversized.bin"), "");
    await truncate(join(root, "oversized.bin"), MAX_PLUGIN_BYTES + 1);
    await expect(hashPluginDirectory(root)).rejects.toThrow(/byte limit/u);
  });
});
