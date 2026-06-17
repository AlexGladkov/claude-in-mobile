import type { UiElement } from "../types.js";

/** Semantic UI tree format — grouped by role, minimal tokens (~3x reduction vs default) */
export function formatUiTreeSemantic(elements: UiElement[]): string {
  const nav: string[] = [];
  const actions: string[] = [];
  const inputs: string[] = [];
  const content: string[] = [];

  for (const el of elements) {
    if (el.width <= 0 || el.height <= 0) continue;
    const label = el.text || el.contentDesc || "";
    const isInput = el.className.includes("EditText") || el.className.includes("TextField") || el.className.includes("TextInput");
    const isNav = (el.contentDesc || "").toLowerCase().match(/back|navigate|menu|overflow|drawer/);

    if (isInput) {
      inputs.push(`[${el.index}] "${label || "input"}" (${el.centerX},${el.centerY})${el.focused ? " [focused]" : ""}`);
    } else if (isNav && el.clickable) {
      nav.push(`[${el.index}] "${label || "nav"}" (${el.centerX},${el.centerY})`);
    } else if (el.clickable && el.enabled) {
      actions.push(`[${el.index}] "${label || "btn"}" (${el.centerX},${el.centerY})`);
    } else if (label && !el.clickable) {
      content.push(`"${label.slice(0, 50)}"`);
    }
  }

  const sections: string[] = [];
  if (nav.length) sections.push(`Nav: ${nav.join(" | ")}`);
  if (inputs.length) sections.push(`Inputs: ${inputs.join(" | ")}`);
  if (actions.length) sections.push(`Actions: ${actions.join(" | ")}`);
  if (content.length) sections.push(`Text: ${content.slice(0, 5).join(", ")}${content.length > 5 ? ` (+${content.length - 5})` : ""}`);

  return sections.join("\n") || "Empty screen";
}
