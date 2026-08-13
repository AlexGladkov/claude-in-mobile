/**
 * conversation-tree -- serialize a Telegram dialog into a uiautomator-XML
 * string that the core UI pipeline (`parseUiHierarchy` in
 * src/ui-tree/ui-parser/node-parser.ts) consumes unchanged, plus the inverse
 * decode that turns a tap coordinate back into the button that was pressed.
 *
 * This module is the load-bearing bridge for the two design holes the
 * consilium flagged:
 *
 *   HOLE #2 -- `getUiHierarchy()` is typed to return an XML *string*, never a
 *   `UiElement[]`. The core re-parses that string with a regex. So a dialog
 *   must be emitted as an XML dialect that the regex accepts byte-for-byte
 *   (attributes `bounds` / `resource-id` / `text` / `clickable` / `class`,
 *   single-line nodes, no `>` or `"` inside attribute values).
 *
 *   HOLE #1 -- a ref never reaches the adapter: the core collapses every
 *   interaction into `adapter.tap(x, y)`. So each tappable button is encoded
 *   into a *deterministic* synthetic `bounds` keyed by its global button
 *   index `i`, and the adapter recovers `i` from `y` alone.
 *
 * ENCODE/DECODE INVARIANT (do not change without migrating both sides):
 *
 *   Tappable button with global index `i` (0-based) ->
 *       bounds = [0, i*STRIDE] [BTN_W, i*STRIDE + BTN_H]
 *   => centerY = floor((i*STRIDE + i*STRIDE + BTN_H) / 2) = i*STRIDE + BTN_H/2
 *   => floor(centerY / STRIDE) = i                          (BTN_H < STRIDE)
 *
 *   With STRIDE=100, BTN_H=80: centerY = i*100 + 40, floor(centerY/100) = i.
 *   The map i -> centerY -> i is therefore total and bijective for i >= 0.
 *
 * Messages live in a disjoint high y-band (MSG_BASE) and are never tappable,
 * so a tap that lands on a message slot decodes to an out-of-range index and
 * is rejected -- there is no way to "tap" a message.
 */

import { sanitizeErrorMessage } from "mcp-devices/utils/sanitize";

// ── Encode geometry (the invariant above depends on these exact values) ──

/** Vertical pixels allotted to one button row. Must exceed BTN_H. */
export const STRIDE = 100;
/** Synthetic button width. Arbitrary but stable. */
export const BTN_W = 1000;
/** Synthetic button height. Must be < STRIDE so centerY stays in slot `i`. */
export const BTN_H = 80;
/**
 * y-offset where the message band starts. Chosen far above any realistic
 * button count so `floor(y/STRIDE)` for a message can never collide with a
 * valid button index.
 */
export const MSG_BASE = 100_000;
/** Height of a message row in the (non-tappable) message band. */
export const MSG_H = 80;

export type ButtonKind = "callback" | "reply" | "url";

// ── Raw input (platform-neutral; GramJS extraction happens in gram-client) ──

/** One button as pulled off a Telegram message's reply markup. */
export interface RawButton {
  readonly text: string;
  readonly kind: ButtonKind;
  /** Callback payload (callback buttons only). */
  readonly data?: Buffer;
  /** Target URL (url buttons only) -- informational, not tappable in v1. */
  readonly url?: string;
}

/** One Telegram message, normalised away from the GramJS Api.Message shape. */
export interface RawMessage {
  /** Telegram message id (needed to answer callbacks). */
  readonly id: number;
  /** true => sent by the bot under test; false => sent by our userbot. */
  readonly fromBot: boolean;
  readonly text: string;
  /** Inline / reply keyboard rows, top-to-bottom. */
  readonly buttonRows: ReadonlyArray<ReadonlyArray<RawButton>>;
}

// ── Snapshot (what the adapter caches between getUiHierarchy and tap) ──

export interface SnapshotMessage {
  /** Stable ref, e.g. "m1" (1-based, chronological). */
  readonly ref: string;
  readonly fromBot: boolean;
  readonly text: string;
}

