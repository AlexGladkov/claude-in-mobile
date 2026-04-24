import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLiteTools, type LiteToolDefinition } from "./definitions.js";

// Mock DeviceManager
function createMockDM() {
  return {
    tap: vi.fn().mockResolvedValue(undefined),
    swipeDirection: vi.fn().mockResolvedValue(undefined),
    inputText: vi.fn().mockResolvedValue(undefined),
    pressKey: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue({ data: "base64data", mimeType: "image/jpeg" }),
    getUiHierarchy: vi.fn().mockResolvedValue(
      '<node text="Login" class="android.widget.Button" bounds="[100,300][200,400]">\n' +
      '<node text="Username" class="android.widget.EditText" bounds="[50,100][300,150]">\n' +
      '<node text="Password" class="android.widget.EditText" bounds="[50,200][300,250]">\n'
    ),
    launchApp: vi.fn().mockReturnValue("Launched com.example.app"),
    getSystemInfo: vi.fn().mockResolvedValue("Android 14, 1080x2400"),
    cleanup: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe("Lite Tool Definitions", () => {
  let tools: LiteToolDefinition[];
  let toolMap: Map<string, LiteToolDefinition>;

  beforeEach(() => {
    tools = createLiteTools();
    toolMap = new Map(tools.map(t => [t.tool.name, t]));
  });

  it("should have exactly 12 tools", () => {
    expect(tools).toHaveLength(12);
  });

  it("should have all expected tool names", () => {
    const names = tools.map(t => t.tool.name).sort();
    expect(names).toEqual([
      "device_info",
      "find_element",
      "get_ui",
      "go_back",
      "launch_app",
      "press_key",
      "screenshot",
      "swipe",
      "tap",
      "tap_text",
      "type_text",
      "wait",
    ]);
  });

  it("should have total JSON schema under 2000 chars (~600 tokens)", () => {
    const totalSchema = JSON.stringify(tools.map(t => t.tool));
    expect(totalSchema.length).toBeLessThan(2000);
  });

  it("should have no tool with more than 3 properties", () => {
    for (const t of tools) {
      const schema = t.tool.inputSchema as any;
      const propCount = Object.keys(schema.properties ?? {}).length;
      expect(propCount).toBeLessThanOrEqual(3);
    }
  });

  describe("tap", () => {
    it("should call dm.tap with coordinates", async () => {
      const dm = createMockDM();
      const result = await toolMap.get("tap")!.handler({ x: 100, y: 200 }, dm);
      expect(dm.tap).toHaveBeenCalledWith(100, 200);
      expect(result).toEqual({ text: "OK" });
    });
  });

  describe("tap_text", () => {
    it("should find element by text and tap center", async () => {
      const dm = createMockDM();
      const result = await toolMap.get("tap_text")!.handler({ text: "Login" }, dm);
      expect(dm.tap).toHaveBeenCalledWith(150, 350);
      expect((result as any).text).toContain("Tapped");
    });

    it("should return error when element not found", async () => {
      const dm = createMockDM();
      const result = await toolMap.get("tap_text")!.handler({ text: "NonExistent" }, dm);
      expect((result as any).isError).toBe(true);
    });
  });

  describe("swipe", () => {
    it("should call dm.swipeDirection", async () => {
      const dm = createMockDM();
      await toolMap.get("swipe")!.handler({ direction: "up" }, dm);
      expect(dm.swipeDirection).toHaveBeenCalledWith("up");
    });
  });

  describe("type_text", () => {
    it("should call dm.inputText", async () => {
      const dm = createMockDM();
      await toolMap.get("type_text")!.handler({ text: "hello" }, dm);
      expect(dm.inputText).toHaveBeenCalledWith("hello");
    });
  });

  describe("press_key", () => {
    it("should call dm.pressKey", async () => {
      const dm = createMockDM();
      await toolMap.get("press_key")!.handler({ key: "ENTER" }, dm);
      expect(dm.pressKey).toHaveBeenCalledWith("ENTER");
    });
  });

  describe("screenshot", () => {
    it("should return image result with low quality", async () => {
      const dm = createMockDM();
      const result = await toolMap.get("screenshot")!.handler({}, dm) as any;
      expect(result.image).toBeDefined();
      expect(result.image.data).toBe("base64data");
      expect(dm.screenshot).toHaveBeenCalledWith(undefined, true, {
        maxWidth: 270,
        maxHeight: 480,
        quality: 40,
      });
    });
  });

  describe("get_ui", () => {
    it("should return formatted UI tree", async () => {
      const dm = createMockDM();
      const result = await toolMap.get("get_ui")!.handler({}, dm) as any;
      expect(result.text).toContain("[0]");
      expect(result.text).toContain("Login");
    });

    it("should limit to 15 elements max", async () => {
      const dm = createMockDM();
      // Generate 20 elements
      const lines = Array.from({ length: 20 }, (_, i) =>
        `<node text="Item${i}" class="android.widget.TextView" bounds="[0,${i*50}][100,${i*50+40}]">`
      ).join("\n");
      dm.getUiHierarchy.mockResolvedValue(lines);

      const result = await toolMap.get("get_ui")!.handler({}, dm) as any;
      const outputLines = result.text.split("\n");
      // 15 elements + 1 "... N more elements" line
      expect(outputLines.length).toBe(16);
      expect(outputLines[15]).toContain("5 more elements");
    });
  });

  describe("find_element", () => {
    it("should find matching elements", async () => {
      const dm = createMockDM();
      const result = await toolMap.get("find_element")!.handler({ text: "Login" }, dm) as any;
      expect(result.text).toContain("Login");
    });

    it("should return error when no match", async () => {
      const dm = createMockDM();
      const result = await toolMap.get("find_element")!.handler({ text: "NoMatch" }, dm) as any;
      expect(result.isError).toBe(true);
    });
  });

  describe("launch_app", () => {
    it("should call dm.launchApp", async () => {
      const dm = createMockDM();
      const result = await toolMap.get("launch_app")!.handler({ package: "com.example.app" }, dm) as any;
      expect(dm.launchApp).toHaveBeenCalledWith("com.example.app");
      expect(result.text).toContain("Launched");
    });
  });

  describe("go_back", () => {
    it("should press BACK key", async () => {
      const dm = createMockDM();
      await toolMap.get("go_back")!.handler({}, dm);
      expect(dm.pressKey).toHaveBeenCalledWith("BACK");
    });
  });

  describe("wait", () => {
    it("should wait default 1000ms", async () => {
      const dm = createMockDM();
      const start = Date.now();
      const result = await toolMap.get("wait")!.handler({}, dm) as any;
      expect(result.text).toBe("Waited 1000ms");
    });

    it("should wait custom ms", async () => {
      const dm = createMockDM();
      const result = await toolMap.get("wait")!.handler({ ms: 500 }, dm) as any;
      expect(result.text).toBe("Waited 500ms");
    });
  });

  describe("device_info", () => {
    it("should return system info", async () => {
      const dm = createMockDM();
      const result = await toolMap.get("device_info")!.handler({}, dm) as any;
      expect(result.text).toContain("Android 14");
    });
  });
});
