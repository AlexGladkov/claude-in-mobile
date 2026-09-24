import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExternalPluginManager } from "./external-plugin-manager.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ExternalPluginManager", () => {
  it("installs, verifies, grants, revokes, and removes a local package", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-manager-"));
    tempRoots.push(root);
    const packageRoot = join(root, "package");
    const pluginRoot = join(root, "plugins");
    const lockPath = join(root, "plugins.lock");
    const permissionPath = join(root, "plugin-permissions.json");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "demo-managed-plugin",
        version: "1.0.0",
        type: "module",
        main: "index.js",
      }),
    );
    await writeFile(
      join(packageRoot, "index.js"),
      `export function createPlugin() {
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

    expect(await manager.grant("demo-managed", ["network"])).toEqual(["network"]);
    expect((await manager.list())[0]?.grantedPermissions).toEqual(["network"]);
    expect(await manager.revoke("demo-managed", ["network"])).toEqual([]);

    const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
      plugins: Record<string, unknown>;
    };
    expect(lock.plugins["demo-managed"]).toBeDefined();

    await manager.remove("demo-managed");
    expect(await manager.list()).toEqual([]);
    expect(await manager.verify()).toEqual([]);
  });
});
