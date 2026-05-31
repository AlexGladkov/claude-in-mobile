import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync, unlinkSync } from "fs";
import { tmpdir, platform } from "os";
import { delimiter, join } from "path";

import { AuroraClient } from "./client.js";

/**
 * Security regression tests for issue #40 — host-side OS Command Injection (CWE-78).
 *
 * Strategy: install a fake `audb` shell script that always exits 0 in a tmp dir,
 * then prepend that dir to PATH so `execFileSync("audb", ...)` resolves to the fake.
 * Invoke AuroraClient methods with payloads that would trigger host-side RCE under the old
 * `execSync(string)` implementation. Assert that the side-effect (touch on host filesystem)
 * does NOT occur — which proves the argv-form (execFileSync) is in effect.
 *
 * Skipped on Windows where the shell semantics of `&` differ (cmd.exe vs /bin/sh) and the
 * shim mechanism isn't portable. The vulnerability and fix are Unix-shell-specific.
 *
 * NOTE: Aurora client resolves `audb` by name from PATH (no resolver module / env-var
 * override), so we use the PATH-prepend strategy. The fake audb must precede the real one
 * (if any) in PATH.
 */

const isWin = platform() === "win32";
const describeUnix = isWin ? describe.skip : describe;

describeUnix("AuroraClient — host-side injection regression (issue #40)", () => {
  let workDir: string;
  let proofFile: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "cim-sec-aurora-"));
    const fakeAudb = join(workDir, "audb");
    proofFile = join(workDir, "RCE_PROOF");

    // Fake audb: exit 0, ignore args. Real audb would also exit 0 for many sub-commands;
    // we only care about host-side side-effects here.
    writeFileSync(fakeAudb, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeAudb, 0o755);

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
    const client = new AuroraClient();
    // Under the OLD execSync(string) path this would background-fork the (fake) audb call
    // and then run `touch <proofFile>` on the host. With the new execFileSync(audb, argv)
    // path the entire payload travels as a single argv slot — host shell never parses it.
    client.shell(`x & touch ${proofFile}`);
    expect(existsSync(proofFile)).toBe(false);
  });

  it("shell() with `; touch` chaining does NOT execute the host command", () => {
    const client = new AuroraClient();
    client.shell(`x ; touch ${proofFile}`);
    expect(existsSync(proofFile)).toBe(false);
  });

  it("shell() with `$(touch <hostfile>)` does NOT execute the host command", () => {
    const client = new AuroraClient();
    client.shell(`echo $(touch ${proofFile})`);
    expect(existsSync(proofFile)).toBe(false);
  });

  it("shell() with backticks does NOT execute the host command", () => {
    const client = new AuroraClient();
    client.shell("echo `touch " + proofFile + "`");
    expect(existsSync(proofFile)).toBe(false);
  });

  it("installApp() with a path containing `; touch` does NOT execute the host command", () => {
    const client = new AuroraClient();
    // Path with embedded injection attempt — argv-form treats it as a literal filename.
    client.installApp(`/tmp/fake.rpm; touch ${proofFile}`);
    expect(existsSync(proofFile)).toBe(false);
  });

  it("launchApp() with an injection payload does NOT execute the host command", () => {
    const client = new AuroraClient();
    // `audb launch <packageName>` — the entire packageName slot stays a single argv arg.
    client.launchApp(`ru.example.App; touch ${proofFile}`);
    expect(existsSync(proofFile)).toBe(false);
  });

  it("pushFile() with injection in remote path does NOT execute the host command", () => {
    const client = new AuroraClient();
    // Both args pass through to `audb push <local> <remote>` as distinct argv slots.
    client.pushFile("/tmp/local.bin", `/tmp/remote.bin; touch ${proofFile}`);
    expect(existsSync(proofFile)).toBe(false);
  });
});
