import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, unlinkSync } from "fs";
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
  it("does not echo sensitive text when adb fails", async () => {
    const fakeAdb = join(workDir, "adb");
    writeFileSync(fakeAdb, "#!/bin/sh\nprintf 'unknown failure\\n' >&2\nexit 1\n");
    chmodSync(fakeAdb, 0o755);

    const secret = "do-not-echo-this-password";
    const client = new AdbClient();
    let syncMessage = "";
    try {
      client.inputText(secret);
    } catch (error: unknown) {
      syncMessage = error instanceof Error ? error.message : String(error);
    }
    expect(syncMessage).toContain("ADB shell failed");
    expect(syncMessage).not.toContain(secret);

    const asyncError = await client.inputTextAsync(secret).catch((error: unknown) => error);
    expect(String(asyncError)).not.toContain(secret);
  });


  it("installApk() with a path containing `; touch` does NOT execute the host command", () => {
    const client = new AdbClient();
    // Path with embedded injection attempt — argv-form treats it as a literal filename.
    client.installApk(`/tmp/fake.apk; touch ${proofFile}`);
    expect(existsSync(proofFile)).toBe(false);
  });

  it("keeps text literal in the combined device-shell command", async () => {
    const deviceBin = join(workDir, "device-bin");
    mkdirSync(deviceBin);
    for (const command of ["input", "uiautomator"]) {
      const path = join(deviceBin, command);
      writeFileSync(path, "#!/bin/sh\nexit 0\n");
      chmodSync(path, 0o755);
    }

    const fakeAdb = join(workDir, "adb");
    writeFileSync(
      fakeAdb,
      `#!/bin/sh
if [ "$1" = "shell" ] && [ "$2" = "sh" ] && [ "$3" = "-c" ]; then
  PATH="${deviceBin}:$PATH" "$2" "$3" "$4"
fi
`,
    );
    chmodSync(fakeAdb, 0o755);

    const client = new AdbClient();
    await client.execWithUiDump(["input", "text", `O'Reilly; touch ${proofFile}`]);

    expect(existsSync(proofFile)).toBe(false);
  });

  it("preserves action success when the UI dump fails", async () => {
    const deviceBin = join(workDir, "device-bin");
    mkdirSync(deviceBin);
    const input = join(deviceBin, "input");
    writeFileSync(input, `#!/bin/sh\n: > "${proofFile}"\nexit 0\n`);
    chmodSync(input, 0o755);
    const uiautomator = join(deviceBin, "uiautomator");
    writeFileSync(uiautomator, "#!/bin/sh\nexit 1\n");
    chmodSync(uiautomator, 0o755);

    const fakeAdb = join(workDir, "adb");
    writeFileSync(
      fakeAdb,
      `#!/bin/sh
if [ "$1" = "shell" ] && [ "$2" = "sh" ] && [ "$3" = "-c" ]; then
  PATH="${deviceBin}:$PATH" "$2" "$3" "$4"
fi
`,
    );
    chmodSync(fakeAdb, 0o755);

    const client = new AdbClient();
    await expect(client.execWithUiDump(["input", "tap", "1", "2"]))
      .resolves.toMatchObject({ uiXml: "" });

    expect(existsSync(proofFile)).toBe(true);
  });

  it("aborts a running combined action and UI dump process", async () => {
    const fakeAdb = join(workDir, "adb");
    writeFileSync(fakeAdb, "#!/bin/sh\nexec sleep 10\n");
    chmodSync(fakeAdb, 0o755);

    const controller = new AbortController();
    const client = new AdbClient();
    const request = client.execWithUiDump(
      ["input", "tap", "1", "2"],
      undefined,
      controller.signal,
    );
    controller.abort();

    await expect(request).rejects.toBeDefined();
  });
  it("aborts a running text-input ADB process when its signal is cancelled", async () => {
    const fakeAdb = join(workDir, "adb");
    const startedFile = join(workDir, "adb-started");
    writeFileSync(
      fakeAdb,
      `#!/bin/sh\nprintf started > "${startedFile}"\nexec sleep 10\n`,
    );
    chmodSync(fakeAdb, 0o755);

    const controller = new AbortController();
    const client = new AdbClient();
    const request = client.inputTextAsync("audit input", undefined, controller.signal);
    const startDeadline = Date.now() + 1_000;
    while (!existsSync(startedFile) && Date.now() < startDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(existsSync(startedFile)).toBe(true);
    controller.abort();

    await expect(request).rejects.toBeDefined();
  });

});

describe("AdbClient clipboard fallback", () => {
  it("returns clipboard text from the fallback when the primary command fails", () => {
    const client = new AdbClient();
    const execute = vi.spyOn(client, "exec")
      .mockImplementationOnce(() => { throw new Error("primary unavailable"); })
      .mockReturnValueOnce('Broadcast completed: data="fallback text"');

    expect(client.getClipboardText()).toBe("fallback text");
    expect(execute).toHaveBeenNthCalledWith(2, "shell am broadcast -a clipper.get");
  });

  it("preserves both command failures when clipboard access is unavailable", () => {
    const client = new AdbClient();
    const primaryError = new Error("primary unavailable");
    const fallbackError = new Error("fallback unavailable");
    vi.spyOn(client, "exec")
      .mockImplementationOnce(() => { throw primaryError; })
      .mockImplementationOnce(() => { throw fallbackError; });

    let actualError: unknown;
    try {
      client.getClipboardText();
    } catch (error: unknown) {
      actualError = error;
    }

    expect(actualError).toBeInstanceOf(AggregateError);
    expect((actualError as AggregateError).errors).toEqual([primaryError, fallbackError]);
  });

  it("rejects a fallback response without clipboard data", () => {
    const client = new AdbClient();
    vi.spyOn(client, "exec")
      .mockImplementationOnce(() => { throw new Error("primary unavailable"); })
      .mockReturnValueOnce("Broadcast completed: result=0");

    expect(() => client.getClipboardText()).toThrow(AggregateError);
  });
});
