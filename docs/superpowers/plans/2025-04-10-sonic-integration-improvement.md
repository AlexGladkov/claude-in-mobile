# Sonic Integration Improvement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use @superpowers:subagent-driven-development (recommended) or @superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Sonic device integration by implementing iOS coordinate conversion, enhanced WebSocket message handling, app listing, and extended system tools (clipboard, file transfer, WebView inspection).

**Architecture:** Extend existing Sonic adapter classes with new capabilities while maintaining backward compatibility. Add specialized message handlers for Sonic-specific responses. Implement new tools that delegate to Sonic adapters.

**Tech Stack:** TypeScript, WebSocket, Node.js, existing MCP tool framework

---

## File Structure

### Modified Files

| File | Responsibility |
|------|----------------|
| `src/sonic/sonic-ws-client.ts` | Enhanced message handling for new response types (screenshotError, uninstallFinish, appListDetail, appListFinish) |
| `src/sonic/sonic-ios-adapter.ts` | iOS coordinate conversion using logical screen size from openDriver response |
| `src/sonic/sonic-android-adapter.ts` | Add app listing, clipboard, file transfer, WebView inspection support |
| `src/adapters/platform-adapter.ts` | Add new interface methods: getAppList(), clipboard operations, file operations |
| `src/device-manager.ts` | Add delegation methods for new adapter capabilities |
| `src/tools/app-tools.ts` | **Extend** app_list to support Android/iOS via Sonic (currently Aurora only) |
| `src/tools/clipboard-tools.ts` | **Extend** clipboard tools to support Sonic Android/iOS |
| `src/tools/system-tools.ts` | **Extend** system_webview to support Sonic Android/iOS |
| `src/tools/aurora-tools.ts` | **Extend** file_push/file_pull to support Sonic Android |

### New Files

None - all changes extend existing files.

---

## Phase 1: Core Functionality

### Task 1: Enhanced WebSocket Message Handling

**Files:**
- Modify: `src/sonic/sonic-ws-client.ts`
- Test: `src/sonic/sonic-ws-client.test.ts`

**Context:** Current implementation only handles basic message types. Need to add handlers for `screenshotError`, `uninstallFinish`, `appListDetail`, `appListFinish` responses.

- [ ] **Step 1: Write failing test for new message handlers**

```typescript
// src/sonic/sonic-ws-client.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SonicWsClient } from './sonic-ws-client.js';
import WebSocket from 'ws';

vi.mock('ws');

describe('SonicWsClient enhanced message handling', () => {
  let client: SonicWsClient;
  let mockWs: any;
  let messageHandlers: Map<string, Function>;

  beforeEach(() => {
    client = new SonicWsClient();
    messageHandlers = new Map();
    mockWs = {
      send: vi.fn(),
      close: vi.fn(),
      once: vi.fn(),
      on: vi.fn((event: string, handler: Function) => {
        if (event === 'message') messageHandlers.set('message', handler);
      }),
      readyState: WebSocket.OPEN,
    };
    vi.mocked(WebSocket).mockImplementation(() => mockWs);
  });

  it('should handle screenshotError message', async () => {
    const connectPromise = client.connect('ws://test');
    mockWs.once.mock.calls.find(c => c[0] === 'open')?.[1]();
    await connectPromise;

    const screenshotPromise = client.sendForBinary({ type: 'debug', detail: 'screenshot' }, 5000);
    
    // Simulate screenshotError response
    const errorHandler = vi.fn();
    client['msgListeners'].set('screenshotError', errorHandler);
    
    const messageHandler = messageHandlers.get('message');
    messageHandler?.(
      Buffer.from(JSON.stringify({ msg: 'screenshotError', error: 'Driver not initialized' })),
      false
    );

    await expect(screenshotPromise).rejects.toThrow('Screenshot failed: Driver not initialized');
  });

  it('should collect appListDetail messages until appListFinish', async () => {
    const connectPromise = client.connect('ws://test');
    mockWs.once.mock.calls.find(c => c[0] === 'open')?.[1]();
    await connectPromise;

    const appListPromise = client.sendAndCollectList(
      { type: 'appList' },
      'appListDetail',
      'appListFinish',
      5000
    );

    const messageHandler = messageHandlers.get('message');
    
    // Simulate app list responses
    messageHandler?.(
      Buffer.from(JSON.stringify({ 
        msg: 'appListDetail', 
        detail: { appName: 'TestApp', packageName: 'com.test.app' }
      })),
      false
    );
    
    messageHandler?.(
      Buffer.from(JSON.stringify({ 
        msg: 'appListDetail', 
        detail: { appName: 'AnotherApp', packageName: 'com.another.app' }
      })),
      false
    );
    
    messageHandler?.(
      Buffer.from(JSON.stringify({ msg: 'appListFinish' })),
      false
    );

    const result = await appListPromise;
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ appName: 'TestApp', packageName: 'com.test.app' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- src/sonic/sonic-ws-client.test.ts
```

