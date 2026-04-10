import type { PlatformAdapter } from "./platform-adapter.js";
import type { Platform, Device } from "../device-manager.js";
import type { CompressOptions } from "../utils/image.js";
import { BrowserClient } from "../browser/client.js";
import { SessionManager } from "../browser/session-manager.js";
import { compressScreenshot } from "../utils/image.js";
import type {
  BrowserOpenOptions,
  BrowserNavigateOptions,
  BrowserClickOptions,
  BrowserFillOptions,
  BrowserFillFormOptions,
} from "../browser/types.js";
import { DEFAULT_SESSION } from "../browser/types.js";
import { BrowserNoSessionError, BrowserSessionNotFoundError } from "../errors.js";

const VIRTUAL_BROWSER_DEVICE: Device = {
  id: "browser",
  name: "Browser (Chrome)",
  platform: "browser",
  state: "available",
  isSimulator: false,
};

export class BrowserAdapter implements PlatformAdapter {
  readonly platform: Platform = "browser";

  readonly sessionManager: SessionManager;
  readonly client: BrowserClient;

  constructor() {
    this.sessionManager = new SessionManager();
    this.client = new BrowserClient(this.sessionManager);
  }

  // -- Device management --
  listDevices(): Device[] {
    return [VIRTUAL_BROWSER_DEVICE];
  }
  selectDevice(_deviceId: string): void {}
  getSelectedDeviceId(): string | undefined { return "browser"; }
  autoDetectDevice(): Device | undefined { return VIRTUAL_BROWSER_DEVICE; }

  // -- Core actions (via active session) --
  private getActiveSession(sessionName?: string) {
    const name = sessionName ?? DEFAULT_SESSION;
    const session = this.sessionManager.getSession(name);
    if (!session) throw new BrowserNoSessionError();
    return session;
  }

  async tap(x: number, y: number): Promise<void> {
    await this.client.tap(this.getActiveSession(), x, y);
  }

  async doubleTap(x: number, y: number): Promise<void> {
    const session = this.getActiveSession();
    await this.client.tap(session, x, y);
    await new Promise(r => setTimeout(r, 100));
    await this.client.tap(session, x, y);
  }

