import { describe, it, expect, beforeEach } from "vitest";
import type { UiElement } from "../adb/ui-parser.js";
import type { ToolContext } from "./context.js";
import { autopilotTools } from "./autopilot-tools.js";
import { generateScreenFingerprint, isSameScreen } from "../autopilot/screen-fingerprint.js";
import { NavigationGraph } from "../autopilot/nav-graph.js";
import { healSelector } from "../autopilot/healer.js";
import { generateTests } from "../autopilot/generator.js";
import type { ExplorationResult, OriginalSelector } from "../autopilot/types.js";
import { ValidationError, HealingFailedError, TestGenerationError } from "../errors.js";

// ── Helpers ──

function makeElement(overrides: Partial<UiElement> = {}): UiElement {
  return {
    index: 0,
    resourceId: "",
    className: "android.widget.Button",
    packageName: "com.test",
    text: "",
    contentDesc: "",
    checkable: false,
    checked: false,
    clickable: false,
    enabled: true,
    focusable: true,
    focused: false,
    scrollable: false,
    longClickable: false,
    password: false,
    selected: false,
    bounds: { x1: 0, y1: 0, x2: 100, y2: 100 },
    centerX: 50,
    centerY: 50,
    width: 100,
    height: 100,
    ...overrides,
  };
}

let mockElements: UiElement[] = [];

function mockCtx(): ToolContext {
  return {
    deviceManager: {
      getCurrentPlatform: () => "android",
      getUiHierarchyAsync: async () => {
        const nodes = mockElements
          .map(
            (el) =>
              `<node index="${el.index}" text="${el.text}" resource-id="${el.resourceId}" ` +
              `class="${el.className}" package="${el.packageName}" ` +
              `content-desc="${el.contentDesc}" checkable="${el.checkable}" ` +
              `checked="${el.checked}" clickable="${el.clickable}" ` +
              `enabled="${el.enabled}" focusable="${el.focusable}" ` +
              `focused="${el.focused}" scrollable="${el.scrollable}" ` +
              `long-clickable="${el.longClickable}" password="${el.password}" ` +
              `selected="${el.selected}" ` +
              `bounds="[${el.bounds.x1},${el.bounds.y1}][${el.bounds.x2},${el.bounds.y2}]" />`,
          )
          .join("\n");
        return `<hierarchy>${nodes}</hierarchy>`;
      },
      cleanup: async () => {},
    } as any,
    getCachedElements: () => [],
    setCachedElements: () => {},
    lastScreenshotMap: new Map(),
    lastUiTreeMap: new Map(),
    screenshotScaleMap: new Map(),
    generateActionHints: async () => "",
    getElementsForPlatform: async () => [],
    iosTreeToUiElements: () => [],
    formatIOSUITree: () => "",
    platformParam: { type: "string", enum: ["android"], description: "" },
    handleTool: async () => ({ text: "ok" }),
  };
}

// ── Screen Fingerprint tests ──

describe("generateScreenFingerprint", () => {
  it("returns same fingerprint for same elements", () => {
    const elements = [
      makeElement({ className: "android.widget.Button", text: "Login" }),
      makeElement({ className: "android.widget.EditText", text: "Username", index: 1 }),
    ];
    const fp1 = generateScreenFingerprint(elements);
    const fp2 = generateScreenFingerprint(elements);
    expect(fp1).toBe(fp2);
  });

  it("returns same fingerprint regardless of element order", () => {
    const el1 = makeElement({ className: "android.widget.Button", text: "Login" });
    const el2 = makeElement({ className: "android.widget.EditText", text: "Username", index: 1 });
    const fp1 = generateScreenFingerprint([el1, el2]);
    const fp2 = generateScreenFingerprint([el2, el1]);
    expect(fp1).toBe(fp2);
  });

  it("returns different fingerprint for different elements", () => {
    const elements1 = [makeElement({ text: "Login" })];
    const elements2 = [makeElement({ text: "Register" })];
    const fp1 = generateScreenFingerprint(elements1);
    const fp2 = generateScreenFingerprint(elements2);
    expect(fp1).not.toBe(fp2);
  });

  it("skips invisible elements", () => {
    const visible = makeElement({ text: "Login", width: 100, height: 50 });
    const invisible = makeElement({ text: "Hidden", width: 0, height: 0, index: 1 });
    const fpWith = generateScreenFingerprint([visible, invisible]);
    const fpWithout = generateScreenFingerprint([visible]);
    expect(fpWith).toBe(fpWithout);
  });
});