Expected: FAIL - `sendAndCollectList method does not exist`, `screenshotError handling not implemented`

- [ ] **Step 3: Implement enhanced message handling**

```typescript
// Add to src/sonic/sonic-ws-client.ts

export class SonicWsClient {
  // ... existing code ...

  /**
   * Send message and collect a list of responses until a completion message.
   * Used for app list, process list, etc.
   */
  async sendAndCollectList<T>(
    payload: object,
    itemMsg: string,
    doneMsg: string,
    timeout = 30_000,
  ): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const items: T[] = [];
      const timer = setTimeout(() => {
        this.msgListeners.delete(itemMsg);
        this.msgListeners.delete(doneMsg);
        reject(new Error(`sendAndCollectList timeout waiting for "${doneMsg}"`));
      }, timeout);

      this.msgListeners.set(itemMsg, (data: Record<string, unknown>) => {
        const detail = data['detail'] as T;
        if (detail) items.push(detail);
      });

      this.msgListeners.set(doneMsg, () => {
        clearTimeout(timer);
        this.msgListeners.delete(itemMsg);
        this.msgListeners.delete(doneMsg);
        resolve(items);
      });

      this.send(payload);
    });
  }

  /**
   * Send message and collect list responses with timeout-based completion.
   * Used when the server doesn't send a completion message (like Android appList).
   * Waits for messages and returns after timeout with collected items.
   */
  async sendAndCollectListWithTimeout<T>(
    payload: object,
    itemMsg: string,
    timeout = 30_000,
  ): Promise<T[]> {
    return new Promise((resolve) => {
      const items: T[] = [];
      
      const timer = setTimeout(() => {
        this.msgListeners.delete(itemMsg);
        resolve(items);
      }, timeout);

      this.msgListeners.set(itemMsg, (data: Record<string, unknown>) => {
        const detail = data['detail'] as T;
        if (detail) items.push(detail);
      });

      this.send(payload);
    });
  }

  /**
   * Send message and wait for response with enhanced error handling.
   * Handles screenshotError and other error responses.
   */
  async sendAndWaitWithError(
    payload: object,
    expectedMsg: string,
    errorMsg: string,
    timeout = 10_000,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.msgListeners.delete(expectedMsg);
        this.msgListeners.delete(errorMsg);
        reject(new Error(`Timeout waiting for "${expectedMsg}"`));
      }, timeout);

      this.msgListeners.set(expectedMsg, (data) => {
        clearTimeout(timer);
        this.msgListeners.delete(expectedMsg);
        this.msgListeners.delete(errorMsg);
        resolve(data);
      });

      this.msgListeners.set(errorMsg, (data) => {
        clearTimeout(timer);
        this.msgListeners.delete(expectedMsg);
        this.msgListeners.delete(errorMsg);
        const error = data['error'] || 'Unknown error';
        reject(new Error(`${errorMsg}: ${error}`));
      });

      this.send(payload);
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- src/sonic/sonic-ws-client.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sonic/sonic-ws-client.ts src/sonic/sonic-ws-client.test.ts
git commit -m "feat(sonic): add enhanced WebSocket message handling

- Add sendAndCollectList for batch responses (app list, etc.)
- Add sendAndWaitWithError for error-aware request/response
- Support screenshotError, appListDetail, appListFinish messages"
```

---

### Task 2: iOS Coordinate Conversion

**Files:**
- Modify: `src/sonic/sonic-ios-adapter.ts`
- Test: `src/sonic/sonic-ios-adapter.test.ts`

**Context:** iOS Sonic uses logical coordinates from WDA, but screenshots are physical pixels. Need conversion factor like Python implementation.

- [ ] **Step 1: Write failing test for coordinate conversion**

