import type { PlatformAdapter } from "../adapters/platform-adapter.js";
import type { Device } from "../device-manager.js";
import type { CompressOptions } from "../utils/image.js";
import type { SonicConnectionInfo } from "./sonic-device-source.js";
import { SonicWsClient } from "./sonic-ws-client.js";

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
   * Convert relative coordinates (0-1000) to absolute pixels.
   * Screen size is initialized in connect().
   * Reference: /autospecter/autospecter/new_agents/tools/device/pos_adapter.py
   */
  private toAbsolute(xPos: number, yPos: number): { x: number; y: number } {
    const absX = Math.round(xPos / 1000 * this.screenWidth);
    const absY = Math.round(yPos / 1000 * this.screenHeight);
    return { x: absX, y: absY };
  }

  /**
   * Convert coordinates using logic screen size factor.
   * CRITICAL: This divides by the factor, NOT multiplies.
   * Python reference: new_x = int(x / x_factor)
   * Formula: xFactor = screenWidth / logicWidth, then x / xFactor
   * Example: physical (300, 600) with factor 3 -> logical (100, 200)
   */
  private convertByFactor(x: number, y: number): { x: number; y: number } {
    if (this.logicWidth <= 0 || this.logicHeight <= 0) {
      throw new Error(`Logic screen size not available: ${this.logicWidth}x${this.logicHeight}`);
    }

    const xFactor = this.screenWidth / this.logicWidth;
    const yFactor = this.screenHeight / this.logicHeight;

    // IMPORTANT: Divide by factor, not multiply
    // Example: physical (300, 600) with factor 3 -> logical (100, 200)
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

  async dispose(): Promise<void> {
    this.client.disconnect();
  }

  // Device management stubs
  listDevices(): Device[] { return []; }
  selectDevice(id: string): void { this.selectedDeviceId = id; }
  getSelectedDeviceId(): string { return this.selectedDeviceId; }
  autoDetectDevice(): Device | undefined { return undefined; }

  // Core actions - Sonic iOS receives physical coordinates and converts to logical
  async tap(x: number, y: number, _targetPid?: number): Promise<void> {
    const { x: convX, y: convY } = this.convertByFactor(x, y);
    this.client.send({ type: "debug", detail: "tap", point: `${convX},${convY}` });
  }

  async doubleTap(x: number, y: number): Promise<void> {
    const { x: convX, y: convY } = this.convertByFactor(x, y);
    this.client.send({ type: "debug", detail: "tap", point: `${convX},${convY}` });
    await new Promise(r => setTimeout(r, 100));
    this.client.send({ type: "debug", detail: "tap", point: `${convX},${convY}` });
  }

  async longPress(x: number, y: number): Promise<void> {
    const { x: convX, y: convY } = this.convertByFactor(x, y);
    this.client.send({ type: "debug", detail: "longPress", point: `${convX},${convY}` });
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, _durationMs?: number): Promise<void> {
    const start = this.convertByFactor(x1, y1);
    const end = this.convertByFactor(x2, y2);
    this.client.send({ type: "debug", detail: "swipe", pointA: `${start.x},${start.y}`, pointB: `${end.x},${end.y}` });
  }

  async swipeDirection(direction: "up" | "down" | "left" | "right"): Promise<void> {
    const cx = this.screenWidth / 2;
    const cy = this.screenHeight / 2;
    const delta = Math.min(this.screenWidth, this.screenHeight) * 0.3;
    const dirs = {
      up:    [cx, cy + delta, cx, cy - delta],
      down:  [cx, cy - delta, cx, cy + delta],
      left:  [cx + delta, cy, cx - delta, cy],
      right: [cx - delta, cy, cx + delta, cy],
    };
    const [x1, y1, x2, y2] = dirs[direction];
    // swipe() expects relative coordinates (0-1000), so convert back
    const toRel = (v: number, max: number) => Math.round(v / max * 1000);
    await this.swipe(toRel(x1, this.screenWidth), toRel(y1, this.screenHeight), toRel(x2, this.screenWidth), toRel(y2, this.screenHeight));
  }

  async inputText(text: string, _targetPid?: number): Promise<void> {
    this.client.send({ type: "send", detail: text });
  }

  async pressKey(key: string, _targetPid?: number): Promise<void> {
    this.client.send({ type: "debug", detail: "keyEvent", key });
  }

  // Screenshot
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

  // UI
  async getUiHierarchy(): Promise<string> {
    const res = await this.client.sendAndWait({ type: "debug", detail: "tree" }, "tree", 15_000);
    return JSON.stringify(res["detail"]);
  }

  // App management
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

  async installApp(path: string): Promise<string> {
    const res = await this.client.sendAndWait(
      { type: "debug", detail: "install", ipa: path },
      "installFinish",
      60_000,
    );
    if (res["status"] !== "success") throw new Error(`Install failed: ${res["status"]}`);
    return `Installed ${path}`;
  }

  // Permissions — not supported on iOS
  async grantPermission(_pkg: string, _permission: string): Promise<string> {
    throw new Error("grantPermission not supported on sonic-ios");
  }

  async revokePermission(_pkg: string, _permission: string): Promise<string> {
    throw new Error("revokePermission not supported on sonic-ios");
  }

  async resetPermissions(_pkg: string): Promise<string> {
    throw new Error("resetPermissions not supported on sonic-ios");
  }

  // System
  async shell(_command: string): Promise<string> {
    throw new Error("shell not supported on sonic-ios");
  }

  async getLogs(_options: { level?: string; tag?: string; lines?: number; package?: string } = {}): Promise<string> {
    const termClient = new SonicWsClient();
    const { agentHost, agentPort, key, token } = this.conn;
    await termClient.connect(
      `ws://${agentHost}:${agentPort}/websockets/ios/terminal/${key}/${this.udId}/${token}`
    );
    try {
      return await new Promise((resolve) => {
        const lines: string[] = [];
        termClient["msgListeners"].set("syslogResp", (data: Record<string, unknown>) => {
          lines.push(String(data["detail"] ?? ""));
        });
        termClient.send({ type: "syslog", filter: "" });
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

  async clearLogs(): Promise<string> {
    throw new Error("clearLogs not supported on sonic-ios");
  }

  async getSystemInfo(): Promise<string> {
    throw new Error("getSystemInfo not supported on sonic-ios");
  }

  // ============ App Listing ============

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

      // iOS sends appListFinish, so we use the standard collection method
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

  // ============ Clipboard Operations ============

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

  // ============ WebView Inspection ============

  async getWebViews(): Promise<Array<{ packageName?: string; socket?: string; [key: string]: any }>> {
    const res = await this.client.sendAndWait(
      { type: "forwardView" },
      "forwardView",
      10_000
    );

    const detail = res.detail as any;
    if (!detail) return [];

    // Parse WebView info from response
    if (Array.isArray(detail)) {
      return detail;
    }

    return [detail];
  }
}
