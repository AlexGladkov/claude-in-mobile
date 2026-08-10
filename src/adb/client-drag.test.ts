import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from "fs";
import { tmpdir, platform } from "os";
import { join } from "path";

import { AdbClient } from "./client.js";
import { _resetCacheForTests } from "./resolver.js";

const isWin = platform() === "win32";
const describeUnix = isWin ? describe.skip : describe;

/**
 * Verifies the drag command construction by installing a fake `adb` that logs
 * its argv. Asserts the simple path uses one-process `input draganddrop`, and
 * the rich path (waypoints / holds) emits a single device-side motionevent
 * stream — the continuous held pointer #52 asks for.
 */
describeUnix("AdbClient.drag — command construction", () => {
  let workDir: string;
  let logFile: string;
  let savedAdbPath: string | undefined;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "cim-drag-"));
    const fakeAdb = join(workDir, "adb");
    logFile = join(workDir, "argv.log");
    // Log every invocation's argv (one line), then exit 0.
    writeFileSync(fakeAdb, `#!/bin/sh\necho "$@" >> ${logFile}\nexit 0\n`);
    chmodSync(fakeAdb, 0o755);
    savedAdbPath = process.env.ADB_PATH;
    process.env.ADB_PATH = fakeAdb;
    _resetCacheForTests();
  });

  afterEach(() => {
    if (savedAdbPath === undefined) delete process.env.ADB_PATH;
    else process.env.ADB_PATH = savedAdbPath;
    _resetCacheForTests();
    rmSync(workDir, { recursive: true, force: true });
  });

  const log = () => (existsSync(logFile) ? readFileSync(logFile, "utf8") : "");

  it("uses `input draganddrop` for a simple drag (no waypoints / holds)", () => {
    new AdbClient().drag(100, 200, 300, 400, { durationMs: 600 });
    const out = log();
    expect(out).toMatch(/shell input draganddrop 100 200 300 400 600/);
    expect(out).not.toMatch(/motionevent/);
  });

  it("emits a single motionevent DOWN/MOVE/UP stream when waypoints are given", () => {
    new AdbClient().drag(10, 20, 90, 100, {
      waypoints: [[50, 60]],
      grabHoldMs: 500,
      dwellMs: 300,
      durationMs: 800,
    });
    const out = log();
    // One shell invocation carrying the whole sequence via `sh -c`.
    expect(out).toMatch(/shell sh -c/);
    expect(out).toMatch(/input motionevent DOWN 10 20/);
    expect(out).toMatch(/input motionevent MOVE 50 60/);
    expect(out).toMatch(/input motionevent MOVE 90 100/);
    expect(out).toMatch(/input motionevent UP 90 100/);
    expect(out).not.toMatch(/draganddrop/);
  });

  it("truncates fractional coordinates to integers", () => {
    new AdbClient().drag(100.7, 200.2, 300.9, 400.1);
    expect(log()).toMatch(/draganddrop 100 200 300 400/);
  });
});
