import { describe, expect, it, vi } from "vitest";

import type { ToolContext } from "./context.js";
import { desktopTools } from "./desktop-tools.js";

const handler = desktopTools.find((tool) => tool.tool.name === "desktop_windows")!.handler;

describe("desktop_windows", () => {
  it("removes terminal controls and bidi overrides from window titles and IDs", async () => {
    const context = {
      deviceManager: {
        isDesktopRunning: vi.fn(() => true),
        getDesktopClient: () => ({
          getWindowInfo: vi.fn(async () => ({
            windows: [{
              id: "main\u001b[2Jwindow\u202e",
              title: "Demo\u001b]0;spoof\u0007\u061c\u200e\u200f",
              focused: false,
              processId: 123,
              bounds: { x: 0, y: 0, width: 800, height: 600 },
            }],
          })),
        }),
      },
    } as unknown as ToolContext;

    const result = await handler({}, context);
    const text = (result as { text: string }).text;

    expect(text).toContain("mainwindow");
    expect(text).toContain("Demo");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u202e");
    expect(text).not.toContain("\u0007");
    expect(text).not.toContain("\u061c");
    expect(text).not.toContain("\u200e");
    expect(text).not.toContain("\u200f");
  });
});

describe("desktop_focus", () => {
  it("sanitizes caller-supplied window IDs in the success message", async () => {
    const focusWindow = vi.fn(async () => {});
    const context = {
      deviceManager: {
        isDesktopRunning: vi.fn(() => true),
        getDesktopClient: () => ({ focusWindow }),
      },
    } as unknown as ToolContext;
    const focusHandler = desktopTools.find((tool) => tool.tool.name === "desktop_focus")!.handler;
    const windowId = "main\u001b[31mwindow\u202e";

    const result = await focusHandler({ windowId }, context);
    const text = (result as { text: string }).text;

    expect(focusWindow).toHaveBeenCalledWith(windowId);
    expect(text).toContain("mainwindow");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u202e");
  });
});
