import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { ScenarioStore, MAX_STEPS_PER_SCENARIO } from "./scenario-store.js";
import type { Scenario, ScenarioStep } from "./scenario-store.js";
import {
  ScenarioNotFoundError,
  ScenarioExistsError,
  ScenarioCorruptedError,
  ValidationError,
  MobileError,
} from "../errors.js";

function makeStep(overrides?: Partial<ScenarioStep>): ScenarioStep {
  return {
    index: 0,
    type: "tool_call",
    action: "input_tap",
    args: { text: "Login" },
    timestampMs: 0,
    delayBeforeMs: 0,
    ...overrides,
  };
}

function makeScenario(name: string, platform: string, steps: ScenarioStep[] = [makeStep()]): Scenario {
  const checksum = createHash("sha256").update(JSON.stringify(steps)).digest("hex");
  return {
    version: 1,
    name,
    platform,
    description: "test scenario",
    tags: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    checksum,
    steps,
    metadata: {
      recordedWithVersion: "3.5.0",
      totalRecordingTimeMs: 1000,
    },
  };
}

let tempDir: string;
let store: ScenarioStore;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "scenario-test-"));
  store = new ScenarioStore(tempDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ── Save ──

describe("save", () => {
  it("saves scenario and returns entry", async () => {
    const scenario = makeScenario("login-flow", "android");
    const entry = await store.save(scenario);
    expect(entry.name).toBe("login-flow");
    expect(entry.platform).toBe("android");
    expect(entry.stepCount).toBe(1);
    expect(entry.checksum).toBeTruthy();
  });

  it("rejects duplicate without overwrite", async () => {
    const scenario = makeScenario("login", "android");
    await store.save(scenario);
    await expect(store.save(scenario)).rejects.toThrow(ScenarioExistsError);
  });

  it("allows overwrite with flag", async () => {
    const scenario = makeScenario("login", "android");
    await store.save(scenario);
    const entry = await store.save(scenario, { overwrite: true });
    expect(entry.name).toBe("login");
  });

  it("rejects invalid scenario name", async () => {
    const scenario = makeScenario("../evil", "android");
    await expect(store.save(scenario)).rejects.toThrow(MobileError);
  });

  it("rejects empty name", async () => {
    const scenario = makeScenario("", "android");
    await expect(store.save(scenario)).rejects.toThrow(MobileError);
  });

  it("saves with tags", async () => {
    const scenario = makeScenario("login", "android");
    scenario.tags = ["auth", "smoke"];
    const entry = await store.save(scenario);
    expect(entry.tags).toEqual(["auth", "smoke"]);
  });
});

// ── Get ──

describe("get", () => {
  it("retrieves saved scenario", async () => {
    const scenario = makeScenario("login", "android");
    await store.save(scenario);
    const loaded = await store.get("login", "android");
    expect(loaded.name).toBe("login");
    expect(loaded.steps.length).toBe(1);
  });

  it("throws ScenarioNotFoundError for missing", async () => {
    await expect(store.get("nonexistent", "android")).rejects.toThrow(ScenarioNotFoundError);
  });

  it("validates checksum on load", async () => {
    const scenario = makeScenario("login", "android");
    await store.save(scenario);

    // Tamper with file
    const { writeFile } = await import("fs/promises");
    const filePath = join(tempDir, ".test-scenarios", "android", "login.json");
    const raw = JSON.parse(await (await import("fs/promises")).readFile(filePath, "utf-8"));
    raw.steps[0].action = "TAMPERED";
    await writeFile(filePath, JSON.stringify(raw, null, 2));

    await expect(store.get("login", "android")).rejects.toThrow(ScenarioCorruptedError);
  });
});

// ── Delete ──

describe("delete", () => {
  it("deletes existing scenario", async () => {
    const scenario = makeScenario("login", "android");
    await store.save(scenario);
    await store.delete("login", "android");
    await expect(store.get("login", "android")).rejects.toThrow(ScenarioNotFoundError);
  });

  it("throws for non-existent", async () => {
    await expect(store.delete("nope", "android")).rejects.toThrow(ScenarioNotFoundError);
  });
});

// ── List ──

describe("list", () => {
  it("returns all scenarios", async () => {
    await store.save(makeScenario("login", "android"));
    await store.save(makeScenario("home", "android"));
    const entries = await store.list();
    expect(entries.length).toBe(2);
  });

  it("filters by platform", async () => {
    await store.save(makeScenario("login", "android"));
    await store.save(makeScenario("login", "ios"));
    const androidOnly = await store.list("android");
    expect(androidOnly.length).toBe(1);
    expect(androidOnly[0].platform).toBe("android");
  });

  it("filters by tag", async () => {
    const s1 = makeScenario("login", "android");
    s1.tags = ["auth"];
    const s2 = makeScenario("home", "android");
    s2.tags = ["main"];
    await store.save(s1);
    await store.save(s2);
    const authOnly = await store.list(undefined, "auth");
    expect(authOnly.length).toBe(1);
    expect(authOnly[0].name).toBe("login");
  });

  it("returns empty for no matches", async () => {
    const entries = await store.list("desktop");
    expect(entries).toEqual([]);
  });
});

// ── Validation ──

describe("validation", () => {
  it("rejects scenario with too many steps", async () => {
    const steps = Array.from({ length: MAX_STEPS_PER_SCENARIO + 1 }, (_, i) => makeStep({ index: i }));
    const scenario = makeScenario("big", "android", steps);
    // Recompute checksum for the steps
    scenario.checksum = createHash("sha256").update(JSON.stringify(steps)).digest("hex");
    await expect(store.save(scenario)).rejects.toThrow(ValidationError);
  });
});

// ── Env override ──

describe("env override", () => {
  it("uses CLAUDE_MOBILE_SCENARIOS_DIR when set", async () => {
    const customDir = join(tempDir, "custom-scenarios");
    process.env.CLAUDE_MOBILE_SCENARIOS_DIR = customDir;
    try {
      const customStore = new ScenarioStore();
      expect(customStore.getScenariosDir()).toBe(customDir);
    } finally {
      delete process.env.CLAUDE_MOBILE_SCENARIOS_DIR;
    }
  });
});
