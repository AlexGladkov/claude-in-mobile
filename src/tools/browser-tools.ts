import type { ToolDefinition } from "./registry.js";
import { compressScreenshot } from "../utils/image.js";

export const browserTools: ToolDefinition[] = [
  {
    tool: {
      name: "browser_open",
      description: "Open a URL in a browser session. Returns an accessibility snapshot of the loaded page.",
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
      const adapter = ctx.deviceManager.getBrowserAdapter();
      const text = await adapter.open({
        url: args.url as string,
        session: args.session as string | undefined,
        headless: args.headless as boolean | undefined,
      });
      return { text };
    },
  },
  {
    tool: {
      name: "browser_close",
      description: "Close a browser session and release resources.",
      inputSchema: {
        type: "object",
        properties: {
          session: { type: "string", description: "Session name. If omitted, closes all sessions." },
        },
      },
    },
    handler: async (args, ctx) => {
      await ctx.deviceManager.getBrowserAdapter().closeSession(args.session as string | undefined);
      const session = args.session ?? "all";
      return { text: `Browser session "${session}" closed.` };
    },
  },
  {
    tool: {
      name: "browser_list_sessions",
      description: "List active browser sessions.",
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
      description: "Navigate to a URL, or go back/forward/reload in the current session.",
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
      const text = await ctx.deviceManager.getBrowserAdapter().navigate({
        url: args.url as string | undefined,
        action: args.action as "back" | "forward" | "reload" | undefined,
        session: args.session as string | undefined,
      });
      return { text };
    },
  },
  {
    tool: {
      name: "browser_click",
      description: "Click an element in the browser. Use ref from browser_snapshot (preferred), CSS selector, or visible text.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Ref from browser_snapshot (e.g. 'e1'). Fastest and most reliable." },
          selector: { type: "string", description: "CSS selector" },
          text: { type: "string", description: "Visible text content of element to click" },
          session: { type: "string", description: "Session name. Default: 'default'" },
        },
      },
    },
    handler: async (args, ctx) => {
      const text = await ctx.deviceManager.getBrowserAdapter().clickElement({
        ref: args.ref as string | undefined,
        selector: args.selector as string | undefined,
        text: args.text as string | undefined,
        session: args.session as string | undefined,
      });
      return { text };
    },
  },
  {
    tool: {
      name: "browser_fill",
      description: "Fill an input field with a value.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Ref from browser_snapshot (e.g. 'e2')" },
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
      await ctx.deviceManager.getBrowserAdapter().fillField({
        ref: args.ref as string | undefined,
        selector: args.selector as string | undefined,
        value: args.value as string,
        session: args.session as string | undefined,
        clear: args.clear as boolean | undefined,
        pressEnter: args.pressEnter as boolean | undefined,
      });
      return { text: `Filled field with value: "${args.value}"` };
    },
  },
  {
    tool: {
      name: "browser_fill_form",
      description: "Fill multiple form fields at once. Optionally submit the form.",
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
      await ctx.deviceManager.getBrowserAdapter().fillForm({
        fields,
        submit: args.submit as boolean | undefined,
        session: args.session as string | undefined,
      });
      return { text: `Filled ${fields.length} field(s)${args.submit ? " and submitted." : "."}` };
    },
  },
  {
    tool: {
      name: "browser_press_key",
      description: "Press a keyboard key in the browser. Supported: Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, Space.",
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
      const session = adapter.sessionManager.getSession(args.session as string | undefined);
      if (!session) throw new Error("No active browser session. Use browser_open first.");
      await adapter.client.pressKey(session, args.key as string);
      return { text: `Pressed key: ${args.key}` };
    },
  },
  {
    tool: {
      name: "browser_snapshot",
      description: "Get accessibility snapshot of the current page with ref-ids for interactive elements. Use refs with browser_click and browser_fill.",
      inputSchema: {
        type: "object",
        properties: {
          session: { type: "string", description: "Session name. Default: 'default'" },
        },
      },
    },
    handler: async (args, ctx) => {
      const text = await ctx.deviceManager.getBrowserAdapter().snapshot(args.session as string | undefined);
      return { text };
    },
  },
  {
    tool: {
      name: "browser_screenshot",
      description: "Take a screenshot of the current browser page.",
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
      const buffer = await adapter.screenshotBrowser(
        args.session as string | undefined,
        args.fullPage as boolean | undefined
      );
      const compressed = await compressScreenshot(buffer, {});
      return {
        image: { data: compressed.data, mimeType: compressed.mimeType },
        text: `Screenshot taken${args.fullPage ? " (full page)" : ""}.`,
      };
    },
  },
  {
    tool: {
      name: "browser_evaluate",
      description: "Execute JavaScript in the browser page and return the result.",
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
      const text = await ctx.deviceManager.getBrowserAdapter().evaluateJs(
        args.expression as string,
        args.session as string | undefined
      );
      return { text };
    },
  },
  {
    tool: {
      name: "browser_wait_for_selector",
      description: "Wait for an element to appear on the page.",
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
      await ctx.deviceManager.getBrowserAdapter().waitForSelector(
        args.selector as string,
        args.timeout as number | undefined,
        args.state as "attached" | "visible" | undefined,
        args.session as string | undefined
      );
      return { text: `Element "${args.selector}" found.` };
    },
  },
  {
    tool: {
      name: "browser_clear_session",
      description: "Delete all stored data for a browser session (cookies, localStorage, etc.). The session will be closed.",
      inputSchema: {
        type: "object",
        properties: {
          session: { type: "string", description: "Session name to clear" },
        },
        required: ["session"],
      },
    },
    handler: async (args, ctx) => {
      await ctx.deviceManager.getBrowserAdapter().clearSessionData(args.session as string);
      return { text: `Session "${args.session}" data cleared.` };
    },
  },
];