```typescript
// src/sonic/sonic-ios-adapter.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SonicIosAdapter } from './sonic-ios-adapter.js';
import { SonicWsClient } from './sonic-ws-client.js';

vi.mock('./sonic-ws-client.js');
vi.mock('../utils/image.js', () => ({
  getImageDimensions: vi.fn().mockResolvedValue({ width: 1170, height: 2532 })
}));

describe('SonicIosAdapter coordinate conversion', () => {
  let adapter: SonicIosAdapter;
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      send: vi.fn(),
      sendAndWait: vi.fn().mockResolvedValue({ msg: 'tree', detail: {} }),
      sendForBinary: vi.fn().mockResolvedValue(Buffer.from('fake-screenshot')),
      sendAndWaitWithError: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
    };
    vi.mocked(SonicWsClient).mockImplementation(() => mockClient);

    adapter = new SonicIosAdapter('test-udid', {
      agentHost: 'localhost',
      agentPort: 8080,
      key: 'test-key',
      token: 'test-token'
    });
  });

  it('should convert coordinates using logic screen size', async () => {
    // Mock openDriver response with logical size
    mockClient.sendAndWaitWithError.mockResolvedValueOnce({
      msg: 'openDriver',
      status: 'success',
      width: 390,  // logical width
      height: 844  // logical height
    });

    await adapter.connect();

    // Tap at relative coordinates (300, 600) in physical space
    // This should be converted to logical coordinates for Sonic
    // factorX = 1170 / 390 = 3
    // factorY = 2532 / 844 = 3
    // x = 300 / 3 = 100 (logical)
    // y = 600 / 3 = 200 (logical)
    await adapter.tap(300, 600);

    const sendCall = mockClient.send.mock.calls.find(c => c[0].detail === 'tap');
    // Sonic receives logical coordinates
    expect(sendCall[0].point).toBe('100,200');
  });

  it('should handle swipe with coordinate conversion', async () => {
    mockClient.sendAndWaitWithError.mockResolvedValueOnce({
      msg: 'openDriver',
      status: 'success',
      width: 390,
      height: 844
    });

    await adapter.connect();
    // Physical coordinates (900, 1200) -> (1800, 2400)
    // Logical coordinates: (300, 400) -> (600, 800)
    await adapter.swipe(900, 1200, 1800, 2400);

    const sendCall = mockClient.send.mock.calls.find(c => c[0].detail === 'swipe');
    expect(sendCall[0].pointA).toBe('300,400');
    expect(sendCall[0].pointB).toBe('600,800');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- src/sonic/sonic-ios-adapter.test.ts
```

Expected: FAIL - coordinate conversion not implemented

- [ ] **Step 3: Implement iOS coordinate conversion**

```typescript
// src/sonic/sonic-ios-adapter.ts

export class SonicIosAdapter implements PlatformAdapter {
  readonly platform = "ios" as const;
  private client: SonicWsClient;
  private selectedDeviceId: string;
  private screenWidth: number = 0;
  private screenHeight: number = 0;
  private logicWidth: number = 0;
  private logicHeight: number = 0;

  constructor(
    private readonly udId: string,
    private readonly conn: SonicConnectionInfo,
  ) {
    this.client = new SonicWsClient();
    this.selectedDeviceId = udId;
  }

  /**
   * Convert coordinates using logic screen size factor.
   * CRITICAL: This divides by the factor, NOT multiplies.
   * Python reference: new_x = int(x / x_factor)
   */
  private convertByFactor(x: number, y: number): { x: number; y: number } {
    if (this.logicWidth <= 0 || this.logicHeight <= 0) {
      throw new Error(`Logic screen size not available: ${this.logicWidth}x${this.logicHeight}`);
    }

    const xFactor = this.screenWidth / this.logicWidth;
    const yFactor = this.screenHeight / this.logicHeight;

    // IMPORTANT: Divide by factor, not multiply
    // Example: logical (100, 200) with factor 3 -> physical (33, 67)
    return {
      x: Math.round(x / xFactor),
      y: Math.round(y / yFactor)
    };
  }

  async connect(): Promise<void> {
    const { agentHost, agentPort, key, token } = this.conn;
    await this.client.connect(`ws://${agentHost}:${agentPort}/websockets/ios/${key}/${this.udId}/${token}`);

    // Wait for openDriver response to get logic screen size
    const openDriverResponse = await this.client.sendAndWaitWithError(
      { type: "debug", detail: "openDriver" },
      "openDriver",
      "error",
      60_000
    );

    if (openDriverResponse.status !== "success") {
      throw new Error(`iOS Driver initialization failed: ${openDriverResponse.status}`);
    }

    // Get logical screen size from driver
    this.logicWidth = (openDriverResponse.width as number) || 0;
    this.logicHeight = (openDriverResponse.height as number) || 0;

    // Initialize physical screen size from screenshot
    const buf = await this.getScreenshotBufferAsync();
    const size = await import("../utils/image.js").then(m => m.getImageDimensions(buf));
    this.screenWidth = size.width;
    this.screenHeight = size.height;

    console.error(`[Sonic] Connected to ${this.udId}`);
    console.error(`[Sonic] Logic size: ${this.logicWidth}x${this.logicHeight}, Physical: ${this.screenWidth}x${this.screenHeight}`);
  }

  // Update tap to use coordinate conversion
  async tap(x: number, y: number, _targetPid?: number): Promise<void> {
    const { x: convX, y: convY } = this.convertByFactor(x, y);
    this.client.send({ type: "debug", detail: "tap", point: `${convX},${convY}` });
  }

  // Update longPress to use coordinate conversion
  async longPress(x: number, y: number, _durationMs?: number): Promise<void> {
    const { x: convX, y: convY } = this.convertByFactor(x, y);
    this.client.send({ type: "debug", detail: "longPress", point: `${convX},${convY}` });
  }

  // Update swipe to use coordinate conversion
  async swipe(x1: number, y1: number, x2: number, y2: number, _durationMs?: number): Promise<void> {
    const start = this.convertByFactor(x1, y1);
    const end = this.convertByFactor(x2, y2);
    this.client.send({ 
      type: "debug", 
      detail: "swipe", 
      pointA: `${start.x},${start.y}`, 
      pointB: `${end.x},${end.y}` 
    });
  }

  // ... rest of existing methods ...
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- src/sonic/sonic-ios-adapter.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sonic/sonic-ios-adapter.ts src/sonic/sonic-ios-adapter.test.ts
git commit -m "feat(sonic): implement iOS coordinate conversion

