import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";


const ROOT = new URL("../", import.meta.url).pathname;
const jsonRecordSchema = z.record(z.string(), z.unknown());


function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function readJson(rel: string): Record<string, unknown> {
  return jsonRecordSchema.parse(JSON.parse(read(rel)));
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

  it("declares mcpServers as ./.mcp.json on the Grok plugin.json only", () => {
    // grok-only by design (see "Claude vs Grok plugin.json" below): the Claude
    // manifest intentionally omits mcpServers so it does not auto-register an
    // MCP server for existing Claude Code users.
    expect(grokPlugin.mcpServers).toBe("./.mcp.json");
    expect(claudePlugin.mcpServers).toBeUndefined();
  });

  describe("Claude vs Grok plugin.json", () => {
    // The two manifests are intentionally NOT byte-identical: `mcpServers` is
    // grok-only by design. We deliberately dropped `mcpServers` from the Claude
    // manifest so that installing the plugin does not auto-register an MCP
    // server for existing Claude Code users (they opt in themselves), while the
    // Grok manifest keeps it to wire up the mobile server out of the box.
    // Comparing the whole objects with toEqual would be brittle — any future
    // grok-only field would become a false CI blocker — so instead we assert
    // the shared fields match and pin the allowed divergence explicitly.
    let claude: Record<string, unknown>;
    let grok: Record<string, unknown>;

    beforeAll(() => {
      claude = readJson("cli/plugin/.claude-plugin/plugin.json");
      grok = readJson("cli/plugin/.grok-plugin/plugin.json");
    });

    it("keeps the shared fields identical", () => {
      const SHARED_FIELDS = [
        "name",
        "version",
        "description",
        "author",
        "homepage",
        "keywords",
        "skills",
      ] as const;
      for (const field of SHARED_FIELDS) {
        expect(grok[field], `field '${field}' must match across manifests`).toEqual(
          claude[field],
        );
      }
    });

    it("keeps mcpServers as a grok-only divergence", () => {
      // Grok registers the MCP server out of the box…
      expect(grok.mcpServers).toBe("./.mcp.json");
      // …while Claude intentionally omits the key entirely (opt-in for existing users).
      expect(claude.mcpServers).toBeUndefined();
    });
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
