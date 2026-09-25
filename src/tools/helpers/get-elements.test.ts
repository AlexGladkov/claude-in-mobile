import { describe, expect, it, vi } from "vitest";

import { DeviceManager } from "../../device-manager.js";
import type { CorePlatformAdapter } from "../../adapters/platform-adapter.js";
import { InMemoryRegistry } from "../../kernel/registry.js";
import type { PluginUiElement } from "@mcp-devices/plugin-api";
import type { ToolContext } from "../context.js";
import { uiTree } from "../ui/tree.js";
import { findElements } from "../../ui-tree/ui-parser.js";
import {
  getUiElements,
  MAX_PLUGIN_UI_DEPTH,
  MAX_PLUGIN_UI_NODES,
  MAX_PLUGIN_UI_STRING_CHARS,
  MAX_PLUGIN_UI_TOTAL_STRING_CHARS,
  normalizePluginUiElements,
} from "./get-elements.js";

function makeContext(deviceManager: DeviceManager): ToolContext {
  return {
    deviceManager,
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
}

describe("external platform UI providers", () => {
  it("routes generic UI extraction through normalized records instead of XML", async () => {
    const getUiHierarchy = vi.fn(async () => "not Android XML");
    const getUiElementsProvider = vi.fn(async () => [
      {
        id: "submit",
        role: "button",
        text: "Continue",
        clickable: true,
        bounds: { x: 10, y: 20, width: 100, height: 40 },
      },
    ]);
    const adapter = {
      platform: "tizen",
      listDevices: () => [],
      selectDevice: () => {},
      getSelectedDeviceId: () => "tizen-1",
      autoDetectDevice: () => undefined,
      tap: async () => {},
      doubleTap: async () => {},
      longPress: async () => {},
      swipe: async () => {},
      swipeDirection: async () => {},
      inputText: async () => {},
      pressKey: async () => {},
      screenshotAsync: async () => ({ data: "", mimeType: "image/png" }),
      getScreenshotBufferAsync: async () => Buffer.alloc(0),
      getUiHierarchy,
      getUiElements: getUiElementsProvider,
      getSystemInfo: async () => "{}",
    } as unknown as CorePlatformAdapter;
    const deviceManager = new DeviceManager({
      adapters: new Map([["tizen", adapter]]),
      activeTarget: "tizen",
    });

    const result = await getUiElements(makeContext(deviceManager), "tizen", "tizen-2");

    expect(getUiElementsProvider).toHaveBeenCalledWith("tizen-2");
    expect(getUiHierarchy).not.toHaveBeenCalled();
    expect(result.rawTree).toBeUndefined();
    expect(result.elements[0]).toMatchObject({
      resourceId: "submit",

      className: "button",
      text: "Continue",
      clickable: true,
      width: 100,
      height: 40,
    });
  });
});

describe("browser UI provider routing", () => {
  it("normalizes accessibility records instead of parsing the browser snapshot as XML", async () => {
    const getUiHierarchy = vi.fn(async () => `[Example]\n\nbutton "wrong path"`);
    const getUiElementsProvider = vi.fn(async () => [{
      role: "button",
      label: "Open settings",
      clickable: true,
      bounds: { x: 30, y: 40, width: 120, height: 44 },
    }]);
    const adapter = {
      platform: "browser",
      listDevices: () => [],
      selectDevice: () => {},
      getSelectedDeviceId: () => "browser",
      autoDetectDevice: () => undefined,
      tap: async () => {},
      doubleTap: async () => {},
      longPress: async () => {},
      swipe: async () => {},
      swipeDirection: async () => {},
      inputText: async () => {},
      pressKey: async () => {},
      screenshotAsync: async () => ({ data: "", mimeType: "image/png" }),
      getScreenshotBufferAsync: async () => Buffer.alloc(0),
      getUiHierarchy,
      getUiElements: getUiElementsProvider,
      getSystemInfo: async () => "{}",
    } as unknown as CorePlatformAdapter;
    const deviceManager = new DeviceManager({
      adapters: new Map([["browser", adapter]]),
      activeTarget: "browser",
    });

    const result = await getUiElements(makeContext(deviceManager), "browser");

    expect(getUiElementsProvider).toHaveBeenCalledWith(undefined);
    expect(getUiHierarchy).not.toHaveBeenCalled();
    expect(result.elements).toMatchObject([
      { className: "button", text: "Open settings", clickable: true },
    ]);
  });
});
describe("normalized provider trust boundary", () => {
  it("registers a provider-only external adapter and routes ui_tree output", async () => {
    const getUiElementsProvider = vi.fn(async () => [{
      id: "continue",
      role: "button",
      text: "Continue",
      clickable: true,
      bounds: { x: 10, y: 20, width: 100, height: 40 },
    }]);
    const adapter = {
      platform: "tizen",
      listDevices: () => [],
      selectDevice: () => {},
      getSelectedDeviceId: () => "tizen-1",
      autoDetectDevice: () => undefined,
      tap: async () => {},
      doubleTap: async () => {},
      longPress: async () => {},
      swipe: async () => {},
      swipeDirection: async () => {},
      inputText: async () => {},
      pressKey: async () => {},
      screenshotAsync: async () => ({ data: "", mimeType: "image/png" }),
      getScreenshotBufferAsync: async () => Buffer.alloc(0),
      getUiElements: getUiElementsProvider,
      getSystemInfo: async () => "{}",
    };
    const registry = new InMemoryRegistry();
    registry.register({
      manifest: {
        id: "tizen-provider",
        name: "Tizen provider",
        version: "1.0.0",
        apiVersion: "1",
        capabilities: ["ui"],
      },
      init: () => {},
      adapter,
    });
    const entry = registry.get("tizen-provider");
    if (!entry) throw new Error("provider plugin was not registered");
    entry.state = "active";

    const deviceManager = DeviceManager.fromKernel({ registry });
    const result = await uiTree.handler(
      {
        platform: "tizen",
        showAll: false,
        compact: false,
        fresh: true,
      } as never,
      makeContext(deviceManager),
    ) as { content: Array<{ text: string }> };
    const output = result.content.map((part) => part.text).join("\n");

    expect(getUiElementsProvider).toHaveBeenCalledWith(undefined);
    expect(output).toContain("Continue");
    expect(output).not.toContain("No UI elements found");
  });
  it("omits hidden records and their descendants from generic matching", () => {
    const elements = normalizePluginUiElements([
      {
        id: "top-hidden",
        role: "button",
        text: "Top hidden action",
        visible: false,
        clickable: true,
        children: [{
          id: "top-hidden-child",
          role: "button",
          text: "Top hidden child action",
          visible: true,
          clickable: true,
        }],
      },
      {
        id: "root",
        role: "group",
        children: [{
          id: "nested-hidden",
          role: "button",
          text: "Nested hidden action",
          visible: false,
          clickable: true,
          children: [{
            id: "nested-hidden-child",
            role: "button",
            text: "Nested hidden child action",
            visible: true,
            clickable: true,
          }],
        }],
      },
      {
        id: "explicit-visible",
        role: "button",
        text: "Explicit visible action",
        visible: true,
        clickable: true,
      },
      {
        id: "implicit-visible",
        role: "button",
        text: "Implicit visible action",
        clickable: true,
      },
    ]);

    expect(elements.map(element => element.resourceId)).toEqual([
      "root",
      "explicit-visible",
      "implicit-visible",
    ]);
    expect(findElements(elements, { text: "Top hidden action", clickable: true }))
      .toHaveLength(0);
    expect(findElements(elements, { text: "Top hidden child action", clickable: true }))
      .toHaveLength(0);
    expect(findElements(elements, { text: "Nested hidden action", clickable: true }))
      .toHaveLength(0);
    expect(findElements(elements, { text: "Nested hidden child action", clickable: true }))
      .toHaveLength(0);
    expect(findElements(elements, { text: "Explicit visible action", clickable: true }))
      .toHaveLength(1);
    expect(findElements(elements, { text: "Implicit visible action", clickable: true }))
      .toHaveLength(1);
  });

  it("rejects cyclic normalized provider records", () => {
    const cyclic = { role: "group", children: [] } as unknown as PluginUiElement;
    (cyclic.children as PluginUiElement[]).push(cyclic);

    expect(() => normalizePluginUiElements([cyclic])).toThrow(/cyclic|repeated/i);
  });

  it("rejects normalized provider records beyond the node bound", () => {
    const records = Array.from(
      { length: MAX_PLUGIN_UI_NODES + 1 },
      () => ({ role: "text" }) as PluginUiElement,
    );

    expect(() => normalizePluginUiElements(records)).toThrow(/node limit/i);
  });

  it("rejects normalized provider records beyond the depth bound", () => {
    let root: PluginUiElement = { role: "group" };
    for (let depth = 0; depth <= MAX_PLUGIN_UI_DEPTH; depth++) {
      root = { role: "group", children: [root] };
    }

    expect(() => normalizePluginUiElements([root])).toThrow(/depth limit/i);
  });
  it("redacts secure provider text and descriptions before normalization", () => {
    const [element] = normalizePluginUiElements([{
      role: "securetextbox",
      password: true,
      id: "credential-value-as-provider-id",
      text: "typed-provider-secret",
      label: "secure provider label",
      contentDesc: "typed-provider-secret",
    }]);

    expect(element).toMatchObject({
      text: "[REDACTED]",
      contentDesc: "[REDACTED]",
      password: true,
      resourceId: "[REDACTED]",
    });
    expect(JSON.stringify(element)).not.toContain("typed-provider-secret");
    expect(JSON.stringify(element)).not.toContain("secure provider label");
  });
  it("redacts value-bearing text entries without password markers", () => {
    const [element] = normalizePluginUiElements([{
      role: "textbox",
      className: "EditText",
      id: "hunter2",
      value: "hunter2",
      label: "hunter2",
    }]);

    expect(element).toMatchObject({
      password: true,
      text: "[REDACTED]",
      contentDesc: "[REDACTED]",
      resourceId: "[REDACTED]",
    });
    expect(JSON.stringify(element)).not.toContain("hunter2");
  });

  it("redacts an explicit provider value without role metadata", () => {
    const secret = "provider-value-only-secret";
    const [element] = normalizePluginUiElements([{ value: secret }]);

    expect(element).toMatchObject({
      password: true,
      text: "[REDACTED]",
    });
    expect(JSON.stringify(element)).not.toContain(secret);
  });

  it("rejects child fanout before exceeding the queued node bound", () => {
    const children = Array.from(
      { length: MAX_PLUGIN_UI_NODES + 1 },
      () => ({ role: "text" }) as PluginUiElement,
    );

    expect(() => normalizePluginUiElements([{ role: "group", children }]))
      .toThrow(/node limit/i);
  });

  it("bounds individual and aggregate provider strings", () => {
    expect(() => normalizePluginUiElements([{
      role: "text",
      text: "x".repeat(MAX_PLUGIN_UI_STRING_CHARS + 1),
    }])).toThrow(/character.*text limit/i);

    const records = Array.from(
      { length: Math.floor(MAX_PLUGIN_UI_TOTAL_STRING_CHARS / MAX_PLUGIN_UI_STRING_CHARS) + 1 },
      () => ({
        role: "text",
        text: "x".repeat(MAX_PLUGIN_UI_STRING_CHARS),
      }) as PluginUiElement,
    );
    expect(() => normalizePluginUiElements(records)).toThrow(/character.*text limit/i);
  });

});
