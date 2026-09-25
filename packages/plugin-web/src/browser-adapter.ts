/**
 * BrowserAdapter -- implements CorePlatformAdapter only.
 *
 * Browser has no concept of app management, permissions, or shell access.
 * Those capabilities are NOT implemented here -- no more "not supported" throws.
 */

import type { PluginUiElement } from "@mcp-devices/plugin-api";
import type {
  CorePlatformAdapter,
  PerformanceTraceAdapter,
  PerformanceTraceCapture,
  PerformanceTraceHandle,
  PerformanceTraceStartOptions,
  HeapSnapshotAdapter,
  HeapSnapshotCapture,
  HeapSnapshotOptions,
} from "mcp-devices/adapters/platform-adapter";
import type { CompressOptions } from "mcp-devices/utils/image";
import type { Device, Platform } from "mcp-devices/device-manager";
import { BrowserClient } from "./browser/client.js";
import { SessionManager } from "./browser/session-manager.js";
import { compressScreenshot } from "mcp-devices/utils/image";
import { PERFORMANCE } from "mcp-devices/constants/timeouts";
import { randomUUID } from "crypto";
import { rm } from "fs/promises";
import type {
  BrowserOpenOptions,
  BrowserNavigateOptions,
  BrowserClickOptions,
  BrowserFillOptions,
  BrowserFillFormOptions,
} from "./browser/types.js";
import { DEFAULT_SESSION } from "./browser/types.js";
import { BrowserNoSessionError, BrowserSessionNotFoundError } from "mcp-devices/errors";
import { sanitizeBrowserUrl } from "./browser/snapshot-builder.js";
import {
  startCdpPerformanceTrace,
  stopCdpPerformanceTrace,
} from "./browser/performance-trace.js";
import { captureCdpHeapSnapshot } from "./browser/heap-snapshot.js";

interface ActiveBrowserTrace {
  handle: PerformanceTraceHandle;
  sessionName: string;
  timer?: ReturnType<typeof setTimeout>;
  finishPromise?: Promise<PerformanceTraceCapture>;
}

const VIRTUAL_BROWSER_DEVICE: Device = {
  id: "browser",
  name: "Browser (Chrome)",
  platform: "browser",
  state: "available",
  isSimulator: false,
};

export class BrowserAdapter implements CorePlatformAdapter, PerformanceTraceAdapter, HeapSnapshotAdapter {
  readonly platform: Platform = "browser";
  readonly heapSnapshotFormat = "chrome-heapsnapshot" as const;

  readonly sessionManager: SessionManager;
  readonly client: BrowserClient;
  private readonly sessionOperations = new Map<string, Promise<void>>();
  private disposed = false;
  private readonly performanceTraces = new Map<string, ActiveBrowserTrace>();
  private readonly traceBySession = new Map<string, string>();
  private readonly heapCaptures = new Set<string>();
  private cleanupPromise?: Promise<void>;

