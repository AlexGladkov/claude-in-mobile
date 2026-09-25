import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type * as JsonFileModule from "../utils/json-file.js";
import {
  MAX_PLUGIN_BYTES,
  withPluginStateLock,
  type PluginLockEntry,
} from "../kernel/plugin-lock.js";
import { ExternalPluginManager } from "./external-plugin-manager.js";

const postRenameFailures = vi.hoisted(() => new Set<string>());

vi.mock("../utils/json-file.js", async () => {
  const actual = await vi.importActual<JsonFileModule>(
    "../utils/json-file.js",
  );
  return {
    ...actual,
    writeJsonAtomic: async (path: string, value: unknown, mode?: number): Promise<void> => {
      await actual.writeJsonAtomic(path, value, mode);
      if (postRenameFailures.delete(path)) {
        throw new Error("simulated post-rename persistence failure");
      }
    },
  };
});

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  postRenameFailures.clear();
});

async function writeManagedPackage(
  directory: string,
  packageName: string,
  id: string,
  version: string,
  permissions: readonly string[] = [],
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const manifest = {
    id,
    name: `${id} plugin`,
    version,
    apiVersion: "1",
    capabilities: ["screen"],
    permissions,
  };
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: packageName,
      version,
      type: "module",
      main: "index.js",
      mcpDevicesPlugin: manifest,
    }),
  );
  await writeFile(
    join(directory, "index.js"),
    `export function createPlugin() {
      return { manifest: ${JSON.stringify(manifest)}, init() {} };
    }`,
  );
}

async function writeDependencyInstallLimitFixture(
  root: string,
  target: "cache" | "staging",
): Promise<{ npmCommand: string; tarCommand: string }> {
  const npmCommand = join(root, `fake-npm-${target}.mjs`);
  const tarCommand = join(root, `fake-tar-${target}.mjs`);
  const manifest = {
    id: "bounded",
    name: "Bounded plugin",
    version: "1.0.0",
    apiVersion: "1",
    capabilities: ["screen"],
    permissions: [],
  };
  const packageJson = {
    name: "bounded-plugin",
    version: "1.0.0",
    type: "module",
    main: "index.js",
    dependencies: { "bounded-dependency": "1.0.0" },
    mcpDevicesPlugin: manifest,
  };
  const entrySource = `export function createPlugin() {
  return { manifest: ${JSON.stringify(manifest)}, init() {} };
}`;
  await writeFile(
    npmCommand,
    `#!/usr/bin/env node
import { truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args.includes("pack")) {
  const destination = args[args.indexOf("--pack-destination") + 1];
  writeFileSync(join(destination, "fake.tgz"), "archive");
  process.stdout.write('[{"filename":"fake.tgz"}]');
} else if (args.includes("install")) {
  const footprintRoot = ${JSON.stringify(target)} === "cache"
    ? process.env.npm_config_cache
    : process.cwd();
  if (typeof footprintRoot !== "string") throw new Error("missing private npm cache");
  const oversized = join(footprintRoot, "oversized.bin");
  writeFileSync(oversized, "");
  truncateSync(oversized, ${MAX_PLUGIN_BYTES + 1});
}
`,
  );
  await writeFile(
    tarCommand,
    `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args.includes("-tvzf")) {
  process.stdout.write("-rw-r--r-- root/root 200 2026-01-01 00:00 package/package.json\\n"
    + "-rw-r--r-- root/root 200 2026-01-01 00:00 package/index.js\\n");
} else if (args.includes("-xzf")) {
  const packageDir = join(process.cwd(), "package");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), ${JSON.stringify(JSON.stringify(packageJson))});
  writeFileSync(join(packageDir, "index.js"), ${JSON.stringify(entrySource)});
}
`,
  );
  await chmod(npmCommand, 0o755);
  await chmod(tarCommand, 0o755);
  return { npmCommand, tarCommand };
}

