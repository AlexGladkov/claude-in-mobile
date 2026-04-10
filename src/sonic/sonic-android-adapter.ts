import type { PlatformAdapter } from "../adapters/platform-adapter.js";
import type { Device } from "../device-manager.js";
import type { CompressOptions } from "../utils/image.js";
import type { SonicConnectionInfo } from "./sonic-device-source.js";
import { SonicWsClient } from "./sonic-ws-client.js";

export class SonicAndroidAdapter implements PlatformAdapter {
  readonly platform = "android" as const;
  private client: SonicWsClient;
  private selectedDeviceId: string;
  private screenWidth: number = 0;
  private screenHeight: number = 0;

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

  async connect(): Promise<void> {
    const { agentHost, agentPort, key, token } = this.conn;
    await this.client.connect(`ws://${agentHost}:${agentPort}/websockets/android/${key}/${this.udId}/${token}`);
    // Initialize screen size once at connection time
    const buf = await this.getScreenshotBufferAsync();
    const size = await import("../utils/image.js").then(m => m.getImageDimensions(buf));
    this.screenWidth = size.width;
    this.screenHeight = size.height;
  }

  async dispose(): Promise<void> {
    this.client.disconnect();
  }

  // Device management stubs
  listDevices(): Device[] { return []; }
  selectDevice(id: string): void { this.selectedDeviceId = id; }
  getSelectedDeviceId(): string { return this.selectedDeviceId; }
  autoDetectDevice(): Device | undefined { return undefined; }

  // Core actions - Sonic receives relative coordinates (0-1000) and converts to absolute
  async tap(x: number, y: number, _targetPid?: number): Promise<void> {
    const { x: absX, y: absY } = this.toAbsolute(x, y);
    this.client.send({ type: "debug", detail: "tap", point: `${absX},${absY}` });
  }

  async doubleTap(x: number, y: number): Promise<void> {
    const { x: absX, y: absY } = this.toAbsolute(x, y);
    this.client.send({ type: "debug", detail: "tap", point: `${absX},${absY}` });
    await new Promise(r => setTimeout(r, 100));
    this.client.send({ type: "debug", detail: "tap", point: `${absX},${absY}` });
  }

  async longPress(x: number, y: number): Promise<void> {
    const { x: absX, y: absY } = this.toAbsolute(x, y);
    this.client.send({ type: "debug", detail: "longPress", point: `${absX},${absY}` });
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, _durationMs?: number): Promise<void> {
    const start = this.toAbsolute(x1, y1);
    const end = this.toAbsolute(x2, y2);
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
    this.client.send({ type: "text", detail: text });
  }

  async pressKey(key: string, _targetPid?: number): Promise<void> {
    this.client.send({ type: "keyEvent", detail: key });
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

  // Permissions (via shell)
  async grantPermission(pkg: string, permission: string): Promise<string> {
    return this.shell(`pm grant ${pkg} ${permission}`);
  }

  async revokePermission(pkg: string, permission: string): Promise<string> {
    return this.shell(`pm revoke ${pkg} ${permission}`);
  }

  async resetPermissions(pkg: string): Promise<string> {
    return this.shell(`pm reset-permissions ${pkg}`);
  }

  // System (via terminal WS)
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

  async getLogs(options: { level?: string; tag?: string; lines?: number; package?: string } = {}): Promise<string> {
    const termClient = new SonicWsClient();
    const { agentHost, agentPort, key, token } = this.conn;
    await termClient.connect(
      `ws://${agentHost}:${agentPort}/websockets/android/terminal/${key}/${this.udId}/${token}`
    );
    try {
      // Collect logcat for 3 seconds then return
      return await new Promise((resolve) => {
        const lines: string[] = [];
        // Set up listener for logcat responses before sending command
        termClient["msgListeners"].set("logcatResp", (data: Record<string, unknown>) => {
          lines.push(String(data["detail"] ?? ""));
        });
        termClient.send({ type: "logcat", level: options.level ?? "V", filter: options.tag ?? "" });
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
    return this.shell("logcat -c");
  }

  async getSystemInfo(): Promise<string> {
    throw new Error("getSystemInfo not supported on sonic-android in phase 1");
  }
}
