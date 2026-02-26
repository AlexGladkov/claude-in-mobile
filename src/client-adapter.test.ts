import { describe, it, expect } from "vitest";
import { detectClient, getConfigSnippet, type ClientType } from "./client-adapter.js";

describe("detectClient", () => {
  it("should detect claude-code from clientInfo name", () => {
    const adapter = detectClient({ name: "claude-code", version: "1.0.0" });
    expect(adapter.clientType).toBe("claude-code");
    expect(adapter.clientName).toBe("claude-code");
    expect(adapter.clientVersion).toBe("1.0.0");
  });

  it("should detect claude-code from partial name match", () => {
    const adapter = detectClient({ name: "claude-desktop", version: "2.0.0" });
    expect(adapter.clientType).toBe("claude-code");
  });

  it("should detect opencode", () => {
    const adapter = detectClient({ name: "opencode", version: "0.1.0" });
    expect(adapter.clientType).toBe("opencode");
  });

  it("should detect cursor", () => {
    const adapter = detectClient({ name: "cursor", version: "1.5.0" });
    expect(adapter.clientType).toBe("cursor");
  });

  it("should return unknown for unrecognized clients", () => {
    const adapter = detectClient({ name: "some-new-client", version: "1.0.0" });
    expect(adapter.clientType).toBe("unknown");
  });

  it("should return unknown when clientInfo is undefined", () => {
    const adapter = detectClient(undefined);
    expect(adapter.clientType).toBe("unknown");
    expect(adapter.clientName).toBe("unknown");
    expect(adapter.clientVersion).toBe("unknown");
  });
});

describe("getAdditionalAliases", () => {
  it("should return extra aliases for opencode", () => {
    const adapter = detectClient({ name: "opencode", version: "1.0.0" });
    const aliases = adapter.getAdditionalAliases();
    expect(aliases["touch"]).toBe("tap");
    expect(aliases["capture_screen"]).toBe("screenshot");
  });

  it("should return empty aliases for claude-code", () => {
    const adapter = detectClient({ name: "claude-code", version: "1.0.0" });
    const aliases = adapter.getAdditionalAliases();
    expect(Object.keys(aliases).length).toBe(0);
  });

  it("should return empty aliases for unknown clients", () => {
    const adapter = detectClient(undefined);
    const aliases = adapter.getAdditionalAliases();
    expect(Object.keys(aliases).length).toBe(0);
  });
});

describe("getInstructions", () => {
  it("should return instructions string for opencode", () => {
    const adapter = detectClient({ name: "opencode", version: "1.0.0" });
    const instructions = adapter.getInstructions();
    expect(instructions).toContain("screenshot");
    expect(instructions).toContain("tap");
    expect(instructions.length).toBeGreaterThan(0);
  });

  it("should return instructions for claude-code", () => {
    const adapter = detectClient({ name: "claude-code", version: "1.0.0" });
    expect(adapter.getInstructions().length).toBeGreaterThan(0);
  });
});

describe("getConfigSnippet", () => {
  it("should generate valid opencode config", () => {
    const config = getConfigSnippet("opencode");
    const parsed = JSON.parse(config);
    expect(parsed.mcp.mobile.type).toBe("local");
    expect(parsed.mcp.mobile.command).toEqual(["npx", "-y", "claude-in-mobile"]);
    expect(parsed.mcp.mobile.enabled).toBe(true);
  });

  it("should generate valid cursor config", () => {
    const config = getConfigSnippet("cursor");
    const parsed = JSON.parse(config);
    expect(parsed.mcpServers.mobile.command).toBe("npx");
    expect(parsed.mcpServers.mobile.args).toEqual(["-y", "claude-in-mobile"]);
  });

  it("should generate valid claude-code config", () => {
    const config = getConfigSnippet("claude-code");
    const parsed = JSON.parse(config);
    expect(parsed.mcpServers.mobile.command).toBe("npx");
    expect(parsed.mcpServers.mobile.args).toEqual(["-y", "claude-in-mobile"]);
  });

  it("should throw for unsupported client", () => {
    expect(() => getConfigSnippet("nonexistent" as ClientType)).toThrow();
  });
});
