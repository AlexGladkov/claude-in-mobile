import { AdbClient } from "./adb/client.js";
import { IosClient } from "./ios/client.js";
import { DesktopClient } from "./desktop/client.js";
import { compressScreenshot, type CompressOptions } from "./utils/image.js";
import type { LaunchOptions } from "./desktop/types.js";
import { auroraClient as aurora, AuroraClient } from "./aurora/index.js";

export type Platform = "android" | "ios" | "desktop" | "aurora";

export interface Device {
  id: string;
  name: string;
  platform: Platform;
  state: string;
  isSimulator: boolean;
}

/**
 * Interface for mobile clients that support raw screenshots
 */
interface MobileClientWithScreenshot {
  screenshotRaw(): Buffer;
}

export class DeviceManager {
  private androidClient: AdbClient;
  private iosClient: IosClient;
  private desktopClient: DesktopClient;
  private aurora = aurora;
  private activeDevice?: Device;
  private activeTarget: Platform = "android";

  constructor() {
    this.androidClient = new AdbClient();
    this.iosClient = new IosClient();
    this.desktopClient = new DesktopClient();
  }

  private getClient(platform?: Platform) {
    const p = platform ?? this.getCurrentPlatform();
    switch (p) {
      case "android": return this.androidClient;
      case "ios": return this.iosClient;
      case "desktop": return this.desktopClient;
      case "aurora": return this.aurora;
      default:
        throw new Error(`Unknown platform: ${p}`);
    }
  }

  // ============ Target Management ============

  /**
   * Set active target platform
   */
  setTarget(target: Platform): void {
    this.activeTarget = target;
  }

  /**
   * Get active target and its status
   */
  getTarget(): { target: Platform; status: string } {
    if (this.activeTarget === "desktop") {
      const state = this.desktopClient.getState();
      return { target: "desktop", status: state.status };
    }

    const device = this.activeDevice;
    if (device) {
      return { target: device.platform, status: device.state };
    }

    return { target: this.activeTarget, status: "no device" };
  }

  // ============ Desktop Specific ============

  /**
   * Launch desktop automation (and optionally a user's app via Gradle)
   */
  async launchDesktopApp(options: LaunchOptions): Promise<string> {
    await this.desktopClient.launch(options);
    this.activeTarget = "desktop";
    if (options.projectPath) {
      return `Desktop automation started. Also launching app from ${options.projectPath}`;
    }
    return "Desktop automation started";
  }

  /**
   * Stop desktop app
   */
  async stopDesktopApp(): Promise<void> {
    await this.desktopClient.stop();
  }

  /**
   * Get desktop client directly
   */
  getDesktopClient(): DesktopClient {
    return this.desktopClient;
  }

  /**
   * Check if desktop app is running
   */
  isDesktopRunning(): boolean {
    return this.desktopClient.isRunning();
  }

  // ============ Device Management ============

  /**
   * Get all connected devices (Android + iOS + Aurora)
   */
  getAllDevices(): Device[] {
    const devices: Device[] = [];

    // Get Android devices
    try {
      const androidDevices = this.androidClient.getDevices();
      for (const d of androidDevices) {
        devices.push({
          id: d.id,
          name: d.model ?? d.id,
          platform: "android",
          state: d.state,
          isSimulator: d.id.startsWith("emulator")
        });
      }
    } catch {
      // ADB not available or no devices
    }

    // Get iOS simulators
    try {
      const iosDevices = this.iosClient.getDevices();
      for (const d of iosDevices) {
        devices.push({
          id: d.id,
          name: d.name,
          platform: "ios",
          state: d.state,
          isSimulator: d.isSimulator
        });
      }
    } catch {
      // simctl not available or no simulators
    }

    // Add desktop as virtual device if running
    if (this.desktopClient.isRunning()) {
      const state = this.desktopClient.getState();
      devices.push({
        id: "desktop",
        name: "Desktop App",
        platform: "desktop",
        state: state.status,
        isSimulator: false
      });
    }

    // Get Aurora devices (use sync version)
    try {
      const auroraDevices = this.aurora.listDevicesSync();
      for (const d of auroraDevices) {
        devices.push({
          id: d.id,
          name: d.name,
          platform: "aurora",
          state: d.state,
          isSimulator: d.isSimulator
        });
      }
    } catch {
      // audb not available or no devices
    }

    return devices;
  }

