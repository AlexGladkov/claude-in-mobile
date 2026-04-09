import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SonicDeviceSource } from "./sonic-device-source.js";

const AGENT_RESPONSE = {
  code: 2000,
  data: { host: "10.0.0.1", port: 7777, agentKey: "test-key" },
};

const DEVICES_RESPONSE = {
  code: 2000,
  data: [
    { udId: "device-001", nickName: "Pixel 7", platform: 1, status: "ONLINE" },
    { udId: "device-002", nickName: "iPhone 15", platform: 2, status: "ONLINE" },
    { udId: "device-003", nickName: "Offline", platform: 1, status: "OFFLINE" },
  ],
};

function mockFetch(agentResp = AGENT_RESPONSE, devicesResp = DEVICES_RESPONSE) {
  return vi.fn().mockImplementation((url: string) => {
    const body = url.includes("/agents") ? agentResp : devicesResp;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  });
}

describe("SonicDeviceSource", () => {
  beforeEach(() => { vi.stubGlobal("fetch", mockFetch()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("fetchOnce builds correct Device objects", async () => {
    const source = new SonicDeviceSource("http://sonic:9090", 1, "token");
    await source.fetchOnce();
    const devices = source.listDevices();
    expect(devices).toHaveLength(3);
    const android = devices.find(d => d.id === "device-001");
    expect(android?.platform).toBe("android");
    expect(android?.name).toBe("Pixel 7");
    expect(android?.state).toBe("ONLINE");
    expect(android?.isSimulator).toBe(false);
    const ios = devices.find(d => d.id === "device-002");
    expect(ios?.platform).toBe("ios");
  });

  it("getConnectionInfo returns agent host/port/key/token", async () => {
    const source = new SonicDeviceSource("http://sonic:9090", 1, "my-token");
    await source.fetchOnce();
    const conn = source.getConnectionInfo();
    expect(conn.agentHost).toBe("10.0.0.1");
    expect(conn.agentPort).toBe(7777);
    expect(conn.key).toBe("test-key");
    expect(conn.token).toBe("my-token");
  });

  it("fetchOnce throws when agentInfo request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 401, json: () => Promise.resolve({ code: 401, message: "Unauthorized" })
    }));
    const source = new SonicDeviceSource("http://sonic:9090", 1, "bad-token");
    await expect(source.fetchOnce()).rejects.toThrow();
  });

  it("second fetchOnce (poll) failure silently preserves cached devices", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    const source = new SonicDeviceSource("http://sonic:9090", 1, "token");
    await source.fetchOnce();
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/agents")) return Promise.resolve({ ok: true, json: () => Promise.resolve(AGENT_RESPONSE) });
      return Promise.reject(new Error("network error"));
    });
    await source.fetchDevicesOnly();
    expect(source.listDevices()).toHaveLength(3);
  });

  it("start() launches poll timer; stop() clears it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const source = new SonicDeviceSource("http://sonic:9090", 1, "token", 5000);
    await source.start();
    expect(source.listDevices()).toHaveLength(3);
    vi.advanceTimersByTime(5000);
    // Allow any pending promises to resolve
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(2);
    source.stop();
    vi.useRealTimers();
  });
});
