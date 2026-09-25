import { describe, expect, it, vi } from "vitest";

import type { CDPAccessibilityNode, CDPClientInterface } from "./cdp-types.js";
import type { BrowserSession } from "./types.js";
import { buildSnapshot, buildUiElements, sanitizeBrowserUrl } from "./snapshot-builder.js";

function axValue(value: string): { type: "string"; value: string } {
  return { type: "string", value };
}

function fakeSession(url: string): BrowserSession {
  return {
    id: "default",
    url,
    refMap: new Map(),
    lastRefCounter: 0,
  } as unknown as BrowserSession;
}

type TestCdp = Omit<CDPClientInterface, "Runtime"> & {
  Runtime: CDPClientInterface["Runtime"] & {
    releaseObject: (params: { objectId: string }) => Promise<void>;
  };
};

function fakeCdp(nodes: CDPAccessibilityNode[], title = "Example"): TestCdp {
  return {
    Accessibility: {
      getFullAXTree: vi.fn(async () => ({ nodes })),
    },
    DOM: {
      pushNodesByBackendIdsToFrontend: vi.fn(async () => ({ nodeIds: [1] })),
      getBoxModel: vi.fn(async () => ({
        model: { content: [10, 20, 110, 20, 110, 60, 10, 60], width: 100, height: 40 },
      })),
      resolveNode: vi.fn(async () => ({ object: { objectId: "object-1" } })),
      getDocument: vi.fn(),
      querySelector: vi.fn(),
      focus: vi.fn(),
    },
    Runtime: {
      enable: vi.fn(),
      evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
        result: {
          type: "string",
          value: expression === "document.title"
            ? title
            : "https://example.com/login?code=oauth-secret&token=abc#access_token=fragment",
        },
      })),
      callFunctionOn: vi.fn(async ({ functionDeclaration }: { functionDeclaration: string }) => ({
        result: functionDeclaration.includes("this.getAttribute(\"type\")")
          ? {
              type: "object",
              value: {
                id: "password-field",
                type: "password",
                autocomplete: "current-password",
                ariaRole: "textbox",
                textEntry: true,
              },
            }
          : { type: "string", value: "#password-field" },
      })),
      releaseObject: vi.fn(async () => {}),
    },
    Page: {
      enable: vi.fn(),
      navigate: vi.fn(),
      loadEventFired: vi.fn(),
      frameNavigated: vi.fn(),
      reload: vi.fn(),
      captureScreenshot: vi.fn(),
    },
    Network: { enable: vi.fn() },
    Tracing: {
      start: vi.fn(),
      end: vi.fn(),
      tracingComplete: vi.fn(),
    },
    IO: { read: vi.fn(), close: vi.fn() },
    HeapProfiler: {
      enable: vi.fn(),
      disable: vi.fn(),
      takeHeapSnapshot: vi.fn(),
    },
    Input: {
      dispatchMouseEvent: vi.fn(),
      dispatchKeyEvent: vi.fn(),
      insertText: vi.fn(),
    },
    on: vi.fn(),
    removeListener: vi.fn(),
    close: vi.fn(),
  } as unknown as TestCdp;
}

