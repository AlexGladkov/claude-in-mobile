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

    it("tap() converts coordinates using logic screen size", async () => {
      const adapter = new SonicIosAdapter(UDID, conn);
      await adapter.connect();

      // Tap at physical coordinates (300, 600)
      // factorX = 1170 / 390 = 3
      // factorY = 2532 / 844 = 3
      // logical x = 300 / 3 = 100
      // logical y = 600 / 3 = 200
      await adapter.tap(300, 600);

      const sendCall = mockClientMethods.send.mock.calls.find(c => c[0].detail === "tap");
      expect(sendCall[0].point).toBe("100,200");
    });

    it("longPress() converts coordinates using logic screen size", async () => {
      const adapter = new SonicIosAdapter(UDID, conn);
      await adapter.connect();

      // Long press at physical coordinates (600, 900)
      // factorX = 1170 / 390 = 3
      // factorY = 2532 / 844 = 3
      // logical x = 600 / 3 = 200
      // logical y = 900 / 3 = 300
      await adapter.longPress(600, 900);

      const sendCall = mockClientMethods.send.mock.calls.find(c => c[0].detail === "longPress");
      expect(sendCall[0].point).toBe("200,300");
    });

    it("swipe() converts both points using logic screen size", async () => {
      const adapter = new SonicIosAdapter(UDID, conn);
      await adapter.connect();

      // Swipe from physical (900, 1200) to (1800, 2400)
      // factorX = 1170 / 390 = 3
      // factorY = 2532 / 844 = 3
      // logical start: (900/3, 1200/3) = (300, 400)
      // logical end: (1800/3, 2400/3) = (600, 800)
      await adapter.swipe(900, 1200, 1800, 2400);

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

    it("tap() sends correct JSON", async () => {
      const adapter = new SonicIosAdapter(UDID, conn);
      await adapter.connect();

      await adapter.tap(50, 100);
      // 50 / 3 = 16.67 -> 17, 100 / 3 = 33.33 -> 33
      expect(mockClientMethods.send).toHaveBeenCalledWith({ type: "debug", detail: "tap", point: "17,33" });
    });

    it("inputText() uses 'send' type (not 'text')", async () => {
      const adapter = new SonicIosAdapter(UDID, conn);
      await adapter.connect();

      await adapter.inputText("hello");
      expect(mockClientMethods.send).toHaveBeenCalledWith({ type: "send", detail: "hello" });
    });

    it("launchApp() waits for launchResult", async () => {
      mockClientMethods.sendAndWait.mockResolvedValue({ msg: "launchResult", pkg: "com.example", status: "success" });

      const adapter = new SonicIosAdapter(UDID, conn);
      await adapter.connect();

      await adapter.launchApp("com.example");
      expect(mockClientMethods.sendAndWait).toHaveBeenCalledWith(
        { type: "launch", pkg: "com.example" }, "launchResult", expect.any(Number)
      );
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