export interface SnapshotButton {
  /** Stable ref, e.g. "b1" (1-based). */
  readonly ref: string;
  /** Global 0-based button index -- the value `y` encodes/decodes to. */
  readonly index: number;
  readonly text: string;
  readonly kind: ButtonKind;
  /** Telegram message id this button belongs to (for callbacks). */
  readonly msgId: number;
  readonly data?: Buffer;
}

export interface ConversationSnapshot {
  /** Bot under test, e.g. "@my_bot". */
  readonly peer: string;
  readonly messages: ReadonlyArray<SnapshotMessage>;
  readonly buttons: ReadonlyArray<SnapshotButton>;
  /** url/webapp buttons surfaced as read-only labels (skipped for tapping). */
  readonly inertLabels: ReadonlyArray<string>;
}

// ── Encode helpers ──

export interface SyntheticBounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Bounds for tappable button with global index `i` (the HOLE #1 encode). */
export function encodeButtonBounds(i: number): SyntheticBounds {
  return { x1: 0, y1: i * STRIDE, x2: BTN_W, y2: i * STRIDE + BTN_H };
}

/** centerY the core will compute (via `Math.floor`) for button index `i`. */
export function buttonCenterY(i: number): number {
  const b = encodeButtonBounds(i);
  return Math.floor((b.y1 + b.y2) / 2);
}

/** Bounds for the j-th message row in the disjoint, non-tappable band. */
export function encodeMessageBounds(j: number): SyntheticBounds {
  const y1 = MSG_BASE + j * STRIDE;
  return { x1: 0, y1, x2: BTN_W, y2: y1 + MSG_H };
}

// ── Snapshot construction ──

/**
 * Flatten raw messages (oldest -> newest) into a snapshot, assigning refs and
 * global button indices. url/webapp buttons are recorded as inert labels and
 * are NOT tappable (no browser in this target).
 */
export function buildSnapshot(
  peer: string,
  messages: ReadonlyArray<RawMessage>,
): ConversationSnapshot {
  const snapMessages: SnapshotMessage[] = [];
  const buttons: SnapshotButton[] = [];
  const inertLabels: string[] = [];

  let buttonIndex = 0;
  messages.forEach((m, mi) => {
    snapMessages.push({
      ref: `m${mi + 1}`,
      fromBot: m.fromBot,
      text: m.text,
    });
    for (const row of m.buttonRows) {
      for (const btn of row) {
        if (btn.kind === "url") {
          inertLabels.push(btn.text);
          continue;
        }
        buttons.push({
          ref: `b${buttonIndex + 1}`,
          index: buttonIndex,
          text: btn.text,
          kind: btn.kind,
          msgId: m.id,
          data: btn.data,
        });
        buttonIndex += 1;
      }
    }
  });

  return { peer, messages: snapMessages, buttons, inertLabels };
}

// ── XML serialisation (the HOLE #2 dialect) ──

/**
 * Escape a value for inclusion in a uiautomator-XML attribute.
 *
 * The core regex is `/<node[^>]+>/` followed by `attr="([^"]*)"`, so the two
 * fatal characters are `>` (closes the node early) and `"` (closes the
 * attribute early). Newlines would also break the single-line node match.
 * We additionally escape `<` and `&` for well-formedness.
 */
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/[\r\n\t]+/g, " ");
}

/**
 * Bot-authored text may echo a secret the bot received. Run every
 * bot/button string through `sanitizeErrorMessage` (T3) BEFORE it lands in an
 * XML `text=` attribute. Our own (out) messages are echoes of what we sent, so
 * they get the same treatment for uniformity.
 */
function safeText(value: string): string {
  return escapeXmlAttr(sanitizeErrorMessage(value));
}

function node(attrs: Record<string, string | boolean | number>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(attrs)) {
    const rendered = typeof v === "string" ? v : String(v);
    parts.push(`${k}="${rendered}"`);
  }
  return `  <node ${parts.join(" ")} />`;
}