- Add convertByFactor method for logic to physical coordinate conversion
- Get logic screen size from openDriver response
- Apply conversion to tap, longPress, and swipe operations
- Reference: Python _covert_by_factor implementation"
```

---

### Task 3: App Listing via Terminal Connection

**Files:**
- Modify: `src/sonic/sonic-android-adapter.ts`
- Modify: `src/sonic/sonic-ios-adapter.ts`
- Modify: `src/adapters/platform-adapter.ts`
- Modify: `src/tools/app-tools.ts`
- Test: `src/sonic/sonic-android-adapter.test.ts`, `src/sonic/sonic-ios-adapter.test.ts`

**Context:** Both Android and iOS support app listing via Terminal WebSocket connection.

- [ ] **Step 1: Add getAppList to PlatformAdapter interface**

```typescript
// src/adapters/platform-adapter.ts

export interface PlatformAdapter {
  // ... existing methods ...

  /**
   * Get list of installed applications.
   * Returns array of app info objects.
   */
  getAppList(): Promise<Array<{
    appName: string;
    packageName: string;
    versionName?: string;
    versionCode?: string;
  }>>;
}
```

- [ ] **Step 2: Implement getAppList in SonicAndroidAdapter**

```typescript
// Add to src/sonic/sonic-android-adapter.ts

export class SonicAndroidAdapter implements PlatformAdapter {
  // ... existing code ...

  async getAppList(): Promise<Array<{
    appName: string;
    packageName: string;
    versionName?: string;
    versionCode?: string;
  }>> {
    // Create terminal connection
    const termClient = new SonicWsClient();
    const { agentHost, agentPort, key, token } = this.conn;
    
    try {
      await termClient.connect(
        `ws://${agentHost}:${agentPort}/websockets/android/terminal/${key}/${this.udId}/${token}`
      );

      // Android doesn't send appListFinish, so we use timeout-based collection
      // similar to the Python implementation
      const apps = await termClient.sendAndCollectListWithTimeout<{
        appName: string;
        packageName: string;
        versionName?: string;
        versionCode?: string;
      }>(
        { type: "appList" },
        "appListDetail",
        30_000
      );

      return apps;
    } finally {
      termClient.disconnect();
    }
  }
}
```

- [ ] **Step 3: Implement getAppList in SonicIosAdapter**

```typescript
// Add to src/sonic/sonic-ios-adapter.ts

export class SonicIosAdapter implements PlatformAdapter {
  // ... existing code ...

  async getAppList(): Promise<Array<{
    appName: string;
    packageName: string;
    versionName?: string;
    versionCode?: string;
  }>> {
    const termClient = new SonicWsClient();
    const { agentHost, agentPort, key, token } = this.conn;
    
    try {
      await termClient.connect(
        `ws://${agentHost}:${agentPort}/websockets/ios/terminal/${key}/${this.udId}/${token}`
      );

      const apps = await termClient.sendAndCollectList<{
        appName: string;
        packageName: string;
        versionName?: string;
        versionCode?: string;
      }>(
        { type: "appList" },
        "appListDetail",
        "appListFinish",
        30_000
      );

      return apps;
    } finally {
      termClient.disconnect();
    }
  }
}
```

- [ ] **Step 4: Add getAppList to DeviceManager**

```typescript
// Add to src/device-manager.ts

export class DeviceManager {
  // ... existing code ...

  async getAppList(platform?: Platform): Promise<Array<{
    appName: string;
    packageName: string;
    versionName?: string;
    versionCode?: string;
  }>> {
    const adapter = this.getAdapter(platform);
    if (!adapter.getAppList) {
      throw new Error(`getAppList not supported for ${adapter.platform}`);
    }
    return adapter.getAppList();
  }
}
```

- [ ] **Step 5: Update app_list tool to support Sonic**

```typescript
// Modify src/tools/app-tools.ts

