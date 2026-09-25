import { describe, expect, it, vi } from "vitest";
import type { DeviceManager } from "../device-manager.js";
import type { ToolContext } from "./context.js";
import { interactionTools } from "./interaction-tools.js";

function makeContext(iosClient: Record<string, unknown>) {
  const doubleTap = vi.fn();
  const ctx: ToolContext = {
    deviceManager: {
      getCurrentPlatform: vi.fn(() => "ios"),
      getIosClient: vi.fn(() => iosClient),
      doubleTap,
    } as unknown as DeviceManager,
    getCachedElements: vi.fn(() => []),
    setCachedElements: vi.fn(),
    lastScreenshotMap: new Map(),
    lastUiTreeMap: new Map(),
    screenshotScaleMap: new Map(),
    generateActionHints: vi.fn(async () => ""),
    getElementsForPlatform: vi.fn(async () => []),
    iosTreeToUiElements: vi.fn(() => []),
    formatIOSUITree: vi.fn(() => ""),
    invalidateUiTreeCache: vi.fn(),
    platformParam: {} as ToolContext["platformParam"],
    handleTool: vi.fn(async () => ({ text: "ok" })),
    turboDefault: false,
  };
  return { ctx, doubleTap };
}

function findDoubleTapHandler() {
  const definition = interactionTools.find((entry) => entry.tool.name === "input_double_tap");
  if (!definition) throw new Error("input_double_tap tool is not registered");
  return definition.handler;
}

function findInputTextHandler() {
  const definition = interactionTools.find((entry) => entry.tool.name === "input_text");
  if (!definition) throw new Error("input_text tool is not registered");
  return definition.handler;
}


describe("input_double_tap iOS target resolution", () => {
  it("rejects a rect-less WDA element without dispatching sentinel coordinates", async () => {
    const iosClient = {
      findElement: vi.fn(async () => ({ ELEMENT: "element-1" })),
      getElementRect: vi.fn(async () => null),
      findElements: vi.fn(async () => []),
      getScreenPointSize: vi.fn(async () => ({ width: 390, height: 844 })),
    };
    const { ctx, doubleTap } = makeContext(iosClient);

    await expect(
      findDoubleTapHandler()({ platform: "ios", text: "Target", hints: false }, ctx),
    ).rejects.toThrow("target-aware double tap");

    expect(doubleTap).not.toHaveBeenCalled();
    expect(iosClient.getElementRect).toHaveBeenCalledWith("element-1");
  });

  it("uses a target-aware WDA double-tap method when available", async () => {
    const doubleTapElement = vi.fn(async () => {});
    const iosClient = {
      findElement: vi.fn(async () => ({ ELEMENT: "element-2" })),
      getElementRect: vi.fn(async () => null),
      doubleTapElement,
      findElements: vi.fn(async () => []),
      getScreenPointSize: vi.fn(async () => ({ width: 390, height: 844 })),
    };
    const { ctx, doubleTap } = makeContext(iosClient);

    await findDoubleTapHandler()({ platform: "ios", text: "Target", interval: 125, hints: false }, ctx);

    expect(doubleTapElement).toHaveBeenCalledWith("element-2", 125);
    expect(doubleTap).not.toHaveBeenCalled();
  });
});

describe("input_text cancellation", () => {
  it("forwards the flow abort signal to the device manager", async () => {
    const { ctx } = makeContext({});
    const inputText = vi.fn(async () => {});
    ctx.deviceManager.inputText = inputText as unknown as DeviceManager["inputText"];
    const signal = new AbortController().signal;
    ctx.signal = signal;

    await findInputTextHandler()(
      { text: "typed value", hints: false, platform: "android" },
      ctx,
    );

    expect(inputText).toHaveBeenCalledWith(
      "typed value",
      "android",
      undefined,
      undefined,
      signal,
    );
  });
});