  constructor(
    sessionManager = new SessionManager(),
    client?: BrowserClient,
  ) {
    this.sessionManager = sessionManager;
    this.client = client ?? new BrowserClient(sessionManager);
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
    const { w = 800, h = 600 } = JSON.parse((result.value as string) ?? "{}");
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

  async getUiHierarchy(): Promise<string> {
    return this.client.getSnapshot(this.getActiveSession());
  }

  async getUiElements(_deviceId?: string): Promise<readonly PluginUiElement[]> {
    return this.client.getUiElements(this.getActiveSession());
  }

  // -- System info --
  async getSystemInfo(): Promise<string> {
    const sessions = this.sessionManager.listSessions();
    return JSON.stringify({ platform: "browser", activeSessions: sessions.length, sessions }, null, 2);
  }

  // -- Performance traces --
  async startPerformanceTrace(options: PerformanceTraceStartOptions): Promise<PerformanceTraceHandle> {
    if (!Number.isInteger(options.durationMs) || options.durationMs < 1000 || options.durationMs > PERFORMANCE.MAX_TRACE_DURATION_MS) {
      throw new Error(
        `Browser trace duration must be an integer from 1000 to ${PERFORMANCE.MAX_TRACE_DURATION_MS}ms.`,
      );
    }
    const sessionName = options.session ?? DEFAULT_SESSION;
    const session = this.getActiveSession(sessionName);
    if (this.traceBySession.has(sessionName)) {
      throw new Error(`Browser session "${sessionName}" already has an active performance trace.`);
    }

    await startCdpPerformanceTrace(session.cdp, options.preset);
    const startedAtMs = Date.now();
    const handle: PerformanceTraceHandle = {
      traceId: randomUUID(),
      platform: "browser",
      preset: options.preset,
      startedAt: new Date(startedAtMs).toISOString(),
      deadlineAt: new Date(startedAtMs + options.durationMs).toISOString(),
    };
    const active: ActiveBrowserTrace = { handle, sessionName };
    this.performanceTraces.set(handle.traceId, active);
    this.traceBySession.set(sessionName, handle.traceId);
    active.timer = setTimeout(() => {
      const finish = this.finishBrowserTrace(active);
      void finish.catch(() => {});
    }, options.durationMs);
    active.timer.unref();
    return handle;
  }

  async stopPerformanceTrace(traceId: string): Promise<PerformanceTraceCapture> {
    const active = this.performanceTraces.get(traceId);
    if (!active) {
      throw new Error(`Browser performance trace "${traceId}" is not active.`);
    }
    try {
      return await this.finishBrowserTrace(active);
    } finally {
      this.forgetBrowserTrace(active);
    }
  }

  private finishBrowserTrace(active: ActiveBrowserTrace): Promise<PerformanceTraceCapture> {
    if (active.finishPromise) return active.finishPromise;
    if (active.timer) clearTimeout(active.timer);
    const session = this.sessionManager.getSession(active.sessionName);
    if (!session) {
      return Promise.reject(
        new Error(`Browser session "${active.sessionName}" closed before its performance trace was finalized.`),
      );
    }
    active.finishPromise = (async () => {
      const { data, summary } = await stopCdpPerformanceTrace(session.cdp);
      const endedAtMs = Date.now();
      return {
        ...active.handle,
        endedAt: new Date(endedAtMs).toISOString(),
        durationMs: Math.max(0, endedAtMs - Date.parse(active.handle.startedAt)),
        format: "chrome-json",
        mimeType: "application/json",
        producer: "Chrome DevTools Protocol",
        session: active.sessionName,
        summary,
        data,
      };
    })();
    return active.finishPromise;
  }

  private forgetBrowserTrace(active: ActiveBrowserTrace): void {
    if (active.timer) clearTimeout(active.timer);
    this.performanceTraces.delete(active.handle.traceId);
    if (this.traceBySession.get(active.sessionName) === active.handle.traceId) {
      this.traceBySession.delete(active.sessionName);
    }
  }

  private discardBrowserTrace(sessionName: string): void {
    const traceId = this.traceBySession.get(sessionName);
    if (!traceId) return;
    const active = this.performanceTraces.get(traceId);
    if (active) this.forgetBrowserTrace(active);
  }

  // -- Heap snapshots --
  async captureHeapSnapshot(options: HeapSnapshotOptions): Promise<HeapSnapshotCapture> {
    const sessionName = options.session ?? DEFAULT_SESSION;
    return this.withSessionOperation(sessionName, async () => {
      const session = this.getActiveSession(sessionName);
      if (this.heapCaptures.has(sessionName)) {
        throw new Error(`Browser session "${sessionName}" already has an active heap capture.`);
      }
      if (this.traceBySession.has(sessionName)) {
        throw new Error(`Browser session "${sessionName}" is recording a performance trace. Stop it before capturing the heap.`);
      }
      this.heapCaptures.add(sessionName);
      try {
        const summary = await captureCdpHeapSnapshot(session.cdp, options.outputPath);
        return {
          platform: "browser",
          capturedAt: new Date().toISOString(),
          format: this.heapSnapshotFormat,
          mimeType: "application/json",
          producer: "Chrome DevTools Protocol HeapProfiler",
          session: sessionName,
          summary,
        };
      } finally {
        this.heapCaptures.delete(sessionName);
      }
    });
  }

  // -- Browser-specific public API (used by browser-tools.ts) --

  async open(options: BrowserOpenOptions): Promise<string> {
    const sessionName = options.session ?? DEFAULT_SESSION;
    return this.withSessionOperation(sessionName, async () => {
      if (this.disposed) throw new Error("Browser adapter is disposed");
      const existing = this.sessionManager.getSession(sessionName);
      if (existing) {
        this.discardBrowserTrace(sessionName);
        await this.client.close(existing);
      }
      const session = await this.client.launch(options);
      try {
        const snapshot = await this.client.getSnapshot(session);
        return `Opened ${sanitizeBrowserUrl(options.url)} in session "${sessionName}"\n\n${snapshot}`;
      } catch (error) {
        await this.client.close(session);
        throw error;
      }
    });
  }

  async closeSession(session?: string): Promise<void> {
    if (!session) {
      await Promise.all(
        this.sessionManager.listSessions().map((name) =>
          this.withSessionOperation(name, async () => {
            const active = this.sessionManager.getSession(name);
            this.discardBrowserTrace(name);
            if (active) await this.client.close(active);
          })
        ),
      );
      return;
    }
    await this.withSessionOperation(session, async () => {
      const active = this.sessionManager.getSession(session);
      if (!active) {
        throw new BrowserSessionNotFoundError(session, this.sessionManager.listSessions());
      }
      this.discardBrowserTrace(session);
      await this.client.close(active);
    });
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
    const action = options.action ?? `navigate to ${sanitizeBrowserUrl(options.url ?? session.url)}`;
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
      const safeNewUrl = newUrl ? sanitizeBrowserUrl(newUrl) : undefined;
      return `Clicked -> navigated to ${safeNewUrl ?? "unknown"}\n\n${snapshot}`;
    }

    return `Clicked successfully. Use browser(action:'snapshot') to see changes.`;
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
    return this.client.evaluate(session, expression);
  }