export const appTools: ToolDefinition[] = [
  // ... existing tools ...

  {
    tool: {
      name: "app_list",
      description: "List installed applications on the device",
      inputSchema: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["android", "ios", "aurora"], description: "Target platform" },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();

      if (currentPlatform === "aurora") {
        const packages = ctx.deviceManager.getAuroraClient().listPackages();
        return { text: `Installed packages (${packages.length}):\n${packages.join("\n")}` };
      }

      if (ctx.deviceManager.isSonicMode() && (currentPlatform === "android" || currentPlatform === "ios")) {
        const apps = await ctx.deviceManager.getAppList(platform);
        if (apps.length === 0) {
          return { text: "No apps found or unable to retrieve app list." };
        }
        const formatted = apps.map(a => 
          `${a.appName} (${a.packageName})${a.versionName ? ` - v${a.versionName}` : ''}`
        ).join('\n');
        return { text: `Installed apps (${apps.length}):\n${formatted}` };
      }

      return { text: `app_list is not supported for ${currentPlatform} in non-Sonic mode.` };
    },
  },
];
```

- [ ] **Step 6: Run tests**

```bash
npm test -- src/sonic/sonic-android-adapter.test.ts src/sonic/sonic-ios-adapter.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/adapters/platform-adapter.ts src/sonic/sonic-android-adapter.ts src/sonic/sonic-ios-adapter.ts src/device-manager.ts src/tools/app-tools.ts
git commit -m "feat(sonic): add app listing support for Android and iOS

- Add getAppList() to PlatformAdapter interface
- Implement getAppList via Terminal WebSocket for Android and iOS
- Update app_list tool to support Sonic devices
- Use sendAndCollectList for batch response handling"
```

---

### Task 4: Enhanced Response Waiting for Android

**Files:**
- Modify: `src/sonic/sonic-android-adapter.ts`
- Test: `src/sonic/sonic-android-adapter.test.ts`

**Context:** Android launchApp, stopApp, and uninstallApp should wait for server responses.

- [ ] **Step 1: Add uninstallApp with response waiting (Android)**

**NOTE:** Android `launchApp` and `stopApp` do NOT send response messages (fire-and-forget).
Only `uninstallApp` sends a response. See AndroidWSServer.java lines 219-233.

```typescript
// Add to src/sonic/sonic-android-adapter.ts

async uninstallApp(pkg: string): Promise<string> {
  const res = await this.client.sendAndWaitWithError(
    { type: "uninstallApp", detail: pkg },
    "uninstallFinish",
    "error",
    60_000
  );
  
  if (res.detail !== "success") {
    throw new Error(`Uninstall failed: ${res.detail}`);
  }
  
  return `Uninstalled ${pkg}`;
}
```

- [ ] **Step 2: Update iOS launchApp with response waiting**

**NOTE:** iOS `launch` and `kill` DO send response messages. See IOSWSServer.java lines 305-406.

```typescript
// Modify src/sonic/sonic-ios-adapter.ts

async launchApp(pkg: string): Promise<string> {
  const res = await this.client.sendAndWaitWithError(
    { type: "launch", pkg },
    "launchResult",
    "error",
    15_000
  );
  
  if (res.status !== "success") {
    throw new Error(`Launch failed: ${res.status} - ${res.error || 'Unknown error'}`);
  }
  
  return `Launched ${pkg}`;
}

async stopApp(pkg: string): Promise<void> {
  const res = await this.client.sendAndWaitWithError(
    { type: "kill", pkg },
    "killResult",
    "error",
    15_000
  );
  
  if (res.status !== "success") {
    throw new Error(`Stop failed: ${res.status} - ${res.error || 'Unknown error'}`);
  }
}
```

- [ ] **Step 3: Run tests**

```bash
npm test -- src/sonic/sonic-android-adapter.test.ts src/sonic/sonic-ios-adapter.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/sonic/sonic-android-adapter.ts src/sonic/sonic-ios-adapter.ts
git commit -m "feat(sonic): add response waiting for app operations

- Add uninstallApp for Android with response validation
- Update iOS launchApp to wait for launchResult response
- Update iOS stopApp to wait for killResult response
- Use sendAndWaitWithError for reliable operation confirmation"
```

---

## Phase 2: Extended Tools

### Task 5: Clipboard Operations

**Files:**
- Modify: `src/sonic/sonic-android-adapter.ts`
- Modify: `src/sonic/sonic-ios-adapter.ts`
- Modify: `src/adapters/platform-adapter.ts`
- Modify: `src/tools/clipboard-tools.ts`

**Context:** Sonic supports setPasteboard/getPasteboard for both platforms.

- [ ] **Step 1: Add clipboard methods to PlatformAdapter**

```typescript
// Add to src/adapters/platform-adapter.ts

export interface PlatformAdapter {
  // ... existing methods ...

  /**
   * Set clipboard content.
   */
  setClipboard(text: string): Promise<void>;

