import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync, unlinkSync } from "fs";
import { tmpdir, platform } from "os";
import { join } from "path";

import { AdbClient } from "./client.js";
import { _resetCacheForTests } from "./resolver.js";

/**
 * Security regression tests for issue #40 — host-side OS Command Injection (CWE-78).
 *
 * Strategy: install a real fake `adb` shell script that always exits 0. Point ADB_PATH at it.
 * Invoke AdbClient methods with payloads that would trigger host-side RCE under the old
 * `execSync(string)` implementation. Assert that the side-effect (touch on host filesystem)
 * does NOT occur — which proves the argv-form (execFileSync) is in effect.
 *
 * Skipped on Windows where the shell semantics of `&` differ (cmd.exe vs /bin/sh) and the
 * shim mechanism isn't portable. The vulnerability and fix are Unix-shell-specific.
 */

const isWin = platform() === "win32";
const describeUnix = isWin ? describe.skip : describe;

describeUnix("AdbClient — host-side injection regression (issue #40)", () => {
  let workDir: string;
  let proofFile: string;
  let savedAdbPath: string | undefined;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "cim-sec-"));
    const fakeAdb = join(workDir, "adb");
    proofFile = join(workDir, "RCE_PROOF");

    // Fake adb: exit 0, ignore args. Real adb would also exit 0 for unrecognized commands.
    writeFileSync(fakeAdb, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeAdb, 0o755);

    savedAdbPath = process.env.ADB_PATH;
    process.env.ADB_PATH = fakeAdb;
    _resetCacheForTests();
  });

  afterEach(() => {
    if (savedAdbPath === undefined) delete process.env.ADB_PATH;
    else process.env.ADB_PATH = savedAdbPath;
    _resetCacheForTests();
    try {
      if (existsSync(proofFile)) unlinkSync(proofFile);
    } catch {
      // best-effort
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it("shell() with `& touch <hostfile>` does NOT execute the host command", () => {
    const client = new AdbClient();
    // Under the OLD execSync(string) path this would background-fork the (fake) adb call
    // and then run `touch <proofFile>` on the host. With the new execFileSync(adb, argv)
    // path the entire payload travels as a single argv slot — host shell never parses it.
    client.shell(`x & touch ${proofFile}`);
    expect(existsSync(proofFile)).toBe(false);
  });

  it("exec() with `& touch <hostfile>` does NOT execute the host command", () => {
    const client = new AdbClient();
    client.exec(`shell x & touch ${proofFile}`);
    expect(existsSync(proofFile)).toBe(false);
  });

  it("shell() with `$(touch <hostfile>)` does NOT execute the host command", () => {
    const client = new AdbClient();
    client.shell(`echo $(touch ${proofFile})`);
    expect(existsSync(proofFile)).toBe(false);
  });

  it("shell() with backticks does NOT execute the host command", () => {
    const client = new AdbClient();
    client.shell("echo `touch " + proofFile + "`");
    expect(existsSync(proofFile)).toBe(false);
  });

  it("shell() with `; touch` chaining does NOT execute the host command", () => {
    const client = new AdbClient();
    client.shell(`x ; touch ${proofFile}`);
    expect(existsSync(proofFile)).toBe(false);
  });

  it("inputText() with `; touch` payload does NOT execute the host command", () => {
    const client = new AdbClient();
    client.inputText(`hello; touch ${proofFile}`);
    expect(existsSync(proofFile)).toBe(false);
  });

  it("installApk() with a path containing `; touch` does NOT execute the host command", () => {
    const client = new AdbClient();
    // Path with embedded injection attempt — argv-form treats it as a literal filename.
    client.installApk(`/tmp/fake.apk; touch ${proofFile}`);
    expect(existsSync(proofFile)).toBe(false);
  });
});
