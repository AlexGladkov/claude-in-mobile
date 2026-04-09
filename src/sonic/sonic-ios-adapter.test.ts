import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SonicIosAdapter } from "./sonic-ios-adapter.js";
import type { SonicConnectionInfo } from "./sonic-device-source.js";
import { SonicWsClient } from "./sonic-ws-client.js";

const conn: SonicConnectionInfo = { agentHost: "10.0.0.1", agentPort: 7777, key: "k", token: "t" };
const UDID = "ios-device-001";

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

describe("SonicIosAdapter", () => {
  let adapter: SonicIosAdapter;
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
    
    adapter = new SonicIosAdapter(UDID, conn);
    await adapter.connect();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("connect() opens WebSocket with iOS path", () => {
    expect(mockClient.connect).toHaveBeenCalledWith(
      `ws://10.0.0.1:7777/websockets/ios/k/${UDID}/t`
    );
  });

  it("tap() sends correct JSON", async () => {
    await adapter.tap(50, 100);
    expect(mockClient.send).toHaveBeenCalledWith({ type: "debug", detail: "tap", point: "50,100" });
  });

  it("inputText() uses 'send' type (not 'text')", async () => {
    await adapter.inputText("hello");
    expect(mockClient.send).toHaveBeenCalledWith({ type: "send", detail: "hello" });
  });

  it("launchApp() waits for launchResult", async () => {
    mockClient.sendAndWait.mockResolvedValue({ msg: "launchResult", pkg: "com.example", status: "success" });
    await adapter.launchApp("com.example");
    expect(mockClient.sendAndWait).toHaveBeenCalledWith(
      { type: "launch", pkg: "com.example" }, "launchResult", expect.any(Number)
    );
  });

  it("getSystemInfo() throws not supported", async () => {
    await expect(adapter.getSystemInfo()).rejects.toThrow("not supported");
  });

  it("platform is ios", () => {
    expect(adapter.platform).toBe("ios");
  });
});