  /**
   * Get clipboard content.
   */
  getClipboard(): Promise<string>;
}
```

- [ ] **Step 2: Implement clipboard in SonicAndroidAdapter**

```typescript
// Add to src/sonic/sonic-android-adapter.ts

async setClipboard(text: string): Promise<void> {
  this.client.send({ type: "setPasteboard", detail: text });
  // Small delay to allow operation to complete
  await new Promise(r => setTimeout(r, 500));
}

async getClipboard(): Promise<string> {
  const response = await this.client.sendAndWait(
    { type: "getPasteboard" },
    "paste",
    5_000
  );
  return String(response.detail || "");
}
```

- [ ] **Step 3: Implement clipboard in SonicIosAdapter**

```typescript
// Add to src/sonic/sonic-ios-adapter.ts

async setClipboard(text: string): Promise<void> {
  this.client.send({ type: "setPasteboard", detail: text });
  await new Promise(r => setTimeout(r, 500));
}

async getClipboard(): Promise<string> {
  const response = await this.client.sendAndWait(
    { type: "getPasteboard" },
    "paste",
    5_000
  );
  return String(response.detail || "");
}
```

- [ ] **Step 4: Update clipboard-tools.ts to support Sonic**

**NOTE:** Extend existing `clipboard_select`, `clipboard_copy`, `clipboard_paste`, `clipboard_get_android` to support Sonic mode.

```typescript
// Modify src/tools/clipboard-tools.ts - clipboard_get_android handler

handler: async (args, ctx) => {
  const platform = args.platform as Platform | undefined;
  const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();

  // Sonic mode support for Android and iOS
  if (ctx.deviceManager.isSonicMode() && (currentPlatform === "android" || currentPlatform === "ios")) {
    const adapter = ctx.deviceManager.getAdapter(platform) as import("../sonic/sonic-android-adapter.js").SonicAndroidAdapter | import("../sonic/sonic-ios-adapter.js").SonicIosAdapter;
    const text = await adapter.getClipboard();
    return { text: `Clipboard: ${text}` };
  }

  // Original ADB implementation for Android
  if (currentPlatform !== "android") {
    return { text: "clipboard_get_android is only available on Android platform" };
  }

  if (ctx.deviceManager.isSonicMode()) {
    return { content: [{ type: "text", text: "clipboard_get_android is not supported in Sonic mode" }] };
  }

  const client = getAndroidAdapter(ctx, platform);
  const text = client.getClipboardText();
  return { text: `Clipboard: ${text}` };
},
```

Similarly update `clipboard_select`, `clipboard_copy`, `clipboard_paste` to support Sonic mode by delegating to adapter methods.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/platform-adapter.ts src/sonic/sonic-android-adapter.ts src/sonic/sonic-ios-adapter.ts src/tools/clipboard-tools.ts
git commit -m "feat(sonic): add clipboard operations for Android and iOS

- Add setClipboard() and getClipboard() to PlatformAdapter
- Implement via setPasteboard/getPasteboard Sonic messages
- Update clipboard tools to support Sonic devices"
```

---

### Task 6: File Transfer (Extend Aurora Tools to Support Sonic Android)

**Files:**
- Modify: `src/sonic/sonic-android-adapter.ts`
- Modify: `src/tools/aurora-tools.ts`

**Context:** Android Sonic supports pullFile and pushFile operations. Extend existing Aurora file tools to also support Sonic Android.

- [ ] **Step 1: Implement pullFile and pushFile in SonicAndroidAdapter**

```typescript
// Add to src/sonic/sonic-android-adapter.ts

async pullFile(path: string): Promise<{ url: string; status: string }> {
  const res = await this.client.sendAndWaitWithError(
    { type: "pullFile", path },
    "pullResult",
    "error",
    30_000
  );
  
  if (res.status !== "success") {
    throw new Error(`Pull file failed: ${res.status}`);
  }
  
  return {
    url: String(res.url || ""),
    status: String(res.status)
  };
}

async pushFile(localPath: string, remotePath: string): Promise<void> {
  const res = await this.client.sendAndWaitWithError(
    { type: "pushFile", file: localPath, path: remotePath },
    "pushResult",
    "error",
    60_000
  );
  
  if (res.status !== "success") {
    throw new Error(`Push file failed: ${res.status}`);
  }
}
```

- [ ] **Step 2: Extend aurora-tools.ts to support Sonic Android**

