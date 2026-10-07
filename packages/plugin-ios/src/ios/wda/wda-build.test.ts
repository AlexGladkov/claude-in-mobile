import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  buildWDAIfNeeded(wdaPath: string, targetId?: string): Promise<void>;
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

  it("builds against the simulator WDA is launching on, not another booted one", async () => {
    const manager = new WDAManager();
    harness(manager).derivedDataPath = derivedDataPath;

    await harness(manager).buildWDAIfNeeded(wdaPath, "UDID-SHUTDOWN");

    expect(readFileSync(buildArgsLog, "utf8")).toContain("id=UDID-SHUTDOWN");
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
