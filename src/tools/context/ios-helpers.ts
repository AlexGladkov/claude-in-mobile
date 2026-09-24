/**
 * iOS-specific tree parsing: convert WDA accessibility tree to UiElement[].
 */

import type { UiElement } from "../../ui-tree/ui-parser.js";
import { z } from "zod";

/**
 * Structural shape of a WebDriverAgent accessibility node (`/wda/accessibleSource`).
 *
 * WDA returns a nested tree. Container nodes (the root `XCUIElementTypeApplication`,
 * windows, layout groups) frequently carry a `rect` with zero width/height — or no
 * `rect` at all — while still holding paintable descendants. Leaf/interactive nodes
 * carry a real rect. Every field is optional, and a present field may hold an
 * explicit `null`: WDA writes `null` for empty label/value/name instead of
 * dropping the key.
 */
export interface WdaNode {
  type?: string | null;
  label?: string | null;
  value?: string | null;
  name?: string | null;
  identifier?: string | null;
  enabled?: boolean | null;
  selected?: boolean | null;
  rect?: { x?: number; y?: number; width?: number; height?: number };
  children?: WdaNode[];
}

/**
 * WDA HTTP envelope. When the session is healthy the payload lives under `value`;
 * on session degradation WDA still answers 200 but with `value: null`. We must not
 * cast that envelope straight to a tree node — doing so silently yields `[]`.
 */

/**
 * Thrown when the WDA response cannot be interpreted as an accessibility tree.
 * Callers (e.g. the hints path) rely on this to distinguish a genuine "empty UI"
 * from a broken/degraded WDA session, instead of poisoning caches with `[]`.
 */
export class WdaTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WdaTreeError";
  }
}

const wdaRectSchema = z.object({
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  width: z.number().finite().optional(),
  height: z.number().finite().optional(),
}).passthrough();
const wdaNodeSchema = z.object({
  // `.nullish()`, not `.optional()`: WDA emits `"label": null` for a node
  // without a label rather than omitting the key, so `.optional()` rejects
  // every real node and the whole tree is reported as degraded.
  type: z.string().max(65_536).nullish(),
  label: z.string().max(65_536).nullish(),
  value: z.string().max(65_536).nullish(),
  name: z.string().max(65_536).nullish(),
  identifier: z.string().max(65_536).nullish(),
  enabled: z.boolean().nullish(),
  selected: z.boolean().nullish(),
  rect: wdaRectSchema.optional(),
  children: z.array(z.unknown()).max(50_000).optional(),
}).passthrough().refine(
  (node) => Object.hasOwn(node, "type")
    || Object.hasOwn(node, "rect")
    || Object.hasOwn(node, "children"),
  "WDA node has no recognizable fields",
);
const wdaEnvelopeSchema = z.object({
  value: z.unknown().optional(),
  status: z.number().finite().optional(),
  sessionId: z.string().max(1024).optional(),
}).passthrough();

function validateWdaTree(root: unknown): WdaNode {
  const stack: unknown[] = [root];
  let visited = 0;
  while (stack.length > 0) {
    if (++visited > 50_000) {
      throw new WdaTreeError("WDA accessibility tree exceeded the node limit.");
    }
    const result = wdaNodeSchema.safeParse(stack.pop());
    if (!result.success) {
      throw new WdaTreeError("WDA accessibility tree contains an invalid node.");
    }
    if (result.data.children) stack.push(...result.data.children);
  }
  return root as WdaNode;
}

/**
 * Runtime schema-guard on the WDA trust boundary.
 *
 * Accepts either a raw tree node or the `{value}` envelope and returns a real
 * tree node, or throws {@link WdaTreeError} when the response is a degraded
 * envelope / null / non-tree. This is the single place where an untrusted
 * external process (WDA on localhost:8100) is validated before being cast to
 * our internal shape — the previous `response.value || response` unwrap let a
 * `value:null` envelope leak through and parse to `[]` with no error.
 */
export function unwrapWdaTree(response: unknown): WdaNode {
  const nodeResult = wdaNodeSchema.safeParse(response);
  if (nodeResult.success) {
    return validateWdaTree(response);
  }

  const envelopeResult = wdaEnvelopeSchema.safeParse(response);
  if (envelopeResult.success && envelopeResult.data.value !== undefined) {
    const valueResult = wdaNodeSchema.safeParse(envelopeResult.data.value);
    if (valueResult.success) {
      return validateWdaTree(envelopeResult.data.value);
    }
    throw new WdaTreeError(
      "WDA returned an empty accessibility tree (value is null/absent). " +
        "The WebDriverAgent session may have been backgrounded or lost.",
    );
  }

  throw new WdaTreeError(
    `WDA response is not an accessibility tree (got ${response === null ? "null" : typeof response}).`,
  );
}

