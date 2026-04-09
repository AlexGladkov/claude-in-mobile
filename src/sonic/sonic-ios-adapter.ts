import type { PlatformAdapter } from "../adapters/platform-adapter.js";
import type { Device } from "../device-manager.js";
import type { CompressOptions } from "../utils/image.js";
import type { SonicConnectionInfo } from "./sonic-device-source.js";
import { SonicWsClient } from "./sonic-ws-client.js";

export class SonicIosAdapter implements PlatformAdapter {
  readonly platform = "ios" as const;
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
    await this.client.connect(`ws://${agentHost}:${agentPort}/websockets/ios/${key}/${this.udId}/${token}`);
  }

  async dispose(): Promise<void> {
    this.client.disconnect();
  }

  // Device management stubs
  listDevices(): Device[] { return []; }
  selectDevice(id: string): void { this.selectedDeviceId = id; }
  getSelectedDeviceId(): string { return this.selectedDeviceId; }
  autoDetectDevice(): Device | undefined { return undefined; }

  // Core actions
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
    const res = await this.client.sendAndWait({ type: "launch", pkg }, "launchResult", 10_000);
    if (res["status"] !== "success") throw new Error(`Launch failed: ${res["status"]}`);
    return `Launched ${pkg}`;
  }

  async stopApp(pkg: string): Promise<void> {
    await this.client.sendAndWait({ type: "kill", pkg }, "killResult", 10_000);
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
}
