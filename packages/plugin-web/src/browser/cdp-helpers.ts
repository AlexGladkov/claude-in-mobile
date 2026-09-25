import { z } from "zod";
import type { CDPClientInterface } from "./cdp-types.js";

const cdpNodeIdSchema = z.number().int().nonnegative();
const boxModelResultSchema = z.object({
  model: z.object({
    content: z.array(z.number().finite()).length(8),
  }).passthrough(),
}).passthrough();
const documentResultSchema = z.object({
  root: z.object({ nodeId: cdpNodeIdSchema }).passthrough(),
}).passthrough();
const querySelectorResultSchema = z.object({
  nodeId: cdpNodeIdSchema,
}).passthrough();
const textCoordinatesResultSchema = z.object({
  result: z.object({
    value: z.object({
      x: z.number().finite(),
      y: z.number().finite(),
    }).strict().nullable(),
  }).passthrough(),
}).passthrough();
const resolvedNodeResultSchema = z.object({
  object: z.object({
    objectId: z.string().min(1).max(1024),
  }).passthrough(),
}).passthrough();
const selectorResultSchema = z.object({
  result: z.object({
    value: z.string().max(16 * 1024),
  }).passthrough(),
}).passthrough();

/**
 * Pure CDP helpers — no session state, no retries. Lifted out of BrowserClient
 * so the class can stay focused on lifecycle/orchestration. Behaviour is
 * byte-identical to the previous private methods.
 */

export async function getCoordinates(
  cdp: CDPClientInterface,
  nodeId: number
): Promise<{ x: number; y: number }> {
  const { model } = boxModelResultSchema.parse(
    await cdp.DOM.getBoxModel({ nodeId }),
  );
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
    const { root } = documentResultSchema.parse(
      await cdp.DOM.getDocument({ depth: 0 }),
    );
    const { nodeId } = querySelectorResultSchema.parse(
      await cdp.DOM.querySelector({ nodeId: root.nodeId, selector }),
    );
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
    const parsed = textCoordinatesResultSchema.parse(await cdp.Runtime.evaluate({
      expression: `(function() {
        const all = document.querySelectorAll('a, button, [role="button"], [role="link"], input[type="submit"], input[type="button"]');
        const t = ${JSON.stringify(text.toLowerCase())};
        for (const el of all) {
          if (el.textContent?.toLowerCase().includes(t) || el.value?.toLowerCase()?.includes(t)) {
            return {x: el.getBoundingClientRect().left + el.offsetWidth/2, y: el.getBoundingClientRect().top + el.offsetHeight/2};
          }
        }
        return null;
      })()`,
      returnByValue: true,
    }));
    return parsed.result.value;
  } catch {}
  return null;
}

export async function buildSelector(
  cdp: CDPClientInterface,
  nodeId: number
): Promise<string> {
  try {
    const { object } = resolvedNodeResultSchema.parse(
      await cdp.DOM.resolveNode({ nodeId }),
    );
    const parsed = selectorResultSchema.parse(await cdp.Runtime.callFunctionOn({
      objectId: object.objectId,
      functionDeclaration: `function() {
        if (this.id) return '#' + CSS.escape(this.id);
        for (const attr of ['data-testid', 'data-test', 'data-cy']) {
          const value = this.getAttribute(attr);
          if (value) return '[' + attr + '=' + CSS.escape(value) + ']';
        }
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
    }));
    return parsed.result.value;
  } catch {
    return "";
  }
}
