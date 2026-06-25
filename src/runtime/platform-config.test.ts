import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parsePlatformList,
  resolveEnabledPlatforms,
  writeEnabledPlatforms,
} from "./platform-config.js";

describe("parsePlatformList", () => {
  it("handles none / empty", () => {
    expect(parsePlatformList("none")).toEqual([]);
    expect(parsePlatformList("")).toEqual([]);
    expect(parsePlatformList("  ")).toEqual([]);
  });

  it("expands all", () => {
    expect(parsePlatformList("all").sort()).toEqual(
      ["android", "aurora", "desktop", "ios", "web"].sort()
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
