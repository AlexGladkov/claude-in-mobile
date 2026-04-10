import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SonicIosAdapter } from "./sonic-ios-adapter.js";
import type { SonicConnectionInfo } from "./sonic-device-source.js";

const conn: SonicConnectionInfo = { agentHost: "10.0.0.1", agentPort: 7777, key: "k", token: "t" };
const UDID = "ios-device-001";

// Create mock client methods
const mockClientMethods = {
  connect: vi.fn().mockResolvedValue(undefined),
  send: vi.fn(),
  sendAndWait: vi.fn(),
  sendForBinary: vi.fn().mockResolvedValue(Buffer.from("fake-screenshot")),
  sendAndCollect: vi.fn(),
  sendAndWaitWithError: vi.fn(),
  disconnect: vi.fn(),
  isConnected: vi.fn().mockReturnValue(true)
};

// Mock the sonic-ws-client module with a proper class constructor
vi.mock("./sonic-ws-client.js", () => ({
  SonicWsClient: class MockSonicWsClient {
    connect = mockClientMethods.connect;
    send = mockClientMethods.send;
    sendAndWait = mockClientMethods.sendAndWait;
    sendForBinary = mockClientMethods.sendForBinary;
    sendAndCollect = mockClientMethods.sendAndCollect;
    sendAndWaitWithError = mockClientMethods.sendAndWaitWithError;
    disconnect = mockClientMethods.disconnect;
    isConnected = mockClientMethods.isConnected;
  }
}));

// Mock the image utils module
vi.mock("../utils/image.js", () => ({
  getImageDimensions: vi.fn().mockResolvedValue({ width: 1170, height: 2532 })
}));

