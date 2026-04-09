# Sonic Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate Sonic remote device service into claude-in-mobile so that AI agents and CLI users can control Sonic-managed physical Android/iOS devices using the exact same MCP tools and CLI commands as local devices.

**Architecture:** Add `SONIC_ENABLE` env var as a mode switch. When enabled, `SonicDeviceSource` polls the Sonic Server REST API for devices and connection info; `DeviceManager` routes Android/iOS commands to `SonicAndroidAdapter`/`SonicIosAdapter` which communicate via WebSocket to sonic-agent. The `PlatformAdapter` interface is upgraded from sync to async for 9 methods to support WebSocket-based adapters.

**Tech Stack:** TypeScript/Node.js (MCP server) + Rust (CLI). WebSocket via `ws` npm package. HTTP via Node.js 18+ built-in `fetch`. Tests via Vitest. Rust adds `reqwest` (with `blocking` feature) + `tungstenite`.

**Spec:** `docs/superpowers/specs/2026-04-09-sonic-integration-design.md`

---

## File Map

### New files (TypeScript)
- `src/sonic/sonic-device-source.ts` — polls Sonic Server REST API, maintains `Device[]`
- `src/sonic/sonic-ws-client.ts` — WebSocket wrapper: text/binary frames, request-response matching
- `src/sonic/sonic-android-adapter.ts` — `PlatformAdapter` impl for Android via sonic-agent WS
- `src/sonic/sonic-ios-adapter.ts` — `PlatformAdapter` impl for iOS via sonic-agent WS
- `src/sonic/sonic-device-source.test.ts`
- `src/sonic/sonic-ws-client.test.ts`
- `src/sonic/sonic-android-adapter.test.ts`
- `src/sonic/sonic-ios-adapter.test.ts`

### Modified files (TypeScript)
- `src/adapters/platform-adapter.ts` — add `dispose?()`, upgrade 9 methods sync→async
- `src/adapters/android-adapter.ts` — make 9 methods async
- `src/adapters/ios-adapter.ts` — make 9 methods async
- `src/adapters/desktop-adapter.ts` — make 9 methods async
- `src/adapters/aurora-adapter.ts` — make 9 methods async
- `src/device-manager.ts` — make 9 wrappers async, add sonic routing
- `src/index.ts` — SONIC_ENABLE lifecycle
- `src/tools/app-tools.ts` — add `await` to launchApp/stopApp/installApp
- `src/tools/system-tools.ts` — add `await` to shell/getLogs/clearLogs/permissions; Sonic guards
- `src/tools/permission-tools.ts` — add `await` to permission calls
- `src/tools/clipboard-tools.ts` — add Sonic mode guard
- `src/tools/ui-tools.ts` — add Sonic mode guard for iOS element-level bypass
- `src/tools/device-tools.ts` — add `await` to `setDevice` call

### New files (Rust CLI)
- `cli/src/sonic.rs` — device discovery + WebSocket execution for Sonic devices

### Modified files (Rust CLI)
- `cli/Cargo.toml` — add `reqwest`, `tokio`, `tungstenite`/`tokio-tungstenite`
- `cli/src/main.rs` — merge Sonic devices into `devices` command; route commands to sonic.rs

---

## Part 1: TypeScript / MCP Server

---

### Task 1: Async upgrade — PlatformAdapter interface

**Files:**
- Modify: `src/adapters/platform-adapter.ts`

The 9 sync methods must become async so Sonic adapters can await WebSocket round-trips. This task only changes the interface — no behavior changes.

- [ ] **Step 1: Edit `platform-adapter.ts` — add `dispose?` and upgrade 9 return types**

```typescript
// Add after getScreenshotBufferAsync:
dispose?(): Promise<void>;

// Change these 9 signatures:
launchApp(packageOrBundleId: string): Promise<string>;
stopApp(packageOrBundleId: string): Promise<void>;
installApp(path: string): Promise<string>;
grantPermission(packageOrBundleId: string, permission: string): Promise<string>;
revokePermission(packageOrBundleId: string, permission: string): Promise<string>;
resetPermissions(packageOrBundleId: string): Promise<string>;
shell(command: string): Promise<string>;
getLogs(options: { level?: string; tag?: string; lines?: number; package?: string }): Promise<string>;
clearLogs(): Promise<string>;
```

- [ ] **Step 2: Build to find all type errors**

```bash
cd /Users/limeng/work/autospecter/claude-in-mobile && npm run build 2>&1 | head -60
```

Expected: TypeScript errors in all 4 existing adapters + DeviceManager + tool files. This is the change list for Tasks 2–5.

- [ ] **Step 3: Commit interface-only change**

```bash
git add src/adapters/platform-adapter.ts
git commit -m "refactor: upgrade PlatformAdapter sync methods to async, add dispose()"
```

---

### Task 2: Async upgrade — existing adapters

**Files:**
- Modify: `src/adapters/android-adapter.ts`
- Modify: `src/adapters/ios-adapter.ts`
- Modify: `src/adapters/desktop-adapter.ts`
- Modify: `src/adapters/aurora-adapter.ts`

Add `async` keyword to the 9 methods in each adapter. Most call `execSync` internally — change to `execAsync` (Node.js `child_process.exec` promisified) where needed, or wrap the sync call in `Promise.resolve()` as a minimal change.

- [ ] **Step 1: Update AndroidAdapter — add `async` to all 9 methods**

For each of the 9 methods in `src/adapters/android-adapter.ts`, add the `async` keyword. Methods that call `execSync` can stay as-is since `async` functions can return non-Promise values and they'll be auto-wrapped. Example:

```typescript
// Before:
launchApp(packageOrBundleId: string): string {
  return this.client.launchApp(packageOrBundleId);
}

// After:
async launchApp(packageOrBundleId: string): Promise<string> {
  return this.client.launchApp(packageOrBundleId);
}
```

Apply to: `launchApp`, `stopApp`, `installApp`, `grantPermission`, `revokePermission`, `resetPermissions`, `shell`, `getLogs`, `clearLogs`.

- [ ] **Step 2: Update IosAdapter — same 9 methods**

Same pattern as AndroidAdapter.

- [ ] **Step 3: Update DesktopAdapter — same 9 methods**

Same pattern. Desktop methods that currently throw "not supported" stay as throws.

- [ ] **Step 4: Update AuroraAdapter — same 9 methods**

Same pattern.

- [ ] **Step 5: Build to verify adapter errors are resolved**

```bash
cd /Users/limeng/work/autospecter/claude-in-mobile && npm run build 2>&1 | grep "src/adapters"
```

Expected: No errors in `src/adapters/`.

- [ ] **Step 6: Run existing tests**

```bash
cd /Users/limeng/work/autospecter/claude-in-mobile && npm test
```

