import { describe, it, expect, vi, beforeEach } from "vitest";
import { SonicAndroidAdapter } from "./sonic-android-adapter.js";
import type { SonicConnectionInfo } from "./sonic-device-source.js";
import { SonicWsClient } from "./sonic-ws-client.js";

const conn: SonicConnectionInfo = { agentHost: "ZINFOID_05Q", agentPort: 7777, key: "k", token: "t" };
const UDID = "device-001";

// Mock the image utils module
vi.mock("../utils/image.js", () => ({
  getImageDimensions: vi.fn().mockResolvedValue({ width: 1080, height: 1920 })
}));

// Create a mock client factory
function createMockClient() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    sendAndWait: vi.fn(),
    sendForBinary: vi.fn(),
    sendAndCollect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true)
  };
}

describe("SonicAndroidAdapter", () => {
  let adapter: SonicAndroidAdapter;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(async () => {
    mockClient = createMockClient();
    // Spy on the SonicWsClient constructor
    vi.spyOn(SonicWsClient.prototype, 'connect').mockImplementation(mockClient.connect);
    vi.spyOn(SonicWsClient.prototype, 'send').mockImplementation(mockClient.send);
    vi.spyOn(SonicWsClient.prototype, 'sendAndWait').mockImplementation(mockClient.sendAndWait);
    vi.spyOn(SonicWsClient.prototype, 'sendForBinary').mockImplementation(mockClient.sendForBinary);
    vi.spyOn(SonicWsClient.prototype, 'sendAndCollect').mockImplementation(mockClient.sendAndCollect);
    vi.spyOn(SonicWsClient.prototype, 'disconnect').mockImplementation(mockClient.disconnect);
    vi.spyOn(SonicWsClient.prototype, 'isConnected').mockImplementation(mockClient.isConnected);

    // Mock setTimeout to avoid 10s delay in connect()
    vi.useFakeTimers();

    adapter = new SonicAndroidAdapter(UDID, conn);
    const connectPromise = adapter.connect();
    // Advance timers to skip the 10s delay
    await vi.runAllTimersAsync();
    await connectPromise;

    vi.useRealTimers();
  }, 15000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("connect() opens WebSocket with correct URL", () => {
    expect(mockClient.connect).toHaveBeenCalledWith(
      `ws://ZINFOID_05Q:7777/websockets/android/k/${UDID}/t`
    );
  });

  it("tap() sends correct JSON with coordinate conversion", async () => {
    // With screen size 1080x1920, relative (100, 200) -> absolute (108, 384)
    await adapter.tap(100, 200);
    expect(mockClient.send).toHaveBeenCalledWith({ type: "debug", detail: "tap", point: "108,384" });
  });

  it("swipe() sends correct JSON with coordinate conversion", async () => {
    // With screen size 1080x1920:
    // relative (0, 500) -> absolute (0, 960)
    // relative (0, 100) -> absolute (0, 192)
    await adapter.swipe(0, 500, 0, 100, 300);
    expect(mockClient.send).toHaveBeenCalledWith({
      type: "debug", detail: "swipe", pointA: "0,960", pointB: "0,192"
    });
  });

  it("inputText() sends text message", async () => {
    await adapter.inputText("hello");
    expect(mockClient.send).toHaveBeenCalledWith({ type: "text", detail: "hello" });
  });

  it("screenshotAsync() sends screenshot command and returns buffer as base64", async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff]);
    mockClient.sendForBinary.mockResolvedValue(buf);
    const result = await adapter.screenshotAsync(false);
    expect(mockClient.sendForBinary).toHaveBeenCalledWith({ type: "debug", detail: "screenshot" }, expect.any(Number));
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.data).toBe(buf.toString("base64"));
  });

  it("getUiHierarchy() sends tree command and returns detail as JSON string", async () => {
    mockClient.sendAndWait.mockResolvedValue({ msg: "tree", detail: { root: "node" } });
    const result = await adapter.getUiHierarchy();
    expect(mockClient.sendAndWait).toHaveBeenCalledWith({ type: "debug", detail: "tree" }, "tree", expect.any(Number));
    expect(JSON.parse(result)).toMatchObject({ root: "node" });
  });

  it("launchApp() sends openApp command", async () => {
    await adapter.launchApp("com.example.app");
    expect(mockClient.send).toHaveBeenCalledWith({ type: "debug", detail: "openApp", pkg: "com.example.app" });
  });

  it("uninstallApp() waits for uninstallFinish response", async () => {
    // Need to mock sendAndWaitWithError
    const { SonicWsClient } = await import("./sonic-ws-client.js");
    const mockSendAndWaitWithError = vi.fn().mockResolvedValue({ msg: "uninstallFinish", detail: "success" });
    vi.spyOn(SonicWsClient.prototype, 'sendAndWaitWithError').mockImplementation(mockSendAndWaitWithError);

    const result = await adapter.uninstallApp("com.example.app");

    expect(mockSendAndWaitWithError).toHaveBeenCalledWith(
      { type: "uninstallApp", detail: "com.example.app" },
      "uninstallFinish",
      "error",
      60000
    );
    expect(result).toBe("Uninstalled com.example.app");
  });

  it("uninstallApp() throws error when uninstall fails", async () => {
    const { SonicWsClient } = await import("./sonic-ws-client.js");
    const mockSendAndWaitWithError = vi.fn().mockResolvedValue({ msg: "uninstallFinish", detail: "failed" });
    vi.spyOn(SonicWsClient.prototype, 'sendAndWaitWithError').mockImplementation(mockSendAndWaitWithError);

    await expect(adapter.uninstallApp("com.example.app")).rejects.toThrow("Uninstall failed: failed");
  });

  it("dispose() disconnects WebSocket", async () => {
    await adapter.dispose();
    expect(mockClient.disconnect).toHaveBeenCalled();
  });

  it("platform is android", () => {
    expect(adapter.platform).toBe("android");
  });
});
