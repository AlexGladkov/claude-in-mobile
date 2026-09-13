import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parsePlatformList,
  resolveEnabledPlatforms,
  writeEnabledPlatforms,
} from "./platform-config.js";
import { readRuntimeConfig, updateRuntimeConfig } from "./config-file.js";

describe("parsePlatformList", () => {
  it("handles none / empty", () => {
    expect(parsePlatformList("none")).toEqual([]);
    expect(parsePlatformList("")).toEqual([]);
    expect(parsePlatformList("  ")).toEqual([]);
  });

  it("expands all", () => {
    expect(parsePlatformList("all").sort()).toEqual(
      ["android", "aurora", "desktop", "harmony", "ios", "web"].sort()
    );
  });

  it("parses csv, dedupes, drops unknowns, lowercases", () => {
    expect(parsePlatformList("ios, Android,ios,bogus")).toEqual(["ios", "android"]);
  });
});

describe("resolveEnabledPlatforms", () => {
  const prev = process.env.MCP_DEVICES_PLATFORMS;
  afterEach(() => {
    if (prev === undefined) delete process.env.MCP_DEVICES_PLATFORMS;
    else process.env.MCP_DEVICES_PLATFORMS = prev;
  });

  it("env wins and parses", () => {
    process.env.MCP_DEVICES_PLATFORMS = "ios,web";
    expect(resolveEnabledPlatforms().sort()).toEqual(["ios", "web"]);
  });

  it("env=none → empty", () => {
    process.env.MCP_DEVICES_PLATFORMS = "none";
    expect(resolveEnabledPlatforms()).toEqual([]);
  });
});

describe("writeEnabledPlatforms / read roundtrip", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cim-cfg-"));
    path = join(dir, "config.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("persists a deduped, valid platform set", () => {
    writeEnabledPlatforms(["ios", "ios", "android"] as never, path);
    const json = JSON.parse(readFileSync(path, "utf-8"));
    expect(json.platforms).toEqual(["ios", "android"]);
  });
});

describe("runtime config hardening", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cim-runtime-cfg-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("rejects oversized config before parsing", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ custom: "x".repeat(1024 * 1024) }));

    expect(readRuntimeConfig(path)).toEqual({});
  });

  it.skipIf(process.platform === "win32")(
    "does not follow config symlinks on read or update",
    () => {
      const target = join(dir, "target.json");
      const path = join(dir, "config.json");
      writeFileSync(target, JSON.stringify({ platforms: ["ios"] }));
      symlinkSync(target, path);

      expect(readRuntimeConfig(path)).toEqual({});
      updateRuntimeConfig({ platforms: ["android"] }, path);

      expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ platforms: ["ios"] });
      expect(lstatSync(path).isSymbolicLink()).toBe(false);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ platforms: ["android"] });
    },
  );
});
