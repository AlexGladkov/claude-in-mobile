import { describe, it, expect } from "vitest";
import {
  iosTreeToUiElements,
  formatIOSUITree,
  unwrapWdaTree,
  WdaTreeError,
} from "./ios-helpers.js";
import {
  diffUiElements,
  suggestNextActions,
} from "../../ui-tree/ui-parser.js";
import type { UiElement } from "../../ui-tree/ui-parser.js";

// ---------------------------------------------------------------------------
// Fixtures modelled on the REAL `/wda/accessibleSource` payload, not the
// synthetic source-schema tree used elsewhere. Key real-world properties:
//   - The response is wrapped in a `{ value, status, sessionId }` envelope.
//   - The root Application + layout containers carry a ZERO-size rect (or none)
//     while still holding paintable descendants.
//   - A SecureTextField exposes the typed password in `value`.
// These are precisely the shapes that used to collapse to `[]` in CI because
// tests fed synthetic non-zero-rect trees.
// ---------------------------------------------------------------------------

/** A realistic WDA accessibleSource envelope with zero-rect containers. */
function wdaEnvelope() {
  return {
    status: 0,
    sessionId: "ABCDEF-0123",
    value: {
      type: "XCUIElementTypeApplication",
      // Root reports a zero-size rect — real WDA does this.
      rect: { x: 0, y: 0, width: 0, height: 0 },
      children: [
        {
          type: "XCUIElementTypeWindow",
          // Container with NO rect at all.
          children: [
            {
              type: "XCUIElementTypeOther",
              rect: { x: 0, y: 0, width: 0, height: 0 },
              children: [
                {
                  type: "XCUIElementTypeStaticText",
                  label: "Welcome",
                  name: "welcome-hint",
                  rect: { x: 20, y: 60, width: 200, height: 30 },
                },
                {
                  type: "XCUIElementTypeButton",
                  label: "Sign in",
                  enabled: true,
                  rect: { x: 20, y: 700, width: 350, height: 44 },
                },
                {
                  type: "XCUIElementTypeSecureTextField",
                  // The typed password lands here. Must never leave the process.
                  value: "hunter2",
                  label: "Password",
                  name: "hunter2-accessibility",
                  enabled: true,
                  rect: { x: 20, y: 400, width: 350, height: 40 },
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

/** A degraded WDA envelope: HTTP 200 but the session lost the tree. */
function degradedEnvelope() {
  return { status: 0, value: null, sessionId: "ABCDEF-0123" };
}

// ---------------------------------------------------------------------------
// Root #1: zero-rect containers must NOT discard their paintable subtree.
// ---------------------------------------------------------------------------
describe("iosTreeToUiElements — real accessibleSource format", () => {
  it("keeps leaf elements even when every ancestor has a zero/absent rect", () => {
    const elements = iosTreeToUiElements(wdaEnvelope());

    // The three paintable leaves survive; the zero-rect containers are skipped
    // as elements but do not swallow their children.
    const labels = elements.map(e => e.text);
    expect(labels).toContain("Welcome");
    expect(labels).toContain("Sign in");
    expect(elements.length).toBe(3);

    const secure = elements.find(e => e.password)!;
    expect(elements.find(e => e.text === "Welcome")?.contentDesc).toBe("welcome-hint");
    expect(secure.text).toBe("[REDACTED]");
    expect(secure.contentDesc).toBe("[REDACTED]");
  });

  it("unwraps the {value,status,sessionId} envelope instead of parsing it as a node", () => {
    // Passing the envelope straight through previously yielded [] because the
    // wrapper has no rect/children of its own.
    const elements = iosTreeToUiElements(wdaEnvelope());
    expect(elements.length).toBeGreaterThan(0);
  });

  it("still accepts a bare tree node (no envelope) for backwards compatibility", () => {
    const bare = wdaEnvelope().value;
    const elements = iosTreeToUiElements(bare);
    expect(elements.length).toBe(3);
  });

  it("redacts secure labels, values, and accessibility names in formatter output", () => {
    const formatted = formatIOSUITree(wdaEnvelope());
    expect(formatted).not.toContain("hunter2");
    expect(formatted).not.toContain("hunter2-accessibility");
    expect(formatted).toContain("[REDACTED]");
    expect(formatted).toContain("Welcome");
    expect(formatted).toContain("welcome-hint");
    expect(formatted).toContain("Sign in");
  });
});

describe("value-bearing iOS text entries", () => {
  it("redacts values from ordinary iOS text-entry elements", () => {
    const otp = "731904";
    const elements = iosTreeToUiElements({
      type: "XCUIElementTypeApplication",
      children: [{
        type: "XCUIElementTypeTextField",
        identifier: `one-time-code-${otp}`,
        value: otp,
        label: "One-time code",
        name: "verification-code",
        rect: { x: 20, y: 100, width: 300, height: 40 },
      }],
    });
    const field = elements[0];

    expect(field.password).toBe(true);
    expect(field.text).toBe("[REDACTED]");
    expect(field.contentDesc).toBe("[REDACTED]");
    expect(field.resourceId).toBe("[REDACTED]");
    expect(formatIOSUITree({
      type: "XCUIElementTypeApplication",
      children: [{
        type: "XCUIElementTypeTextField",
        identifier: `one-time-code-${otp}`,
        value: otp,
        rect: { x: 20, y: 100, width: 300, height: 40 },
      }],
    })).not.toContain(otp);
    const bidiOutput = formatIOSUITree({
      type: "XCUIElementTypeStaticText\u202e",
      label: "value\u2066hidden\u2069",
      rect: { x: 1, y: 2, width: 30, height: 10 },
    });
    expect(bidiOutput).not.toContain("\u202e");
    expect(bidiOutput).not.toContain("\u2066");
    expect(bidiOutput).not.toContain("\u2069");
  });

  it("redacts identifiers for empty generic text-entry fields", () => {
    const identifier = "customer-account-5841";
    const tree = {
      type: "XCUIElementTypeApplication",
      children: [{
        type: "XCUIElementTypeTextField",
        label: "Email address",
        identifier,
        rect: { x: 10, y: 20, width: 200, height: 40 },
      }],
    };
    const [field] = iosTreeToUiElements(tree);
    const formatted = formatIOSUITree(tree);

    expect(field.resourceId).toBe("[REDACTED]");
    expect(formatted).not.toContain(identifier);
    expect(formatted).toContain('label="Email address"');
  });
});

// ---------------------------------------------------------------------------
// Root #2: degraded WDA session must THROW, not silently produce [].
// This is what lets the hints catch-branch report a real error and, crucially,
// stops the empty result from poisoning the element cache.
// ---------------------------------------------------------------------------

describe("unwrapWdaTree — trust boundary validation", () => {
  it("throws WdaTreeError when the session returns value:null", () => {
    expect(() => unwrapWdaTree(degradedEnvelope())).toThrow(WdaTreeError);
  });

  it("throws when the response is not a tree at all", () => {
    expect(() => unwrapWdaTree(null)).toThrow(WdaTreeError);
    expect(() => unwrapWdaTree("oops")).toThrow(WdaTreeError);
    expect(() => unwrapWdaTree(42)).toThrow(WdaTreeError);
  });

  it("iosTreeToUiElements propagates WdaTreeError for a degraded session", () => {
    // Must NOT swallow into []: the hints layer distinguishes "empty UI" from
    // "broken WDA" by whether this throws.
    expect(() => iosTreeToUiElements(degradedEnvelope())).toThrow(WdaTreeError);
  });
});

// ---------------------------------------------------------------------------
// Root #5: password leak through the HINTS path (diff + suggestions).
// The value is redacted in ui_tree formatters but the hints path prints
// el.text directly — these guards ensure the SecureTextField value never
// appears in "New:"/"Gone:"/"Suggested:" output.
// ---------------------------------------------------------------------------

describe("hints path never leaks a SecureTextField value", () => {
  const password = "hunter2";

  it("diffUiElements does not print the secure field value in appeared/disappeared", () => {
    const before: UiElement[] = [];
    const after = iosTreeToUiElements(wdaEnvelope());

    const diff = diffUiElements(before, after);
    const printed = [...diff.appeared, ...diff.disappeared].join(" ");

    expect(printed).not.toContain(password);
    expect(printed).toContain("[REDACTED]");
  });

  it("suggestNextActions does not print the secure field value for a focused password field", () => {
    const secure = iosTreeToUiElements(wdaEnvelope()).find(e => e.password)!;
    // Simulate the field being focused (the input-suggestion branch).
    const focused: UiElement = { ...secure, focused: true, className: "XCUIElementTypeSecureTextField" };

    const suggestions = suggestNextActions([focused]).join(" ");
    expect(suggestions).not.toContain(password);
  });

  it("suggestNextActions does not print the value when a secure field is clickable", () => {
    const secure = iosTreeToUiElements(wdaEnvelope()).find(e => e.password)!;
    const clickable: UiElement = { ...secure, clickable: true, enabled: true };

    const suggestions = suggestNextActions([clickable]).join(" ");
    expect(suggestions).not.toContain(password);
  });
});
