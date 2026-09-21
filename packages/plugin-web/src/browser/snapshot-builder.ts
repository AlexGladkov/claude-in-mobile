import { z } from "zod";

import type { BrowserSession } from "./types.js";
import type { CDPClientInterface, CDPAccessibilityNode } from "./cdp-types.js";
import { buildSelector } from "./cdp-helpers.js";
const MAX_AX_NODES = 5000;
const MAX_INTERACTIVE_REFS = 200;
const MAX_SNAPSHOT_LINES = 1000;
const MAX_SNAPSHOT_CHARS = 1024 * 1024;
const cdpValueSchema = z.object({
  type: z.enum(["string", "computedString"]),
  value: z.string().max(64 * 1024),
}).passthrough();
const runtimeStringResultSchema = z.object({
  result: z.object({
    value: z.string().max(8192).regex(/^[^\u0000-\u001f\u007f]*$/),
  }).passthrough(),
}).passthrough();


/**
 * Accessibility-tree → text snapshot transformer. Pulled out of BrowserClient
 * so the class focuses on CDP session lifecycle; this module owns the
 * AX→UI projection rules.
 */

const INTERACTIVE_ROLES: Readonly<Record<string, true>> = {
  button: true,
  link: true,
  textbox: true,
  combobox: true,
  listbox: true,
  menuitem: true,
  menuitemcheckbox: true,
  menuitemradio: true,
  radio: true,
  checkbox: true,
  switch: true,
  slider: true,
  spinbutton: true,
  tab: true,
  treeitem: true,
  option: true,
  searchbox: true,
  scrollbar: true,
  columnheader: true,
  rowheader: true,
};

function formatValue(value: unknown): string | undefined {
  const parsed = cdpValueSchema.safeParse(value);
  return parsed.success ? parsed.data.value : undefined;
}

export async function buildSnapshot(
  session: BrowserSession,
  cdp: CDPClientInterface
): Promise<string> {
  let axNodes: CDPAccessibilityNode[];
  try {
    const result = await cdp.Accessibility.getFullAXTree();
    axNodes = result.nodes ?? [];
  } catch {
    return "(Failed to get accessibility tree)";
  }

  session.refMap.clear();
  session.lastRefCounter = 0;

  const snapshotLines: string[] = [];
  let snapshotChars = 0;

  const nodeLimit = Math.min(axNodes.length, MAX_AX_NODES);
  for (let nodeIndex = 0; nodeIndex < nodeLimit; nodeIndex++) {
    const node = axNodes[nodeIndex];
    if (node.ignored) continue;
    const role = formatValue(node.role) ?? "";
    if (!role || role === "none" || role === "generic" || role === "InlineTextBox") continue;

    const name = formatValue(node.name) ?? "";

    let ref = "";
    if (
      Object.hasOwn(INTERACTIVE_ROLES, role)
      && name
      && session.lastRefCounter < MAX_INTERACTIVE_REFS
    ) {
      const refId = `e${++session.lastRefCounter}`;
      ref = ` [${refId}]`;

      let selector = "";
      if (node.backendDOMNodeId) {
        try {
          const { nodeIds } = await cdp.DOM.pushNodesByBackendIdsToFrontend({
            backendNodeIds: [node.backendDOMNodeId],
          });
          if (nodeIds?.[0]) selector = await buildSelector(cdp, nodeIds[0]);
        } catch {}
      }

      session.refMap.set(refId, {
        selector,
        backendNodeId: node.backendDOMNodeId ?? 0,
        label: `${role} "${name}"`,
        textFingerprint: name.toLowerCase(),
      });
    }

    const value = formatValue(node.value);
    const valueStr = value ? ` value="${value}"` : "";
    const disabled = node.properties?.slice(0, 1000)
      .find((property) => property.name === "disabled")?.value?.value
      ? " [disabled]"
      : "";
    const line = `${role} "${name}"${ref}${valueStr}${disabled}`;
    if (
      snapshotLines.length >= MAX_SNAPSHOT_LINES
      || snapshotChars + line.length > MAX_SNAPSHOT_CHARS
    ) {
      snapshotLines.push("[snapshot truncated]");
      break;
    }
    snapshotLines.push(line);
    snapshotChars += line.length + 1;
  }

  let title = "";
  try {
    const parsed = runtimeStringResultSchema.safeParse(
      await cdp.Runtime.evaluate({ expression: "document.title", returnByValue: true }),
    );
    if (parsed.success) title = parsed.data.result.value;
  } catch {}

  try {
    const parsed = runtimeStringResultSchema.safeParse(
      await cdp.Runtime.evaluate({ expression: "location.href", returnByValue: true }),
    );
    if (parsed.success) session.url = parsed.data.result.value;
  } catch {}

  const header = `[${title || "Untitled"}] ${session.url}\n\n`;
  const body = snapshotLines.join("\n") || "(no interactive elements found)";
  const hint = `\n\n--- ${session.refMap.size} interactive elements, refs e1..e${session.lastRefCounter} ---`;

  return header + body + hint;
}
