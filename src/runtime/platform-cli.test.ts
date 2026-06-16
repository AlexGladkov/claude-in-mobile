import { describe, expect, it } from "vitest";

import {
  applyInstall,
  applyUninstall,
  runPlatformCommand,
} from "./platform-cli.js";

describe("applyInstall", () => {
  it("adds and dedupes", () => {
    expect(applyInstall(["ios"], ["android", "ios"])).toEqual(["ios", "android"]);
  });
  it("expands all", () => {
    expect(applyInstall([], ["all"]).sort()).toEqual(
      ["android", "aurora", "desktop", "ios", "web"].sort()
    );
  });
  it("ignores unknown tokens", () => {
    expect(applyInstall([], ["bogus", "ios"])).toEqual(["ios"]);
  });
});

describe("applyUninstall", () => {
  it("removes listed platforms", () => {
    expect(applyUninstall(["ios", "android", "web"], ["android"])).toEqual([
      "ios",
      "web",
    ]);
  });
  it("uninstall all clears", () => {
    expect(applyUninstall(["ios", "web"], ["all"])).toEqual([]);
  });
});

describe("runPlatformCommand dispatch", () => {
  it("returns false for non-platform argv (falls through)", () => {
    const r = runPlatformCommand(["node", "cli.js", "--version"], (() => {
      throw new Error("should not exit");
    }) as never);
    expect(r).toBe(false);
  });

  it("handles a known command and exits 0", () => {
    let code: number | undefined;
    const exit = ((c: number) => {
      code = c;
      return undefined as never;
    }) as (c: number) => never;
    runPlatformCommand(["node", "cli.js", "platforms"], exit);
    expect(code).toBe(0);
  });

  it("install with no args exits 1", () => {
    const codes: number[] = [];
    const exit = ((c: number) => {
      codes.push(c);
      return undefined as never;
    }) as (c: number) => never;
    runPlatformCommand(["node", "cli.js", "install"], exit);
    expect(codes).toContain(1);
  });
});
