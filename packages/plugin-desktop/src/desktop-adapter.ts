/**
 * DesktopAdapter -- wraps DesktopClient.
 *
 * Implements:
 *   - CorePlatformAdapter (universal)
 *   - AppManagementAdapter (launchApp / stopApp / installApp)
 *   - ShellAdapter (shell / logs)
 *
 * Does NOT implement PermissionAdapter or SyncScreenshotAdapter
 * because desktop has no concept of runtime permissions or sync screenshots.
 */

import type {
  CorePlatformAdapter,
  AppManagementAdapter,
  ShellAdapter,
  LogsAdapter,
} from "mcp-devices/adapters/platform-adapter";
import type { Device } from "mcp-devices/device-manager";
import { DesktopClient } from "./desktop/client.js";
import type { RawLaunchOptions, UiHierarchy, DesktopUiElement } from "./desktop/types.js";
import type { PluginUiElement } from "@mcp-devices/plugin-api";
import { isSecureElement, REDACTED } from "mcp-devices/ui-tree/ui-parser/formatters/redact";
import { safeTerminalText } from "mcp-devices/utils/terminal-controls";
export class DesktopAdapter implements CorePlatformAdapter, AppManagementAdapter, ShellAdapter, LogsAdapter {
  readonly platform = "desktop" as const;
  private client: DesktopClient;

  constructor(client?: DesktopClient) {
    this.client = client ?? new DesktopClient();
  }

  /** Raw client access -- needed by tools that call getDesktopClient(). */
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
    // Desktop has no notion of device selection -- it's always "desktop".
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

  async launch(options: RawLaunchOptions): Promise<void> {
    await this.client.launch(options);
  }

  async stop(): Promise<void> {
    await this.client.stop();
  }

  async dispose(): Promise<void> {
    await this.client.stop();
  }

  // ============ Core actions ============