  async longPress(x: number, y: number): Promise<void> {
    const session = this.getActiveSession();
    await session.cdp.Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
    await session.cdp.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await new Promise(r => setTimeout(r, 1000));
    await session.cdp.Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 300): Promise<void> {
    const session = this.getActiveSession();
    const steps = Math.max(5, Math.floor(durationMs / 20));
    await session.cdp.Input.dispatchMouseEvent({ type: "mousePressed", x: x1, y: y1, button: "left", clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      const x = Math.round(x1 + (x2 - x1) * (i / steps));
      const y = Math.round(y1 + (y2 - y1) * (i / steps));
      await session.cdp.Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
      await new Promise(r => setTimeout(r, durationMs / steps));
    }
    await session.cdp.Input.dispatchMouseEvent({ type: "mouseReleased", x: x2, y: y2, button: "left", clickCount: 1 });
  }

  async swipeDirection(direction: "up" | "down" | "left" | "right"): Promise<void> {
    const { result } = await this.getActiveSession().cdp.Runtime.evaluate({
      expression: `JSON.stringify({w: window.innerWidth, h: window.innerHeight})`,
      returnByValue: true,
    });
    const { w = 800, h = 600 } = JSON.parse(result.value ?? "{}");
    const cx = w / 2, cy = h / 2;
    const offset = Math.min(w, h) * 0.3;
    const dirs: Record<string, number[]> = {
      up: [cx, cy + offset, cx, cy - offset],
      down: [cx, cy - offset, cx, cy + offset],
      left: [cx + offset, cy, cx - offset, cy],
      right: [cx - offset, cy, cx + offset, cy],
    };
    const [x1, y1, x2, y2] = dirs[direction];
    await this.swipe(x1, y1, x2, y2);
  }

  async inputText(text: string): Promise<void> {
    await this.getActiveSession().cdp.Input.insertText({ text });
  }

  async pressKey(key: string): Promise<void> {
    await this.client.pressKey(this.getActiveSession(), key);
  }

  // -- Screenshot --
  async screenshotAsync(compress: boolean, options?: CompressOptions): Promise<{ data: string; mimeType: string }> {
    const session = this.getActiveSession();
    const buffer = await this.client.screenshot(session, false);
    if (compress) {
      return compressScreenshot(buffer, options);
    }
    return { data: buffer.toString("base64"), mimeType: "image/png" };
  }

  async getScreenshotBufferAsync(): Promise<Buffer> {
    return this.client.screenshot(this.getActiveSession(), false);
  }

  screenshotRaw(): string {
    throw new Error("screenshotRaw not supported for browser platform. Use screenshotAsync.");
  }

  // -- UI --
  async getUiHierarchy(): Promise<string> {
    return this.client.getSnapshot(this.getActiveSession());
  }

  // -- App management (not supported) --
  async launchApp(_pkg: string): Promise<string> {
    throw new Error("launchApp is not supported for browser platform. Use browser_open.");
  }
  async stopApp(_pkg: string): Promise<void> {
    throw new Error("stopApp is not supported for browser platform. Use browser_close.");
  }
  async installApp(_path: string): Promise<string> {
    throw new Error("installApp is not supported for browser platform.");
  }

  // -- Permissions (not supported) --
  async grantPermission(_pkg: string, _perm: string): Promise<string> {
    throw new Error("grantPermission is not supported for browser platform.");
  }
  async revokePermission(_pkg: string, _perm: string): Promise<string> {
    throw new Error("revokePermission is not supported for browser platform.");
  }
  async resetPermissions(_pkg: string): Promise<string> {
    throw new Error("resetPermissions is not supported for browser platform.");
  }

  // -- System (stub) --
  async shell(_cmd: string): Promise<string> {
    throw new Error("shell is not supported for browser platform.");
  }
  async getLogs(_opts: { level?: string; tag?: string; lines?: number; package?: string } = {}): Promise<string> {
    return "(Browser console logs not implemented. Use browser_evaluate to inspect page.)";
  }
  async clearLogs(): Promise<string> {
    return "OK";
  }
  async getSystemInfo(): Promise<string> {
    const sessions = this.sessionManager.listSessions();
    return JSON.stringify({ platform: "browser", activeSessions: sessions.length, sessions }, null, 2);
  }

  // -- Browser-specific public API (used by browser-tools.ts) --

  async open(options: BrowserOpenOptions): Promise<string> {
    const sessionName = options.session ?? DEFAULT_SESSION;
    // Close existing session with same name if any
    const existing = this.sessionManager.getSession(sessionName);
    if (existing) {
      await this.client.close(existing);
    }
    const session = await this.client.launch(options);
    const snapshot = await this.client.getSnapshot(session);
    return `Opened ${options.url} in session "${sessionName}"\n\n${snapshot}`;
  }

  async closeSession(session?: string): Promise<void> {
    if (!session) {
      await this.client.closeAll();
      return;
    }
    const s = this.sessionManager.getSession(session);
    if (!s) throw new BrowserSessionNotFoundError(session, this.sessionManager.listSessions());
    await this.client.close(s);
  }

  async navigate(options: BrowserNavigateOptions): Promise<string> {
    const sessionName = options.session ?? DEFAULT_SESSION;

    // If no session exists and url is provided, create one
    if (!this.sessionManager.hasSession(sessionName) && options.url) {
      return this.open({ url: options.url, session: sessionName });
    }

    const session = this.sessionManager.getSession(sessionName);
    if (!session) throw new BrowserNoSessionError();

    await this.client.navigate(session, options);
    const snapshot = await this.client.getSnapshot(session);
    const action = options.action ?? `navigate to ${options.url}`;
    return `${action} in session "${sessionName}"\n\n${snapshot}`;
  }

  async clickElement(options: BrowserClickOptions): Promise<string> {
    const sessionName = options.session ?? DEFAULT_SESSION;
    const session = this.sessionManager.getSession(sessionName);
    if (!session) throw new BrowserNoSessionError();

    const { navigated, newUrl } = await this.client.click(session, options);

    if (navigated) {
      await new Promise(r => setTimeout(r, 500)); // let page settle
      const snapshot = await this.client.getSnapshot(session);
      return `Clicked -> navigated to ${newUrl}\n\n${snapshot}`;
    }

    return `Clicked successfully. Use browser_snapshot to see changes.`;
  }

  async fillField(options: BrowserFillOptions): Promise<void> {
    const session = this.sessionManager.getSession(options.session ?? DEFAULT_SESSION);
    if (!session) throw new BrowserNoSessionError();
    await this.client.fill(session, options);
  }

  async fillForm(options: BrowserFillFormOptions): Promise<void> {
    const session = this.sessionManager.getSession(options.session ?? DEFAULT_SESSION);
    if (!session) throw new BrowserNoSessionError();
    for (const field of options.fields) {
      await this.client.fill(session, { ...field, session: options.session });
    }
    if (options.submit) {
      await session.cdp.Input.dispatchKeyEvent({ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
      await session.cdp.Input.dispatchKeyEvent({ type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    }
  }

  async snapshot(sessionName?: string): Promise<string> {
    const session = this.sessionManager.getSession(sessionName ?? DEFAULT_SESSION);
    if (!session) throw new BrowserNoSessionError();
    return this.client.getSnapshot(session);
  }

  async screenshotBrowser(sessionName?: string, fullPage = false): Promise<Buffer> {
    const session = this.sessionManager.getSession(sessionName ?? DEFAULT_SESSION);
    if (!session) throw new BrowserNoSessionError();
    return this.client.screenshot(session, fullPage);
  }

  async evaluateJs(expression: string, sessionName?: string): Promise<string> {
    const session = this.sessionManager.getSession(sessionName ?? DEFAULT_SESSION);
    if (!session) throw new BrowserNoSessionError();
    console.error(`[browser_evaluate] session=${sessionName ?? DEFAULT_SESSION} expression=${expression.slice(0, 200)}`);
    return this.client.evaluate(session, expression);
  }

  async waitForSelector(selector: string, timeout = 5000, state: "attached" | "visible" = "visible", sessionName?: string): Promise<void> {
    const session = this.sessionManager.getSession(sessionName ?? DEFAULT_SESSION);
    if (!session) throw new BrowserNoSessionError();
    await this.client.waitForSelector(session, selector, timeout, state);
  }

  async clearSessionData(sessionName: string): Promise<void> {
    const session = this.sessionManager.getSession(sessionName);
    if (session) {
      await this.client.close(session);
    }
    // Remove profile dir
    const { rm } = await import("fs/promises");
    const profileDir = this.sessionManager.getProfileDir(sessionName);
    await rm(profileDir, { recursive: true, force: true });
  }

  listSessions(): string[] {
    return this.sessionManager.listSessions();
  }

  async cleanup(): Promise<void> {
    await this.client.closeAll();
  }

  // ============ App Listing ============

  async getAppList(): Promise<Array<{
    appName: string;
    packageName: string;
    versionName?: string;
    versionCode?: string;
  }>> {
    throw new Error("App listing is not supported for browser platform");
  }

  // ============ Clipboard Operations ============

  async setClipboard(text: string): Promise<void> {
    const session = this.getActiveSession();
    // Use CDP to set clipboard via JavaScript
    await session.cdp.Runtime.evaluate({
      expression: `navigator.clipboard.writeText('${text.replace(/'/g, "\\'")}')`,
      awaitPromise: true,
    });
  }

  async getClipboard(): Promise<string> {
    const session = this.getActiveSession();
    // Use CDP to read clipboard via JavaScript
    const { result } = await session.cdp.Runtime.evaluate({
      expression: `navigator.clipboard.readText()`,
      awaitPromise: true,
      returnByValue: true,
    });
    return String(result.value ?? "");
  }

  // ============ WebView Inspection ============

  async getWebViews(): Promise<Array<{ packageName?: string; socket?: string; [key: string]: any }>> {
    throw new Error("WebView inspection is not supported for browser platform");
  }
}
