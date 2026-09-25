import { describe, expect, it, vi } from "vitest";

import { BrowserClient } from "./client.js";
import { BrowserSecurityError } from "mcp-devices/errors";
import type { CDPClientInterface } from "./cdp-types.js";
import type { BrowserSession } from "./types.js";
import type { SessionManager } from "./session-manager.js";

describe("BrowserClient reference recovery", () => {
  it("clicks at coordinates from text search when DOM references are stale", async () => {
    const dispatchMouseEvent = vi.fn(async () => {});
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => expression === "location.href"
      ? { result: { type: "string", value: "https://example.com/" } }
      : { result: { type: "object", value: { x: 42, y: 84 } } });
    const cdp = {
      DOM: {
        pushNodesByBackendIdsToFrontend: vi.fn(async () => ({ nodeIds: [0] })),
      },
      Runtime: { evaluate },
      Input: { dispatchMouseEvent },
    } as unknown as CDPClientInterface;
    const session = {
      id: "default",
      cdp,
      url: "https://example.com/",
      refMap: new Map([[
        "e1",
        {
          selector: "",
          backendNodeId: 99,
          label: "button \"Continue\"",
          textFingerprint: "continue",
        },
      ]]),
    } as unknown as BrowserSession;
    const browser = new BrowserClient({} as SessionManager);

    await browser.click(session, { ref: "e1" });

    expect(dispatchMouseEvent).toHaveBeenNthCalledWith(1, {
      type: "mouseMoved",
      x: 42,
      y: 84,
    });
    expect(dispatchMouseEvent).toHaveBeenNthCalledWith(2, {
      type: "mousePressed",
      x: 42,
      y: 84,
      button: "left",
      clickCount: 1,
    });
  });
});

describe("BrowserClient navigation wait cleanup", () => {
  it("unsubscribes a navigation load listener after timeout", async () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const loadEventFired = vi.fn((_callback: () => void) => unsubscribe);
    const cdp = {
      Page: {
        navigate: vi.fn(async () => ({})),
        loadEventFired,
      },
    } as unknown as CDPClientInterface;
    const session = {
      cdp,
      url: "https://example.com/",
    } as unknown as BrowserSession;
    const browser = new BrowserClient({} as SessionManager);

    try {
      const navigation = browser.navigate(session, { url: "https://example.com/next" });
      const observedNavigation = navigation.catch(() => undefined);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(navigation).rejects.toThrow("Navigation timeout");
      await observedNavigation;
      expect(unsubscribe).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("unsubscribes a reload load listener after its resolving timeout", async () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const loadEventFired = vi.fn((_callback: () => void) => unsubscribe);
    const cdp = {
      Page: {
        reload: vi.fn(async () => {}),
        loadEventFired,
      },
    } as unknown as CDPClientInterface;
    const session = {
      cdp,
      url: "https://example.com/",
    } as unknown as BrowserSession;
    const browser = new BrowserClient({} as SessionManager);

    try {
      const reload = browser.navigate(session, { action: "reload" });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(reload).resolves.toBeUndefined();
      expect(unsubscribe).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sanitizes invalid and blocked URL diagnostics", () => {
    const browser = new BrowserClient({} as SessionManager);
    const secrets = ["basic-password-811", "oauth-code-204", "oauth-state-205", "fragment-secret-206"];
    const invalidUrl =
      "https://user:basic-password-811@example.com:bad/callback?code=oauth-code-204&state=oauth-state-205#fragment-secret-206";
    const blockedUrl =
      "ftp://user:basic-password-811@example.com/callback?code=oauth-code-204&state=oauth-state-205#fragment-secret-206";

    let invalidError: Error | undefined;
    try {
      browser.validateUrl(invalidUrl);
    } catch (error) {
      invalidError = error as Error;
    }
    expect(invalidError?.message).toContain("Invalid URL");
    for (const secret of secrets) {
      expect(invalidError?.message).not.toContain(secret);
    }

    let blockedError: Error | undefined;
    try {
      browser.validateUrl(blockedUrl);
    } catch (error) {
      blockedError = error as Error;
    }
    expect(blockedError?.message).toContain("Blocked URL");
    expect(blockedError?.message).toContain("ftp:");
    for (const secret of secrets) {
      expect(blockedError?.message).not.toContain(secret);
    }
  });

  it("sanitizes URLs passed directly to BrowserSecurityError", () => {
    const error = new BrowserSecurityError(
      "ftp://user:basic-password-811@example.com/callback?code=oauth-code-204&state=oauth-state-205#fragment-secret-206",
      "ftp:",
    );

    expect(error.message).toContain("Blocked URL");
    expect(error.message).toContain("ftp:");
    for (const secret of ["basic-password-811", "oauth-code-204", "oauth-state-205", "fragment-secret-206"]) {
      expect(error.message).not.toContain(secret);
    }
  });

  it("sanitizes credentials and OAuth secrets in navigation timeout diagnostics", async () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const loadEventFired = vi.fn((_callback: () => void) => unsubscribe);
    const cdp = {
      Page: {
        navigate: vi.fn(async () => ({})),
        loadEventFired,
      },
    } as unknown as CDPClientInterface;
    const session = {
      cdp,
      url: "https://example.com/",
    } as unknown as BrowserSession;
    const browser = new BrowserClient({} as SessionManager);
    const url =
      "https://user:basic-password-811@example.com/callback?code=oauth-code-204&state=oauth-state-205#fragment-secret-206";

    try {
      const navigation = browser.navigate(session, { url });
      const observedNavigation = navigation.catch((caught: unknown) => caught);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(30_000);
      const error = await observedNavigation;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Navigation timeout");
      expect((error as Error).message).toContain("https://example.com/callback?[REDACTED]#[REDACTED]");
      for (const secret of ["basic-password-811", "oauth-code-204", "oauth-state-205", "fragment-secret-206"]) {
        expect((error as Error).message).not.toContain(secret);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
