import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync, unlinkSync } from "fs";
import { tmpdir, platform } from "os";
import { delimiter, join } from "path";

import { IosClient } from "./client.js";

/**
 * Security regression tests for issue #40 — host-side OS Command Injection (CWE-78).
 *
 * Strategy: install a fake `xcrun` shell script that always exits 0 in a tmp dir,
 * then prepend that dir to PATH so `execFileSync("xcrun", ...)` resolves to the fake.
 * Invoke IosClient methods with payloads that would trigger host-side RCE under the old
 * `execSync(string)` implementation. Assert that the side-effect (touch on host filesystem)
 * does NOT occur — which proves the argv-form (execFileSync) is in effect.
 *
 * Skipped on Windows where the shell semantics of `&` differ (cmd.exe vs /bin/sh), xcrun
 * doesn't exist, and the shim mechanism isn't portable. The vulnerability and fix are
 * Unix-shell-specific.
 *
 * NOTE: iOS client resolves `xcrun` by name (no env-var override like ADB_PATH), so we
 * use the PATH-prepend strategy. The fake xcrun must precede the real one in PATH.
 */

const isWin = platform() === "win32";
const describeUnix = isWin ? describe.skip : describe;

describeUnix("IosClient — host-side injection regression (issue #40)", () => {
  let workDir: string;
  let proofFile: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "cim-sec-ios-"));
    const fakeXcrun = join(workDir, "xcrun");
    proofFile = join(workDir, "RCE_PROOF");

    // Fake xcrun: exit 0, ignore args. Real xcrun would also exit 0 for many simctl commands
    // against a booted simulator; we don't care about output here, only side-effects.
    writeFileSync(fakeXcrun, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeXcrun, 0o755);

    savedPath = process.env.PATH;
    process.env.PATH = `${workDir}${delimiter}${savedPath ?? ""}`;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    try {
      if (existsSync(proofFile)) unlinkSync(proofFile);
    } catch {
      // best-effort
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it("shell() with `& touch <hostfile>` does NOT execute the host command", () => {
    const client = new IosClient();
    // Under the OLD execSync(string) path this would background-fork the (fake) xcrun call
    // and then run `touch <proofFile>` on the host. With the new execFileSync(xcrun, argv)
    // path the entire payload travels as a single argv slot — host shell never parses it.
    client.shell(`x & touch ${proofFile}`);
    expect(existsSync(proofFile)).toBe(false);
  });

  it("shell() with `; touch` chaining does NOT execute the host command", () => {
    const client = new IosClient();
    client.shell(`x ; touch ${proofFile}`);
    expect(existsSync(proofFile)).toBe(false);
  });

  it("shell() with `$(touch <hostfile>)` does NOT execute the host command", () => {
    const client = new IosClient();
    client.shell(`echo $(touch ${proofFile})`);
    expect(existsSync(proofFile)).toBe(false);
  });

  it("shell() with backticks does NOT execute the host command", () => {
    const client = new IosClient();
    client.shell("echo `touch " + proofFile + "`");
    expect(existsSync(proofFile)).toBe(false);
  });

  it("openUrl() with `'; touch ...; #` payload does NOT execute the host command", () => {
    const client = new IosClient();
    // URL scheme validation happens at the tool layer (validateUrl), not in the client.
    // The client method itself must structurally prevent injection — the URL travels as
    // a single argv slot to `xcrun simctl openurl <target> <url>`.
    client.openUrl(`http://example.com'; touch ${proofFile}; #`);
    expect(existsSync(proofFile)).toBe(false);
  });

  it("installApp() with a path containing `; touch` does NOT execute the host command", () => {
    const client = new IosClient();
    // Path with embedded injection attempt — argv-form treats it as a literal filename.
    client.installApp(`/tmp/fake.app; touch ${proofFile}`);
    expect(existsSync(proofFile)).toBe(false);
  });

  it("installApp() with a quoted-injection payload does NOT execute the host command", () => {
    const client = new IosClient();
    client.installApp(`/tmp/x.app'; touch ${proofFile}; '`);
    expect(existsSync(proofFile)).toBe(false);
  });

  it("getAppLogs() with a malicious bundleId either validates OR does not execute the host command", () => {
    const client = new IosClient();
    // bundleId is whitelist-validated (reverse-DNS regex); injection payload should be
    // rejected by validateBundleId BEFORE reaching execFileSync. Either way: no host file.
    expect(() => client.getAppLogs(`com.foo'; touch ${proofFile}; '`, 10)).toThrow();
    expect(existsSync(proofFile)).toBe(false);
  });
});