```typescript
// Modify src/tools/aurora-tools.ts

{
  tool: {
    name: "file_push",
    description: "Upload file to device (Aurora OS or Sonic Android)",
    inputSchema: {
      type: "object",
      properties: {
        localPath: { type: "string", description: "Local file path" },
        remotePath: { type: "string", description: "Destination path on device" },
        platform: { type: "string", enum: ["aurora", "android"], description: "Target platform" },
      },
      required: ["localPath", "remotePath"],
    },
  },
  handler: async (args, ctx) => {
    const platform = args.platform as Platform | undefined;
    const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();

    // Sonic Android support
    if (currentPlatform === "android" && ctx.deviceManager.isSonicMode()) {
      const adapter = ctx.deviceManager.getAdapter(platform) as import("../sonic/sonic-android-adapter.js").SonicAndroidAdapter;
      await adapter.pushFile(args.localPath as string, args.remotePath as string);
      return { text: `File pushed to ${args.remotePath}` };
    }

    // Aurora OS support
    if (currentPlatform !== "aurora") {
      return { text: "file_push is only available for Aurora OS or Sonic Android" };
    }

    await ctx.deviceManager.getAuroraClient().pushFile(
      args.localPath as string,
      args.remotePath as string
    );
    return { text: `File pushed to ${args.remotePath}` };
  },
},

{
  tool: {
    name: "file_pull",
    description: "Download file from device (Aurora OS or Sonic Android)",
    inputSchema: {
      type: "object",
      properties: {
        remotePath: { type: "string", description: "Remote file path on device" },
        localPath: { type: "string", description: "Local destination path" },
        platform: { type: "string", enum: ["aurora", "android"], description: "Target platform" },
      },
      required: ["remotePath", "localPath"],
    },
  },
  handler: async (args, ctx) => {
    const platform = args.platform as Platform | undefined;
    const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();

    // Sonic Android support
    if (currentPlatform === "android" && ctx.deviceManager.isSonicMode()) {
      const adapter = ctx.deviceManager.getAdapter(platform) as import("../sonic/sonic-android-adapter.js").SonicAndroidAdapter;
      const result = await adapter.pullFile(args.remotePath as string);
      return { text: `File pulled successfully. URL: ${result.url}` };
    }

    // Aurora OS support
    if (currentPlatform !== "aurora") {
      return { text: "file_pull is only available for Aurora OS or Sonic Android" };
    }

    await ctx.deviceManager.getAuroraClient().pullFile(
      args.remotePath as string,
      args.localPath as string
    );
    return { text: `File pulled to ${args.localPath}` };
  },
},
```

- [ ] **Step 3: Commit**

```bash
git add src/sonic/sonic-android-adapter.ts src/tools/aurora-tools.ts
git commit -m "feat(sonic): extend file transfer tools to support Sonic Android

- Implement pullFile and pushFile in SonicAndroidAdapter
- Extend aurora-tools.ts file_push/file_pull to support Sonic Android
- No new tool names added - extended existing tools"
```

---

### Task 7: WebView Inspection

**Files:**
- Modify: `src/sonic/sonic-android-adapter.ts`
- Modify: `src/sonic/sonic-ios-adapter.ts`
- Modify: `src/tools/system-tools.ts`

**Context:** Sonic supports forwardView message to get WebView information.

- [ ] **Step 1: Add getWebViews to PlatformAdapter**

```typescript
// Add to src/adapters/platform-adapter.ts

export interface PlatformAdapter {
  // ... existing methods ...

  /**
   * Get list of WebViews in the current app.
   */
  getWebViews(): Promise<Array<{
    packageName?: string;
    socket?: string;
    [key: string]: any;
  }>>;
}
```

- [ ] **Step 2: Implement getWebViews in adapters**

```typescript
// Add to src/sonic/sonic-android-adapter.ts and src/sonic/sonic-ios-adapter.ts

async getWebViews(): Promise<Array<{ packageName?: string; socket?: string }>> {
  const res = await this.client.sendAndWait(
    { type: "forwardView" },
    "forwardView",
    10_000
  );
  
  const detail = res.detail as any;
  if (!detail) return [];
  
  // Parse WebView info from response
  // Format depends on Sonic server response structure
  if (Array.isArray(detail)) {
    return detail;
  }
  
  return [detail];
}
```

- [ ] **Step 3: Update system_webview tool**

```typescript
// Modify src/tools/system-tools.ts - system_webview handler

handler: async (args, ctx) => {
  if (ctx.deviceManager.isSonicMode()) {
    const platform = args.platform as Platform | undefined;
    const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();
    
    if (currentPlatform !== "android" && currentPlatform !== "ios") {
      return { text: `system_webview not supported for ${currentPlatform} in Sonic mode` };
    }
    
    const adapter = ctx.deviceManager.getAdapter(platform) as import("../sonic/sonic-android-adapter.js").SonicAndroidAdapter | import("../sonic/sonic-ios-adapter.js").SonicIosAdapter;
    const webviews = await adapter.getWebViews();
    
    if (webviews.length === 0) {
      return { text: "No WebViews found in current app." };
    }
    
    const formatted = webviews.map((w, i) => 
      `${i + 1}. Package: ${w.packageName || 'N/A'}, Socket: ${w.socket || 'N/A'}`
    ).join('\n');
    
    return { text: `Found ${webviews.length} WebView(s):\n${formatted}` };
  }

  // ... existing non-Sonic implementation ...
},
```

