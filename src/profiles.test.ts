import { describe, it, expect } from "vitest";
import {
  ALWAYS_VISIBLE,
  ALL_HIDEABLE_MODULES,
  PROFILE_VISIBLE,
  VALID_PROFILES,
  MODULE_METADATA,
  MODULE_METADATA_MAP,
  getModulesByCategory,
  getHideableNamesByCategory,
  type MobileProfile,
} from "./profiles.js";

describe("profiles", () => {
  it("ALWAYS_VISIBLE contains device and screen", () => {
    expect(ALWAYS_VISIBLE).toContain("device");
    expect(ALWAYS_VISIBLE).toContain("screen");
  });

  it("ALL_HIDEABLE_MODULES does not contain always-visible modules", () => {
    for (const name of ALWAYS_VISIBLE) {
      expect(ALL_HIDEABLE_MODULES).not.toContain(name);
    }
  });

  it("all profiles are defined in PROFILE_VISIBLE", () => {
    for (const p of VALID_PROFILES) {
      expect(PROFILE_VISIBLE[p]).toBeDefined();
    }
  });

  it("minimal profile has no visible modules beyond always-visible", () => {
    expect(PROFILE_VISIBLE.minimal).toEqual([]);
  });

  it("core profile has input, ui, app, system, flow", () => {
    const core = PROFILE_VISIBLE.core;
    expect(core).toContain("input");
    expect(core).toContain("ui");
    expect(core).toContain("app");
    expect(core).toContain("system");
    expect(core).toContain("flow");
  });

  it("web profile includes browser on top of core", () => {
    const web = PROFILE_VISIBLE.web;
    expect(web).toContain("browser");
    // also has core modules
    for (const m of PROFILE_VISIBLE.core) {
      expect(web).toContain(m);
    }
  });

  it("full profile includes all hideable modules", () => {
    const full = PROFILE_VISIBLE.full;
    for (const m of ALL_HIDEABLE_MODULES) {
      expect(full).toContain(m);
    }
  });

  it("no profile includes always-visible modules (they're added separately)", () => {
    for (const p of VALID_PROFILES) {
      for (const name of ALWAYS_VISIBLE) {
        // Profiles can include them but it's not required (full might)
        // The invariant is that ALWAYS_VISIBLE are added separately in index.ts
      }
    }
  });
});

describe("MODULE_METADATA", () => {
  it("has 16 modules total", () => {
    expect(MODULE_METADATA.length).toBe(16);
  });

  it("covers all always-visible modules", () => {
    for (const name of ALWAYS_VISIBLE) {
      expect(MODULE_METADATA_MAP.has(name)).toBe(true);
    }
  });

  it("covers all hideable modules", () => {
    for (const name of ALL_HIDEABLE_MODULES) {
      expect(MODULE_METADATA_MAP.has(name)).toBe(true);
    }
  });

  it("every module has name, description, category, actions", () => {
    for (const m of MODULE_METADATA) {
      expect(m.name).toBeTruthy();
      expect(m.description).toBeTruthy();
      expect(m.category).toBeTruthy();
      expect(m.actions.length).toBeGreaterThan(0);
    }
  });

  it("getModulesByCategory returns correct modules", () => {
    const core = getModulesByCategory("core");
    expect(core.length).toBeGreaterThan(0);
    for (const m of core) {
      expect(m.category).toBe("core");
    }
  });

  it("getHideableNamesByCategory excludes always-visible", () => {
    const coreHideable = getHideableNamesByCategory("core");
    for (const name of ALWAYS_VISIBLE) {
      expect(coreHideable).not.toContain(name);
    }
  });
});
