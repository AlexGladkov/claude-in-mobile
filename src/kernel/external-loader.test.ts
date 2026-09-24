import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ExternalPluginLoader,
} from "./external-loader.js";
import {
  hashPluginDirectory,
  writePluginLockfile,
} from "./plugin-lock.js";

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
): Promise<string> {
  const directory = join(root, "demo");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "demo-plugin",
      version: "1.0.0",
      type: "module",
      main: "index.js",
    }),
  );
  await writeFile(
    join(directory, "index.js"),
    `export function createPlugin() {
      return {
        manifest: {
          id: "demo",
          name: "Demo",
          version: "1.0.0",
          apiVersion: "1",
          capabilities: ["screen"],
          permissions: ${JSON.stringify(permissions)},
        },
        init() {},
      };
    }`,
  );
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

  it("does not load declared permissions without an explicit grant", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-permission-"));
    tempRoots.push(root);
    const directory = await createPlugin(root, ["network"]);
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
    expect(
      (await new ExternalPluginLoader({
        ...baseOptions,
        permissionGrants: { demo: ["network"] },
      }).discover()).map((plugin) => plugin.manifest.id),
    ).toEqual(["demo"]);
  });
});
