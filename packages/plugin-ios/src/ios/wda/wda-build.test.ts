import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { WDAManager } from "./wda-manager.js";

/**
 * Build-path tests. Follows the fake-binary-on-PATH strategy from client.test.ts:
 * real code runs, only `xcrun` / `xcodebuild` are shimmed, so nothing here mocks
 * the module under test.
 */

interface BuildHarness {
  derivedDataPath: string;
  buildWDAIfNeeded(wdaPath: string): Promise<void>;
}

function harness(manager: WDAManager): BuildHarness {
  return manager as unknown as BuildHarness;
}

const DEVICES_JSON = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
      { udid: "UDID-BOOTED", name: "iPhone 16 Pro", state: "Booted", isAvailable: true },
      { udid: "UDID-SHUTDOWN", name: "iPhone 16", state: "Shutdown", isAvailable: true },
    ],
  },
});

describe("WDAManager build path", () => {
  let workDir: string;
  let wdaPath: string;
  let derivedDataPath: string;
  let buildArgsLog: string;
  let devicesJson: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "cim-wda-build-"));
    wdaPath = join(workDir, "wda");
    derivedDataPath = join(workDir, "DerivedData");
    buildArgsLog = join(workDir, "xcodebuild-args");
    devicesJson = join(workDir, "devices.json");

    mkdirSync(join(wdaPath, "WebDriverAgent.xcodeproj"), { recursive: true });
    // appium-webdriveragent ships `build/` as its TypeScript output — always present,
    // and unrelated to whether xcodebuild has ever run.
    mkdirSync(join(wdaPath, "build"), { recursive: true });
    mkdirSync(derivedDataPath, { recursive: true });

    const bin = join(workDir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "xcodebuild"), `#!/bin/sh\necho "$@" > "${buildArgsLog}"\nexit 0\n`);
    chmodSync(join(bin, "xcodebuild"), 0o755);
    writeFileSync(devicesJson, DEVICES_JSON);
    writeFileSync(join(bin, "xcrun"), `#!/bin/sh\ncat "${devicesJson}"\n`);
    chmodSync(join(bin, "xcrun"), 0o755);

    savedPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${savedPath ?? ""}`;
  });

  afterEach(() => {
    if (savedPath !== undefined) process.env.PATH = savedPath;
    rmSync(workDir, { recursive: true, force: true });
  });

  it("runs xcodebuild despite the unrelated npm build directory", async () => {
    const manager = new WDAManager();
    harness(manager).derivedDataPath = derivedDataPath;

    await harness(manager).buildWDAIfNeeded(wdaPath);

    expect(readFileSync(buildArgsLog, "utf8")).toContain("build-for-testing");
  });

  it("uses one deterministic DerivedData path for incremental builds", async () => {
    const manager = new WDAManager();
    harness(manager).derivedDataPath = derivedDataPath;

    await harness(manager).buildWDAIfNeeded(wdaPath);

    expect(readFileSync(buildArgsLog, "utf8")).toContain(`-derivedDataPath ${derivedDataPath}`);
  });

  it("targets a booted simulator instead of a hardcoded device name", async () => {
    const manager = new WDAManager();
    harness(manager).derivedDataPath = derivedDataPath;

    await harness(manager).buildWDAIfNeeded(wdaPath);

    const args = readFileSync(buildArgsLog, "utf8");
    expect(args).toContain("id=UDID-BOOTED");
    expect(args).not.toContain("iPhone 14");
  });

  it("builds once per checkout for the life of the manager", async () => {
    const manager = new WDAManager();
    harness(manager).derivedDataPath = derivedDataPath;

    await harness(manager).buildWDAIfNeeded(wdaPath);
    rmSync(buildArgsLog);
    await harness(manager).buildWDAIfNeeded(wdaPath);

    expect(existsSync(buildArgsLog)).toBe(false);
  });

  it("retries the build after a failure", async () => {
    writeFileSync(join(workDir, "bin", "xcodebuild"), "#!/bin/sh\necho boom >&2\nexit 65\n");
    const manager = new WDAManager();
    harness(manager).derivedDataPath = derivedDataPath;
    await expect(harness(manager).buildWDAIfNeeded(wdaPath)).rejects.toThrow(/boom/);

    writeFileSync(join(workDir, "bin", "xcodebuild"), `#!/bin/sh\necho "$@" > "${buildArgsLog}"\nexit 0\n`);
    await harness(manager).buildWDAIfNeeded(wdaPath);

    expect(readFileSync(buildArgsLog, "utf8")).toContain("build-for-testing");
  });

  it("builds again after a launch fails, since the products it relied on may be gone", async () => {
    writeFileSync(
      join(workDir, "bin", "xcodebuild"),
      `#!/bin/sh\necho "$@" >> "${buildArgsLog}"\n[ "$1" = test-without-building ] && exit 70\nexit 0\n`,
    );
    const savedWdaPath = process.env.WDA_PATH;
    process.env.WDA_PATH = wdaPath;
    const manager = new WDAManager();
    harness(manager).derivedDataPath = derivedDataPath;
    try {
      await expect(manager.ensureWDAReady("UDID-BOOTED")).rejects.toThrow(/failed to start/);
      await expect(manager.ensureWDAReady("UDID-BOOTED")).rejects.toThrow(/failed to start/);
    } finally {
      if (savedWdaPath === undefined) delete process.env.WDA_PATH;
      else process.env.WDA_PATH = savedWdaPath;
      await manager.cleanup();
    }

    const builds = readFileSync(buildArgsLog, "utf8").split("\n").filter((line) => line.startsWith("build-for-testing"));
    expect(builds).toHaveLength(2);
  });

  it("reports that no simulator is available instead of failing obscurely", async () => {
    writeFileSync(devicesJson, JSON.stringify({ devices: {} }));
    const manager = new WDAManager();
    harness(manager).derivedDataPath = derivedDataPath;

    await expect(harness(manager).buildWDAIfNeeded(wdaPath)).rejects.toThrow(/no iOS simulator/i);
  });

  it("builds the simulator runner without code signing", async () => {
    const manager = new WDAManager();
    harness(manager).derivedDataPath = derivedDataPath;

    await harness(manager).buildWDAIfNeeded(wdaPath);

    expect(readFileSync(buildArgsLog, "utf8")).toContain("CODE_SIGNING_ALLOWED=NO");
  });

  // A cold `build-for-testing` writes ~1 MB of progress to stdout; the child
  // process default maxBuffer is exactly that and terminates xcodebuild early.
  it("survives build output larger than the child-process default buffer", async () => {
    writeFileSync(
      join(workDir, "bin", "xcodebuild"),
      `#!/bin/sh\nawk 'BEGIN { for (i = 0; i < 40000; i++) print "xcodebuild progress line padding" }'\nexit 0\n`,
    );
    chmodSync(join(workDir, "bin", "xcodebuild"), 0o755);
    const manager = new WDAManager();
    harness(manager).derivedDataPath = derivedDataPath;

    await expect(harness(manager).buildWDAIfNeeded(wdaPath)).resolves.toBeUndefined();
  });
});