  /**
   * Get devices filtered by platform
   */
  getDevices(platform?: Platform): Device[] {
    const all = this.getAllDevices();
    if (!platform) return all;
    return all.filter(d => d.platform === platform);
  }

  /**
   * Set active device
   */
  setDevice(deviceId: string, platform?: Platform): Device {
    // Handle desktop special case
    if (deviceId === "desktop" || platform === "desktop") {
      if (!this.desktopClient.isRunning()) {
        throw new Error("Desktop app is not running. Use launch_desktop_app first.");
      }
      this.activeTarget = "desktop";
      return {
        id: "desktop",
        name: "Desktop App",
        platform: "desktop",
        state: "running",
        isSimulator: false
      };
    }

    const devices = this.getAllDevices();

    // Find device by ID
    let device = devices.find(d => d.id === deviceId);

    // If platform specified but device not found, try to match
    if (!device && platform) {
      device = devices.find(d => d.platform === platform && (d.state === "device" || d.state === "booted" || d.state === "connected"));
    }

    if (!device) {
      throw new Error(`Device not found: ${deviceId}`);
    }

    this.activeDevice = device;
    this.activeTarget = device.platform;

    // Set on the appropriate client
    if (device.platform === "android") {
      this.androidClient.setDevice(device.id);
    } else if (device.platform === "ios") {
      this.iosClient.setDevice(device.id);
    }
    // Aurora and Desktop don't need explicit device selection

    return device;
  }

  /**
   * Get active device
   */
  getActiveDevice(): Device | undefined {
    if (this.activeTarget === "desktop" && this.desktopClient.isRunning()) {
      return {
        id: "desktop",
        name: "Desktop App",
        platform: "desktop",
        state: "running",
        isSimulator: false
      };
    }
    return this.activeDevice;
  }

  /**
   * Get current platform
   */
  getCurrentPlatform(): Platform {
    return this.activeTarget;
  }

  // ============ Unified Commands ============

  /**
   * Take screenshot with optional compression
   */
  async screenshot(
    platform?: Platform,
    compress = true,
    options?: { maxWidth?: number; maxHeight?: number; quality?: number; monitorIndex?: number }
  ): Promise<{ data: string; mimeType: string }> {
    const p = platform ?? this.getCurrentPlatform();
    const client = this.getClient(p);

    // Handle DesktopClient specially
    if (client instanceof DesktopClient) {
      const result = await client.screenshotWithMeta({
        monitorIndex: options?.monitorIndex
      });
      return { data: result.base64, mimeType: result.mimeType };
    }

    // Handle Android, iOS, Aurora clients (all have screenshotRaw)
    if (this.isMobileClientWithScreenshot(client)) {
      const buffer = client.screenshotRaw();
      if (compress) {
        return compressScreenshot(buffer, options);
      }
      return { data: buffer.toString("base64"), mimeType: "image/png" };
    }

    throw new Error(`Screenshot not supported for platform: ${p}`);
  }

  /**
   * Type guard for mobile clients with screenshotRaw support
   */
  private isMobileClientWithScreenshot(client: unknown): client is MobileClientWithScreenshot {
    return (
      client instanceof AdbClient ||
      client instanceof IosClient ||
      client instanceof AuroraClient
    );
  }

  /**
   * Take screenshot without compression (legacy)
   */
  screenshotRaw(platform?: Platform): string {
    const client = this.getClient(platform);

    // Desktop doesn't support screenshotRaw (different architecture)
    if (client instanceof DesktopClient) {
      throw new Error("Use screenshot() for desktop platform");
    }

    // All mobile platforms (Android, iOS, Aurora) support screenshotRaw
    if (this.isMobileClientWithScreenshot(client)) {
      return client.screenshotRaw().toString("base64");
    }

    throw new Error(`Screenshot not supported for platform: ${platform ?? this.getCurrentPlatform()}`);
  }

  /**
   * Tap at coordinates
   * @param targetPid - Optional PID for desktop background mode (no focus stealing)
   */
  async tap(x: number, y: number, platform?: Platform, targetPid?: number): Promise<void> {
    const client = this.getClient(platform);
    if (client instanceof DesktopClient) {
      await client.tap(x, y, targetPid);
    } else if (client instanceof AuroraClient) {
      await client.tap(x, y);
    } else {
      (client as AdbClient | IosClient).tap(x, y);
    }
  }