/**
 * Convert an iOS accessibility tree (from WDA) to UiElement[].
 *
 * Robust against two real-world WDA quirks that previously produced `[]`:
 *   1. The response envelope (`{value, status, sessionId}`) is unwrapped and
 *      validated via {@link unwrapWdaTree} — a degraded `value:null` throws
 *      instead of silently yielding an empty list.
 *   2. Container nodes with a zero-size or missing `rect` are NOT dropped: we
 *      still recurse into their children so paintable descendants survive.
 *      Only nodes that themselves have a real (w>0 && h>0) rect are emitted as
 *      elements, but a zero-rect ancestor no longer discards its subtree.
 */
export function iosTreeToUiElements(
  tree: unknown,
  elements: UiElement[] = [],
  index = { value: 0 },
): UiElement[] {
  const root = unwrapWdaTree(tree);
  const stack: WdaNode[] = [root];
  let visited = 0;

  while (stack.length > 0) {
    if (++visited > 50_000) {
      throw new WdaTreeError("WDA accessibility tree exceeded the node limit.");
    }
    const node = stack.pop();
    if (!node) continue;
    const rect = node.rect;
    if (rect) {
      const x = rect.x ?? 0;
      const y = rect.y ?? 0;
      const width = rect.width ?? 0;
      const height = rect.height ?? 0;
      if (width > 0 && height > 0) {
        elements.push({
          index: index.value++,
          resourceId: node.identifier ?? "",
          className: node.type ?? "",
          packageName: "",
          text: node.label ?? node.value ?? "",
          contentDesc: node.name ?? "",
          checkable: false,
          checked: false,
          clickable:
            node.enabled !== false
            && Boolean(node.type?.includes("Button") || node.type?.includes("Link") || node.type?.includes("Cell")),
          enabled: node.enabled !== false,
          focusable: node.enabled !== false,
          focused: false,
          scrollable: node.type?.includes("ScrollView") ?? false,
          longClickable: false,
          password: node.type?.includes("SecureTextField") ?? false,
          selected: node.selected ?? false,
          bounds: { x1: x, y1: y, x2: x + width, y2: y + height },
          centerX: Math.floor(x + width / 2),
          centerY: Math.floor(y + height / 2),
          width,
          height,
        });
      }
    }
    const children = node.children ?? [];
    for (let childIndex = children.length - 1; childIndex >= 0; childIndex--) {
      stack.push(children[childIndex]);
    }
  }
  return elements;
}

export function formatIOSUITree(tree: unknown, indent = 0): string {
  const root = unwrapWdaTree(tree);
  const lines: string[] = [];
  const stack: Array<{ node: WdaNode; depth: number }> = [{ node: root, depth: indent }];
  let visited = 0;
  const safeText = (value: string) =>
    value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1000);

  while (stack.length > 0) {
    if (++visited > 50_000) {
      throw new WdaTreeError("WDA accessibility tree exceeded the node limit.");
    }
    const entry = stack.pop();
    if (!entry) continue;
    const { node, depth } = entry;
    if (node.type) {
      const parts: string[] = [`<${safeText(node.type)}>`];
      if (node.label) parts.push(`label=${JSON.stringify(safeText(node.label))}`);
      if (node.value) parts.push(`value=${JSON.stringify(safeText(node.value))}`);
      if (node.name) parts.push(`name=${JSON.stringify(safeText(node.name))}`);
      if (node.identifier) parts.push(`id=${JSON.stringify(safeText(node.identifier))}`);
      if (node.enabled != null) parts.push(`enabled=${node.enabled}`);
      if (node.rect) parts.push(`@ (${node.rect.x ?? 0}, ${node.rect.y ?? 0})`);
      lines.push(`${"  ".repeat(Math.min(depth, 100))}${parts.join(" ")}`);
    }
    const children = node.children ?? [];
    for (let childIndex = children.length - 1; childIndex >= 0; childIndex--) {
      stack.push({ node: children[childIndex], depth: depth + 1 });
    }
  }
  return lines.join("\n");
}
