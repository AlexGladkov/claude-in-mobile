import { launch as launchChrome } from "chrome-launcher";
// @ts-expect-error — chrome-remote-interface does not publish declarations.
import createCdpClient from "chrome-remote-interface";
import { z } from "zod";

import type { BrowserSession, BrowserOpenOptions, BrowserClickOptions, BrowserFillOptions, BrowserNavigateOptions, LaunchedChrome } from "./types.js";
import type { CDPClientInterface } from "./cdp-types.js";
import { ALLOWED_URL_PROTOCOLS, DEFAULT_SESSION } from "./types.js";
import { SessionManager } from "./session-manager.js";
import { BrowserRefNotFoundError, BrowserSecurityError } from "mcp-devices/errors";
import { validatePngForDecode } from "mcp-devices/utils/image/input";
import { findNodeBySelector, findNodeByText, getCoordinates } from "./cdp-helpers.js";
import { buildSnapshot } from "./snapshot-builder.js";
import { pressKeyOnCdp, formatEvaluateResult } from "./key-map.js";

type CdpFactory = (opts: { port: number }) => Promise<CDPClientInterface>;
const CDP = createCdpClient as unknown as CdpFactory;
const MAX_SCREENSHOT_BYTES = 50 * 1024 * 1024;
const captureScreenshotResultSchema = z.object({
  data: z
    .string()
    .max(Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
}).passthrough();
const locationResultSchema = z.object({
  result: z.object({
    value: z.string().max(8192),
  }).passthrough(),
}).passthrough();
const visibilityResultSchema = z.object({
  result: z.object({
    value: z.boolean(),
  }).passthrough(),
}).passthrough();

export class BrowserClient {
  private sessionManager: SessionManager;

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
  }

  validateUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }
    // S2: fail-closed allowlist — only http/https may reach CDP Page.navigate.
    if (!Object.hasOwn(ALLOWED_URL_PROTOCOLS, parsed.protocol)) {
      throw new BrowserSecurityError(url, parsed.protocol);
    }
  }

  async launch(options: BrowserOpenOptions): Promise<BrowserSession> {
    const { url, session = DEFAULT_SESSION, headless = false } = options;
    this.validateUrl(url);
    const lockToken = this.sessionManager.acquireLock(session);
    const profileDir = this.sessionManager.getProfileDir(session);
    let chrome: LaunchedChrome | undefined;
    let cdp: CDPClientInterface | undefined;

    try {
      this.sessionManager.cleanupOrphanChrome(session);


      const chromeFlags = [
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-translate",
        "--disable-save-password-bubble",
        "--password-store=basic",
        `--user-data-dir=${profileDir}`,
        "--remote-debugging-address=127.0.0.1",
      ];
      if (headless) chromeFlags.push("--headless=new");
      if (process.env.MCP_DEVICES_DISABLE_CHROME_SANDBOX === "1") {
        chromeFlags.push("--no-sandbox", "--disable-dev-shm-usage");
      }

      try {
        chrome = (await launchChrome({
          chromeFlags,
          handleSIGINT: false,
          port: 0,
          logLevel: "silent",
        })) as unknown as LaunchedChrome;
      } catch (error) {
        const details = error as { message?: string; code?: string };
        if (details.message?.includes("not found") || details.code === "ENOENT") {
          throw new Error(
            "Chrome/Chromium not found. Install Google Chrome or set CHROME_PATH environment variable.",
          );
        }
        throw error;
      }

      this.sessionManager.writePidFile(session, chrome.process.pid ?? 0, lockToken);
      cdp = await CDP({ port: chrome.port });
      const { Page, Runtime, DOM, Network } = cdp;
      await Promise.all([
        Page.enable(),
        Runtime.enable(),
        DOM.enable(),
        Network.enable(),
      ]);

      const browserSession: BrowserSession = {
        id: session,
        chrome,
        cdp,
        port: chrome.port,
        profileDir,
        lockToken,
        refMap: new Map(),
        lastRefCounter: 0,
        url: "",
      };
      Page.frameNavigated(() => {
        browserSession.staleRefMap = new Map(browserSession.refMap);
        browserSession.refMap.clear();
        browserSession.lastRefCounter = 0;
      });

      await this.navigateToUrl(cdp, url);
      browserSession.url = url;
      this.sessionManager.setSession(session, browserSession, lockToken);
      return browserSession;
    } catch (error) {
      try { await cdp?.close(); } catch {}
      try { await chrome?.kill(); } catch {}
      this.sessionManager.removePidFile(session, lockToken);
      this.sessionManager.releaseLock(session, lockToken);
      throw error;
    }
  }

  private async navigateToUrl(cdp: CDPClientInterface, url: string): Promise<void> {
    const { Page } = cdp;
    // One-shot promise form self-removes the underlying CDP listener once it
    // resolves, so repeated navigations on a long-lived session don't leak
    // handlers (issue M1). Start the wait before navigate() to avoid a race
    // where the load event fires before we subscribe.
    const loaded = Page.loadEventFired();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timed = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`Navigation timeout for ${url}`)), 30000);
    });
    try {
      await Page.navigate({ url });
      await Promise.race([loaded, timed]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async navigate(session: BrowserSession, options: BrowserNavigateOptions): Promise<void> {
    const { cdp } = session;
    const { url, action } = options;

    if (action === "back") {
      await cdp.Runtime.evaluate({ expression: "history.back()" });
      await new Promise(r => setTimeout(r, 500));
    } else if (action === "forward") {
      await cdp.Runtime.evaluate({ expression: "history.forward()" });
      await new Promise(r => setTimeout(r, 500));
    } else if (action === "reload") {
      // One-shot promise form self-removes the CDP listener (issue M1). Subscribe
      // before reload() so a fast load event isn't missed.
      const loaded = cdp.Page.loadEventFired();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timed = new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 10000);
      });
      try {
        await cdp.Page.reload();
        await Promise.race([loaded, timed]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    } else if (url) {
      this.validateUrl(url);
      await this.navigateToUrl(cdp, url);
      session.url = url;
    } else {
      throw new Error("browser_navigate: provide url or action (back/forward/reload)");
    }
  }

  async getSnapshot(session: BrowserSession): Promise<string> {
    return buildSnapshot(session, session.cdp);
  }

  async resolveRef(session: BrowserSession, ref: string): Promise<{ nodeId?: number; selector: string; label: string }> {
    let entry = session.refMap.get(ref);

    // Level 2: stale refs from before navigation
    if (!entry && session.staleRefMap) {
      entry = session.staleRefMap.get(ref);
    }

    if (!entry) {
      throw new BrowserRefNotFoundError(ref);
    }

    // Level 1: try backendNodeId (works if element still in DOM)
    if (entry.backendNodeId) {
      try {
        const { nodeIds } = await session.cdp.DOM.pushNodesByBackendIdsToFrontend({ backendNodeIds: [entry.backendNodeId] });
        if (nodeIds?.[0]) {
          return { nodeId: nodeIds[0], selector: entry.selector, label: entry.label };
        }
      } catch {}
    }

    // Level 3: try CSS selector
    if (entry.selector) {
      const nodeId = await findNodeBySelector(session.cdp, entry.selector);
      if (nodeId) {
        return { nodeId, selector: entry.selector, label: entry.label };
      }
    }

    // Level 4: try text search
    if (entry.textFingerprint) {
      const coords = await findNodeByText(session.cdp, entry.textFingerprint);
      if (coords) {
        // Return selector-less result — caller will use coordinates from findNodeByText
        return { selector: "", label: `${entry.label} (found by text)` };
      }
    }

    throw new BrowserRefNotFoundError(ref, entry.label);
  }

  async click(session: BrowserSession, options: BrowserClickOptions): Promise<{ navigated: boolean; newUrl?: string }> {
    const { cdp } = session;
    let x: number, y: number;

    const prevUrl = session.url;

    if (options.ref) {
      const resolved = await this.resolveRef(session, options.ref);
      if (resolved.nodeId) {
        const coords = await getCoordinates(cdp, resolved.nodeId);
        x = coords.x;
        y = coords.y;
      } else if (resolved.selector) {
        const nodeId = await findNodeBySelector(cdp, resolved.selector);
        if (!nodeId) throw new Error(`Element not found for selector: ${resolved.selector}`);
        const coords = await getCoordinates(cdp, nodeId);
        x = coords.x;
        y = coords.y;
      } else {
        throw new Error(`Could not resolve ref "${options.ref}"`);
      }
    } else if (options.selector) {
      const nodeId = await findNodeBySelector(cdp, options.selector);
      if (!nodeId) throw new Error(`No element matches selector: ${options.selector}`);
      const coords = await getCoordinates(cdp, nodeId);
      x = coords.x;
      y = coords.y;
    } else if (options.text) {
      const result = await findNodeByText(cdp, options.text);
      if (!result) throw new Error(`No element found with text: "${options.text}"`);
      x = result.x;
      y = result.y;
    } else {
      throw new Error("browser_click: provide ref, selector, or text");
    }

    // Perform click
    await cdp.Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
    await cdp.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdp.Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });

    // Wait a bit and check for navigation
    await new Promise(r => setTimeout(r, 300));

    let navigated = false;
    let newUrl: string | undefined;

    try {
      const parsed = locationResultSchema.parse(
        await cdp.Runtime.evaluate({ expression: "location.href", returnByValue: true }),
      );
      newUrl = parsed.result.value;
      navigated = newUrl !== prevUrl;
      if (navigated) session.url = newUrl;
    } catch {}

    return { navigated, newUrl };
  }

  async fill(session: BrowserSession, options: BrowserFillOptions): Promise<void> {
    const { cdp } = session;
    const { value, clear = true, pressEnter = false } = options;

    let nodeId: number | null = null;

    if (options.ref) {
      const resolved = await this.resolveRef(session, options.ref);
      if (resolved.nodeId) {
        nodeId = resolved.nodeId;
      } else if (resolved.selector) {
        nodeId = await findNodeBySelector(cdp, resolved.selector);
      }
    } else if (options.selector) {
      nodeId = await findNodeBySelector(cdp, options.selector);
    }

    if (nodeId === null) {
      throw new Error(`browser_fill: could not find element. Provide ref or selector.`);
    }

    // Focus element
    try {
      await cdp.DOM.focus({ nodeId });
    } catch {}

    // Clear field
    if (clear) {
      await cdp.Input.dispatchKeyEvent({ type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
      await cdp.Input.dispatchKeyEvent({ type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
      await cdp.Input.dispatchKeyEvent({ type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
      await cdp.Input.dispatchKeyEvent({ type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    }

    // Type text
    await cdp.Input.insertText({ text: value });

    if (pressEnter) {
      await cdp.Input.dispatchKeyEvent({ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
      await cdp.Input.dispatchKeyEvent({ type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    }
  }

  async pressKey(session: BrowserSession, key: string): Promise<void> {
    await pressKeyOnCdp(session.cdp, key);
  }

  async tap(session: BrowserSession, x: number, y: number): Promise<void> {
    await session.cdp.Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
    await session.cdp.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await session.cdp.Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async screenshot(session: BrowserSession, fullPage = false): Promise<Buffer> {
    const parsed = captureScreenshotResultSchema.parse(
      await session.cdp.Page.captureScreenshot({
        format: "png",
        captureBeyondViewport: fullPage,
      }),
    );
    const screenshot = Buffer.from(parsed.data, "base64");
    validatePngForDecode(screenshot);
    return screenshot;
  }

  async evaluate(session: BrowserSession, expression: string): Promise<string> {
    const { result, exceptionDetails } = await session.cdp.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true,
    });

    if (exceptionDetails) {
      throw new Error(`JavaScript error: ${exceptionDetails.text || exceptionDetails.exception?.description || "Unknown error"}`);
    }

    return formatEvaluateResult(result.value);
  }

  async waitForSelector(session: BrowserSession, selector: string, timeout = 5000, state: "attached" | "visible" = "visible"): Promise<void> {
    const interval = 200;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      try {
        const { root } = await session.cdp.DOM.getDocument({ depth: 0 });
        const { nodeId } = await session.cdp.DOM.querySelector({ nodeId: root.nodeId, selector });
        if (nodeId !== 0) {
          if (state === "attached") return;
          // Check visibility
          const parsed = visibilityResultSchema.parse(
            await session.cdp.Runtime.evaluate({
              expression: `(function() {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
              })()`,
              returnByValue: true,
            }),
          );
          if (parsed.result.value) return;
        }
      } catch {}
      await new Promise(r => setTimeout(r, interval));
    }

    throw new Error(`Timeout: selector "${selector}" not found within ${timeout}ms`);
  }

  async close(session: BrowserSession): Promise<void> {
    this.sessionManager.removeSession(session.id);
    try {
      try { await session.cdp.close(); } catch {}
      try { await session.chrome.kill(); } catch {}
    } finally {
      this.sessionManager.removePidFile(session.id, session.lockToken);
      this.sessionManager.releaseLock(session.id, session.lockToken);
    }
  }

  async closeAll(): Promise<void> {
    for (const name of this.sessionManager.listSessions()) {
      const session = this.sessionManager.getSession(name);
      if (session) await this.close(session);
    }
  }
}
