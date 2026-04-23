import type { ToolDefinition } from "../registry.js";
import { browserTools } from "../browser-tools.js";
import { UnknownActionError } from "../../errors.js";

const handlers = new Map<string, ToolDefinition["handler"]>();
for (const t of browserTools) {
  handlers.set(t.tool.name.replace(/^browser_/, ""), t.handler);
}

// browser_navigate has its own "action" param (back/forward/reload).
// To avoid collision with meta "action", we accept "nav" in the meta schema
// and remap it to "action" before delegating to the original handler.
const originalNavigateHandler = handlers.get("navigate")!;
handlers.set("navigate", async (args, ctx, depth) => {
  const remapped = { ...args };
  if (remapped.nav !== undefined) {
    remapped.action = remapped.nav;
    delete remapped.nav;
  }
  return originalNavigateHandler(remapped, ctx, depth);
});

export const browserMeta: ToolDefinition = {
  tool: {
    name: "browser",
    description:
      "Browser automation. open/close/list_sessions: session management. navigate/click/fill/fill_form/press_key: interaction. snapshot/screenshot: capture. evaluate: run JS. wait_for_selector: wait for element.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "open", "close", "list_sessions", "navigate", "click", "fill", "fill_form",
            "press_key", "snapshot", "screenshot", "evaluate", "wait_for_selector", "clear_session",
          ],
        },
        url: { type: "string", description: "URL to open or navigate to" },
        session: { type: "string", description: "Session name (default: 'default')" },
        headless: { type: "boolean", description: "Run browser in headless mode (open only)", default: false },
        ref: { type: "string", description: "Element ref from snapshot (e.g. 'e1')" },
        selector: { type: "string", description: "CSS selector" },
        text: { type: "string", description: "Visible text content of element to click" },
        value: { type: "string", description: "Value to enter (fill)" },
        key: { type: "string", description: "Key name (press_key, e.g. Enter, Tab, Escape)" },
        expression: { type: "string", description: "JavaScript expression (evaluate)" },
        fields: {
          type: "array",
          description: "Array of fields to fill (fill_form)",
          items: {
            type: "object",
            properties: {
              ref: { type: "string" },
              selector: { type: "string" },
              value: { type: "string" },
            },
            required: ["value"],
          },
        },
        submit: { type: "boolean", description: "Press Enter to submit after fill_form", default: false },
        clear: { type: "boolean", description: "Clear field before typing (fill)", default: true },
        pressEnter: { type: "boolean", description: "Press Enter after filling (fill)", default: false },
        fullPage: { type: "boolean", description: "Capture full page screenshot", default: false },
        timeout: { type: "number", description: "Max wait time in ms (wait_for_selector)" },
        state: {
          type: "string",
          enum: ["attached", "visible"],
          description: "Wait state (wait_for_selector, default: 'visible')",
        },
        nav: {
          type: "string",
          enum: ["back", "forward", "reload"],
          description: "Navigation action (navigate only). Mapped from browser_navigate's 'action' param.",
        },
      },
      required: ["action"],
    },
  },
  handler: async (args, ctx, depth) => {
    const action = args.action as string;
    const handler = handlers.get(action);
    if (!handler) throw new UnknownActionError("browser", action, ["open", "close", "list_sessions", "navigate", "click", "fill", "fill_form", "press_key", "snapshot", "screenshot", "evaluate", "wait_for_selector", "clear_session"]);
    return handler(args, ctx, depth);
  },
};

export const browserAliases: Record<string, { tool: string; defaults: Record<string, unknown> }> = {
  browser_open: { tool: "browser", defaults: { action: "open" } },
  browser_close: { tool: "browser", defaults: { action: "close" } },
  browser_list_sessions: { tool: "browser", defaults: { action: "list_sessions" } },
  browser_navigate: { tool: "browser", defaults: { action: "navigate" } },
  browser_click: { tool: "browser", defaults: { action: "click" } },
  browser_fill: { tool: "browser", defaults: { action: "fill" } },
  browser_fill_form: { tool: "browser", defaults: { action: "fill_form" } },
  browser_press_key: { tool: "browser", defaults: { action: "press_key" } },
  browser_snapshot: { tool: "browser", defaults: { action: "snapshot" } },
  browser_screenshot: { tool: "browser", defaults: { action: "screenshot" } },
  browser_evaluate: { tool: "browser", defaults: { action: "evaluate" } },
  browser_wait_for_selector: { tool: "browser", defaults: { action: "wait_for_selector" } },
  browser_clear_session: { tool: "browser", defaults: { action: "clear_session" } },
};