function boundsAttr(b: SyntheticBounds): string {
  return `[${b.x1},${b.y1}][${b.x2},${b.y2}]`;
}

/**
 * Serialise a snapshot to the uiautomator-XML string `parseUiHierarchy`
 * expects. Buttons occupy the low y-band (indexed by their global index);
 * messages and inert labels occupy the high band and are non-clickable.
 */
export function serializeSnapshotToXml(snapshot: ConversationSnapshot): string {
  const lines: string[] = [];
  lines.push(`<?xml version='1.0' encoding='UTF-8'?>`);
  lines.push(`<hierarchy rotation="0">`);

  // Tappable buttons first (low band, index-encoded bounds).
  for (const b of snapshot.buttons) {
    lines.push(
      node({
        index: b.index,
        text: safeText(b.text),
        "resource-id": b.ref,
        class: "android.widget.Button",
        package: "org.telegram.bot",
        "content-desc": b.kind,
        checkable: false,
        checked: false,
        clickable: true,
        enabled: true,
        focusable: true,
        focused: false,
        scrollable: false,
        "long-clickable": false,
        password: false,
        selected: false,
        bounds: boundsAttr(encodeButtonBounds(b.index)),
      }),
    );
  }

  // Messages (high band, non-clickable).
  snapshot.messages.forEach((m, j) => {
    lines.push(
      node({
        index: j,
        text: safeText(m.text),
        "resource-id": m.ref,
        class: "android.widget.TextView",
        package: "org.telegram.bot",
        "content-desc": m.fromBot ? "bot" : "me",
        checkable: false,
        checked: false,
        clickable: false,
        enabled: true,
        focusable: false,
        focused: false,
        scrollable: false,
        "long-clickable": false,
        password: false,
        selected: false,
        bounds: boundsAttr(encodeMessageBounds(j)),
      }),
    );
  });

  // Inert (url/webapp) labels -- visible but not tappable.
  snapshot.inertLabels.forEach((label, k) => {
    lines.push(
      node({
        index: snapshot.messages.length + k,
        text: safeText(label),
        "resource-id": `url${k + 1}`,
        class: "android.widget.TextView",
        package: "org.telegram.bot",
        "content-desc": "url",
        checkable: false,
        checked: false,
        clickable: false,
        enabled: false,
        focusable: false,
        focused: false,
        scrollable: false,
        "long-clickable": false,
        password: false,
        selected: false,
        bounds: boundsAttr(
          encodeMessageBounds(snapshot.messages.length + k),
        ),
      }),
    );
  });

  lines.push(`</hierarchy>`);
  return lines.join("\n");
}

// ── Decode (the inverse of HOLE #1, used by the adapter's tap) ──

export class NoButtonAtCoordinateError extends Error {
  constructor(public readonly y: number, public readonly buttonCount: number) {
    super(
      `No tappable Telegram button at y=${y} ` +
        `(decoded index ${Math.floor(y / STRIDE)}, snapshot has ${buttonCount} button(s)). ` +
        `Re-read ui_tree -- the bot may have edited the message.`,
    );
    this.name = "NoButtonAtCoordinateError";
  }
}

/** Recover the global button index a `y` coordinate encodes. */
export function decodeButtonIndex(y: number): number {
  return Math.floor(y / STRIDE);
}

/**
 * Resolve a tap `y` back to the button it targets within `snapshot`
 * (the adapter's `tap(x, y)` decode). `x` is ignored: the encode never uses
 * it, so honouring it would only invent a failure mode.
 */
export function decodeTap(
  snapshot: ConversationSnapshot,
  y: number,
): SnapshotButton {
  const index = decodeButtonIndex(y);
  const button = snapshot.buttons.find((b) => b.index === index);
  if (!button) {
    throw new NoButtonAtCoordinateError(y, snapshot.buttons.length);
  }
  return button;
}
