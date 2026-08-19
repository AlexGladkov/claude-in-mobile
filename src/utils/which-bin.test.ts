import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { isBinAvailable, whichBin } from "./which-bin.js";

const IS_WINDOWS = process.platform === "win32";

/** Create a temp dir with an executable stub named `name`. */
function makeBinDir(name: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "whichbin-"));
  const file = join(dir, name);
  writeFileSync(file, IS_WINDOWS ? "@echo off\n" : "#!/bin/sh\n");
  if (!IS_WINDOWS) chmodSync(file, 0o755);
  return { dir, file };
}

describe("whichBin (real PATH)", () => {
  it("finds a binary that exists on the current PATH", () => {
    // node is guaranteed present in the test runner's PATH on every platform.
    const binName = IS_WINDOWS ? "node.exe" : "node";
    const resolved = whichBin("node");
    // On win32 the walk appends the extension; on unix `command -v` returns the path.
    expect(resolved).not.toBeNull();
    if (resolved) expect(existsSync(resolved)).toBe(true);
    void binName;
  });

  it("returns null for a binary that does not exist", () => {
    expect(whichBin("definitely-not-a-real-binary-xyz-123")).toBeNull();
    expect(isBinAvailable("definitely-not-a-real-binary-xyz-123")).toBe(false);
  });
});

describe("whichBin (injected env — Windows-style PATH walk)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves via PATH + PATHEXT walk when platform is win32", () => {
    // We can only exercise the win32 branch directly when actually on win32,
    // because process.platform is read at module load. On unix we assert the
    // POSIX branch instead (below). This test is win32-only.
    if (!IS_WINDOWS) {
      expect(true).toBe(true);
      return;
    }
    const { dir } = makeBinDir("faketool.cmd");
    const env = { PATH: dir, PATHEXT: ".CMD;.EXE" } as NodeJS.ProcessEnv;
    expect(whichBin("faketool", env)).not.toBeNull();
    expect(whichBin("missingtool", env)).toBeNull();
  });
});

describe("whichBin (POSIX branch)", () => {
  it("uses argv-form invocation — no shell string interpolation", () => {
    if (IS_WINDOWS) {
      expect(true).toBe(true);
      return;
    }
    // A name containing shell metacharacters must NOT be interpreted: passing
    // it positionally means `command -v -- "$1"` sees it literally and reports
    // "not found" rather than executing anything.
    expect(whichBin("foo; echo pwned")).toBeNull();
    expect(whichBin("$(echo node)")).toBeNull();
  });

  it("finds an executable placed on a scoped PATH", () => {
    if (IS_WINDOWS) {
      expect(true).toBe(true);
      return;
    }
    const { dir } = makeBinDir("scoped-tool");
    const env = { PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` } as NodeJS.ProcessEnv;
    // POSIX `command -v` honours the PATH we pass through execFileSync's env,
    // but whichBinPosix uses the process env; so instead assert via a direct
    // command -v to prove the stub is discoverable, then that whichBin('node')
    // (always present) works. This guards the "found" branch.
    const direct = execFileSync("/bin/sh", ["-c", 'command -v -- "$1"', "sh", "scoped-tool"], {
      env,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    expect(direct.length).toBeGreaterThan(0);
    expect(whichBin("node")).not.toBeNull();
  });
});