describe("SonicIosAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("basic connectivity", () => {
    it("connect() opens WebSocket with iOS path", async () => {
      mockClientMethods.sendAndWaitWithError.mockResolvedValueOnce({
        msg: "openDriver",
        status: "success",
        width: 390,
        height: 844
      });

      const adapter = new SonicIosAdapter(UDID, conn);
      await adapter.connect();

      expect(mockClientMethods.connect).toHaveBeenCalledWith(
        `ws://10.0.0.1:7777/websockets/ios/k/${UDID}/t`
      );
    });

    it("connect() gets logic screen size from openDriver response", async () => {
      mockClientMethods.sendAndWaitWithError.mockResolvedValueOnce({
        msg: "openDriver",
        status: "success",
        width: 390,
        height: 844
      });

      const adapter = new SonicIosAdapter(UDID, conn);
      await adapter.connect();

      expect(mockClientMethods.sendAndWaitWithError).toHaveBeenCalledWith(
        { type: "debug", detail: "openDriver" },
        "openDriver",
        "error",
        60000
      );
    });
  });

  describe("coordinate conversion", () => {
    beforeEach(async () => {
      // Setup for coordinate conversion tests
      mockClientMethods.sendAndWaitWithError.mockResolvedValueOnce({
        msg: "openDriver",
        status: "success",
        width: 390,
        height: 844
      });
    });

    it("tap() converts relative coordinates (0-1000) to logical coordinates", async () => {
      const adapter = new SonicIosAdapter(UDID, conn);
      await adapter.connect();

      // Tap at relative coordinates (256, 237) - approximately 300/1170*1000, 600/2532*1000
      // Step 1: toAbsolute: (256/1000*1170, 237/1000*2532) = (300, 600)
      // Step 2: convertByFactor: factorX = 1170/390 = 3, factorY = 2532/844 = 3
      //         logical = (300/3, 600/3) = (100, 200)
      await adapter.tap(256, 237);

      const sendCall = mockClientMethods.send.mock.calls.find(c => c[0].detail === "tap");
      expect(sendCall[0].point).toBe("100,200");
    });

    it("longPress() converts relative coordinates (0-1000) to logical coordinates", async () => {
      const adapter = new SonicIosAdapter(UDID, conn);
      await adapter.connect();

      // Long press at relative coordinates (513, 355) - approximately 600/1170*1000, 900/2532*1000
      // Step 1: toAbsolute: (513/1000*1170, 355/1000*2532) = (600, 900)
      // Step 2: convertByFactor: factorX = 1170/390 = 3, factorY = 2532/844 = 3
      //         logical = (600/3, 900/3) = (200, 300)
      await adapter.longPress(513, 355);

      const sendCall = mockClientMethods.send.mock.calls.find(c => c[0].detail === "longPress");
      expect(sendCall[0].point).toBe("200,300");
    });

    it("swipe() converts relative coordinates (0-1000) to logical coordinates", async () => {
      const adapter = new SonicIosAdapter(UDID, conn);
      await adapter.connect();

      // Swipe from relative (769, 474) to (1538, 948)
      // Step 1: toAbsolute: (769/1000*1170, 474/1000*2532) = (900, 1200)
      //         toAbsolute: (1538/1000*1170, 948/1000*2532) = (1800, 2400)
      // Step 2: convertByFactor: factorX = 1170/390 = 3, factorY = 2532/844 = 3
      //         logical start: (900/3, 1200/3) = (300, 400)
      //         logical end: (1800/3, 2400/3) = (600, 800)
      await adapter.swipe(769, 474, 1538, 948);

      const sendCall = mockClientMethods.send.mock.calls.find(c => c[0].detail === "swipe");
      expect(sendCall[0].pointA).toBe("300,400");
      expect(sendCall[0].pointB).toBe("600,800");
    });

    it("convertByFactor throws error when logic size not available", async () => {
      const adapter = new SonicIosAdapter(UDID, conn);

      // Try to tap without connecting first
      await expect(adapter.tap(100, 200)).rejects.toThrow("Logic screen size not available");
    });
  });

  describe("existing functionality", () => {
    beforeEach(async () => {
      mockClientMethods.sendAndWaitWithError.mockResolvedValueOnce({
        msg: "openDriver",
        status: "success",
        width: 390,
        height: 844
      });
    });

    it("tap() sends correct JSON with coordinate conversion", async () => {
      const adapter = new SonicIosAdapter(UDID, conn);
      await adapter.connect();

      // Input: relative coordinates (43, 39) - approximately 50/1170*1000, 100/2532*1000
      // Step 1: toAbsolute: (43/1000*1170, 39/1000*2532) = (50, 100)
      // Step 2: convertByFactor: (50/3, 100/3) = (17, 33)
      await adapter.tap(43, 39);
      expect(mockClientMethods.send).toHaveBeenCalledWith({ type: "debug", detail: "tap", point: "17,33" });
    });

    it("inputText() uses 'send' type (not 'text')", async () => {
      const adapter = new SonicIosAdapter(UDID, conn);
      await adapter.connect();

      await adapter.inputText("hello");
      expect(mockClientMethods.send).toHaveBeenCalledWith({ type: "send", detail: "hello" });
    });

    it("launchApp() waits for launchResult", async () => {
      mockClientMethods.sendAndWaitWithError.mockResolvedValue({ msg: "launchResult", pkg: "com.example", status: "success" });

      const adapter = new SonicIosAdapter(UDID, conn);
      await adapter.connect();

      await adapter.launchApp("com.example");
      expect(mockClientMethods.sendAndWaitWithError).toHaveBeenCalledWith(
        { type: "launch", pkg: "com.example" }, "launchResult", "error", expect.any(Number)
      );
    });

    it("launchApp() throws error when launch fails", async () => {
      mockClientMethods.sendAndWaitWithError.mockResolvedValue({
        msg: "launchResult",
        pkg: "com.example",
        status: "failed",
        error: "App not installed"
      });

      const adapter = new SonicIosAdapter(UDID, conn);
      await adapter.connect();

      await expect(adapter.launchApp("com.example")).rejects.toThrow("Launch failed: failed - App not installed");
    });

    it("stopApp() waits for killResult", async () => {
      mockClientMethods.sendAndWaitWithError.mockResolvedValue({ msg: "killResult", pkg: "com.example", status: "success" });

      const adapter = new SonicIosAdapter(UDID, conn);
      await adapter.connect();

      await adapter.stopApp("com.example");
      expect(mockClientMethods.sendAndWaitWithError).toHaveBeenCalledWith(
        { type: "kill", pkg: "com.example" }, "killResult", "error", expect.any(Number)
      );
    });

    it("stopApp() throws error when kill fails", async () => {
      mockClientMethods.sendAndWaitWithError.mockResolvedValue({
        msg: "killResult",
        pkg: "com.example",
        status: "failed",
        error: "Process not found"
      });

      const adapter = new SonicIosAdapter(UDID, conn);
      await adapter.connect();

      await expect(adapter.stopApp("com.example")).rejects.toThrow("Stop failed: failed - Process not found");
    });

    it("getSystemInfo() throws not supported", async () => {
      const adapter = new SonicIosAdapter(UDID, conn);
      await adapter.connect();

      await expect(adapter.getSystemInfo()).rejects.toThrow("not supported");
    });

    it("platform is ios", async () => {
      const adapter = new SonicIosAdapter(UDID, conn);
      await adapter.connect();

      expect(adapter.platform).toBe("ios");
    });
  });
});