  async waitForSelector(selector: string, timeout = 5000, state: "attached" | "visible" = "visible", sessionName?: string): Promise<void> {
    const session = this.sessionManager.getSession(sessionName ?? DEFAULT_SESSION);
    if (!session) throw new BrowserNoSessionError();
    await this.client.waitForSelector(session, selector, timeout, state);
  }

  async clearSessionData(sessionName: string): Promise<void> {
    await this.withSessionOperation(sessionName, async () => {
      const session = this.sessionManager.getSession(sessionName);
      this.discardBrowserTrace(sessionName);
      if (session) await this.client.close(session);
      const token = this.sessionManager.acquireLock(sessionName);
      try {
        this.sessionManager.cleanupOrphanChrome(sessionName);
        await rm(this.sessionManager.getProfileDir(sessionName), {
          recursive: true,
          force: true,
        });
      } finally {
        this.sessionManager.releaseLock(sessionName, token);
      }
    });
  }

  listSessions(): string[] {
    return this.sessionManager.listSessions();
  }

  async cleanup(): Promise<void> {
    if (!this.cleanupPromise) {
      this.disposed = true;
      this.cleanupPromise = (async () => {
        await Promise.allSettled([...this.sessionOperations.values()]);
        await this.closeSession();
      })();
    }
    return this.cleanupPromise;
  }

  async dispose(): Promise<void> {
    await this.cleanup();
  }

  private async withSessionOperation<T>(
    sessionName: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.sessionOperations.get(sessionName) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const tail = current.then(() => undefined, () => undefined);
    this.sessionOperations.set(sessionName, tail);
    try {
      return await current;
    } finally {
      if (this.sessionOperations.get(sessionName) === tail) {
        this.sessionOperations.delete(sessionName);
      }
    }
  }
}