- [ ] **Step 4: Commit**

```bash
git add src/adapters/platform-adapter.ts src/sonic/sonic-android-adapter.ts src/sonic/sonic-ios-adapter.ts src/tools/system-tools.ts
git commit -m "feat(sonic): add WebView inspection support

- Add getWebViews() to PlatformAdapter
- Implement via forwardView Sonic message
- Update system_webview tool to support Sonic devices"
```

---

## Testing Strategy

### Unit Tests

Each task includes unit tests for:
- Message handling logic
- Coordinate conversion calculations
- Adapter method implementations

### Integration Tests

After all tasks complete, run full integration:

```bash
# Build the project
npm run build

# Run all tests
npm test

# Test specific Sonic functionality
npm test -- src/sonic/
```

### Manual Testing Checklist

- [ ] iOS coordinate conversion with different screen sizes
- [ ] App listing on Android and iOS
- [ ] Clipboard set/get operations
- [ ] File pull/push on Android
- [ ] WebView inspection
- [ ] Enhanced response waiting for app operations

---

## Summary

This plan implements:

**Phase 1 (Core):**
1. Enhanced WebSocket message handling for batch responses and error handling
2. iOS coordinate conversion using logical screen size
3. App listing via Terminal WebSocket
4. Response waiting for Android app operations

**Phase 2 (Extended):**
5. Clipboard operations (set/get)
6. File transfer (Android pull/push)
7. WebView inspection

All changes maintain backward compatibility and follow existing code patterns in the repository.

---

## Appendix: Sonic Message Types Reference

### Request Messages (Client → Server)

| Message Type | Direction | Platform | Description |
|--------------|-----------|----------|-------------|
| `debug/tap` | Client→Server | Both | Tap at coordinates |
| `debug/longPress` | Client→Server | Both | Long press at coordinates |
| `debug/swipe` | Client→Server | Both | Swipe between coordinates |
| `debug/openApp` | Client→Server | Android | Launch app (fire-and-forget) |
| `debug/killApp` | Client→Server | Android | Stop app (fire-and-forget) |
| `launch` | Client→Server | iOS | Launch app (with response) |
| `kill` | Client→Server | iOS | Stop app (with response) |
| `uninstallApp` | Client→Server | Android | Uninstall app |
| `debug/install` | Client→Server | Both | Install app (APK/IPA) |
| `debug/tree` | Client→Server | Both | Get UI hierarchy |
| `debug/screenshot` | Client→Server | Both | Get screenshot |
| `text` | Client→Server | Android | Send text input |
| `send` | Client→Server | iOS | Send text input |
| `keyEvent` | Client→Server | Both | Press key |
| `setPasteboard` | Client→Server | Both | Set clipboard |
| `getPasteboard` | Client→Server | Both | Get clipboard |
| `forwardView` | Client→Server | Both | Get WebView info |
| `pullFile` | Client→Server | Android | Download file |
| `pushFile` | Client→Server | Android | Upload file |
| `appList` | Client→Server | Both | Get installed apps |

### Response Messages (Server → Client)

| Message Type | Direction | Platform | Description |
|--------------|-----------|----------|-------------|
| `openDriver` | Server→Client | Both | Driver initialization status |
| `screenshotError` | Server→Client | Both | Screenshot failure |
| `launchResult` | Server→Client | iOS | Launch result with status/error |
| `killResult` | Server→Client | iOS | Kill result with status/error |
| `installFinish` | Server→Client | Both | Installation completion |
| `uninstallFinish` | Server→Client | Android | Uninstallation completion |
| `appListDetail` | Server→Client | Both | Single app info (streamed) |
| `appListFinish` | Server→Client | iOS | End of app list (Android doesn't send this) |
| `paste` | Server→Client | Both | Clipboard content |
| `setPaste` | Server→Client | iOS | Clipboard set confirmation |
| `forwardView` | Server→Client | Both | WebView information |
| `pullResult` | Server→Client | Android | File pull result |
| `pushResult` | Server→Client | Android | File push result |
| `tree` | Server→Client | Both | UI hierarchy response |

### Important Notes

1. **iOS Coordinate Conversion**: Sonic iOS expects logical coordinates, but screenshots are physical pixels. Convert by dividing physical coordinates by the factor (screenWidth / logicWidth).

2. **Android App List**: Android Terminal WSServer doesn't send `appListFinish`. Use timeout-based collection.

3. **Response Differences**:
   - Android `launchApp`/`stopApp`: Fire-and-forget (no response)
   - iOS `launch`/`kill`: Have response messages (`launchResult`/`killResult`)

4. **Terminal WebSocket**: App listing requires separate Terminal WebSocket connection (`/websockets/{platform}/terminal/{key}/{udId}/{token}`)