  private ensureRunning(): void {
    if (!this.client.isRunning()) {
      throw new Error("Desktop app is not running. Use desktop(action:'launch') first.");
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

  /**
   * Resolve the main window ID for the target process.
   * Returns undefined if no targetPid or no matching window found.
   */
  private async resolveTargetWindowId(): Promise<string | undefined> {
    const pid = this.client.targetPid;
    if (!pid) return undefined;
    try {
      const info = await this.client.getWindowInfo();
      // Prefer focused window of target process, fall back to first window
      const targetWindows = info.windows.filter((w) => w.processId === pid);
      const focused = targetWindows.find((w) => w.focused);
      return (focused ?? targetWindows[0])?.id;
    } catch {
      return undefined;
    }
  }

  async screenshotAsync(
    _compress: boolean = true,
    options?: { monitorIndex?: number },
  ): Promise<{ data: string; mimeType: string }> {
    this.ensureRunning();
    const windowId = await this.resolveTargetWindowId();
    const result = await this.client.screenshotWithMeta({
      windowId,
      monitorIndex: options?.monitorIndex,
    });
    return { data: result.base64, mimeType: result.mimeType };
  }

  async getScreenshotBufferAsync(): Promise<Buffer> {
    this.ensureRunning();
    const windowId = await this.resolveTargetWindowId();
    const result = await this.client.screenshotWithMeta({ windowId });
    return Buffer.from(result.base64, "base64");
  }

  // ============ UI ============

  async getUiHierarchy(): Promise<string> {
    this.ensureRunning();
    const hierarchy = await this.client.getUiHierarchy();
    return formatDesktopHierarchy(hierarchy);
  }

  async getUiElements(_deviceId?: string): Promise<readonly PluginUiElement[]> {
    this.ensureRunning();
    const hierarchy = await this.client.getUiHierarchy();
    return hierarchy.elements.map(toPluginUiElement);
  }

  // ============ App management (AppManagementAdapter) ============

  async launchApp(packageName: string): Promise<string> {
    return this.client.launchApp(packageName);
  }

  stopApp(packageName: string): void {
    this.client.stopApp(packageName);
  }

  installApp(_path: string): string {
    return "Desktop platform doesn't support app installation";
  }

  // ============ Shell / Logs (ShellAdapter) ============

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

  // ============ System info ============

  async getSystemInfo(): Promise<string> {
    this.ensureRunning();
    const metrics = await this.client.getPerformanceMetrics();
    return `=== Desktop Performance ===\nMemory: ${metrics.memoryUsageMb} MB${
      metrics.cpuPercent ? `\nCPU: ${metrics.cpuPercent}%` : ""
    }`;
  }
}

function toPluginUiElement(element: DesktopUiElement): PluginUiElement {
  const secure = isSecureDesktopElement(element);
  const id = safeDesktopElementId(element, secure);

  return {
    index: element.index,
    ...(id !== undefined ? { id } : {}),
    ...(element.role !== undefined ? { role: safeTerminalText(element.role) } : {}),
    className: safeTerminalText(element.className),
    ...(element.text !== undefined
      ? { text: secure ? REDACTED : safeTerminalText(element.text) }
      : {}),
    ...(element.contentDescription !== undefined
      ? {
          label: secure ? REDACTED : safeTerminalText(element.contentDescription),
          contentDesc: secure ? REDACTED : safeTerminalText(element.contentDescription),
        }
      : {}),
    enabled: element.enabled,
    focused: element.focused,
    clickable: element.clickable,
    focusable: element.focusable,
    ...(secure
      ? { password: true }
      : element.password !== undefined
        ? { password: element.password }
        : {}),
    bounds: element.bounds,
    centerX: element.centerX,
    centerY: element.centerY,
    children: element.children.map(toPluginUiElement),
  };
}

function safeDesktopElementId(
  element: DesktopUiElement,
  secure: boolean,
): string | undefined {
  const id = element.id;
  if (id === undefined) return undefined;

  // Empty text-entry fields do not become secure based on their value, but
  // their provider-generated identifiers can still disclose user data.
  const textEntry = [element.className, element.role].some(isTextEntryIdentifier);
  if (textEntry) return REDACTED;
  if (!secure) return safeTerminalText(id);

  const rawValues = [element.text, element.contentDescription];
  return rawValues.some(
    (value) => value !== undefined && value.length > 0 && id.includes(value),
  )
    ? REDACTED
    : safeTerminalText(id);
}

/**
 * Desktop accessibility providers may expose the current value only as `text`
 * and omit both `password` and a protocol-level `value` field.
 */

function isTextEntryIdentifier(value: string | undefined): boolean {
  if (!value) return false;
  const compact = value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");

  return compact === "input"
    || compact === "email"
    || compact === "url"
    || compact === "tel"
    || compact === "number"
    || compact.includes("edittext")
    || compact.includes("textfield")
    || compact.includes("textview")
    || compact.includes("textinput")
    || compact.includes("textarea")
    || compact.includes("textbox")
    || compact.includes("searchfield")
    || compact.includes("searchbox")
    || compact.includes("combobox")
    || compact.includes("spinbutton");
}

function isSecureDesktopElement(element: DesktopUiElement): boolean {
  const secureByProvider = isSecureElement({
    index: element.index,
    resourceId: element.id ?? "",
    className: [element.className, element.role].filter(Boolean).join(" "),
    packageName: "",
    text: element.text ?? "",
    contentDesc: element.contentDescription ?? "",
    checkable: false,
    checked: false,
    clickable: element.clickable,
    enabled: element.enabled,
    focusable: element.focusable,
    focused: element.focused,
    scrollable: false,
    longClickable: false,
    password: element.password === true,
    selected: false,
    bounds: {
      x1: element.bounds.x,
      y1: element.bounds.y,
      x2: element.bounds.x + element.bounds.width,
      y2: element.bounds.y + element.bounds.height,
    },
    centerX: element.centerX,
    centerY: element.centerY,
    width: element.bounds.width,
    height: element.bounds.height,
  });
  if (secureByProvider) return true;

  return element.text !== undefined
    && element.text.trim().length > 0
    && [element.className, element.role].some(isTextEntryIdentifier);
}

// ============ Helpers (moved from old device-manager.ts) ============

/**
 * Format desktop UI hierarchy as text
 */
function formatDesktopHierarchy(hierarchy: UiHierarchy): string {
  const lines: string[] = [];

  lines.push(`Scale Factor: ${hierarchy.scaleFactor}`);
  lines.push(`\n=== Windows (${hierarchy.windows.length}) ===`);

  for (const win of hierarchy.windows) {
    const focused = win.focused ? " [FOCUSED]" : "";
    lines.push(
      `  ${safeTerminalText(win.title)}${focused} (${win.bounds.width}x${win.bounds.height})`,
    );
  }

  lines.push(`\n=== UI Elements (${hierarchy.elements.length}) ===`);

  for (const el of hierarchy.elements) {
    const secure = isSecureDesktopElement(el);
    const text = secure
      ? `"${REDACTED}"`
      : el.text
        ? `"${safeTerminalText(el.text)}"`
        : "";
    const role = safeTerminalText(el.role || el.className);
    const clickable = el.clickable ? " [clickable]" : "";
    const focused = el.focused ? " [focused]" : "";

    lines.push(
      `[${el.index}] ${role} ${text}${clickable}${focused} ` +
        `(${el.centerX}, ${el.centerY}) [${el.bounds.x},${el.bounds.y},${el.bounds.width},${el.bounds.height}]`,
    );
  }

  return lines.join("\n");
}