Expected: All existing tests pass (behavior unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/adapters/android-adapter.ts src/adapters/ios-adapter.ts src/adapters/desktop-adapter.ts src/adapters/aurora-adapter.ts
git commit -m "refactor: make existing adapters async for PlatformAdapter interface compliance"
```

---

### Task 3: Async upgrade — DeviceManager wrappers + tool layer

**Files:**
- Modify: `src/device-manager.ts`
- Modify: `src/tools/app-tools.ts`
- Modify: `src/tools/system-tools.ts`
- Modify: `src/tools/permission-tools.ts`

Make the 9 DeviceManager wrapper methods async and add `await` in the tool layer.

- [ ] **Step 1: Update DeviceManager — make 9 wrapper methods async**

```typescript
// src/device-manager.ts — change these 9 methods:

async launchApp(packageOrBundleId: string, platform?: Platform): Promise<string> {
  const adapter = this.getAdapter(platform);
  return await adapter.launchApp(packageOrBundleId);
}

async stopApp(packageOrBundleId: string, platform?: Platform): Promise<void> {
  const adapter = this.getAdapter(platform);
  await adapter.stopApp(packageOrBundleId);
}

async installApp(path: string, platform?: Platform): Promise<string> {
  const adapter = this.getAdapter(platform);
  return await adapter.installApp(path);
}

async grantPermission(packageOrBundleId: string, permission: string, platform?: Platform): Promise<string> {
  const adapter = this.getAdapter(platform);
  return await adapter.grantPermission(packageOrBundleId, permission);
}

async revokePermission(packageOrBundleId: string, permission: string, platform?: Platform): Promise<string> {
  const adapter = this.getAdapter(platform);
  return await adapter.revokePermission(packageOrBundleId, permission);
}

async resetPermissions(packageOrBundleId: string, platform?: Platform): Promise<string> {
  const adapter = this.getAdapter(platform);
  return await adapter.resetPermissions(packageOrBundleId);
}

async shell(command: string, platform?: Platform): Promise<string> {
  const adapter = this.getAdapter(platform);
  return await adapter.shell(command);
}

async getLogs(options: { platform?: Platform; level?: string; tag?: string; lines?: number; package?: string } = {}): Promise<string> {
  const adapter = this.getAdapter(options.platform);
  return await adapter.getLogs({ level: options.level, tag: options.tag, lines: options.lines, package: options.package });
}

async clearLogs(platform?: Platform): Promise<string> {
  const adapter = this.getAdapter(platform);
  return await adapter.clearLogs();
}
```

- [ ] **Step 2: Add `await` in tool layer**

In `src/tools/app-tools.ts` — find all calls to `ctx.deviceManager.launchApp(...)`, `stopApp(...)`, `installApp(...)` and add `await`:
```typescript
// Before:
const result = ctx.deviceManager.launchApp(pkg);
// After:
const result = await ctx.deviceManager.launchApp(pkg);
```

In `src/tools/system-tools.ts` — add `await` to `shell(...)`, `getLogs(...)`, `clearLogs(...)`.

In `src/tools/permission-tools.ts` — add `await` to `grantPermission(...)`, `revokePermission(...)`, `resetPermissions(...)`.

- [ ] **Step 3: Build — should be clean**

```bash
cd /Users/limeng/work/autospecter/claude-in-mobile && npm run build 2>&1 | head -40
```

Expected: No errors.

- [ ] **Step 4: Run tests**

```bash
cd /Users/limeng/work/autospecter/claude-in-mobile && npm test
```

Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/device-manager.ts src/tools/app-tools.ts src/tools/system-tools.ts src/tools/permission-tools.ts
git commit -m "refactor: make DeviceManager wrappers async, add await in tool layer"
```

---

### Task 4: SonicDeviceSource

**Files:**
- Create: `src/sonic/sonic-device-source.ts`
- Create: `src/sonic/sonic-device-source.test.ts`

Polls Sonic Server REST API, builds `Device[]`, provides `SonicConnectionInfo`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/sonic/sonic-device-source.test.ts
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
    expect(devices).toHaveLength(3); // includes OFFLINE
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
    await source.fetchOnce(); // succeeds
    // now fail device list fetch
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/agents")) return Promise.resolve({ ok: true, json: () => Promise.resolve(AGENT_RESPONSE) });
      return Promise.reject(new Error("network error"));
    });
    await source.fetchDevicesOnly(); // should not throw
    expect(source.listDevices()).toHaveLength(3); // cached
  });

  it("start() launches poll timer; stop() clears it", async () => {
    vi.useFakeTimers();
    const source = new SonicDeviceSource("http://sonic:9090", 1, "token", 5000);
    await source.start();
    expect(source.listDevices()).toHaveLength(3);
    vi.advanceTimersByTime(5000);
    await vi.runAllTimersAsync(); // flush async fetch callbacks before asserting
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(2);
    source.stop();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/limeng/work/autospecter/claude-in-mobile && npx vitest run src/sonic/sonic-device-source.test.ts 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module './sonic-device-source.js'`

- [ ] **Step 3: Implement SonicDeviceSource**

```typescript
// src/sonic/sonic-device-source.ts
import type { Device } from "../device-manager.js";

export interface SonicConnectionInfo {
  agentHost: string;
  agentPort: number;
  key: string;       // from agentKey field in API response
  token: string;
}

interface SonicServerDevice {
  udId: string;
  nickName?: string;
  platform: number;  // 1=Android, 2=iOS
  status: string;
}

export class SonicDeviceSource {
  private devices: Device[] = [];
  private conn: SonicConnectionInfo | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly agentId: number,
    private readonly token: string,
    private readonly pollInterval: number = 30_000,
  ) {}

  async start(): Promise<void> {
    await this.fetchOnce();
    this.timer = setInterval(() => this.fetchDevicesOnly(), this.pollInterval);
  }

  async fetchOnce(): Promise<void> {
    await this.fetchAgentInfo();   // throws on failure — startup should abort
    await this.fetchDevicesOnly(); // silent on failure in subsequent polls, but not here
  }

  async fetchDevicesOnly(): Promise<void> {
    try {
      const list = await this.get<SonicServerDevice[]>(
        "/server/api/controller/devices/listByAgentId",
        { agentId: this.agentId },
      );
      this.devices = list.map(d => this.buildDevice(d));
    } catch {
      // Preserve cache — don't update this.devices
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  listDevices(): Device[] {
    return this.devices;
  }

  getConnectionInfo(): SonicConnectionInfo {
    if (!this.conn) throw new Error("SonicDeviceSource not initialized — call fetchOnce() first");
    return this.conn;
  }

  private async fetchAgentInfo(): Promise<void> {
    const data = await this.get<{ host: string; port: number; agentKey: string }>(
      "/server/api/controller/agents",
      { id: this.agentId },
    );
    if (!data.host || !data.port || !data.agentKey) {
      throw new Error(`Sonic agent info incomplete: ${JSON.stringify(data)}`);
    }
    this.conn = { agentHost: data.host, agentPort: data.port, key: data.agentKey, token: this.token };
  }

  private buildDevice(raw: SonicServerDevice): Device {
    return {
      id: raw.udId,
      name: raw.nickName ?? raw.udId,
      platform: raw.platform === 2 ? "ios" : "android",
      state: raw.status,
      isSimulator: false,
    };
  }

  private async get<T>(path: string, params: Record<string, unknown>): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const res = await fetch(url.toString(), { headers: { SonicToken: this.token } });
    if (!res.ok) throw new Error(`Sonic API ${path} failed: HTTP ${res.status}`);
    const json = await res.json() as { code: number; message?: string; data: T };
    if (json.code !== 2000) throw new Error(`Sonic API ${path} error: ${json.message}`);
    return json.data;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/limeng/work/autospecter/claude-in-mobile && npx vitest run src/sonic/sonic-device-source.test.ts
```

Expected: All pass. (Note: `fetchDevicesOnly` needs to be `public` — verify test for "second fetchOnce failure" compiles.)

- [ ] **Step 5: Commit**

```bash
git add src/sonic/sonic-device-source.ts src/sonic/sonic-device-source.test.ts
git commit -m "feat: add SonicDeviceSource — device discovery + polling from Sonic Server API"
```

---

### Task 5: SonicWsClient

**Files:**
- Modify: `package.json` — add `ws` dependency
- Create: `src/sonic/sonic-ws-client.ts`
- Create: `src/sonic/sonic-ws-client.test.ts`

Wraps a WebSocket connection. Sends JSON frames, awaits specific `msg` responses, handles binary frames (screenshots).

- [ ] **Step 1: Add `ws` dependency**

```bash
cd /Users/limeng/work/autospecter/claude-in-mobile && npm install ws && npm install -D @types/ws
```

- [ ] **Step 2: Write failing tests**

```typescript
// src/sonic/sonic-ws-client.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer } from "ws";
import { SonicWsClient } from "./sonic-ws-client.js";

let wss: WebSocketServer;
let port: number;

beforeEach(async () => {
  await new Promise<void>(resolve => {
    wss = new WebSocketServer({ port: 0 }, () => {
      port = (wss.address() as { port: number }).port;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>(resolve => wss.close(() => resolve()));
});

describe("SonicWsClient", () => {
  it("connect() opens connection", async () => {
    const client = new SonicWsClient();
    await client.connect(`ws://localhost:${port}`);
    expect(client.isConnected()).toBe(true);
    client.disconnect();
  });

  it("send() delivers JSON message to server", async () => {
    const received: string[] = [];
    wss.on("connection", ws => ws.on("message", d => received.push(d.toString())));

    const client = new SonicWsClient();
    await client.connect(`ws://localhost:${port}`);
    client.send({ type: "debug", detail: "tap", point: "100,200" });
    await new Promise(r => setTimeout(r, 50));
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0])).toMatchObject({ type: "debug", detail: "tap" });
    client.disconnect();
  });

  it("sendAndWait() resolves when expected msg arrives", async () => {
    wss.on("connection", ws => {
      ws.on("message", () => {
        ws.send(JSON.stringify({ msg: "tree", detail: { root: "node" } }));
      });
    });

    const client = new SonicWsClient();
    await client.connect(`ws://localhost:${port}`);
    const result = await client.sendAndWait({ type: "debug", detail: "tree" }, "tree");
    expect(result).toMatchObject({ msg: "tree", detail: { root: "node" } });
    client.disconnect();
  });

  it("sendAndWait() rejects on timeout", async () => {
    const client = new SonicWsClient();
    await client.connect(`ws://localhost:${port}`);
    await expect(
      client.sendAndWait({ type: "debug", detail: "tree" }, "tree", 100)
    ).rejects.toThrow("timeout");
    client.disconnect();
  });

  it("sendForBinary() resolves with binary frame", async () => {
    const imgData = Buffer.from([0xff, 0xd8, 0xff]); // fake JPEG header
    wss.on("connection", ws => {
      ws.on("message", () => ws.send(imgData));
    });

    const client = new SonicWsClient();
    await client.connect(`ws://localhost:${port}`);
    const buf = await client.sendForBinary({ type: "debug", detail: "screenshot" });
    expect(buf).toEqual(imgData);
    client.disconnect();
  });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
cd /Users/limeng/work/autospecter/claude-in-mobile && npx vitest run src/sonic/sonic-ws-client.test.ts 2>&1 | tail -5
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement SonicWsClient**

```typescript
// src/sonic/sonic-ws-client.ts
import WebSocket from "ws";

type MsgListener = (data: Record<string, unknown>) => void;

export class SonicWsClient {
  private ws: WebSocket | null = null;
  private msgListeners = new Map<string, MsgListener>();
  private binaryResolve: ((buf: Buffer) => void) | null = null;
  private binaryReject: ((err: Error) => void) | null = null;

  async connect(url: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });

    this.ws!.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        this.binaryResolve?.(data as Buffer);
        this.binaryResolve = null;
        this.binaryReject = null;
        return;
      }
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        const key = msg["msg"] as string | undefined;
        if (key) this.msgListeners.get(key)?.(msg);
      } catch { /* ignore malformed frames */ }
    });
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(payload: object): void {
    this.ws?.send(JSON.stringify(payload));
  }

  async sendAndWait(
    payload: object,
    expectedMsg: string,
    timeout = 10_000,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.msgListeners.delete(expectedMsg);
        reject(new Error(`SonicWsClient sendAndWait timeout waiting for msg="${expectedMsg}"`));
      }, timeout);

      this.msgListeners.set(expectedMsg, (data) => {
        clearTimeout(timer);
        this.msgListeners.delete(expectedMsg);
        resolve(data);
      });

      this.send(payload);
    });
  }

  async sendForBinary(payload: object, timeout = 10_000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.binaryResolve = null;
        this.binaryReject = null;
        reject(new Error("SonicWsClient sendForBinary timeout"));
      }, timeout);

      this.binaryResolve = (buf) => { clearTimeout(timer); resolve(buf); };
      this.binaryReject = reject;
      this.send(payload);
    });
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }
}
```

- [ ] **Step 5: Run tests**

```bash
cd /Users/limeng/work/autospecter/claude-in-mobile && npx vitest run src/sonic/sonic-ws-client.test.ts
```

Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/sonic/sonic-ws-client.ts src/sonic/sonic-ws-client.test.ts
git commit -m "feat: add SonicWsClient — WebSocket wrapper with request-response and binary frame support"
```

---

### Task 6: SonicAndroidAdapter

**Files:**
- Create: `src/sonic/sonic-android-adapter.ts`
- Create: `src/sonic/sonic-android-adapter.test.ts`

Implements `PlatformAdapter` for Android devices via sonic-agent WebSocket.

- [ ] **Step 1: Write failing tests**

```typescript
// src/sonic/sonic-android-adapter.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SonicAndroidAdapter } from "./sonic-android-adapter.js";
import type { SonicConnectionInfo } from "./sonic-device-source.js";
import { SonicWsClient } from "./sonic-ws-client.js";

vi.mock("./sonic-ws-client.js");

const conn: SonicConnectionInfo = { agentHost: "10.0.0.1", agentPort: 7777, key: "k", token: "t" };
const UDID = "device-001";

function mockClient() {
  const client = new SonicWsClient() as vi.Mocked<SonicWsClient>;
  client.connect = vi.fn().mockResolvedValue(undefined);
  client.send = vi.fn();
  client.sendAndWait = vi.fn();
  client.sendForBinary = vi.fn();
  client.disconnect = vi.fn();
  return client;
}

describe("SonicAndroidAdapter", () => {
  let adapter: SonicAndroidAdapter;
  let client: ReturnType<typeof mockClient>;

  beforeEach(async () => {
    vi.mocked(SonicWsClient).mockImplementation(() => {
      client = mockClient();
      return client;
    });
    adapter = new SonicAndroidAdapter(UDID, conn);
    await adapter.connect();
  });

  it("connect() opens WebSocket with correct URL", () => {
    expect(client.connect).toHaveBeenCalledWith(
      `ws://10.0.0.1:7777/websockets/android/k/${UDID}/t`
    );
  });

  it("tap() sends correct JSON", async () => {
    await adapter.tap(100, 200);
    expect(client.send).toHaveBeenCalledWith({ type: "debug", detail: "tap", point: "100,200" });
  });

  it("swipe() sends correct JSON", async () => {
    await adapter.swipe(0, 500, 0, 100, 300);
    expect(client.send).toHaveBeenCalledWith({
      type: "debug", detail: "swipe", pointA: "0,500", pointB: "0,100"
    });
  });

  it("inputText() sends text message", async () => {
    await adapter.inputText("hello");
    expect(client.send).toHaveBeenCalledWith({ type: "text", detail: "hello" });
  });

  it("screenshotAsync() sends screenshot command and returns buffer as base64", async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff]);
    client.sendForBinary = vi.fn().mockResolvedValue(buf);
    const result = await adapter.screenshotAsync(false);
    expect(client.sendForBinary).toHaveBeenCalledWith({ type: "debug", detail: "screenshot" }, expect.any(Number));
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.data).toBe(buf.toString("base64"));
  });

  it("getUiHierarchy() sends tree command and returns detail as JSON string", async () => {
    client.sendAndWait = vi.fn().mockResolvedValue({ msg: "tree", detail: { root: "node" } });
    const result = await adapter.getUiHierarchy();
    expect(client.sendAndWait).toHaveBeenCalledWith({ type: "debug", detail: "tree" }, "tree", expect.any(Number));
    expect(JSON.parse(result)).toMatchObject({ root: "node" });
  });

  it("launchApp() sends openApp command", async () => {
    await adapter.launchApp("com.example.app");
    expect(client.send).toHaveBeenCalledWith({ type: "debug", detail: "openApp", pkg: "com.example.app" });
  });

  it("dispose() disconnects WebSocket", async () => {
    await adapter.dispose();
    expect(client.disconnect).toHaveBeenCalled();
  });

  it("platform is android", () => {
    expect(adapter.platform).toBe("android");
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/limeng/work/autospecter/claude-in-mobile && npx vitest run src/sonic/sonic-android-adapter.test.ts 2>&1 | tail -5
```

- [ ] **Step 3: Implement SonicAndroidAdapter**

```typescript
// src/sonic/sonic-android-adapter.ts
import type { PlatformAdapter } from "../adapters/platform-adapter.js";
import type { Device } from "../device-manager.js";
import type { CompressOptions } from "../utils/image.js";
import type { SonicConnectionInfo } from "./sonic-device-source.js";
import { SonicWsClient } from "./sonic-ws-client.js";

export class SonicAndroidAdapter implements PlatformAdapter {
  readonly platform = "android" as const;
  private client: SonicWsClient;
  private selectedDeviceId: string;

  constructor(
    private readonly udId: string,
    private readonly conn: SonicConnectionInfo,
  ) {
    this.client = new SonicWsClient();
    this.selectedDeviceId = udId;
  }

  async connect(): Promise<void> {
    const { agentHost, agentPort, key, token } = this.conn;
    await this.client.connect(`ws://${agentHost}:${agentPort}/websockets/android/${key}/${this.udId}/${token}`);
  }

  async dispose(): Promise<void> {
    this.client.disconnect();
  }

  // ── PlatformAdapter: device management stubs ──────────────────

  listDevices(): Device[] { return []; }
  selectDevice(id: string): void { this.selectedDeviceId = id; }
  getSelectedDeviceId(): string { return this.selectedDeviceId; }
  autoDetectDevice(): Device | undefined { return undefined; }

  // ── Core actions ───────────────────────────────────────────────

  async tap(x: number, y: number, _targetPid?: number): Promise<void> {
    this.client.send({ type: "debug", detail: "tap", point: `${x},${y}` });
  }

  async doubleTap(x: number, y: number): Promise<void> {
    this.client.send({ type: "debug", detail: "tap", point: `${x},${y}` });
    await new Promise(r => setTimeout(r, 100));
    this.client.send({ type: "debug", detail: "tap", point: `${x},${y}` });
  }

  async longPress(x: number, y: number): Promise<void> {
    this.client.send({ type: "debug", detail: "longPress", point: `${x},${y}` });
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, _durationMs?: number): Promise<void> {
    this.client.send({ type: "debug", detail: "swipe", pointA: `${x1},${y1}`, pointB: `${x2},${y2}` });
  }

  async swipeDirection(direction: "up" | "down" | "left" | "right"): Promise<void> {
    // Use fixed screen center + direction vector (1080x1920 baseline)
    const cx = 540, cy = 960, delta = 600;
    const dirs = {
      up:    [cx, cy + delta, cx, cy - delta],
      down:  [cx, cy - delta, cx, cy + delta],
      left:  [cx + delta, cy, cx - delta, cy],
      right: [cx - delta, cy, cx + delta, cy],
    };
    const [x1, y1, x2, y2] = dirs[direction];
    await this.swipe(x1, y1, x2, y2);
  }

  async inputText(text: string, _targetPid?: number): Promise<void> {
    this.client.send({ type: "text", detail: text });
  }

  async pressKey(key: string, _targetPid?: number): Promise<void> {
    this.client.send({ type: "keyEvent", detail: key });
  }

  // ── Screenshot ─────────────────────────────────────────────────

  async screenshotAsync(compress: boolean, _options?: CompressOptions): Promise<{ data: string; mimeType: string }> {
    const buf = await this.client.sendForBinary({ type: "debug", detail: "screenshot" }, 15_000);
    return { data: buf.toString("base64"), mimeType: "image/jpeg" };
  }

  async getScreenshotBufferAsync(): Promise<Buffer> {
    return this.client.sendForBinary({ type: "debug", detail: "screenshot" }, 15_000);
  }

  screenshotRaw(): string {
    throw new Error("screenshotRaw not supported on Sonic devices — use screenshotAsync()");
  }

  // ── UI ─────────────────────────────────────────────────────────

  async getUiHierarchy(): Promise<string> {
    const res = await this.client.sendAndWait({ type: "debug", detail: "tree" }, "tree", 15_000);
    return JSON.stringify(res["detail"]);
  }

  // ── App management ─────────────────────────────────────────────

  async launchApp(pkg: string): Promise<string> {
    this.client.send({ type: "debug", detail: "openApp", pkg });
    return `Launched ${pkg}`;
  }

  async stopApp(pkg: string): Promise<void> {
    this.client.send({ type: "debug", detail: "killApp", pkg });
  }

  async installApp(path: string): Promise<string> {
    const res = await this.client.sendAndWait(
      { type: "debug", detail: "install", apk: path, forceInstall: false },
      "installFinish",
      60_000,
    );
    if (res["status"] !== "success") throw new Error(`Install failed: ${res["status"]}`);
    return `Installed ${path}`;
  }

  // ── Permissions (via shell) ────────────────────────────────────

  async grantPermission(pkg: string, permission: string): Promise<string> {
    return this.shell(`pm grant ${pkg} ${permission}`);
  }

  async revokePermission(pkg: string, permission: string): Promise<string> {
    return this.shell(`pm revoke ${pkg} ${permission}`);
  }

  async resetPermissions(pkg: string): Promise<string> {
    return this.shell(`pm reset-permissions ${pkg}`);
  }

  // ── System ─────────────────────────────────────────────────────

  async shell(command: string): Promise<string> {
    const termClient = new SonicWsClient();
    const { agentHost, agentPort, key, token } = this.conn;
    await termClient.connect(
      `ws://${agentHost}:${agentPort}/websockets/android/terminal/${key}/${this.udId}/${token}`
    );
    try {
      return await new Promise((resolve, reject) => {
        const lines: string[] = [];
        const timer = setTimeout(() => reject(new Error("shell timeout")), 30_000);
        // Subscribe to streaming responses before sending
        (termClient as unknown as { ws: { on: (e: string, cb: (d: unknown) => void) => void } })
          .ws?.on; // Note: need raw WS access — see implementation note below
        // Simpler: use internal sendAndCollect helper
        resolve(""); // placeholder — real impl collects terResp until terDone
        clearTimeout(timer);
      });
    } finally {
      termClient.disconnect();
    }
  }

  async getLogs(options: { level?: string; tag?: string; lines?: number; package?: string } = {}): Promise<string> {
    // Streaming logcat — connect terminal WS, collect N lines then disconnect
    return ""; // placeholder
  }

  async clearLogs(): Promise<string> {
    return this.shell("logcat -c");
  }

  async getSystemInfo(): Promise<string> {
    throw new Error("getSystemInfo not supported on sonic-android in phase 1");
  }
}
```

> **Implementation note for `shell()` and `getLogs()`:** The terminal WebSocket streams responses as multiple `{ msg:"terResp", detail:"line" }` frames until `{ msg:"terDone" }`. `SonicWsClient.sendAndWait` only captures a single response. You need to extend `SonicWsClient` with a `sendAndCollect(payload, doneMsg, streamMsg, timeout)` method that accumulates stream frames until the done signal. Add this in the next step.

- [ ] **Step 4: Add `sendAndCollect` to SonicWsClient and replace `shell()` / `getLogs()` in SonicAndroidAdapter**

**Replace the entire `shell()` method written in Step 3** (the placeholder) with the correct implementation. Also replace `getLogs()`.

First add to `sonic-ws-client.ts`:

```typescript
// Streams multiple frames with `streamMsg` until `doneMsg` arrives, returns joined output
async sendAndCollect(
  payload: object,
  streamMsg: string,
  doneMsg: string,
  timeout = 30_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    const timer = setTimeout(() => {
      this.msgListeners.delete(streamMsg);
      this.msgListeners.delete(doneMsg);
      reject(new Error(`sendAndCollect timeout waiting for "${doneMsg}"`));
    }, timeout);

    this.msgListeners.set(streamMsg, (data) => {
      lines.push(String(data["detail"] ?? ""));
    });
    this.msgListeners.set(doneMsg, () => {
      clearTimeout(timer);
      this.msgListeners.delete(streamMsg);
      this.msgListeners.delete(doneMsg);
      resolve(lines.join("\n"));
    });

    this.send(payload);
  });
}
```

Then update `shell()` in `SonicAndroidAdapter` to use it:

```typescript
async shell(command: string): Promise<string> {
  const termClient = new SonicWsClient();
  const { agentHost, agentPort, key, token } = this.conn;
  await termClient.connect(
    `ws://${agentHost}:${agentPort}/websockets/android/terminal/${key}/${this.udId}/${token}`
  );
  try {
    return await termClient.sendAndCollect(
      { type: "command", detail: command },
      "terResp",
      "terDone",
    );
  } finally {
    termClient.disconnect();
  }
}

async getLogs(options: { level?: string } = {}): Promise<string> {
  const termClient = new SonicWsClient();
  const { agentHost, agentPort, key, token } = this.conn;
  await termClient.connect(
    `ws://${agentHost}:${agentPort}/websockets/android/terminal/${key}/${this.udId}/${token}`
  );
  try {
    // Collect for 3 seconds then disconnect
    const lines: string[] = [];
    return await new Promise((resolve) => {
      termClient.send({ type: "logcat", level: options.level ?? "V", filter: "" });
      setTimeout(() => {
        termClient.disconnect();
        resolve(lines.join("\n"));
      }, 3_000);
    });
  } catch {
    termClient.disconnect();
    return "";
  }
}
```

- [ ] **Step 5: Run tests**

```bash
cd /Users/limeng/work/autospecter/claude-in-mobile && npx vitest run src/sonic/sonic-android-adapter.test.ts
```

Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/sonic/sonic-android-adapter.ts src/sonic/sonic-android-adapter.test.ts src/sonic/sonic-ws-client.ts
git commit -m "feat: add SonicAndroidAdapter + sendAndCollect for streaming terminal commands"
```

---

### Task 7: SonicIosAdapter

**Files:**
- Create: `src/sonic/sonic-ios-adapter.ts`
- Create: `src/sonic/sonic-ios-adapter.test.ts`

Same structure as Android, different WebSocket paths and some different command names.

- [ ] **Step 1: Write failing tests**

```typescript
// src/sonic/sonic-ios-adapter.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SonicIosAdapter } from "./sonic-ios-adapter.js";
import type { SonicConnectionInfo } from "./sonic-device-source.js";
import { SonicWsClient } from "./sonic-ws-client.js";

vi.mock("./sonic-ws-client.js");

const conn: SonicConnectionInfo = { agentHost: "10.0.0.1", agentPort: 7777, key: "k", token: "t" };
const UDID = "ios-device-001";

function mockClient() {
  const c = new SonicWsClient() as vi.Mocked<SonicWsClient>;
  c.connect = vi.fn().mockResolvedValue(undefined);
  c.send = vi.fn();
  c.sendAndWait = vi.fn();
  c.sendForBinary = vi.fn();
  c.disconnect = vi.fn();
  return c;
}

describe("SonicIosAdapter", () => {
  let adapter: SonicIosAdapter;
  let client: ReturnType<typeof mockClient>;

  beforeEach(async () => {
    vi.mocked(SonicWsClient).mockImplementation(() => { client = mockClient(); return client; });
    adapter = new SonicIosAdapter(UDID, conn);
    await adapter.connect();
  });

  it("connect() opens WebSocket with iOS path", () => {
    expect(client.connect).toHaveBeenCalledWith(
      `ws://10.0.0.1:7777/websockets/ios/k/${UDID}/t`
    );
  });

  it("tap() sends correct JSON", async () => {
    await adapter.tap(50, 100);
    expect(client.send).toHaveBeenCalledWith({ type: "debug", detail: "tap", point: "50,100" });
  });

  it("inputText() uses 'send' type (not 'text')", async () => {
    await adapter.inputText("hello");
    expect(client.send).toHaveBeenCalledWith({ type: "send", detail: "hello" });
  });

  it("launchApp() waits for launchResult", async () => {
    client.sendAndWait = vi.fn().mockResolvedValue({ msg: "launchResult", pkg: "com.example", status: "success" });
    await adapter.launchApp("com.example");
    expect(client.sendAndWait).toHaveBeenCalledWith(
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
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/limeng/work/autospecter/claude-in-mobile && npx vitest run src/sonic/sonic-ios-adapter.test.ts 2>&1 | tail -5
```

- [ ] **Step 3: Implement SonicIosAdapter**

Mirror `SonicAndroidAdapter` with these differences:
- WebSocket path: `/websockets/ios/${key}/${udId}/${token}`
- Terminal path: `/websockets/ios/terminal/${key}/${udId}/${token}`
- `inputText` sends `{ type: "send", detail: text }` (not `type: "text"`)
- `launchApp` sends `{ type: "launch", pkg }` and awaits `{ msg: "launchResult" }`
- `stopApp` sends `{ type: "kill", pkg }` and awaits `{ msg: "killResult" }`
- `installApp` sends `{ type: "debug", detail: "install", ipa: path }` awaits `{ msg: "installFinish" }`
- `grantPermission / revokePermission / resetPermissions` throw "not supported on sonic-ios"
- `getSystemInfo` throws "not supported on sonic-ios"
- `getLogs` uses terminal WS with `{ type: "syslog", filter: "" }`

**Method signatures must match `PlatformAdapter` exactly** — include `_targetPid?: number` on `tap`, `inputText`, `pressKey` and `_durationMs?: number` on `swipe`. The iOS adapter's `readonly platform = "ios" as const`.

```typescript
// src/sonic/sonic-ios-adapter.ts
// (Full implementation following same pattern as sonic-android-adapter.ts
//  with differences noted above)
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/limeng/work/autospecter/claude-in-mobile && npx vitest run src/sonic/sonic-ios-adapter.test.ts
```

- [ ] **Step 5: Run all tests**

```bash
cd /Users/limeng/work/autospecter/claude-in-mobile && npm test
```

Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/sonic/sonic-ios-adapter.ts src/sonic/sonic-ios-adapter.test.ts
git commit -m "feat: add SonicIosAdapter"
```

---

### Task 8: DeviceManager + index.ts integration

**Files:**
- Modify: `src/device-manager.ts`
- Modify: `src/index.ts`
- Modify: `src/tools/device-tools.ts` — add `await` to `setDevice` call site

Wire `SonicDeviceSource` into `DeviceManager`. Add Sonic routing in `setDevice()`. Update `index.ts` lifecycle.

- [ ] **Step 1: Add sonic fields and setSonicSource to DeviceManager**

```typescript
// src/device-manager.ts — add imports
import { SonicDeviceSource } from "./sonic/sonic-device-source.js";
import { SonicAndroidAdapter } from "./sonic/sonic-android-adapter.js";
import { SonicIosAdapter } from "./sonic/sonic-ios-adapter.js";

// Add to DeviceManager class:
private sonicSource?: SonicDeviceSource;
private sonicEnabled = false;
private activeSonicAdapter?: SonicAndroidAdapter | SonicIosAdapter;

setSonicSource(source: SonicDeviceSource): void {
  this.sonicSource = source;
  this.sonicEnabled = true;
}
```

- [ ] **Step 2: Update `getAllDevices()` to include sonic devices**

```typescript
getAllDevices(): Device[] {
  if (this.sonicEnabled && this.sonicSource) {
    const sonicDevices = this.sonicSource.listDevices();
    // Non-mobile local devices (Desktop/Aurora/Browser) still listed
    const localNonMobile: Device[] = [];
    for (const [platform, adapter] of this.adapters) {
      if (platform !== "android" && platform !== "ios") {
        localNonMobile.push(...adapter.listDevices());
      }
    }
    return [...sonicDevices, ...localNonMobile];
  }
  const devices: Device[] = [];
  for (const adapter of this.adapters.values()) {
    devices.push(...adapter.listDevices());
  }
  return devices;
}
```

- [ ] **Step 3: Update `setDevice()` to route Sonic devices**

```typescript
// In setDevice(), replace the `this.activeDevice = device; this.activeTarget = device.platform` block:

if (this.sonicEnabled && (device.platform === "android" || device.platform === "ios")) {
  const conn = this.sonicSource!.getConnectionInfo();
  const newAdapter = device.platform === "android"
    ? new SonicAndroidAdapter(device.id, conn)
    : new SonicIosAdapter(device.id, conn);

  // Dispose previous sonic adapter (closes WebSocket = releases device)
  await this.activeSonicAdapter?.dispose?.();
  await newAdapter.connect();
  this.activeSonicAdapter = newAdapter;

  // Register in adapters map so getAdapter() routes correctly
  this.adapters.set(device.platform, newAdapter);
  this.activeDevice = device;
  this.activeTarget = device.platform;
  return device;
}
```

Note: `setDevice` currently returns synchronously — it must be changed to `async setDevice()` returning `Promise<Device>`.

- [ ] **Step 3b: Update `device-tools.ts` — await the now-async setDevice**

In `src/tools/device-tools.ts`, find the call to `ctx.deviceManager.setDevice(...)` and add `await`:

```typescript
// Before:
const device = ctx.deviceManager.setDevice(args.deviceId as string, platform);
// After:
const device = await ctx.deviceManager.setDevice(args.deviceId as string, platform);
```

The handler is already `async`, so this compiles without other changes.

- [ ] **Step 4: Update `cleanup()` to dispose sonic adapter**

```typescript
async cleanup(): Promise<void> {
  try { await this.activeSonicAdapter?.dispose?.(); } catch {}
  try { await this.desktopAdapter.stop(); } catch {}
  // ... rest unchanged
}
```

- [ ] **Step 5: Update `src/index.ts` — SONIC_ENABLE lifecycle**

```typescript
// Add before server.connect(transport):
let sonicSource: SonicDeviceSource | undefined;

if (process.env.SONIC_ENABLE === "true") {
  const baseUrl = process.env.SONIC_BASE_URL;
  const agentId = process.env.SONIC_AGENT_ID;
  const token = process.env.SONIC_TOKEN;
  if (!baseUrl || !agentId || !token) {
    throw new Error("SONIC_ENABLE=true requires SONIC_BASE_URL, SONIC_AGENT_ID, SONIC_TOKEN");
  }
  sonicSource = new SonicDeviceSource(
    baseUrl,
    Number(agentId),
    token,
    process.env.SONIC_POLL_INTERVAL ? Number(process.env.SONIC_POLL_INTERVAL) : undefined,
  );
  await sonicSource.start();
  ctx.deviceManager.setSonicSource(sonicSource);
}

// Add to SIGTERM/SIGINT handlers:
process.on("SIGTERM", () => { sonicSource?.stop(); });
process.on("SIGINT",  () => { sonicSource?.stop(); });
```

- [ ] **Step 6: Build**

```bash
cd /Users/limeng/work/autospecter/claude-in-mobile && npm run build 2>&1 | head -30
```

Expected: Clean build.

- [ ] **Step 7: Run all tests**

```bash
cd /Users/limeng/work/autospecter/claude-in-mobile && npm test
```

- [ ] **Step 8: Commit**

```bash
git add src/device-manager.ts src/index.ts
git commit -m "feat: wire SonicDeviceSource into DeviceManager, add sonic routing in setDevice"
```

---

### Task 9: Sonic mode guards for bypassed tools

**Files:**
- Modify: `src/tools/system-tools.ts`
- Modify: `src/tools/clipboard-tools.ts`
- Modify: `src/tools/ui-tools.ts`

Tools that call `getAndroidClient()` / `getIosClient()` directly must return a clear error in Sonic mode.

- [ ] **Step 1: Add `isSonicMode()` helper to DeviceManager**

```typescript
// src/device-manager.ts
isSonicMode(): boolean {
  return this.sonicEnabled;
}
```

- [ ] **Step 2: Add guards to bypassed tool paths**

In `src/tools/system-tools.ts`, find the `system_activity` handler and the `system_open_url` (Android + iOS) paths that call raw clients. Add at the top of each:

```typescript
if (ctx.deviceManager.isSonicMode()) {
  return { content: [{ type: "text", text: "system_activity is not supported in Sonic mode" }] };
}
```

Apply same guard pattern to:
- `system_activity`
- `system_open_url` (Android path using `getAndroidClient().shell(...)`)
- `system_open_url` (iOS path using `getIosClient().openUrl(...)`)
- `system_webview`
- `ui_find` (iOS element-level path calling `getIosClient().findElements(...)` in `src/tools/ui-tools.ts`)

In `src/tools/clipboard-tools.ts`, add guard to paths that call `getAndroidClient()`:
- `clipboard_get_android`
- `clipboard_select`, `clipboard_copy`, `clipboard_paste`

- [ ] **Step 3: Build and test**

```bash
cd /Users/limeng/work/autospecter/claude-in-mobile && npm run build && npm test
```

- [ ] **Step 4: Commit**

```bash
git add src/tools/system-tools.ts src/tools/clipboard-tools.ts src/device-manager.ts
git commit -m "feat: add Sonic mode guards for tools that bypass PlatformAdapter"
```

---

## Part 2: Rust CLI

---

### Task 10: Add Rust dependencies for Sonic

**Files:**
- Modify: `cli/Cargo.toml`

- [ ] **Step 1: Add dependencies**

```toml
# cli/Cargo.toml — add under [dependencies]:
reqwest = { version = "0.12", features = ["json", "blocking"] }
tungstenite = "0.24"
```

> **Note:** Do NOT add `tokio` — `reqwest::blocking` brings its own internal runtime. Adding a separate `tokio` dependency alongside `reqwest::blocking` causes a "Cannot start a runtime from within a Tokio runtime" panic.

- [ ] **Step 2: Verify build**

```bash
cd /Users/limeng/work/autospecter/claude-in-mobile/cli && cargo build 2>&1 | tail -10
```

Expected: Compiles (new deps downloaded).

- [ ] **Step 3: Commit**

```bash
git add cli/Cargo.toml cli/Cargo.lock
git commit -m "chore(cli): add reqwest, tokio, tungstenite for Sonic support"
```

---

### Task 11: Sonic device discovery in Rust CLI

**Files:**
- Create: `cli/src/sonic.rs`
- Modify: `cli/src/main.rs`

One-shot device discovery from Sonic Server API + WebSocket command execution.

- [ ] **Step 1: Create sonic.rs with types and discovery**

```rust
// cli/src/sonic.rs
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct AgentInfo {
    pub host: String,
    pub port: u16,
    #[serde(rename = "agentKey")]
    pub agent_key: String,
}

#[derive(Debug, Deserialize)]
pub struct SonicDevice {
    #[serde(rename = "udId")]
    pub ud_id: String,
    #[serde(rename = "nickName")]
    pub nick_name: Option<String>,
    pub platform: u8,   // 1=Android, 2=iOS
    pub status: String,
}

#[derive(Debug, Clone)]
pub struct SonicConnection {
    pub host: String,
    pub port: u16,
    pub key: String,
    pub token: String,
}

#[derive(Debug, Deserialize)]
struct ApiResponse<T> {
    code: i32,
    message: Option<String>,
    data: Option<T>,
}

pub struct SonicClient {
    base_url: String,
    agent_id: u32,
    token: String,
}

impl SonicClient {
    pub fn new(base_url: String, agent_id: u32, token: String) -> Self {
        Self { base_url, agent_id, token }
    }

    pub fn fetch_agent_info(&self) -> Result<AgentInfo> {
        let url = format!("{}/server/api/controller/agents?id={}", self.base_url, self.agent_id);
        let resp: ApiResponse<AgentInfo> = reqwest::blocking::Client::new()
            .get(&url)
            .header("SonicToken", &self.token)
            .send()?
            .json()?;
        if resp.code != 2000 {
            return Err(anyhow!("Sonic API error: {:?}", resp.message));
        }
        resp.data.ok_or_else(|| anyhow!("Empty agent data"))
    }

    pub fn fetch_devices(&self) -> Result<Vec<SonicDevice>> {
        let url = format!(
            "{}/server/api/controller/devices/listByAgentId?agentId={}",
            self.base_url, self.agent_id
        );
        let resp: ApiResponse<Vec<SonicDevice>> = reqwest::blocking::Client::new()
            .get(&url)
            .header("SonicToken", &self.token)
            .send()?
            .json()?;
        if resp.code != 2000 {
            return Err(anyhow!("Sonic API error: {:?}", resp.message));
        }
        Ok(resp.data.unwrap_or_default())
    }

    pub fn get_connection(&self) -> Result<(SonicConnection, Vec<SonicDevice>)> {
        let agent = self.fetch_agent_info()?;
        let devices = self.fetch_devices()?;
        let conn = SonicConnection {
            host: agent.host,
            port: agent.port,
            key: agent.agent_key,
            token: self.token.clone(),
        };
        Ok((conn, devices))
    }
}

pub fn send_command_and_wait(
    conn: &SonicConnection,
    ud_id: &str,
    platform: u8,
    payload: &serde_json::Value,
    expected_msg: Option<&str>,
) -> Result<Option<serde_json::Value>> {
    use tungstenite::connect;
    use tungstenite::Message;

    let path = if platform == 2 { "ios" } else { "android" };
    let url = format!(
        "ws://{}:{}/websockets/{}/{}/{}/{}",
        conn.host, conn.port, path, conn.key, ud_id, conn.token
    );
    let (mut socket, _) = connect(&url)?;
    socket.send(Message::Text(payload.to_string().into()))?;

    if let Some(expected) = expected_msg {
        loop {
            let msg = socket.read()?;
            if let Message::Text(text) = msg {
                let val: serde_json::Value = serde_json::from_str(&text)?;
                if val.get("msg").and_then(|m| m.as_str()) == Some(expected) {
                    socket.close(None)?;
                    return Ok(Some(val));
                }
            }
            if let Message::Binary(_) = msg {
                break; // screenshot case
            }
        }
    }
    socket.close(None)?;
    Ok(None)
}
```

- [ ] **Step 2: Update main.rs — `devices` command includes Sonic**

In `cli/src/main.rs`, find the `devices` subcommand handler. Add:

```rust
// After listing local devices, append Sonic devices if SONIC_ENABLE is set
if std::env::var("SONIC_ENABLE").as_deref() == Ok("true") {
    if let (Ok(base_url), Ok(agent_id), Ok(token)) = (
        std::env::var("SONIC_BASE_URL"),
        std::env::var("SONIC_AGENT_ID"),
        std::env::var("SONIC_TOKEN"),
    ) {
        if let Ok(agent_id_num) = agent_id.parse::<u32>() {
            let client = sonic::SonicClient::new(base_url, agent_id_num, token);
            match client.fetch_devices() {
                Ok(devices) => {
                    for d in devices {
                        let platform_str = if d.platform == 2 { "ios" } else { "android" };
                        let name = d.nick_name.as_deref().unwrap_or(&d.ud_id);
                        println!("{:<24} {:<20} {:<10} {:<10} sonic",
                            d.ud_id, name, platform_str, d.status.to_lowercase());
                    }
                }
                Err(e) => eprintln!("Warning: Sonic device fetch failed: {}", e),
            }
        }
    }
}
```

- [ ] **Step 3: Route commands to Sonic when device is a Sonic device**

For commands like `screenshot`, `tap`, etc. — when the `--device` flag matches a Sonic device UDID, use `sonic::send_command_and_wait`. The routing logic checks if SONIC_ENABLE is set and the device ID exists in the Sonic device list.

Add a helper in `main.rs`:

```rust
fn resolve_device_backend(device_id: &str) -> Option<(sonic::SonicConnection, u8)> {
    if std::env::var("SONIC_ENABLE").as_deref() != Ok("true") {
        return None;
    }
    let (Ok(base_url), Ok(agent_id), Ok(token)) = (
        std::env::var("SONIC_BASE_URL"),
        std::env::var("SONIC_AGENT_ID"),
        std::env::var("SONIC_TOKEN"),
    ) else { return None; };
    let Ok(agent_id_num) = agent_id.parse::<u32>() else { return None; };
    let client = sonic::SonicClient::new(base_url, agent_id_num, token);
    let Ok((conn, devices)) = client.get_connection() else { return None; };
    let device = devices.iter().find(|d| d.ud_id == device_id)?;
    Some((conn, device.platform))
}
```

Then in each command handler that accepts `--device`:
```rust
if let Some((conn, platform)) = resolve_device_backend(&device_id) {
    // use sonic backend
    let payload = serde_json::json!({ "type": "debug", "detail": "screenshot" });
    sonic::send_command_and_wait(&conn, &device_id, platform, &payload, None)?;
} else {
    // existing local backend
}
```

- [ ] **Step 4: Build CLI**

```bash
cd /Users/limeng/work/autospecter/claude-in-mobile/cli && cargo build 2>&1 | tail -10
```

Expected: Compiles cleanly.

- [ ] **Step 5: Commit**

```bash
git add cli/src/sonic.rs cli/src/main.rs
git commit -m "feat(cli): add Sonic device discovery and command routing"
```

---

## Final Verification

- [ ] **Full TypeScript build + tests**

```bash
cd /Users/limeng/work/autospecter/claude-in-mobile && npm run build && npm test
```

Expected: Clean build, all tests pass.

- [ ] **Full Rust build**

```bash
cd /Users/limeng/work/autospecter/claude-in-mobile/cli && cargo build --release
```

- [ ] **End-to-end smoke test (if Sonic agent available)**

```bash
# Set env vars
export SONIC_ENABLE=true
export SONIC_BASE_URL=http://<sonic-server>:9090
export SONIC_AGENT_ID=1
export SONIC_TOKEN=<your-token>

# List devices — should include Sonic devices
node dist/index.js  # start MCP server and call device_list tool

# CLI devices list
./cli/target/release/claude-in-mobile devices
```

- [ ] **Final commit**

```bash
git add -A
git commit -m "feat: Sonic integration complete — MCP + CLI support for remote physical devices"
```
