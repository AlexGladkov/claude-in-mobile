import type { BrowserSession } from "./types.js";
import type { CDPClientInterface, CDPAccessibilityNode } from "./cdp-types.js";
import { buildSelector } from "./cdp-helpers.js";

/**
 * Accessibility-tree → text snapshot transformer. Pulled out of BrowserClient
 * so the class focuses on CDP session lifecycle; this module owns the
 * AX→UI projection rules.
 */

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "combobox", "listbox", "menuitem",
  "menuitemcheckbox", "menuitemradio", "radio", "checkbox", "switch",
  "slider", "spinbutton", "tab", "treeitem", "option",
  "searchbox", "scrollbar", "columnheader", "rowheader",
]);

const formatValue = (v: { type: string; value?: string } | undefined): string | undefined =>
  (v?.type === "string" || v?.type === "computedString") ? v.value : undefined;

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
            selector = await buildSelector(cdp, nodeIds[0]);
          }
        } catch {}
      }

      session.refMap.set(refId, {
        selector,
        backendNodeId: node.backendDOMNodeId ?? 0,
        label: `${role} "${name}"`,
        textFingerprint: name?.toLowerCase() || undefined,
      });
    }

    const value = formatValue(node.value);
    const valueStr = value ? ` value="${value}"` : "";
    const disabled = node.properties?.find(p => p.name === "disabled")?.value?.value ? " [disabled]" : "";

    snapshotLines.push(`${role} "${name}"${ref}${valueStr}${disabled}`);
  }

  let title = "";
  try {
    const { result } = await cdp.Runtime.evaluate({ expression: "document.title", returnByValue: true });
    title = (result.value as string) ?? "";
  } catch {}

  try {
    const { result } = await cdp.Runtime.evaluate({ expression: "location.href", returnByValue: true });
    if (result.value) session.url = result.value as string;
  } catch {}

  const header = `[${title || "Untitled"}] ${session.url}\n\n`;
  const body = snapshotLines.join("\n") || "(no interactive elements found)";
  const hint = `\n\n--- ${session.refMap.size} interactive elements, refs e1..e${session.lastRefCounter} ---`;

  return header + body + hint;
}
