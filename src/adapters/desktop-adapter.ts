/**
 * DesktopAdapter — wraps DesktopClient and implements PlatformAdapter.
 *
 * Desktop is special: it has a single "virtual" device that is present only
 * when the companion app is running.  Many PlatformAdapter methods that
 * don't apply to desktop throw descriptive errors or return no-op values.
 */

import type { PlatformAdapter } from "./platform-adapter.js";
import type { Device } from "../device-manager.js";
import { DesktopClient } from "../desktop/client.js";
import type { LaunchOptions } from "../desktop/types.js";

export class DesktopAdapter implements PlatformAdapter {
  readonly platform = "desktop" as const;
  private client: DesktopClient;

  constructor(client?: DesktopClient) {
    this.client = client ?? new DesktopClient();
  }

  /** Raw client access — needed by tools that call getDesktopClient(). */
  getClient(): DesktopClient {
    return this.client;
  }

  // ============ Device management ============

  listDevices(): Device[] {
    if (!this.client.isRunning()) {
      return [];
    }
    const state = this.client.getState();
    return [
      {
        id: "desktop",
        name: "Desktop App",
        platform: "desktop" as const,
        state: state.status,
        isSimulator: false,
      },
    ];
  }

  selectDevice(_deviceId: string): void {
    // Desktop has no notion of device selection — it's always "desktop".
    // No-op; the important thing is that activeTarget is set in DeviceManager.
  }

  getSelectedDeviceId(): string | undefined {
    return this.client.isRunning() ? "desktop" : undefined;
  }

  autoDetectDevice(): Device | undefined {
    if (!this.client.isRunning()) return undefined;
    const state = this.client.getState();
    return {
      id: "desktop",
      name: "Desktop App",
      platform: "desktop",
      state: state.status,
      isSimulator: false,
    };
  }

  // ============ Desktop-specific lifecycle ============

  isRunning(): boolean {
    return this.client.isRunning();
  }

  getState() {
    return this.client.getState();
  }

  async launch(options: LaunchOptions): Promise<void> {
    await this.client.launch(options);
  }

  async stop(): Promise<void> {
    await this.client.stop();
  }

  // ============ Core actions ============

  private ensureRunning(): void {
    if (!this.client.isRunning()) {
      throw new Error("Desktop app is not running. Use launch_desktop_app first.");
    }
  }

  async tap(x: number, y: number, targetPid?: number): Promise<void> {
    this.ensureRunning();
    await this.client.tap(x, y, targetPid);
  }

  async doubleTap(x: number, y: number, intervalMs: number = 100): Promise<void> {
    this.ensureRunning();
    await this.client.tap(x, y);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    await this.client.tap(x, y);
  }

  async longPress(x: number, y: number, durationMs: number = 1000): Promise<void> {
    this.ensureRunning();
    await this.client.longPress(x, y, durationMs);
  }

  async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number = 300,
  ): Promise<void> {
    this.ensureRunning();
    await this.client.swipe(x1, y1, x2, y2, durationMs);
  }

  async swipeDirection(direction: "up" | "down" | "left" | "right"): Promise<void> {
    this.ensureRunning();
    await this.client.swipeDirection(direction);
  }

  async inputText(text: string, targetPid?: number): Promise<void> {
    this.ensureRunning();
    await this.client.inputText(text, targetPid);
  }

  async pressKey(key: string, targetPid?: number): Promise<void> {
    this.ensureRunning();
    await this.client.pressKey(key, undefined, targetPid);
  }

  // ============ Screenshot ============

  async screenshotAsync(
    _compress: boolean = true,
    options?: { monitorIndex?: number },
  ): Promise<{ data: string; mimeType: string }> {
    this.ensureRunning();
    const result = await this.client.screenshotWithMeta({
      monitorIndex: options?.monitorIndex,
    });
    return { data: result.base64, mimeType: result.mimeType };
  }

  async getScreenshotBufferAsync(): Promise<Buffer> {
    throw new Error("Use screenshot() for desktop platform");
  }

  screenshotRaw(): string {
    throw new Error("Use screenshot() for desktop platform");
  }

  // ============ UI ============

  async getUiHierarchy(): Promise<string> {
    this.ensureRunning();
    const hierarchy = await this.client.getUiHierarchy();
    return formatDesktopHierarchy(hierarchy);
  }

  // ============ App management ============

  launchApp(packageName: string): string {
    return this.client.launchApp(packageName);
  }

  stopApp(packageName: string): void {
    this.client.stopApp(packageName);
  }

  installApp(_path: string): string {
    return "Desktop platform doesn't support app installation";
  }

  // ============ Permissions ============

  grantPermission(_pkg: string, _perm: string): string {
    throw new Error("Permission management is not supported for desktop platform");
  }

  revokePermission(_pkg: string, _perm: string): string {
    throw new Error("Permission management is not supported for desktop platform");
  }

  resetPermissions(_pkg: string): string {
    throw new Error("Permission management is not supported for desktop platform");
  }

  // ============ System ============

  shell(command: string): string {
    return this.client.shell(command);
  }

  getLogs(options: {
    level?: string;
    tag?: string;
    lines?: number;
    package?: string;
  } = {}): string {
    const logs = this.client.getLogs({
      limit: options.lines ?? 100,
    });
    return logs.map((l) => `[${l.type}] ${l.message}`).join("\n");
  }

  clearLogs(): string {
    this.client.clearLogs();
    return "Desktop logs cleared";
  }

  async getSystemInfo(): Promise<string> {
    this.ensureRunning();
    const metrics = await this.client.getPerformanceMetrics();
    return `=== Desktop Performance ===\nMemory: ${metrics.memoryUsageMb} MB${
      metrics.cpuPercent ? `\nCPU: ${metrics.cpuPercent}%` : ""
    }`;
  }
}

// ============ Helpers (moved from old device-manager.ts) ============

/**
 * Format desktop UI hierarchy as text
 */
function formatDesktopHierarchy(hierarchy: any): string {
  const lines: string[] = [];

  lines.push(`Scale Factor: ${hierarchy.scaleFactor}`);
  lines.push(`\n=== Windows (${hierarchy.windows.length}) ===`);

  for (const win of hierarchy.windows) {
    const focused = win.focused ? " [FOCUSED]" : "";
    lines.push(
      `  ${win.title}${focused} (${win.bounds.width}x${win.bounds.height})`,
    );
  }

  lines.push(`\n=== UI Elements (${hierarchy.elements.length}) ===`);

  for (const el of hierarchy.elements) {
    const text = el.text ? `"${el.text}"` : "";
    const role = el.role || el.className;
    const clickable = el.clickable ? " [clickable]" : "";
    const focused = el.focused ? " [focused]" : "";

    lines.push(
      `[${el.index}] ${role} ${text}${clickable}${focused} ` +
        `(${el.centerX}, ${el.centerY}) [${el.bounds.x},${el.bounds.y},${el.bounds.width},${el.bounds.height}]`,
    );
  }

  return lines.join("\n");
}
