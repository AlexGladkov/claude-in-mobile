import { createRequire } from "module";
import type { BrowserSession, BrowserOpenOptions, BrowserClickOptions, BrowserFillOptions, BrowserNavigateOptions, LaunchedChrome } from "./types.js";
import type { CDPClientInterface, CDPAccessibilityNode } from "./cdp-types.js";
import { BLOCKED_URL_PROTOCOLS, DEFAULT_SESSION } from "./types.js";
import { SessionManager } from "./session-manager.js";

const require = createRequire(import.meta.url);

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
    if (BLOCKED_URL_PROTOCOLS.has(parsed.protocol)) {
      throw new Error(
        `Blocked URL protocol "${parsed.protocol}". Only http:// and https:// are allowed.`
      );
    }
  }

  async launch(options: BrowserOpenOptions): Promise<BrowserSession> {
    const { url, session = DEFAULT_SESSION, headless = false } = options;
    this.validateUrl(url);

    const profileDir = this.sessionManager.getProfileDir(session);

    // Kill any orphaned Chrome from previous run
    this.sessionManager.cleanupOrphanChrome(session);

    const chromeLauncher = require("chrome-launcher");
    const CDP = require("chrome-remote-interface");

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
    ];

    if (headless) {
      chromeFlags.push("--headless=new");
    }

    // CI/Docker safety flags
    if (process.env.CI || process.env.DOCKER) {
      chromeFlags.push("--no-sandbox", "--disable-dev-shm-usage");
    }

    let chrome: LaunchedChrome;
    try {
      chrome = await chromeLauncher.launch({
        chromeFlags,
        handleSIGINT: false,
        port: 0, // auto-select free port
        logLevel: "silent",
      });
    } catch (err: unknown) {
      const errObj = err as { message?: string; code?: string };
      if (errObj.message?.includes("not found") || errObj.code === "ENOENT") {
        throw new Error(
          "Chrome/Chromium not found. Install Google Chrome or set CHROME_PATH environment variable."
        );
      }
      throw err;
    }

    // Save PID for orphan detection
    this.sessionManager.writePidFile(session, chrome.process.pid ?? 0);
    this.sessionManager.writeLockFile(session);

    let cdp: CDPClientInterface;
    try {
      cdp = await CDP({ port: chrome.port });
    } catch (err) {
      await chrome.kill().catch(() => {});
      throw err;
    }

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
      refMap: new Map(),
      lastRefCounter: 0,
      url: "",
    };

    // Invalidate refs on navigation
    Page.frameNavigated(() => {
      browserSession.refMap.clear();
      browserSession.lastRefCounter = 0;
    });

    this.sessionManager.setSession(session, browserSession);

    // Navigate to URL
    await this.navigateToUrl(cdp, url);
    browserSession.url = url;

    return browserSession;
  }

  private async navigateToUrl(cdp: CDPClientInterface, url: string): Promise<void> {
    const { Page } = cdp;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Navigation timeout for ${url}`)), 30000);
      Page.loadEventFired(() => {
        clearTimeout(timeout);
        resolve();
      });
      Page.navigate({ url }).catch(reject);
    });
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
      await cdp.Page.reload();
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 10000);
        cdp.Page.loadEventFired(() => { clearTimeout(timeout); resolve(); });
      });
    } else if (url) {
      this.validateUrl(url);
      await this.navigateToUrl(cdp, url);
      session.url = url;
    } else {
      throw new Error("browser_navigate: provide url or action (back/forward/reload)");
    }
  }

  async getSnapshot(session: BrowserSession): Promise<string> {
    const { cdp } = session;

    let axNodes: CDPAccessibilityNode[];
    try {
      const result = await cdp.Accessibility.getFullAXTree();
      axNodes = result.nodes ?? [];
    } catch {
      return "(Failed to get accessibility tree)";
    }

    // Build ref map
    session.refMap.clear();
    session.lastRefCounter = 0;

    const INTERACTIVE_ROLES = new Set([
      "button", "link", "textbox", "combobox", "listbox", "menuitem",
      "menuitemcheckbox", "menuitemradio", "radio", "checkbox", "switch",
      "slider", "spinbutton", "tab", "treeitem", "option",
      "searchbox", "scrollbar", "columnheader", "rowheader",
    ]);

    const formatValue = (v: { type: string; value?: string } | undefined) =>
      (v?.type === "string" || v?.type === "computedString") ? v.value : undefined;

    // Build flat snapshot list
    const snapshotLines: string[] = [];

    for (const node of axNodes) {
      if (node.ignored) continue;
      const role = formatValue(node.role) ?? "";
      if (!role || role === "none" || role === "generic" || role === "InlineTextBox") continue;

      const name = formatValue(node.name) ?? "";

      let ref = "";
      if (INTERACTIVE_ROLES.has(role) && name) {
        const refId = `e${++session.lastRefCounter}`;
        ref = ` [${refId}]`;

        let selector = "";
        if (node.backendDOMNodeId) {
          try {
            const { nodeIds } = await cdp.DOM.pushNodesByBackendIdsToFrontend({ backendNodeIds: [node.backendDOMNodeId] });
            if (nodeIds?.[0]) {
              selector = await this.buildSelector(cdp, nodeIds[0]);
            }
          } catch {}
        }

        session.refMap.set(refId, {
          selector,
          backendNodeId: node.backendDOMNodeId ?? 0,
          label: `${role} "${name}"`,
        });
      }

      const value = formatValue(node.value);
      const valueStr = value ? ` value="${value}"` : "";
      const disabled = node.properties?.find(p => p.name === "disabled")?.value?.value ? " [disabled]" : "";

      snapshotLines.push(`${role} "${name}"${ref}${valueStr}${disabled}`);
    }

    // Get current URL and title
    let title = "";
    try {
      const { result } = await cdp.Runtime.evaluate({ expression: "document.title", returnByValue: true });
      title = (result.value as string) ?? "";
    } catch {}

    // Update session URL
    try {
      const { result } = await cdp.Runtime.evaluate({ expression: "location.href", returnByValue: true });
      if (result.value) session.url = result.value as string;
    } catch {}

    const header = `[${title || "Untitled"}] ${session.url}\n\n`;
    const body = snapshotLines.join("\n") || "(no interactive elements found)";
    const hint = `\n\n--- ${session.refMap.size} interactive elements, refs e1..e${session.lastRefCounter} ---`;

    return header + body + hint;
  }

  private async buildSelector(cdp: CDPClientInterface, nodeId: number): Promise<string> {
    try {
      const { object } = await cdp.DOM.resolveNode({ nodeId });
      const { result } = await cdp.Runtime.callFunctionOn({
        objectId: object.objectId,
        functionDeclaration: `function() {
          if (this.id) return '#' + CSS.escape(this.id);
          const testId = this.getAttribute('data-testid') || this.getAttribute('data-test') || this.getAttribute('data-cy');
          if (testId) return '[data-testid="' + testId + '"]';
          const parts = [];
          let el = this;
          while (el && el !== document.body) {
            let sel = el.tagName.toLowerCase();
            const parent = el.parentElement;
            if (parent) {
              const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
              if (siblings.length > 1) sel += ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')';
            }
            parts.unshift(sel);
            el = parent;
          }
          return parts.join(' > ');
        }`,
        returnByValue: true,
      });
      return (result.value as string) ?? "";
    } catch {
      return "";
    }
  }

  async resolveRef(session: BrowserSession, ref: string): Promise<{ nodeId?: number; selector: string; label: string }> {
    const entry = session.refMap.get(ref);
    if (!entry) {
      throw new Error(`Ref "${ref}" not found. Available: ${Array.from(session.refMap.keys()).join(", ") || "none"}. Run browser(action:'snapshot') first.`);
    }

    // Try backendNodeId first
    if (entry.backendNodeId) {
      try {
        const { nodeIds } = await session.cdp.DOM.pushNodesByBackendIdsToFrontend({ backendNodeIds: [entry.backendNodeId] });
        if (nodeIds?.[0]) {
          return { nodeId: nodeIds[0], selector: entry.selector, label: entry.label };
        }
      } catch {}
    }

    // Fallback to CSS selector
    if (entry.selector) {
      return { selector: entry.selector, label: entry.label };
    }

    throw new Error(
      `Ref "${ref}" is stale (element no longer in DOM). Last known: ${entry.label}. Run browser(action:'snapshot') to get fresh refs.`
    );
  }

  private async getCoordinates(cdp: CDPClientInterface, nodeId: number): Promise<{ x: number; y: number }> {
    const { model } = await cdp.DOM.getBoxModel({ nodeId });
    if (!model) throw new Error("Could not get element bounding box");
    const [x1, y1, x2, , , , , y4] = model.content;
    return {
      x: Math.round((x1 + x2) / 2),
      y: Math.round((y1 + y4) / 2),
    };
  }

  private async findNodeBySelector(cdp: CDPClientInterface, selector: string): Promise<number | null> {
    try {
      const { root } = await cdp.DOM.getDocument({ depth: 0 });
      const { nodeId } = await cdp.DOM.querySelector({ nodeId: root.nodeId, selector });
      return nodeId !== 0 ? nodeId : null;
    } catch {
      return null;
    }
  }

  private async findNodeByText(cdp: CDPClientInterface, text: string): Promise<{ x: number; y: number } | null> {
    try {
      const { result } = await cdp.Runtime.evaluate({
        expression: `(function() {
          const all = document.querySelectorAll('a, button, [role="button"], [role="link"], input[type="submit"], input[type="button"]');
          const t = ${JSON.stringify(text.toLowerCase())};
          for (const el of all) {
            if (el.textContent?.toLowerCase().includes(t) || el.value?.toLowerCase()?.includes(t)) {
              return JSON.stringify({x: el.getBoundingClientRect().left + el.offsetWidth/2, y: el.getBoundingClientRect().top + el.offsetHeight/2});
            }
          }
          return null;
        })()`,
        returnByValue: true,
      });
      if (result.value) {
        return JSON.parse(result.value as string);
      }
    } catch {}
    return null;
  }

  async click(session: BrowserSession, options: BrowserClickOptions): Promise<{ navigated: boolean; newUrl?: string }> {
    const { cdp } = session;
    let x: number, y: number;

    const prevUrl = session.url;

    if (options.ref) {
      const resolved = await this.resolveRef(session, options.ref);
      if (resolved.nodeId) {
        const coords = await this.getCoordinates(cdp, resolved.nodeId);
        x = coords.x;
        y = coords.y;
      } else if (resolved.selector) {
        const nodeId = await this.findNodeBySelector(cdp, resolved.selector);
        if (!nodeId) throw new Error(`Element not found for selector: ${resolved.selector}`);
        const coords = await this.getCoordinates(cdp, nodeId);
        x = coords.x;
        y = coords.y;
      } else {
        throw new Error(`Could not resolve ref "${options.ref}"`);
      }
    } else if (options.selector) {
      const nodeId = await this.findNodeBySelector(cdp, options.selector);
      if (!nodeId) throw new Error(`No element matches selector: ${options.selector}`);
      const coords = await this.getCoordinates(cdp, nodeId);
      x = coords.x;
      y = coords.y;
    } else if (options.text) {
      const result = await this.findNodeByText(cdp, options.text);
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
      const { result } = await cdp.Runtime.evaluate({ expression: "location.href", returnByValue: true });
      newUrl = result.value as string | undefined;
      navigated = newUrl !== prevUrl;
      if (navigated && newUrl) session.url = newUrl;
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
        nodeId = await this.findNodeBySelector(cdp, resolved.selector);
      }
    } else if (options.selector) {
      nodeId = await this.findNodeBySelector(cdp, options.selector);
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
    const KEY_MAP: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
      Enter:      { key: "Enter",      code: "Enter",     keyCode: 13, text: "\r" },
      Tab:        { key: "Tab",        code: "Tab",       keyCode: 9 },
      Escape:     { key: "Escape",     code: "Escape",    keyCode: 27 },
      Backspace:  { key: "Backspace",  code: "Backspace", keyCode: 8 },
      Delete:     { key: "Delete",     code: "Delete",    keyCode: 46 },
      ArrowUp:    { key: "ArrowUp",    code: "ArrowUp",   keyCode: 38 },
      ArrowDown:  { key: "ArrowDown",  code: "ArrowDown", keyCode: 40 },
      ArrowLeft:  { key: "ArrowLeft",  code: "ArrowLeft", keyCode: 37 },
      ArrowRight: { key: "ArrowRight", code: "ArrowRight",keyCode: 39 },
      Home:       { key: "Home",       code: "Home",      keyCode: 36 },
      End:        { key: "End",        code: "End",       keyCode: 35 },
      PageUp:     { key: "PageUp",     code: "PageUp",    keyCode: 33 },
      PageDown:   { key: "PageDown",   code: "PageDown",  keyCode: 34 },
      Space:      { key: " ",          code: "Space",     keyCode: 32, text: " " },
    };

    const def = KEY_MAP[key];
    if (!def) throw new Error(`Unknown key: "${key}". Supported: ${Object.keys(KEY_MAP).join(", ")}`);

    await session.cdp.Input.dispatchKeyEvent({ type: "keyDown", key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, text: def.text });
    await session.cdp.Input.dispatchKeyEvent({ type: "keyUp", key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode });
  }

  async tap(session: BrowserSession, x: number, y: number): Promise<void> {
    await session.cdp.Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
    await session.cdp.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await session.cdp.Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async screenshot(session: BrowserSession, fullPage = false): Promise<Buffer> {
    const { data } = await session.cdp.Page.captureScreenshot({
      format: "png",
      captureBeyondViewport: fullPage,
    });
    return Buffer.from(data, "base64");
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

    const value = result.value;
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (typeof value === "object") {
      const json = JSON.stringify(value, null, 2);
      return json.length > 10000 ? json.slice(0, 10000) + "\n... (truncated)" : json;
    }
    return String(value);
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
          const { result } = await session.cdp.Runtime.evaluate({
            expression: `(function() {
              const el = document.querySelector(${JSON.stringify(selector)});
              if (!el) return false;
              const rect = el.getBoundingClientRect();
              const style = getComputedStyle(el);
              return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
            })()`,
            returnByValue: true,
          });
          if (result.value) return;
        }
      } catch {}
      await new Promise(r => setTimeout(r, interval));
    }

    throw new Error(`Timeout: selector "${selector}" not found within ${timeout}ms`);
  }

  async close(session: BrowserSession): Promise<void> {
    try { await session.cdp.close(); } catch {}
    try { await session.chrome.kill(); } catch {}
    this.sessionManager.removeSession(session.id);
    this.sessionManager.removePidFile(session.id);
    this.sessionManager.removeLockFile(session.id);
  }

  async closeAll(): Promise<void> {
    for (const name of this.sessionManager.listSessions()) {
      const session = this.sessionManager.getSession(name);
      if (session) await this.close(session);
    }
  }
}
