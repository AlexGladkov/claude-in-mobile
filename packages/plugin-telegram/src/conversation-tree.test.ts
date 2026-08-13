import { describe, expect, it } from "vitest";
import { parseUiHierarchy } from "mcp-devices/ui-tree/ui-parser/node-parser";

import {
  STRIDE,
  buildSnapshot,
  buttonCenterY,
  decodeButtonIndex,
  decodeTap,
  encodeButtonBounds,
  serializeSnapshotToXml,
  NoButtonAtCoordinateError,
  type RawMessage,
} from "./conversation-tree.js";

/**
 * These tests pin the HOLE #1 (encode/decode) and HOLE #2 (XML dialect)
 * invariants: the dialog round-trips through the SAME regex parser the core
 * uses (`parseUiHierarchy`), and a tap `y` decodes back to the exact button.
 */

function dialogWithNButtons(n: number): RawMessage[] {
  return [
    {
      id: 1000,
      fromBot: true,
      text: "Choose an option:",
      buttonRows: Array.from({ length: n }, (_, i) => [
        {
          text: `Option ${i}`,
          kind: "callback" as const,
          data: Buffer.from(`opt:${i}`),
        },
      ]),
    },
  ];
}

describe("conversation-tree encode/decode invariant (HOLE #1)", () => {
  it("round-trips button index i -> bounds -> centerY -> i for i = 0..20", () => {
    const snapshot = buildSnapshot("@bot", dialogWithNButtons(21));
    const xml = serializeSnapshotToXml(snapshot);
    const elements = parseUiHierarchy(xml);

    for (let i = 0; i <= 20; i++) {
      const ref = `b${i + 1}`;
      const el = elements.find((e) => e.resourceId === ref);
      expect(el, `element ${ref} must parse`).toBeDefined();
      // centerY computed by the core regex parser must decode back to i.
      expect(el!.centerY).toBe(buttonCenterY(i));
      expect(decodeButtonIndex(el!.centerY)).toBe(i);
      // and decodeTap resolves the same button the core would have tapped.
      const button = decodeTap(snapshot, el!.centerY);
      expect(button.ref).toBe(ref);
      expect(button.index).toBe(i);
    }
  });

  it("encodeButtonBounds keeps centerY strictly inside slot i (BTN_H < STRIDE)", () => {
    for (let i = 0; i < 50; i++) {
      const b = encodeButtonBounds(i);
      const centerY = Math.floor((b.y1 + b.y2) / 2);
      expect(Math.floor(centerY / STRIDE)).toBe(i);
    }
  });

  it("rejects a tap that lands on a message slot (out of button range)", () => {
    const snapshot = buildSnapshot("@bot", dialogWithNButtons(2));
    // y in the high message band decodes to an index far past 2 buttons.
    expect(() => decodeTap(snapshot, 100_040)).toThrow(NoButtonAtCoordinateError);
  });
});

describe("conversation-tree XML dialect (HOLE #2)", () => {
  it("emits nodes the core regex parser accepts, with correct flags", () => {
    const messages: RawMessage[] = [
      {
        id: 1,
        fromBot: true,
        text: "Welcome",
        buttonRows: [
          [
            { text: "Yes", kind: "callback", data: Buffer.from("yes") },
            { text: "No", kind: "callback", data: Buffer.from("no") },
          ],
        ],
      },
      { id: 2, fromBot: false, text: "Yes", buttonRows: [] },
    ];
    const snapshot = buildSnapshot("@bot", messages);
    const elements = parseUiHierarchy(serializeSnapshotToXml(snapshot));

    const yes = elements.find((e) => e.resourceId === "b1");
    const no = elements.find((e) => e.resourceId === "b2");
    const msg = elements.find((e) => e.resourceId === "m1");

    expect(yes?.clickable).toBe(true);
    expect(yes?.text).toBe("Yes");
    expect(no?.clickable).toBe(true);
    expect(msg?.clickable).toBe(false);
    expect(msg?.text).toBe("Welcome");
  });

  it("escapes XML-fatal characters so the node still parses", () => {
    const messages: RawMessage[] = [
      {
        id: 1,
        fromBot: true,
        text: 'a "quote" & <tag> > end',
        buttonRows: [[{ text: 'b"<>&', kind: "reply" }]],
      },
    ];
    const snapshot = buildSnapshot("@bot", messages);
    const xml = serializeSnapshotToXml(snapshot);
    // No raw fatal chars inside attribute regions (besides the legit ones).
    const elements = parseUiHierarchy(xml);
    const msg = elements.find((e) => e.resourceId === "m1");
    const btn = elements.find((e) => e.resourceId === "b1");
    // The node must still be found (i.e. `>`/`"` did not break the match).
    expect(msg).toBeDefined();
    expect(btn).toBeDefined();
    // Entities are left encoded (the agent reads them, not a real XML DOM).
    expect(msg!.text).toContain("&quot;");
    expect(msg!.text).toContain("&lt;tag&gt;");
  });

  it("surfaces url buttons as inert (non-tappable) labels", () => {
    const messages: RawMessage[] = [
      {
        id: 1,
        fromBot: true,
        text: "Open",
        buttonRows: [
          [{ text: "Website", kind: "url", url: "https://example.com" }],
        ],
      },
    ];
    const snapshot = buildSnapshot("@bot", messages);
    expect(snapshot.buttons).toHaveLength(0);
    expect(snapshot.inertLabels).toContain("Website");
    const elements = parseUiHierarchy(serializeSnapshotToXml(snapshot));
    const url = elements.find((e) => e.resourceId === "url1");
    expect(url?.clickable).toBe(false);
  });
});