describe("browser accessibility projection", () => {
  it("returns normalized records and masks password-type AX values", async () => {
    const nodes: CDPAccessibilityNode[] = [
      {
        nodeId: "password",
        backendDOMNodeId: 1,
        role: axValue("textbox"),
        name: axValue("Username"),
        value: axValue("hunter2"),
      },
      {
        nodeId: "button",
        backendDOMNodeId: 2,
        role: axValue("button"),
        name: axValue("Continue"),
      },
    ];
    const cdp = fakeCdp(nodes);
    const session = fakeSession("https://example.com/login");

    const records = await buildUiElements(session, cdp);
    const snapshot = await buildSnapshot(session, cdp);

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ role: "textbox", password: true });
    expect(records[0]).not.toHaveProperty("value");
    expect(snapshot).not.toContain("hunter2");
    expect(snapshot).toContain("value=\"[REDACTED]\"");
    expect(snapshot).toContain("Continue");
  });

  it("stores escaped selectors from their actual test-attribute name", async () => {
    const session = fakeSession("https://example.com/");
    const cdp = fakeCdp([{
      nodeId: "save",
      backendDOMNodeId: 1,
      role: axValue("button"),
      name: axValue("Save"),
    }]);
    const escape = vi.fn((value: string) => value.replace(":", "\\:"));
    vi.spyOn(cdp.Runtime, "callFunctionOn").mockImplementation(async ({ functionDeclaration }) => {
      const selectorFunction = new Function(
        "CSS",
        "document",
        `return (${functionDeclaration});`,
      )({ escape }, { body: {} }) as (this: { id: string; getAttribute(name: string): string | null }) => string;
      const selector = selectorFunction.call({
        id: "",
        getAttribute: (name) => name === "data-test" ? "save:button" : null,
      });
      return { result: { type: "string", value: selector } };
    });

    await buildSnapshot(session, cdp);

    expect(session.refMap.get("e1")?.selector).toBe("[data-test=save\\:button]");
    expect(escape).toHaveBeenCalledWith("save:button");
  });
  it("redacts secure names from normalized records, snapshots, and reference labels", async () => {
    const secret = "typed-sentinel-984";
    const session = fakeSession("https://example.com/login");
    const cdp = fakeCdp([{
      nodeId: "secure",
      backendDOMNodeId: 1,
      role: axValue("textbox"),
      name: axValue(secret),
      value: axValue(secret),
      properties: [{
        name: "autocomplete",
        value: axValue("current-password"),
      }],
    }]);

    const records = await buildUiElements(session, cdp);
    const snapshot = await buildSnapshot(session, cdp);

    expect(records[0]).toMatchObject({
      password: true,
      text: "[REDACTED]",
      label: "[REDACTED]",
      contentDesc: "[REDACTED]",
      id: "[REDACTED]",
    });
    expect(snapshot).not.toContain(secret);
    expect(JSON.stringify([...session.refMap.values()])).not.toContain(secret);
  });
  it("checks secure DOM metadata when AX omits the input value", async () => {
    const secret = "typed-sentinel-984";
    const session = fakeSession("https://example.com/login");
    const cdp = fakeCdp([{
      nodeId: "input",
      backendDOMNodeId: 1,
      role: axValue("textbox"),
      name: axValue(secret),
    }]);

    const records = await buildUiElements(session, cdp);
    const snapshot = await buildSnapshot(session, cdp);

    expect(records[0]).toMatchObject({
      password: true,
      text: "[REDACTED]",
      label: "[REDACTED]",
      id: "[REDACTED]",
    });
    expect(snapshot).not.toContain(secret);
    expect(JSON.stringify([...session.refMap.values()])).not.toContain(secret);
  });

  it("redacts populated ordinary text inputs from snapshots and normalized records", async () => {
    const secret = "user-value-381@example.test";
    const session = fakeSession("https://example.com/login");
    const cdp = fakeCdp([{
      nodeId: "email",
      backendDOMNodeId: 1,
      role: axValue("textbox"),
      name: axValue("Email"),
      value: axValue(secret),
    }]);
    cdp.Runtime.callFunctionOn = vi.fn(async ({ functionDeclaration }) => ({
      result: functionDeclaration.includes("this.getAttribute(\"type\")")
        ? {
            value: {
              id: "email-field",
              type: "text",
              autocomplete: "",
              ariaRole: "textbox",
              textEntry: true,
            },
          }
        : { type: "string", value: "#email-field" },
    }));

    const records = await buildUiElements(session, cdp);
    const snapshot = await buildSnapshot(session, cdp);

    expect(records[0]).toMatchObject({
      password: true,
      text: "[REDACTED]",
      label: "[REDACTED]",
    });
    expect(records[0]).not.toHaveProperty("value");
    expect(snapshot).toContain('value="[REDACTED]"');
    expect(snapshot).not.toContain(secret);
  });

  it("redacts IDs and reference selectors for empty browser text fields", async () => {
    const dynamicId = "customer-email-7841";
    const session = fakeSession("https://example.com/login");
    const cdp = fakeCdp([{
      nodeId: "email",
      backendDOMNodeId: 1,
      role: axValue("textbox"),
      name: axValue("Email address"),
    }]);
    cdp.Runtime.callFunctionOn = vi.fn(async ({ functionDeclaration }) => ({
      result: functionDeclaration.includes("this.getAttribute(\"type\")")
        ? {
            type: "object",
            value: {
              id: dynamicId,
              type: "text",
              autocomplete: "",
              ariaRole: "textbox",
              textEntry: true,
            },
          }
        : { type: "string", value: `#${dynamicId}` },
    }));

    const records = await buildUiElements(session, cdp);
    const snapshot = await buildSnapshot(session, cdp);

    expect(records[0]).toMatchObject({
      id: "[REDACTED]",
      role: "textbox",
      text: "Email address",
    });
    expect(snapshot).toContain("Email address");
    expect(snapshot).not.toContain(dynamicId);
    expect(JSON.stringify(records)).not.toContain(dynamicId);
    expect(session.refMap.get("e1")?.selector).toBe("");
  });

  it("keeps browser controls actionable after complete security metadata", async () => {
    const cdp = fakeCdp([{
      nodeId: "email",
      backendDOMNodeId: 1,
      role: axValue("textbox"),
      name: axValue("Email"),
    }]);
    cdp.Runtime.callFunctionOn = vi.fn(async ({ functionDeclaration }) => ({
      result: functionDeclaration.includes("this.getAttribute(\"type\")")
        ? {
            type: "object",
            value: {
              id: "email-field",
              type: "email",
              autocomplete: "email",
              ariaRole: "textbox",
              textEntry: true,
            },
          }
        : { type: "string", value: "#email-field" },
    }));

    const [record] = await buildUiElements(fakeSession("https://example.com"), cdp);

    expect(record).toMatchObject({
      text: "Email",
      enabled: true,
      visible: true,
      clickable: true,
      focusable: true,
      id: "[REDACTED]",
    });
  });

  it("keeps AX secret markers sticky when DOM metadata is clean", async () => {
    const secret = "secret-selector-value-271";
    const session = fakeSession("https://example.com/form");
    const cdp = fakeCdp([{
      nodeId: "marked-button",
      backendDOMNodeId: 1,
      role: axValue("button"),
      name: axValue(secret),
    }]);
    cdp.Runtime.callFunctionOn = vi.fn(async ({ functionDeclaration }) => ({
      result: functionDeclaration.includes("this.getAttribute(\"type\")")
        ? {
            value: {
              id: "public-button",
              type: "button",
              autocomplete: "",
              ariaRole: "button",
              textEntry: false,
            },
          }
        : { type: "string", value: `#${secret}` },
    }));

    const records = await buildUiElements(session, cdp);
    const snapshot = await buildSnapshot(session, cdp);

    expect(records[0]).toMatchObject({
      password: true,
      text: "[REDACTED]",
      label: "[REDACTED]",
      id: "[REDACTED]",
    });
    expect(snapshot).not.toContain(secret);
    expect(JSON.stringify(records)).not.toContain(secret);
    expect(JSON.stringify([...session.refMap.values()])).not.toContain(secret);
    expect(session.refMap.get("e1")?.selector).toBe("");
  });



  it("bounds DOM work, preserves interactive bounds, and coalesces overlap", async () => {
    const nodes: CDPAccessibilityNode[] = Array.from({ length: 512 }, (_, index) => ({
      nodeId: `button-${index}`,
      backendDOMNodeId: index + 1,
      role: axValue("button"),
      name: axValue(`Button ${index}`),
    }));
    const cdp = fakeCdp(nodes);
    cdp.DOM.pushNodesByBackendIdsToFrontend = vi.fn(
      async ({ backendNodeIds }: { backendNodeIds: number[] }) => ({
        nodeIds: backendNodeIds,
      }),
    );
    let activeBoxes = 0;
    let maxActiveBoxes = 0;
    cdp.DOM.getBoxModel = vi.fn(async () => {
      activeBoxes++;
      await Promise.resolve();
      activeBoxes--;
      return {
        model: { content: [10, 20, 110, 20, 110, 60, 10, 60], width: 100, height: 40 },
      };
    });
    const session = fakeSession("https://example.com");

    const first = buildUiElements(session, cdp);
    const second = buildUiElements(session, cdp);
    expect(second).toBe(first);
    const records = await first;

    expect(records).toHaveLength(nodes.length);
    expect(records[0]).toMatchObject({
      bounds: { x: 10, y: 20, width: 100, height: 40 },
      clickable: true,
    });
    const pushCalls = vi.mocked(cdp.DOM.pushNodesByBackendIdsToFrontend).mock.calls;
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]?.[0].backendNodeIds.length).toBeLessThanOrEqual(128);
    expect(vi.mocked(cdp.DOM.getBoxModel).mock.calls.length).toBeLessThanOrEqual(128);
    expect(maxActiveBoxes).toBeLessThanOrEqual(8);
    expect(vi.mocked(cdp.DOM.resolveNode).mock.calls.length).toBeLessThanOrEqual(128);
    expect(vi.mocked(cdp.Runtime.callFunctionOn).mock.calls.length).toBeLessThanOrEqual(128);
  });

  it("redacts fields whose security classification misses the projection budget", async () => {
    const secret = "budgeted-verification-code-390";
    const nodes: CDPAccessibilityNode[] = Array.from({ length: 140 }, (_, index) => ({
      nodeId: `field-${index}`,
      backendDOMNodeId: index + 1,
      role: axValue("textbox"),
      name: axValue(index === 139 ? secret : `Field ${index}`),
      value: axValue(index === 139 ? secret : `value-${index}`),
    }));
    const cdp = fakeCdp(nodes);
    cdp.DOM.pushNodesByBackendIdsToFrontend = vi.fn(
      async ({ backendNodeIds }: { backendNodeIds: number[] }) => ({
        nodeIds: backendNodeIds,
      }),
    );
    let releasePending!: (value: {
      result: { type: string; value: unknown };
    }) => void;
    const pendingRuntime = new Promise<{ result: { type: string; value: unknown } }>((resolve) => {
      releasePending = resolve;
    });
    cdp.Runtime.callFunctionOn = vi.fn(async ({
      functionDeclaration,
    }: {
      objectId: string;
      functionDeclaration: string;
      returnByValue?: boolean;
    }) => {
      if (functionDeclaration.includes("this.getAttribute(\"type\")")) {
        return pendingRuntime;
      }
      return { result: { type: "string", value: "" } };
    });
    vi.useFakeTimers();
    const session = fakeSession("https://example.com");
    try {
      const projection = buildUiElements(session, cdp);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(250);
      const records = await projection;
      expect(buildUiElements(session, cdp)).toBe(projection);

      expect(JSON.stringify(records)).not.toContain(secret);
      expect(records.at(-1)).toMatchObject({
        text: "[REDACTED]",
        label: "[REDACTED]",
        password: true,
        enabled: false,
        visible: false,
        clickable: false,
      });
    } finally {
      releasePending({
        result: {
          value: {
            id: "field",
            type: "text",
            autocomplete: "",
            ariaRole: "textbox",
            textEntry: true,
          },
        },
      });
      await Promise.resolve();
      vi.useRealTimers();
    }

  });
  it("redacts one-time, verification, and PIN codes in AX and DOM projections", async () => {
    const oneTimeCode = "otp-code-431-219";
    const verificationCode = "verification-code-882-704";
    const pinCode = "pin-code-449-103";
    const nodes: CDPAccessibilityNode[] = [
      {
        nodeId: "otp",
        backendDOMNodeId: 1,
        role: axValue("textbox"),
        name: axValue("One-time code"),
        value: axValue(oneTimeCode),
        properties: [{ name: "autocomplete", value: axValue("one-time-code") }],
      },
      {
        nodeId: "verification",
        backendDOMNodeId: 2,
        role: axValue("textbox"),
        name: axValue("Verification code"),
        value: axValue(verificationCode),
        properties: [{ name: "data-purpose", value: axValue("verification-code") }],
      },
      {
        nodeId: "pin",
        backendDOMNodeId: 3,
        role: axValue("textbox"),
        name: axValue("PIN"),
        value: axValue(pinCode),
      },
    ];
    const cdp = fakeCdp(nodes);
    cdp.DOM.pushNodesByBackendIdsToFrontend = vi.fn(
      async ({ backendNodeIds }: { backendNodeIds: number[] }) => ({
        nodeIds: backendNodeIds,
      }),
    );
    const releaseObject = vi.fn(async (_params: { objectId: string }) => {});
    cdp.Runtime.releaseObject = releaseObject;
    cdp.Runtime.callFunctionOn = vi.fn(async ({
      functionDeclaration,
    }: {
      objectId: string;
      functionDeclaration: string;
      returnByValue?: boolean;
    }) => ({
      result: functionDeclaration.includes("this.getAttribute(\"type\")")
        ? {
            value: {
              id: "pin-field",
              type: "text",
              autocomplete: "",
              ariaRole: "textbox",
              textEntry: true,
            },
          }
        : { type: "string", value: "#pin-field" },
    }));
    const session = fakeSession("https://example.com/login");

    const records = await buildUiElements(session, cdp);
    const snapshot = await buildSnapshot(session, cdp);

    expect(records).toHaveLength(3);
    expect(records.every((record) => record.password === true)).toBe(true);
    for (const secret of [oneTimeCode, verificationCode, pinCode]) {
      expect(JSON.stringify(records)).not.toContain(secret);
      expect(snapshot).not.toContain(secret);
      expect(JSON.stringify([...session.refMap.values()])).not.toContain(secret);
    }
    expect(records[2]).toMatchObject({
      password: true,
      text: "[REDACTED]",
      id: "[REDACTED]",
    });
    expect(releaseObject).toHaveBeenCalled();
  });

  it("propagates accessibility read failures instead of returning a cache-poisoning empty tree", async () => {
    const cdp = fakeCdp([]);
    cdp.Accessibility.getFullAXTree = vi.fn(async () => {
      throw new Error("CDP unavailable");
    });

    await expect(buildUiElements(fakeSession("https://example.com"), cdp))
      .rejects.toThrow("CDP unavailable");
  });

  it("redacts page-title credentials and sanitizes query secrets in snapshots", async () => {
    const session = fakeSession(
      "https://example.com/login?code=oauth-secret&token=abc#access_token=fragment",
    );
    const pageTitle = "Settings password=title-password token=title-token";
    const snapshot = await buildSnapshot(
      session,
      fakeCdp([{
        nodeId: "button",
        role: axValue("button"),
        name: axValue("Continue"),
      }], pageTitle),
    );

    expect(snapshot).toContain("https://example.com/login?[REDACTED]#[REDACTED]");
    expect(snapshot).not.toContain("oauth-secret");
    expect(snapshot).not.toContain("access_token=fragment");
    expect(snapshot).toContain("Settings password=[REDACTED] token=[REDACTED]");
    expect(snapshot).not.toContain("title-password");
    expect(snapshot).not.toContain("title-token");
    expect(sanitizeBrowserUrl("https://user:pass@example.com/a?token=abc#frag"))
      .toBe("https://example.com/a?[REDACTED]#[REDACTED]");
  });
  it("uses the shared URL sanitizer for URL-shaped page titles", async () => {
    const oauthCode = "oauth-code-title-031";
    const oauthState = "oauth-state-title-047";
    const snapshot = await buildSnapshot(
      fakeSession("https://example.com/callback"),
      fakeCdp(
        [{
          nodeId: "button",
          role: axValue("button"),
          name: axValue("Continue"),
        }],
        `https://example.com/callback?code=${oauthCode}&state=${oauthState}&next=home`,
      ),
    );

    expect(snapshot).not.toContain(oauthCode);
    expect(snapshot).not.toContain(oauthState);
  });

  it("strips terminal escapes and bidi controls from page-controlled output", async () => {
    const attack = "Visible\u001b]0;owned-title\u0007\u202eRTL\u2066hidden\u2069";
    const session = fakeSession("https://example.com/path\u202e?token=secret");
    const cdp = fakeCdp([{
      nodeId: "heading",
      role: axValue("heading"),
      name: axValue(attack),
    }], `Title ${attack}`);

    const snapshot = await buildSnapshot(session, cdp);
    const records = await buildUiElements(session, cdp);
    const output = `${snapshot}\n${JSON.stringify(records)}`;

    expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u);
    expect(output).not.toContain("owned-title");
    expect(output).toContain("RTL");
    expect(sanitizeBrowserUrl("https://example.com/path\u202e")).not.toContain("\u202e");
  });
});