describe("ExternalPluginManager", () => {
  it("installs, verifies, grants, revokes, and removes a local package", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-manager-"));
    tempRoots.push(root);
    const packageRoot = join(root, "package");
    const pluginRoot = join(root, "plugins");
    const lockPath = join(root, "plugins.lock");
    const permissionPath = join(root, "plugin-permissions.json");
    const marker = join(root, "plugin-executed");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "demo-managed-plugin",
        version: "1.0.0",
        type: "module",
        main: "index.js",
        mcpDevicesPlugin: {
          id: "demo-managed",
          name: "Demo managed",
          version: "1.0.0",
          apiVersion: "1",
          capabilities: ["screen"],
          permissions: ["network"],
        },
      }),
    );
    await writeFile(
      join(packageRoot, "index.js"),
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "executed");
export function createPlugin() {
  writeFileSync(${JSON.stringify(marker)}, "factory");
  return {
    manifest: {
      id: "demo-managed",
      name: "Demo managed",
      version: "1.0.0",
      apiVersion: "1",
      capabilities: ["screen"],
      permissions: ["network"],
    },
    init() {},
  };
}`,
    );

    const manager = new ExternalPluginManager({
      pluginRoot,
      lockPath,
      permissionPath,
    });
    const installed = await manager.install(packageRoot);
    expect(installed.id).toBe("demo-managed");
    expect((await manager.verify()).map((result) => result.ok)).toEqual([true]);
    expect((await manager.list())[0]?.grantedPermissions).toEqual([]);
    expect((await manager.list())[0]).toMatchObject({
      packageVersion: "1.0.0",
      pluginVersion: "1.0.0",
      apiVersion: "1",
    });

    expect(await manager.grant("demo-managed", ["network"])).toEqual(["network"]);
    expect((await manager.list())[0]?.grantedPermissions).toEqual(["network"]);
    expect(await manager.revoke("demo-managed", ["network"])).toEqual([]);

    const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
      plugins: Record<string, unknown>;
    };
    expect(lock.plugins["demo-managed"]).toBeDefined();
    await expect(readFile(marker)).rejects.toThrow();

    await manager.remove("demo-managed");
    expect(await manager.list()).toEqual([]);
    expect(await manager.verify()).toEqual([]);
  });
  it("revokes grants when replacement changes package identity or integrity", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-manager-replace-"));
    tempRoots.push(root);
    const packageRoot = join(root, "package");
    const pluginRoot = join(root, "plugins");
    const lockPath = join(root, "plugins.lock");
    const permissionPath = join(root, "plugin-permissions.json");
    await writeManagedPackage(packageRoot, "replace-plugin", "replace", "1.0.0", ["network"]);
    const manager = new ExternalPluginManager({
      pluginRoot,
      lockPath,
      permissionPath,
    });
    await manager.install(packageRoot);
    await manager.grant("replace", ["network"]);
    expect((await manager.list())[0]?.grantedPermissions).toEqual(["network"]);

    await writeManagedPackage(packageRoot, "replace-plugin", "replace", "2.0.0", ["network"]);
    await manager.install(packageRoot, { replace: true });
    expect((await manager.list())[0]?.grantedPermissions).toEqual([]);
  });
  it("keeps replacement state coherent when policy persistence reports a post-rename failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-manager-policy-failure-"));
    tempRoots.push(root);
    const packageRoot = join(root, "package");
    const pluginRoot = join(root, "plugins");
    const lockPath = join(root, "plugins.lock");
    const permissionPath = join(root, "plugin-permissions.json");
    await writeManagedPackage(packageRoot, "replace-plugin", "replace", "1.0.0", ["network"]);
    const manager = new ExternalPluginManager({
      pluginRoot,
      lockPath,
      permissionPath,
    });
    await manager.install(packageRoot);
    await manager.grant("replace", ["network"]);

    await writeManagedPackage(packageRoot, "replace-plugin", "replace", "2.0.0", ["network"]);
    postRenameFailures.add(permissionPath);
    await expect(manager.install(packageRoot, { replace: true }))
      .rejects.toThrow("simulated post-rename persistence failure");

    expect((await manager.list())[0]).toMatchObject({
      packageVersion: "2.0.0",
      pluginVersion: "2.0.0",
      apiVersion: "1",
      grantedPermissions: [],
    });
    expect(await manager.verify()).toEqual([{
      id: "replace",
      ok: true,
      reason: undefined,
    }]);
    const installedPackage = JSON.parse(
      await readFile(join(pluginRoot, "replace", "package.json"), "utf8"),
    ) as { version: string };
    expect(installedPackage.version).toBe("2.0.0");
  });
  it("keeps removal state coherent when lock persistence reports a post-rename failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-manager-remove-failure-"));
    tempRoots.push(root);
    const packageRoot = join(root, "package");
    const pluginRoot = join(root, "plugins");
    const lockPath = join(root, "plugins.lock");
    const permissionPath = join(root, "plugin-permissions.json");
    await writeManagedPackage(packageRoot, "remove-plugin", "remove", "1.0.0", ["network"]);
    const manager = new ExternalPluginManager({
      pluginRoot,
      lockPath,
      permissionPath,
    });
    await manager.install(packageRoot);
    await manager.grant("remove", ["network"]);

    postRenameFailures.add(lockPath);
    await expect(manager.remove("remove"))
      .rejects.toThrow("simulated post-rename persistence failure");

    expect(await manager.list()).toEqual([]);
    expect(await manager.verify()).toEqual([]);
    await expect(readFile(join(pluginRoot, "remove", "package.json"))).rejects.toThrow();
    const policy = JSON.parse(await readFile(permissionPath, "utf8")) as {
      grants: Record<string, unknown>;
    };
    expect(Object.hasOwn(policy.grants, "remove")).toBe(false);
  });
  it("does not resurrect a plugin removed while update was preparing", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-manager-update-race-"));
    tempRoots.push(root);
    const packageRoot = join(root, "package");
    const pluginRoot = join(root, "plugins");
    const lockPath = join(root, "plugins.lock");
    const permissionPath = join(root, "plugin-permissions.json");
    await writeManagedPackage(packageRoot, "race-plugin", "race", "1.0.0");
    const manager = new ExternalPluginManager({
      pluginRoot,
      lockPath,
      permissionPath,
    });
    await manager.install(packageRoot);

    type InternalInstall = (
      rawSpec: string,
      options?: { replace?: boolean; expected?: PluginLockEntry },
    ) => Promise<PluginLockEntry>;
    const internals = manager as unknown as { installInternal: InternalInstall };
    const originalInstallInternal = internals.installInternal.bind(manager);
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    internals.installInternal = async (rawSpec, options) => {
      started();
      await releasePromise;
      return originalInstallInternal(rawSpec, options);
    };

    const updatePromise = manager.update();
    await startedPromise;
    try {
      await manager.remove("race");
    } finally {
      release();
      internals.installInternal = originalInstallInternal;
    }

    await expect(updatePromise).rejects.toThrow(/changed while update was preparing/u);
    expect(await manager.list()).toEqual([]);
    expect(await manager.verify()).toEqual([]);
    await expect(readFile(join(pluginRoot, "race", "package.json"))).rejects.toThrow();
  });

  it("serializes concurrent installs without losing distinct lock entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-manager-concurrent-"));
    tempRoots.push(root);
    const pluginRoot = join(root, "plugins");
    const lockPath = join(root, "plugins.lock");
    const permissionPath = join(root, "plugin-permissions.json");
    const packageA = join(root, "package-a");
    const packageB = join(root, "package-b");
    await writeManagedPackage(packageA, "plugin-a", "plugin-a", "1.0.0", ["network"]);
    await writeManagedPackage(packageB, "plugin-b", "plugin-b", "1.0.0", ["network"]);
    const managerA = new ExternalPluginManager({ pluginRoot, lockPath, permissionPath });
    const managerB = new ExternalPluginManager({ pluginRoot, lockPath, permissionPath });
    await Promise.all([managerA.install(packageA), managerB.install(packageB)]);
    expect((await managerA.list()).map((entry) => entry.id)).toEqual(["plugin-a", "plugin-b"]);
    await Promise.all([
      managerA.grant("plugin-a", ["network"]),
      managerB.grant("plugin-b", ["network"]),
    ]);
    expect((await managerA.list()).map((entry) => entry.grantedPermissions)).toEqual([
      ["network"],
      ["network"],
    ]);
  });
  it("serializes list and verify behind a complete plugin state transaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-manager-read-lock-"));
    tempRoots.push(root);
    const packageRoot = join(root, "package");
    const pluginRoot = join(root, "plugins");
    const lockPath = join(root, "plugins.lock");
    const permissionPath = join(root, "plugin-permissions.json");
    await writeManagedPackage(packageRoot, "read-lock-plugin", "read-lock", "1.0.0");
    const manager = new ExternalPluginManager({
      pluginRoot,
      lockPath,
      permissionPath,
    });
    await manager.install(packageRoot);

    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired!: () => void;
    const acquiredPromise = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const heldTransaction = withPluginStateLock(lockPath, async () => {
      acquired();
      await releasePromise;
    });
    await acquiredPromise;

    const listPromise = manager.list();
    const verifyPromise = manager.verify();
    try {
      expect(await Promise.race([
        listPromise.then(() => "settled" as const),
        Promise.resolve("pending" as const),
      ])).toBe("pending");
      expect(await Promise.race([
        verifyPromise.then(() => "settled" as const),
        Promise.resolve("pending" as const),
      ])).toBe("pending");
    } finally {
      release();
      await heldTransaction;
    }
    expect(await listPromise).toHaveLength(1);
    expect(await verifyPromise).toEqual([{
      id: "read-lock",
      ok: true,
      reason: undefined,
    }]);
  });
  it("supports reserved object-prototype plugin ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-manager-prototype-id-"));
    tempRoots.push(root);
    const packageRoot = join(root, "package");
    const pluginRoot = join(root, "plugins");
    const lockPath = join(root, "plugins.lock");
    const permissionPath = join(root, "plugin-permissions.json");
    await writeManagedPackage(packageRoot, "constructor-plugin", "constructor", "1.0.0");
    const manager = new ExternalPluginManager({ pluginRoot, lockPath, permissionPath });
    await manager.install(packageRoot);
    expect((await manager.list()).map((entry) => entry.id)).toEqual(["constructor"]);
    expect(await manager.verify()).toEqual([{
      id: "constructor",
      ok: true,
      reason: undefined,
    }]);
    await manager.remove("constructor");
    expect(await manager.list()).toEqual([]);
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as { plugins: Record<string, unknown> };
    expect(Object.hasOwn(lock.plugins, "constructor")).toBe(false);
  });
  it("rejects oversized archive members before extraction", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-manager-archive-"));
    tempRoots.push(root);
    const pluginRoot = join(root, "plugins");
    const lockPath = join(root, "plugins.lock");
    const permissionPath = join(root, "plugin-permissions.json");
    const marker = join(root, "extracted");
    const npmCommand = join(root, "fake-npm.mjs");
    const tarCommand = join(root, "fake-tar.mjs");
    await writeFile(
      npmCommand,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const destination = args[args.indexOf("--pack-destination") + 1];
writeFileSync(join(destination, "fake.tgz"), "archive");
process.stdout.write('[{"filename":"fake.tgz"}]');
`,
    );
    await writeFile(
      tarCommand,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("-tvzf")) {
  process.stdout.write("-rw-r--r-- root/root 268435457 2026-01-01 00:00 package/huge.js\\n");
} else if (args.includes("-xzf")) {
  writeFileSync(${JSON.stringify(marker)}, "extracted");
}
`,
    );
    await chmod(npmCommand, 0o755);
    await chmod(tarCommand, 0o755);
    const manager = new ExternalPluginManager({
      pluginRoot,
      lockPath,
      permissionPath,
      npmCommand,
      tarCommand,
    });
    await expect(manager.install("./ignored-package")).rejects.toThrow(/expanded limit/u);
    await expect(readFile(marker)).rejects.toThrow();
  });

  for (const target of ["cache", "staging"] as const) {
    it(`bounds npm ${target} footprint during dependency installation`, async () => {
      const root = await mkdtemp(join(tmpdir(), `mcp-manager-${target}-limit-`));
      tempRoots.push(root);
      const pluginRoot = join(root, "plugins");
      const lockPath = join(root, "plugins.lock");
      const permissionPath = join(root, "plugin-permissions.json");
      const { npmCommand, tarCommand } = await writeDependencyInstallLimitFixture(root, target);
      const manager = new ExternalPluginManager({
        pluginRoot,
        lockPath,
        permissionPath,
        npmCommand,
        tarCommand,
      });

      await expect(manager.install("./ignored-package")).rejects.toThrow(
        new RegExp(`npm dependency ${target}.*byte limit`, "u"),
      );
      const remaining = await readdir(root);
      expect(remaining.some((name) => name.startsWith(".mcp-devices-plugin-install-"))).toBe(false);
      expect(remaining.some((name) => name.startsWith(".mcp-devices-plugin-cache-"))).toBe(false);
    });
  }
});
