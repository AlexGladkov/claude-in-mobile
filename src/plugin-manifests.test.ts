import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../", import.meta.url).pathname;

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(read(rel)) as Record<string, unknown>;
}

function cargoVersion(toml: string): string {
  const m = toml.match(/^version\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error("no version in Cargo.toml");
  return m[1];
}

describe("plugin manifests version lock", () => {
  const pkg = readJson("package.json").version as string;
  const claudeMarket = readJson(".claude-plugin/marketplace.json");
  const grokMarket = readJson(".grok-plugin/marketplace.json");
  const claudePlugin = readJson("cli/plugin/.claude-plugin/plugin.json");
  const grokPlugin = readJson("cli/plugin/.grok-plugin/plugin.json");
  const cargo = cargoVersion(read("cli/Cargo.toml"));

  const claudeMarketPlugins = claudeMarket.plugins as Array<Record<string, unknown>>;
  const grokMarketPlugins = grokMarket.plugins as Array<Record<string, unknown>>;

  it("keeps package, marketplaces, plugin.json, and Cargo.toml on the same version", () => {
    expect(pkg).toMatch(/^\d+\.\d+\.\d+/);
    expect(claudeMarketPlugins[0].version).toBe(pkg);
    expect(grokMarketPlugins[0].version).toBe(pkg);
    expect(claudePlugin.version).toBe(pkg);
    expect(grokPlugin.version).toBe(pkg);
    expect(cargo).toBe(pkg);
  });

  it("points both marketplaces at ./cli/plugin", () => {
    expect(claudeMarketPlugins[0].source).toBe("./cli/plugin");
    expect(grokMarketPlugins[0].source).toBe("./cli/plugin");
  });

  it("declares mcpServers as ./.mcp.json on both plugin.json files", () => {
    expect(claudePlugin.mcpServers).toBe("./.mcp.json");
    expect(grokPlugin.mcpServers).toBe("./.mcp.json");
  });

  it("keeps Claude and Grok plugin.json lockstep", () => {
    expect(grokPlugin).toEqual(claudePlugin);
  });

  it("spawns MCP via npx -y mcp-devices", () => {
    expect(readJson("cli/plugin/.mcp.json")).toEqual({
      mobile: {
        command: "npx",
        args: ["-y", "mcp-devices"],
      },
    });
  });
});
