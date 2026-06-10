import type { CDPClientInterface } from "./cdp-types.js";

/**
 * Keyboard payload builder for CDP Input.dispatchKeyEvent. Map ripped out of
 * BrowserClient.pressKey so it can be unit-tested and shared without dragging
 * the whole client in.
 */

export interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

export const KEY_MAP: Record<string, KeyDef> = {
  Enter:      { key: "Enter",      code: "Enter",     keyCode: 13, text: "\r" },
  Tab:        { key: "Tab",        code: "Tab",       keyCode: 9 },
  Escape:     { key: "Escape",     code: "Escape",    keyCode: 27 },
  Backspace:  { key: "Backspace",  code: "Backspace", keyCode: 8 },
  Delete:     { key: "Delete",     code: "Delete",    keyCode: 46 },
  ArrowUp:    { key: "ArrowUp",    code: "ArrowUp",   keyCode: 38 },
  ArrowDown:  { key: "ArrowDown",  code: "ArrowDown", keyCode: 40 },
  ArrowLeft:  { key: "ArrowLeft",  code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight",keyCode: 39 },
  Home:       { key: "Home",       code: "Home",      keyCode: 36 },
  End:        { key: "End",        code: "End",       keyCode: 35 },
  PageUp:     { key: "PageUp",     code: "PageUp",    keyCode: 33 },
  PageDown:   { key: "PageDown",   code: "PageDown",  keyCode: 34 },
  Space:      { key: " ",          code: "Space",     keyCode: 32, text: " " },
};

export async function pressKeyOnCdp(cdp: CDPClientInterface, key: string): Promise<void> {
  const def = KEY_MAP[key];
  if (!def) throw new Error(`Unknown key: "${key}". Supported: ${Object.keys(KEY_MAP).join(", ")}`);

  await cdp.Input.dispatchKeyEvent({ type: "keyDown", key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, text: def.text });
  await cdp.Input.dispatchKeyEvent({ type: "keyUp", key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode });
}

export function formatEvaluateResult(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "object") {
    const json = JSON.stringify(value, null, 2);
    return json.length > 10000 ? json.slice(0, 10000) + "\n... (truncated)" : json;
  }
  return String(value);
}
