import type { CDPClientInterface } from "./cdp-types.js";

/**
 * Pure CDP helpers — no session state, no retries. Lifted out of BrowserClient
 * so the class can stay focused on lifecycle/orchestration. Behaviour is
 * byte-identical to the previous private methods.
 */

export async function getCoordinates(
  cdp: CDPClientInterface,
  nodeId: number
): Promise<{ x: number; y: number }> {
  const { model } = await cdp.DOM.getBoxModel({ nodeId });
  if (!model) throw new Error("Could not get element bounding box");
  const [x1, y1, x2, , , , , y4] = model.content;
  return {
    x: Math.round((x1 + x2) / 2),
    y: Math.round((y1 + y4) / 2),
  };
}

export async function findNodeBySelector(
  cdp: CDPClientInterface,
  selector: string
): Promise<number | null> {
  try {
    const { root } = await cdp.DOM.getDocument({ depth: 0 });
    const { nodeId } = await cdp.DOM.querySelector({ nodeId: root.nodeId, selector });
    return nodeId !== 0 ? nodeId : null;
  } catch {
    return null;
  }
}

export async function findNodeByText(
  cdp: CDPClientInterface,
  text: string
): Promise<{ x: number; y: number } | null> {
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

export async function buildSelector(
  cdp: CDPClientInterface,
  nodeId: number
): Promise<string> {
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