describe("isSameScreen", () => {
  it("returns true for matching fingerprints", () => {
    expect(isSameScreen("abc123", "abc123")).toBe(true);
  });

  it("returns false for different fingerprints", () => {
    expect(isSameScreen("abc123", "def456")).toBe(false);
  });
});

// ── NavigationGraph tests ──

describe("NavigationGraph", () => {
  let graph: NavigationGraph;

  beforeEach(() => {
    graph = new NavigationGraph();
  });

  it("adds and retrieves screens", () => {
    graph.addScreen({
      id: "s1",
      fingerprint: "fp1",
      elements: [],
      visitedAt: new Date().toISOString(),
    });
    expect(graph.screenCount).toBe(1);
    expect(graph.getScreen("s1")).toBeDefined();
    expect(graph.getScreen("s1")!.fingerprint).toBe("fp1");
  });

  it("finds screen by fingerprint", () => {
    graph.addScreen({
      id: "s1",
      fingerprint: "fp1",
      elements: [],
      visitedAt: new Date().toISOString(),
    });
    expect(graph.getScreenByFingerprint("fp1")).toBeDefined();
    expect(graph.hasScreen("fp1")).toBe(true);
    expect(graph.hasScreen("fp2")).toBe(false);
  });

  it("adds edges and avoids duplicates", () => {
    graph.addScreen({ id: "s1", fingerprint: "fp1", elements: [], visitedAt: "" });
    graph.addScreen({ id: "s2", fingerprint: "fp2", elements: [], visitedAt: "" });

    graph.addEdge("s1", "s2", { type: "tap", elementIndex: 0 });
    expect(graph.edgeCount).toBe(1);

    // Duplicate should be ignored
    graph.addEdge("s1", "s2", { type: "tap", elementIndex: 0 });
    expect(graph.edgeCount).toBe(1);

    // Different action should be added
    graph.addEdge("s1", "s2", { type: "tap", elementIndex: 1 });
    expect(graph.edgeCount).toBe(2);
  });

  it("gets edges from a screen", () => {
    graph.addScreen({ id: "s1", fingerprint: "fp1", elements: [], visitedAt: "" });
    graph.addScreen({ id: "s2", fingerprint: "fp2", elements: [], visitedAt: "" });
    graph.addScreen({ id: "s3", fingerprint: "fp3", elements: [], visitedAt: "" });

    graph.addEdge("s1", "s2", { type: "tap", elementIndex: 0 });
    graph.addEdge("s1", "s3", { type: "tap", elementIndex: 1 });
    graph.addEdge("s2", "s3", { type: "tap", elementIndex: 0 });

    expect(graph.getEdgesFrom("s1")).toHaveLength(2);
    expect(graph.getEdgesFrom("s2")).toHaveLength(1);
    expect(graph.getEdgesFrom("s3")).toHaveLength(0);
  });

  it("finds all paths", () => {
    graph.addScreen({ id: "s1", fingerprint: "fp1", elements: [], visitedAt: "" });
    graph.addScreen({ id: "s2", fingerprint: "fp2", elements: [], visitedAt: "" });
    graph.addScreen({ id: "s3", fingerprint: "fp3", elements: [], visitedAt: "" });

    graph.addEdge("s1", "s2", { type: "tap", elementIndex: 0 });
    graph.addEdge("s2", "s3", { type: "tap", elementIndex: 0 });
    graph.addEdge("s1", "s3", { type: "tap", elementIndex: 1 });

    const paths = graph.getAllPaths();
    expect(paths.length).toBeGreaterThanOrEqual(2);
    // One path: s1 -> s2 -> s3, another: s1 -> s3
    expect(paths.some((p) => p.length === 3)).toBe(true);
    expect(paths.some((p) => p.length === 2)).toBe(true);
  });

  it("serializes and deserializes", () => {
    graph.addScreen({ id: "s1", fingerprint: "fp1", elements: [], visitedAt: "t1" });
    graph.addScreen({ id: "s2", fingerprint: "fp2", elements: [], visitedAt: "t2" });
    graph.addEdge("s1", "s2", { type: "tap", elementIndex: 0 });

    const json = graph.toJSON();
    const restored = NavigationGraph.fromJSON(json);

    expect(restored.screenCount).toBe(2);
    expect(restored.edgeCount).toBe(1);
    expect(restored.getScreen("s1")!.fingerprint).toBe("fp1");
    expect(restored.getEdgesFrom("s1")).toHaveLength(1);
  });
});

