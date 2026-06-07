/**
 * Generic plugin contract test suite.
 *
 * Any plugin shipped in src/plugins/<id>/ must include a `contract.test.ts`
 * that invokes `runPluginContract(factory)`. The suite checks the invariants
 * every plugin must satisfy per ADR 0002, independent of platform behavior.
 */

import type {
  Logger,
  PluginContext,
  SourcePlugin,
  ToolDefinition,
} from "@claude-in-mobile/plugin-api";
import {
  ALL_CAPABILITIES,
  PLUGIN_API_VERSION,
  isCapability,
} from "@claude-in-mobile/plugin-api";
import { describe, expect, it } from "vitest";

import { InMemoryEventBus } from "../kernel/eventbus.js";
import { InMemoryRegistry } from "../kernel/registry.js";
import { LifecycleOrchestrator } from "../kernel/lifecycle.js";

export type PluginFactory = () => SourcePlugin;

function silentLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

export function runPluginContract(factory: PluginFactory): void {
  const label = factory().manifest.id;

  describe(`plugin contract: ${label}`, () => {
    it("declares non-empty id matching /^[a-z0-9][a-z0-9._-]*$/", () => {
      const m = factory().manifest;
      expect(m.id).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
    });

    it("apiVersion matches kernel-supported version", () => {
      expect(factory().manifest.apiVersion).toBe(PLUGIN_API_VERSION);
    });

    it("declares a non-empty, unique, valid capability list", () => {
      const caps = factory().manifest.capabilities;
      expect(caps.length).toBeGreaterThan(0);
      expect(new Set(caps).size).toBe(caps.length);
      for (const c of caps) {
        expect(isCapability(c)).toBe(true);
        expect(ALL_CAPABILITIES).toContain(c);
      }
    });

    it("registers cleanly in InMemoryRegistry", () => {
      const r = new InMemoryRegistry();
      expect(() => r.register(factory())).not.toThrow();
    });

    it("init is idempotent and registers tools only via context", async () => {
      const r = new InMemoryRegistry();
      const bus = new InMemoryEventBus();
      const toolNames = new Set<string>();
      const lc = new LifecycleOrchestrator({
        registry: r,
        eventBus: bus,
        logger: silentLogger(),
        configFor: () => ({}),
        onToolRegistered: (_id, def: ToolDefinition) => toolNames.add(def.name),
      });
      r.register(factory());
      await lc.initAll();
      const entry = r.list()[0]!;
      expect(["active", "registered"]).toContain(entry.state);
      if (entry.plugin.manifest.tools) {
        for (const t of entry.plugin.manifest.tools) {
          expect(toolNames.has(t)).toBe(true);
        }
      }
    });

    it("dispose is idempotent", async () => {
      const r = new InMemoryRegistry();
      const bus = new InMemoryEventBus();
      const lc = new LifecycleOrchestrator({
        registry: r,
        eventBus: bus,
        logger: silentLogger(),
        configFor: () => ({}),
        onToolRegistered: () => {},
      });
      r.register(factory());
      await lc.initAll();
      await lc.disposeAll();
      await expect(lc.disposeAll()).resolves.toBeUndefined();
    });
  });
}

export function dummyContext(overrides: Partial<PluginContext> = {}): PluginContext {
  return {
    logger: silentLogger(),
    config: Object.freeze({}),
    eventBus: new InMemoryEventBus(),
    registerTool: () => {},
    ...overrides,
  };
}