  /**
   * Long press
   */
  async longPress(x: number, y: number, durationMs: number = 1000, platform?: Platform): Promise<void> {
    const client = this.getClient(platform);
    if (client instanceof DesktopClient) {
      await client.longPress(x, y, durationMs);
    } else if (client instanceof AuroraClient) {
      await client.longPress(x, y, durationMs);
    } else if (client instanceof AdbClient) {
      client.longPress(x, y, durationMs);
    } else {
      // iOS: simulate with longer tap
      (client as IosClient).tap(x, y);
    }
  }

  /**
   * Swipe
   */
  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number = 300, platform?: Platform): Promise<void> {
    const client = this.getClient(platform);
    if (client instanceof DesktopClient) {
      await client.swipe(x1, y1, x2, y2, durationMs);
    } else if (client instanceof AuroraClient) {
      await client.swipe(x1, y1, x2, y2, durationMs);
    } else {
      (client as AdbClient | IosClient).swipe(x1, y1, x2, y2, durationMs);
    }
  }

  /**
   * Swipe direction
   */
  async swipeDirection(direction: "up" | "down" | "left" | "right", platform?: Platform): Promise<void> {
    const client = this.getClient(platform);
    if (client instanceof DesktopClient) {
      await client.swipeDirection(direction);
    } else if (client instanceof AuroraClient) {
      await client.swipeDirection(direction);
    } else {
      (client as AdbClient | IosClient).swipeDirection(direction);
    }
  }

  /**
   * Input text
   * @param targetPid - Optional PID for desktop background mode (no focus stealing)
   */
  async inputText(text: string, platform?: Platform, targetPid?: number): Promise<void> {
    const client = this.getClient(platform);
    if (client instanceof DesktopClient) {
      await client.inputText(text, targetPid);
    } else if (client instanceof AuroraClient) {
      await client.inputText(text); // Will output warning, but won't break code
    } else {
      (client as AdbClient | IosClient).inputText(text);
    }
  }

  /**
   * Press key
   * @param targetPid - Optional PID for desktop background mode (no focus stealing)
   */
  async pressKey(key: string, platform?: Platform, targetPid?: number): Promise<void> {
    const client = this.getClient(platform);
    if (client instanceof DesktopClient) {
      await client.pressKey(key, undefined, targetPid);
    } else if (client instanceof AuroraClient) {
      await client.pressKey(key);
    } else {
      (client as AdbClient | IosClient).pressKey(key);
    }
  }

  /**
   * Launch app
   */
  async launchApp(packageOrBundleId: string, platform?: Platform): Promise<string> {
    const client = this.getClient(platform);
    if (client instanceof DesktopClient) {
      return client.launchApp(packageOrBundleId);
    }
    if (client instanceof AuroraClient) {
      return client.launchApp(packageOrBundleId);
    }
    return (client as AdbClient | IosClient).launchApp(packageOrBundleId);
  }

  /**
   * Stop app
   */
  async stopApp(packageOrBundleId: string, platform?: Platform): Promise<void> {
    const client = this.getClient(platform);
    if (client instanceof DesktopClient) {
      client.stopApp(packageOrBundleId);
    } else if (client instanceof AuroraClient) {
      await client.stopApp(packageOrBundleId);
    } else {
      (client as AdbClient | IosClient).stopApp(packageOrBundleId);
    }
  }

  /**
   * Install app
   */
  async installApp(path: string, platform?: Platform): Promise<string> {
    const client = this.getClient(platform);
    if (client instanceof DesktopClient) {
      return "Desktop platform doesn't support app installation";
    }
    if (client instanceof AdbClient) {
      return client.installApk(path);
    } else if (client instanceof AuroraClient) {
      return client.installApp(path);
    } else {
      return (client as IosClient).installApp(path);
    }
  }

  /**
   * Get UI hierarchy
   */
  async getUiHierarchy(platform?: Platform): Promise<string> {
    const client = this.getClient(platform);
    if (client instanceof DesktopClient) {
      const hierarchy = await client.getUiHierarchy();
      // Format as text for compatibility
      return formatDesktopHierarchy(hierarchy);
    } else if (client instanceof AuroraClient) {
      // Aurora: returns placeholder XML with warning (feature not available via audb)
      return await client.getUiHierarchy();
    }
    return (client as AdbClient | IosClient).getUiHierarchy();
  }

  /**
   * Execute shell command
   */
  async shell(command: string, platform?: Platform): Promise<string> {
    const client = this.getClient(platform);
    if (client instanceof DesktopClient) {
      return client.shell(command);
    }
    if (client instanceof AuroraClient) {
      return client.shell(command);
    }
    return (client as AdbClient | IosClient).shell(command);
  }

  /**
   * Get Android client directly
   */
  getAndroidClient(): AdbClient {
    return this.androidClient;
  }

  /**
   * Get iOS client directly
   */
  getIosClient(): IosClient {
    return this.iosClient;
  }

  /**
   * Get Aurora client directly
   */
  getAurora() {
    return this.aurora;
  }

  /**
   * Get device logs
   */
  async getLogs(options: {
    platform?: Platform;
    level?: string;
    tag?: string;
    lines?: number;
    package?: string;
  } = {}): Promise<string> {
    const targetPlatform = options.platform ?? this.activeTarget;

    if (targetPlatform === "desktop") {
      const logs = this.desktopClient.getLogs({
        limit: options.lines ?? 100
      });
      return logs.map(l => `[${l.type}] ${l.message}`).join("\n");
    }

    const client = this.getClient(options.platform);

    if (client instanceof AdbClient) {
      return client.getLogs({
        level: options.level as "V" | "D" | "I" | "W" | "E" | "F" | undefined,
        tag: options.tag,
        lines: options.lines,
        package: options.package,
      });
    } else if (client instanceof AuroraClient) {
      return client.getLogs(options);
    } else {
      return (client as IosClient).getLogs({
        level: options.level as "debug" | "info" | "default" | "error" | "fault" | undefined,
        lines: options.lines,
        predicate: options.package ? `subsystem == "${options.package}"` : undefined,
      });
    }
  }

  /**
   * Clear logs
   */
  async clearLogs(platform?: Platform): Promise<string> {
    const targetPlatform = platform ?? this.activeTarget;

    if (targetPlatform === "desktop") {
      this.desktopClient.clearLogs();
      return "Desktop logs cleared";
    }

    const client = this.getClient(platform);

    if (client instanceof AdbClient) {
      client.clearLogs();
      return "Logcat buffer cleared";
    } else if (client instanceof AuroraClient) {
      return client.clearLogs();
    } else {
      return (client as IosClient).clearLogs();
    }
  }

  /**
   * Get system info (battery, memory, etc.)
   */
  async getSystemInfo(platform?: Platform): Promise<string> {
    const targetPlatform = platform ?? this.activeTarget;

    if (targetPlatform === "desktop") {
      const metrics = await this.desktopClient.getPerformanceMetrics();
      return `=== Desktop Performance ===\nMemory: ${metrics.memoryUsageMb} MB${metrics.cpuPercent ? `\nCPU: ${metrics.cpuPercent}%` : ''}`;
    }

    const client = this.getClient(platform);

    if (client instanceof AdbClient) {
      const battery = client.getBatteryInfo();
      const memory = client.getMemoryInfo();
      return `=== Battery ===\n${battery}\n\n=== Memory ===\n${memory}`;
    } else if (client instanceof AuroraClient) {
      return await client.getSystemInfo();
    } else {
      return "System info is only available for Android devices.";
    }
  }
}

/**
 * Format desktop UI hierarchy as text
 */
function formatDesktopHierarchy(hierarchy: any): string {
  const lines: string[] = [];

  lines.push(`Scale Factor: ${hierarchy.scaleFactor}`);
  lines.push(`\n=== Windows (${hierarchy.windows.length}) ===`);

  for (const win of hierarchy.windows) {
    const focused = win.focused ? " [FOCUSED]" : "";
    lines.push(`  ${win.title}${focused} (${win.bounds.width}x${win.bounds.height})`);
  }

  lines.push(`\n=== UI Elements (${hierarchy.elements.length}) ===`);

  for (const el of hierarchy.elements) {
    const text = el.text ? `"${el.text}"` : "";
    const role = el.role || el.className;
    const clickable = el.clickable ? " [clickable]" : "";
    const focused = el.focused ? " [focused]" : "";

    lines.push(
      `[${el.index}] ${role} ${text}${clickable}${focused} ` +
      `(${el.centerX}, ${el.centerY}) [${el.bounds.x},${el.bounds.y},${el.bounds.width},${el.bounds.height}]`
    );
  }

  return lines.join("\n");
}