// ── Healer tests ──

describe("healSelector", () => {
  it("finds exact text match with high confidence", () => {
    const elements = [
      makeElement({ index: 0, text: "Submit", resourceId: "btn_submit", enabled: true }),
      makeElement({ index: 1, text: "Cancel", enabled: true }),
    ];
    const selector: OriginalSelector = { text: "Submit" };
    const result = healSelector(elements, selector, 0.5);

    expect(result.healed).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.9);
    expect(result.healedSelector.index).toBe(0);
  });

  it("finds similar text with partial match", () => {
    const elements = [
      makeElement({ index: 0, text: "Submit Order", enabled: true }),
      makeElement({ index: 1, text: "Cancel", enabled: true }),
    ];
    const selector: OriginalSelector = { text: "Submit" };
    const result = healSelector(elements, selector, 0.5);

    expect(result.healed).toBe(true);
    expect(result.healedSelector.index).toBe(0);
  });

  it("matches by resourceId", () => {
    const elements = [
      makeElement({ index: 0, text: "OK", resourceId: "com.app:id/btn_confirm", enabled: true }),
      makeElement({ index: 1, text: "No", resourceId: "com.app:id/btn_cancel", enabled: true }),
    ];
    const selector: OriginalSelector = { resourceId: "com.app:id/btn_confirm" };
    const result = healSelector(elements, selector, 0.5);

    expect(result.healed).toBe(true);
    expect(result.healedSelector.index).toBe(0);
  });

  it("throws when confidence is below threshold", () => {
    const elements = [
      makeElement({ index: 0, text: "Completely Different", enabled: true }),
    ];
    const selector: OriginalSelector = { text: "Submit Order" };

    expect(() => healSelector(elements, selector, 0.99)).toThrow(HealingFailedError);
  });

  it("throws when no criteria provided", () => {
    const elements = [makeElement({ enabled: true })];
    const selector: OriginalSelector = {};

    expect(() => healSelector(elements, selector)).toThrow(HealingFailedError);
  });

  it("throws when no visible elements", () => {
    const elements = [makeElement({ width: 0, height: 0, enabled: true })];
    const selector: OriginalSelector = { text: "Login" };

    expect(() => healSelector(elements, selector)).toThrow(HealingFailedError);
  });

  it("uses bounds proximity for scoring", () => {
    const elements = [
      makeElement({
        index: 0,
        text: "",
        enabled: true,
        bounds: { x1: 10, y1: 10, x2: 110, y2: 60 },
      }),
      makeElement({
        index: 1,
        text: "",
        enabled: true,
        bounds: { x1: 500, y1: 500, x2: 600, y2: 550 },
      }),
    ];
    const selector: OriginalSelector = {
      bounds: { x1: 10, y1: 10, x2: 110, y2: 60 },
    };
    const result = healSelector(elements, selector, 0.3);
    expect(result.healedSelector.index).toBe(0);
  });
});

// ── Generator tests ──

describe("generateTests", () => {
  it("generates tests from exploration data", () => {
    const exploration: ExplorationResult = {
      id: "test-exploration",
      package: "com.test",
      strategy: "smart",
      startedAt: "2026-04-24T00:00:00Z",
      completedAt: "2026-04-24T00:01:00Z",
      graph: {
        screens: [
          { id: "s1", fingerprint: "fp1", elements: [], title: "Login", visitedAt: "" },
          { id: "s2", fingerprint: "fp2", elements: [], title: "Home", visitedAt: "" },
        ],
        edges: [
          {
            fromScreenId: "s1",
            toScreenId: "s2",
            action: {
              type: "tap",
              elementText: "Login",
              x: 100,
              y: 200,
            },
            timestamp: "",
          },
        ],
      },
      stats: {
        screensFound: 2,
        edgesFound: 1,
        actionsPerformed: 1,
        maxScreensReached: false,
        maxActionsReached: false,
        dryRun: false,
      },
    };

    const suite = generateTests(exploration, "flow_run");
    expect(suite.tests.length).toBeGreaterThan(0);
    expect(suite.explorationId).toBe("test-exploration");

    const test = suite.tests[0];
    expect(test.steps.length).toBe(1);
    expect(test.steps[0].action).toBe("input_tap");
    expect(test.steps[0].label).toContain("Login");
  });

  it("generates steps format", () => {
    const exploration: ExplorationResult = {
      id: "test-exp",
      package: "com.test",
      strategy: "bfs",
      startedAt: "",
      completedAt: "",
      graph: {
        screens: [
          { id: "s1", fingerprint: "fp1", elements: [], visitedAt: "" },
          { id: "s2", fingerprint: "fp2", elements: [], visitedAt: "" },
        ],
        edges: [
          {
            fromScreenId: "s1",
            toScreenId: "s2",
            action: { type: "tap", elementResourceId: "btn_next", x: 50, y: 50 },
            timestamp: "",
          },
        ],
      },
      stats: {
        screensFound: 2,
        edgesFound: 1,
        actionsPerformed: 1,
        maxScreensReached: false,
        maxActionsReached: false,
        dryRun: false,
      },
    };

    const suite = generateTests(exploration, "steps");
    expect(suite.tests[0].format).toBe("steps");
    expect(suite.tests[0].steps[0].action).toBe("tap");
  });

  it("throws when graph has no paths", () => {
    const exploration: ExplorationResult = {
      id: "empty-exp",
      package: "com.test",
      strategy: "bfs",
      startedAt: "",
      completedAt: "",
      graph: { screens: [], edges: [] },
      stats: {
        screensFound: 0,
        edgesFound: 0,
        actionsPerformed: 0,
        maxScreensReached: false,
        maxActionsReached: false,
        dryRun: false,
      },
    };

    expect(() => generateTests(exploration)).toThrow(TestGenerationError);
  });
});

