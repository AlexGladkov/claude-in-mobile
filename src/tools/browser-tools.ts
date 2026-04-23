import type { ToolDefinition } from "./registry.js";
import { compressScreenshot } from "../utils/image.js";
import { truncateOutput } from "../utils/truncate.js";
import { validateUrl } from "../utils/sanitize.js";
import { getString, requireString, getBoolean } from "./helpers/args-parser.js";
import { BrowserNoSessionError } from "../errors.js";

export const browserTools: ToolDefinition[] = [
  {
    tool: {
      name: "browser_open",
      description: "Open URL in browser session",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to open (http:// or https:// only)" },
          session: { type: "string", description: "Session name for persistent state. Default: 'default'" },
          headless: { type: "boolean", description: "Run browser in headless mode. Default: false", default: false },
        },
        required: ["url"],
      },
    },
    handler: async (args, ctx) => {
      const url = requireString(args, "url");
      validateUrl(url);
      const adapter = ctx.deviceManager.getBrowserAdapter();
      const text = await adapter.open({
        url,
        session: getString(args, "session"),
        headless: typeof args.headless === "boolean" ? args.headless : undefined,
      });
      return { text };
    },
  },
  {
    tool: {
      name: "browser_close",
      description: "Close browser session",
      inputSchema: {
        type: "object",
        properties: {
          session: { type: "string", description: "Session name. If omitted, closes all sessions." },
        },
      },
    },
    handler: async (args, ctx) => {
      const session = getString(args, "session");
      await ctx.deviceManager.getBrowserAdapter().closeSession(session);
      return { text: `Browser session "${session ?? "all"}" closed.` };
    },
  },
  {
    tool: {
      name: "browser_list_sessions",
      description: "List active browser sessions",
      inputSchema: { type: "object", properties: {} },
    },
    handler: async (_args, ctx) => {
      const sessions = ctx.deviceManager.getBrowserAdapter().listSessions();
      if (sessions.length === 0) return { text: "No active browser sessions. Use browser_open to start one." };
      return { text: `Active sessions:\n${sessions.map(s => `  - ${s}`).join("\n")}` };
    },
  },
  {
    tool: {
      name: "browser_navigate",
      description: "Navigate to URL or go back/forward/reload",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to navigate to" },
          action: { type: "string", enum: ["back", "forward", "reload"], description: "Navigation action" },
          session: { type: "string", description: "Session name. Default: 'default'" },
        },
      },
    },
    handler: async (args, ctx) => {
      const url = getString(args, "url");
      if (url) {
        validateUrl(url);
      }
      const text = await ctx.deviceManager.getBrowserAdapter().navigate({
        url,
        action: getString(args, "action") as "back" | "forward" | "reload" | undefined,
        session: getString(args, "session"),
      });
      return { text };
    },
  },
  {
    tool: {
      name: "browser_click",
      description: "Click element by ref, selector, or text",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Ref from browser(action:'snapshot') (e.g. 'e1'). Fastest and most reliable." },
          selector: { type: "string", description: "CSS selector" },
          text: { type: "string", description: "Visible text content of element to click" },
          session: { type: "string", description: "Session name. Default: 'default'" },
        },
      },
    },
    handler: async (args, ctx) => {
      const text = await ctx.deviceManager.getBrowserAdapter().clickElement({
        ref: getString(args, "ref"),
        selector: getString(args, "selector"),
        text: getString(args, "text"),
        session: getString(args, "session"),
      });
      return { text };
    },
  },
  {
    tool: {
      name: "browser_fill",
      description: "Fill input field with value",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Ref from browser(action:'snapshot') (e.g. 'e2')" },
          selector: { type: "string", description: "CSS selector of input field" },
          value: { type: "string", description: "Value to enter" },
          session: { type: "string", description: "Session name. Default: 'default'" },
          clear: { type: "boolean", description: "Clear field before typing. Default: true", default: true },
          pressEnter: { type: "boolean", description: "Press Enter after filling. Default: false", default: false },
        },
        required: ["value"],
      },
    },
    handler: async (args, ctx) => {
      const value = requireString(args, "value");
      await ctx.deviceManager.getBrowserAdapter().fillField({
        ref: getString(args, "ref"),
        selector: getString(args, "selector"),
        value,
        session: getString(args, "session"),
        clear: typeof args.clear === "boolean" ? args.clear : undefined,
        pressEnter: typeof args.pressEnter === "boolean" ? args.pressEnter : undefined,
      });
      return { text: `Filled field with value: "${value}"` };
    },
  },
  {
    tool: {
      name: "browser_fill_form",
      description: "Fill multiple form fields at once",
      inputSchema: {
        type: "object",
        properties: {
          fields: {
            type: "array",
            description: "Array of fields to fill",
            items: {
              type: "object",
              properties: {
                ref: { type: "string", description: "Ref from snapshot" },
                selector: { type: "string", description: "CSS selector" },
                value: { type: "string", description: "Value to enter" },
              },
              required: ["value"],
            },
          },
          submit: { type: "boolean", description: "Press Enter to submit after filling. Default: false" },
          session: { type: "string", description: "Session name. Default: 'default'" },
        },
        required: ["fields"],
      },
    },
    handler: async (args, ctx) => {
      const fields = args.fields as Array<{ ref?: string; selector?: string; value: string }>;
      const submit = typeof args.submit === "boolean" ? args.submit : undefined;
      await ctx.deviceManager.getBrowserAdapter().fillForm({
        fields,
        submit,
        session: getString(args, "session"),
      });
      return { text: `Filled ${fields.length} field(s)${submit ? " and submitted." : "."}` };
    },
  },
  {
    tool: {
      name: "browser_press_key",
      description: "Press keyboard key in browser",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key name (e.g. Enter, Tab, Escape, ArrowDown)" },
          session: { type: "string", description: "Session name. Default: 'default'" },
        },
        required: ["key"],
      },
    },
    handler: async (args, ctx) => {
      const adapter = ctx.deviceManager.getBrowserAdapter();
      const session = adapter.sessionManager.getSession(getString(args, "session"));
      if (!session) throw new BrowserNoSessionError();
      const key = requireString(args, "key");
      await adapter.client.pressKey(session, key);
      return { text: `Pressed key: ${key}` };
    },
  },
  {
    tool: {
      name: "browser_snapshot",
      description: "Get accessibility snapshot with element refs",
      inputSchema: {
        type: "object",
        properties: {
          session: { type: "string", description: "Session name. Default: 'default'" },
        },
      },
    },
    handler: async (args, ctx) => {
      const text = await ctx.deviceManager.getBrowserAdapter().snapshot(getString(args, "session"));
      return { text: truncateOutput(text, { maxChars: 15_000 }) };
    },
  },
  {
    tool: {
      name: "browser_screenshot",
      description: "Take browser page screenshot",
      inputSchema: {
        type: "object",
        properties: {
          session: { type: "string", description: "Session name. Default: 'default'" },
          fullPage: { type: "boolean", description: "Capture full page (scroll beyond viewport). Default: false" },
        },
      },
    },
    handler: async (args, ctx) => {
      const adapter = ctx.deviceManager.getBrowserAdapter();
      const fullPage = typeof args.fullPage === "boolean" ? args.fullPage : undefined;
      const buffer = await adapter.screenshotBrowser(
        getString(args, "session"),
        fullPage,
      );
      const compressed = await compressScreenshot(buffer, {});
      return {
        image: { data: compressed.data, mimeType: compressed.mimeType },
        text: `Screenshot taken${fullPage ? " (full page)" : ""}.`,
      };
    },
  },
  {
    tool: {
      name: "browser_evaluate",
      description: "Execute JavaScript in browser page",
      inputSchema: {
        type: "object",
        properties: {
          expression: { type: "string", description: "JavaScript expression to evaluate" },
          session: { type: "string", description: "Session name. Default: 'default'" },
        },
        required: ["expression"],
      },
    },
    handler: async (args, ctx) => {
      const expression = requireString(args, "expression");
      const text = await ctx.deviceManager.getBrowserAdapter().evaluateJs(
        expression,
        getString(args, "session"),
      );
      return { text: truncateOutput(text) };
    },
  },
  {
    tool: {
      name: "browser_wait_for_selector",
      description: "Wait for element to appear on page",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector to wait for" },
          timeout: { type: "number", description: "Maximum wait time in milliseconds. Default: 5000" },
          state: { type: "string", enum: ["attached", "visible"], description: "Wait for element to be 'attached' (in DOM) or 'visible'. Default: 'visible'" },
          session: { type: "string", description: "Session name. Default: 'default'" },
        },
        required: ["selector"],
      },
    },
    handler: async (args, ctx) => {
      const selector = requireString(args, "selector");
      await ctx.deviceManager.getBrowserAdapter().waitForSelector(
        selector,
        typeof args.timeout === "number" ? args.timeout : undefined,
        getString(args, "state") as "attached" | "visible" | undefined,
        getString(args, "session"),
      );
      return { text: `Element "${selector}" found.` };
    },
  },
  {
    tool: {
      name: "browser_clear_session",
      description: "Delete all stored data for a session",
      inputSchema: {
        type: "object",
        properties: {
          session: { type: "string", description: "Session name to clear" },
        },
        required: ["session"],
      },
    },
    handler: async (args, ctx) => {
      const session = requireString(args, "session");
      await ctx.deviceManager.getBrowserAdapter().clearSessionData(session);
      return { text: `Session "${session}" data cleared.` };
    },
  },
];
