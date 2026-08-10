import { describe, it, expect, vi } from "vitest";
import { interactionTools } from "./interaction-tools.js";
import type { ToolContext } from "./context.js";

function findHandler(name: string) {
  const def = interactionTools.find((t) => t.tool.name === name);
  if (!def) throw new Error(`Tool "${name}" not found in interactionTools`);
  return def.handler;
}

function makeCtx(dm?: any): ToolContext {
  return {
    deviceManager: {
      getCurrentPlatform: vi.fn(() => "android"),
      supportsDrag: vi.fn(() => true),
      drag: vi.fn(async () => {}),
      longPress: vi.fn(async () => {}),
      swipe: vi.fn(async () => {}),
      ...dm,
    },
    invalidateUiTreeCache: vi.fn(),
    generateActionHints: vi.fn(async () => ""),
    screenshotScaleMap: new Map(),
  } as any;
}

describe("input_drag", () => {
  const handler = findHandler("input_drag");

  it("dispatches to deviceManager.drag with scaled coords and options", async () => {
    const drag = vi.fn(async () => {});
    const ctx = makeCtx({ supportsDrag: vi.fn(() => true), drag });

    const res: any = await handler(
      { x1: 10, y1: 20, x2: 30, y2: 40, waypoints: [[15, 25]], grabHoldMs: 500, dwellMs: 200, durationMs: 900 },
      ctx,
    );

    expect(drag).toHaveBeenCalledTimes(1);
    const [x1, y1, x2, y2, opts] = drag.mock.calls[0];
    expect([x1, y1, x2, y2]).toEqual([10, 20, 30, 40]);
    expect(opts).toMatchObject({ grabHoldMs: 500, dwellMs: 200, durationMs: 900 });
    expect(opts.waypoints).toEqual([[15, 25]]);
    expect(res.text).toMatch(/Dragged from \(10, 20\) to \(30, 40\)/);
    expect(res.text).toMatch(/1 waypoint/);
  });

  it("falls back to long_press + swipe when the platform has no native drag", async () => {
    const longPress = vi.fn(async () => {});
    const swipe = vi.fn(async () => {});
    const drag = vi.fn(async () => {});
    const ctx = makeCtx({ supportsDrag: vi.fn(() => false), drag, longPress, swipe });

    const res: any = await handler({ x1: 1, y1: 2, x2: 3, y2: 4 }, ctx);

    expect(drag).not.toHaveBeenCalled();
    expect(longPress).toHaveBeenCalledTimes(1);
    expect(swipe).toHaveBeenCalledTimes(1);
    expect(res.text).toMatch(/approximated with long_press \+ swipe/);
  });

  it("rejects missing coordinates", async () => {
    const ctx = makeCtx();
    await expect(handler({ x1: 1, y1: 2 } as any, ctx)).rejects.toThrow();
  });
});
