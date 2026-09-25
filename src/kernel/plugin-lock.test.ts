import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { withPluginStateLock } from "./plugin-lock.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("plugin state lock", () => {
  it("reclaims a lock whose recorded owner process has exited", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-plugin-lock-stale-"));
    tempRoots.push(root);
    const statePath = join(root, "plugins.lock");
    const lockPath = `${statePath}.lock`;
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const childPid = child.pid;
    if (childPid === undefined) throw new Error("child process did not expose a pid");
    const exited = once(child, "exit");
    child.kill();
    await exited;

    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({ pid: childPid }),
      { mode: 0o600 },
    );

    await expect(withPluginStateLock(statePath, async () => "recovered")).resolves.toBe("recovered");
  });
  it("reclaims a lock when the recorded process identity no longer matches", async () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    const root = await mkdtemp(join(tmpdir(), "mcp-plugin-lock-reused-pid-"));
    tempRoots.push(root);
    const statePath = join(root, "plugins.lock");
    const lockPath = `${statePath}.lock`;
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({ pid: process.pid, processStartToken: "not-the-current-process" }),
      { mode: 0o600 },
    );

    await expect(withPluginStateLock(statePath, async () => "recovered")).resolves.toBe("recovered");
  });
  it("waits for an earlier live reclaim marker before reclaiming", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-plugin-lock-reclaim-race-"));
    tempRoots.push(root);
    const statePath = join(root, "plugins.lock");
    const lockPath = `${statePath}.lock`;
    const markerPath = join(lockPath, ".reclaim-z.marker");
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const childPid = child.pid;
    if (childPid === undefined) throw new Error("child process did not expose a pid");
    const exited = once(child, "exit");
    child.kill();
    await exited;

    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({ pid: childPid }),
      { mode: 0o600 },
    );
    await mkdir(markerPath, { recursive: true, mode: 0o700 });
    await writeFile(
      join(markerPath, "owner.json"),
      JSON.stringify({ pid: process.pid }),
      { mode: 0o600 },
    );
    await writeFile(
      join(markerPath, "marker.json"),
      JSON.stringify({ createdAt: "0" }),
      { mode: 0o600 },
    );

    let entered = false;
    const operation = withPluginStateLock(statePath, async () => {
      entered = true;
      return "recovered";
    });
    for (let attempt = 0; attempt < 100 && !entered; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const enteredWhileEarlierMarkerHeld = entered;
    await rm(markerPath, { recursive: true, force: true });

    await expect(operation).resolves.toBe("recovered");
    expect(enteredWhileEarlierMarkerHeld).toBe(false);
  });


  it("does not enter a second operation while the live owner holds the lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-plugin-lock-live-"));
    tempRoots.push(root);
    const statePath = join(root, "plugins.lock");
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const first = withPluginStateLock(statePath, async () => {
      entered();
      await releasePromise;
      return "first";
    });
    await enteredPromise;

    let secondEntered = false;
    const second = withPluginStateLock(statePath, async () => {
      secondEntered = true;
      return "second";
    });
    await Promise.resolve();
    expect(secondEntered).toBe(false);

    release();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });
});