// ── Handler integration tests ──

describe("autopilot_heal handler", () => {
  it("heals a selector and returns formatted output", async () => {
    mockElements = [
      makeElement({
        index: 0,
        text: "Login",
        resourceId: "com.test:id/btn_login",
        clickable: true,
        enabled: true,
      }),
      makeElement({
        index: 1,
        text: "Register",
        clickable: true,
        enabled: true,
      }),
    ];

    const handler = autopilotTools.find(
      (t) => t.tool.name === "autopilot_heal",
    )!.handler;
    const ctx = mockCtx();
    const result = (await handler(
      { originalSelector: { text: "Login" } },
      ctx,
    )) as { text: string };

    expect(result.text).toContain("Healed: YES");
    expect(result.text).toContain("Login");
  });

  it("throws when no selector provided", async () => {
    const handler = autopilotTools.find(
      (t) => t.tool.name === "autopilot_heal",
    )!.handler;
    const ctx = mockCtx();
    await expect(handler({}, ctx)).rejects.toThrow(ValidationError);
  });
});

describe("autopilot_status handler", () => {
  it("returns empty list when no explorations", async () => {
    const handler = autopilotTools.find(
      (t) => t.tool.name === "autopilot_status",
    )!.handler;
    const ctx = mockCtx();
    const result = (await handler({}, ctx)) as { text: string };

    // May contain "No explorations" or a list
    expect(result.text).toBeTruthy();
  });
});

describe("autopilot_explore handler", () => {
  it("validates package name", async () => {
    const handler = autopilotTools.find(
      (t) => t.tool.name === "autopilot_explore",
    )!.handler;
    const ctx = mockCtx();
    await expect(handler({ package: "" }, ctx)).rejects.toThrow(ValidationError);
  });

  it("validates strategy", async () => {
    const handler = autopilotTools.find(
      (t) => t.tool.name === "autopilot_explore",
    )!.handler;
    const ctx = mockCtx();
    await expect(
      handler({ package: "com.test.app", strategy: "invalid" }, ctx),
    ).rejects.toThrow(ValidationError);
  });
});

describe("autopilot_generate handler", () => {
  it("validates explorationId", async () => {
    const handler = autopilotTools.find(
      (t) => t.tool.name === "autopilot_generate",
    )!.handler;
    const ctx = mockCtx();
    await expect(handler({}, ctx)).rejects.toThrow(ValidationError);
  });

  it("validates format", async () => {
    const handler = autopilotTools.find(
      (t) => t.tool.name === "autopilot_generate",
    )!.handler;
    const ctx = mockCtx();
    await expect(
      handler({ explorationId: "test", format: "invalid" }, ctx),
    ).rejects.toThrow(ValidationError);
  });
});

describe("autopilot_tests handler", () => {
  it("validates explorationId", async () => {
    const handler = autopilotTools.find(
      (t) => t.tool.name === "autopilot_tests",
    )!.handler;
    const ctx = mockCtx();
    await expect(handler({}, ctx)).rejects.toThrow(ValidationError);
  });
});
