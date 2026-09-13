import type { ToolDefinition } from "./registry.js";
import { defineTool, z } from "./define-tool.js";
import { compressScreenshot } from "../utils/image.js";
import { truncateOutput } from "../utils/truncate.js";
import { validateUrl } from "../utils/sanitize.js";
import { BrowserNoSessionError } from "../errors.js";
import { textResult } from "../utils/tool-result.js";
import type { ToolResult } from "../utils/tool-result.js";

const browserSessionSchema = z.string().min(1).max(128);
const browserUrlSchema = z.string().min(1).max(8192);
const browserRefSchema = z.string().min(1).max(128);
const browserSelectorSchema = z.string().min(1).max(16 * 1024);
const browserTextSchema = z.string().max(1024 * 1024);
const sessionField = browserSessionSchema
  .optional()
  .describe("Session name for persistent state. Default: 'default'");

export const browserTools: ToolDefinition[] = [
  defineTool({
    name: "browser_open",
    description: "Open URL in browser session",
    schema: z.object({
      url: browserUrlSchema.describe("URL to open (http:// or https:// only)"),
      session: sessionField,
      headless: z
        .boolean()
        .optional()
        .default(false)
        .describe("Run browser in headless mode. Default: false"),
    }),
    handler: async (args, ctx) => {
      validateUrl(args.url);
      const adapter = ctx.deviceManager.getBrowserAdapter();
      const text = await adapter.open({
        url: args.url,
        session: args.session,
        headless: args.headless,
      });
      return textResult(text);
    },
  }),

  defineTool({
    name: "browser_close",
    description: "Close browser session",
    schema: z.object({
      session: browserSessionSchema.optional().describe("Session name. If omitted, closes all sessions."),
    }),
    handler: async (args, ctx) => {
      await ctx.deviceManager.getBrowserAdapter().closeSession(args.session);
      return textResult(`Browser session "${args.session ?? "all"}" closed.`);
    },
  }),

  defineTool({
    name: "browser_list_sessions",
    description: "List active browser sessions",
    schema: z.object({}),
    handler: async (_args, ctx) => {
      const sessions = ctx.deviceManager.getBrowserAdapter().listSessions();
      if (sessions.length === 0) {
        return textResult("No active browser sessions. Use browser_open to start one.");
      }
      return textResult(`Active sessions:\n${sessions.map((s: string) => `  - ${s}`).join("\n")}`);
    },
  }),

  defineTool({
    name: "browser_navigate",
    description: "Navigate to URL or go back/forward/reload",
    schema: z.object({
      url: browserUrlSchema.optional().describe("URL to navigate to"),
      action: z
        .enum(["back", "forward", "reload"])
        .optional()
        .describe("Navigation action"),
      session: sessionField,
    }),
    handler: async (args, ctx) => {
      if (args.url) {
        validateUrl(args.url);
      }
      const text = await ctx.deviceManager.getBrowserAdapter().navigate({
        url: args.url,
        action: args.action,
        session: args.session,
      });
      return textResult(text);
    },
  }),

  defineTool({
    name: "browser_click",
    description: "Click element by ref, selector, or text",
    schema: z.object({
      ref: browserRefSchema
        .optional()
        .describe("Ref from browser(action:'snapshot') (e.g. 'e1'). Fastest and most reliable."),
      selector: browserSelectorSchema.optional().describe("CSS selector"),
      text: browserTextSchema.optional().describe("Visible text content of element to click"),
      session: sessionField,
    }),
    handler: async (args, ctx) => {
      const text = await ctx.deviceManager.getBrowserAdapter().clickElement({
        ref: args.ref,
        selector: args.selector,
        text: args.text,
        session: args.session,
      });
      return textResult(text);
    },
  }),

  defineTool({
    name: "browser_fill",
    description: "Fill input field with value",
    schema: z.object({
      ref: browserRefSchema.optional().describe("Ref from snapshot (e.g. 'e2')"),
      selector: browserSelectorSchema.optional().describe("CSS selector of input field"),
      value: browserTextSchema.describe("Value to enter"),
      session: sessionField,
      clear: z
        .boolean()
        .optional()
        .default(true)
        .describe("Clear field before typing. Default: true"),
      pressEnter: z
        .boolean()
        .optional()
        .default(false)
        .describe("Press Enter after filling. Default: false"),
    }),
    handler: async (args, ctx) => {
      await ctx.deviceManager.getBrowserAdapter().fillField({
        ref: args.ref,
        selector: args.selector,
        value: args.value,
        session: args.session,
        clear: args.clear,
        pressEnter: args.pressEnter,
      });
      return textResult(`Filled field with ${args.value.length} character(s).`);
    },
  }),

  defineTool({
    name: "browser_fill_form",
    description: "Fill multiple form fields at once",
    schema: z.object({
      fields: z
        .array(
          z.object({
            ref: browserRefSchema.optional().describe("Ref from snapshot"),
            selector: browserSelectorSchema.optional().describe("CSS selector"),
            value: browserTextSchema.describe("Value to enter"),
          }),
        )
        .max(256)
        .describe("Array of fields to fill"),
      submit: z
        .boolean()
        .optional()
        .describe("Press Enter to submit after filling. Default: false"),
      session: sessionField,
    }),
    handler: async (args, ctx) => {
      await ctx.deviceManager.getBrowserAdapter().fillForm({
        fields: args.fields,
        submit: args.submit,
        session: args.session,
      });
      return textResult(
        `Filled ${args.fields.length} field(s)${args.submit ? " and submitted." : "."}`,
      );
    },
  }),

  defineTool({
    name: "browser_press_key",
    description: "Press keyboard key in browser",
    schema: z.object({
      key: z.string().min(1).max(64).describe("Key name (e.g. Enter, Tab, Escape, ArrowDown)"),
      session: sessionField,
    }),
    handler: async (args, ctx) => {
      const adapter = ctx.deviceManager.getBrowserAdapter();
      const session = adapter.sessionManager.getSession(args.session);
      if (!session) throw new BrowserNoSessionError();
      await adapter.client.pressKey(session, args.key);
      return textResult(`Pressed key: ${args.key}`);
    },
  }),

  defineTool({
    name: "browser_snapshot",
    description: "Get accessibility snapshot with element refs",
    schema: z.object({
      session: sessionField,
    }),
    handler: async (args, ctx) => {
      const text = await ctx.deviceManager.getBrowserAdapter().snapshot(args.session);
      return textResult(truncateOutput(text, { maxChars: 15_000 }));
    },
  }),

  defineTool({
    name: "browser_screenshot",
    description: "Take browser page screenshot",
    schema: z.object({
      session: sessionField,
      fullPage: z
        .boolean()
        .optional()
        .describe("Capture full page (scroll beyond viewport). Default: false"),
    }),
    handler: async (args, ctx) => {
      const adapter = ctx.deviceManager.getBrowserAdapter();
      const buffer = await adapter.screenshotBrowser(args.session, args.fullPage);
      const compressed = await compressScreenshot(buffer, {});
      return {
        content: [
          { type: "text", text: `Screenshot taken${args.fullPage ? " (full page)" : ""}.` },
        ],
        text: `Screenshot taken${args.fullPage ? " (full page)" : ""}.`,
        image: { data: compressed.data, mimeType: compressed.mimeType },
      } as unknown as ToolResult;
    },
  }),

  defineTool({
    name: "browser_evaluate",
    description: "Execute JavaScript in browser page",
    schema: z.object({
      expression: browserTextSchema.min(1).describe("JavaScript expression to evaluate"),
      session: sessionField,
    }),
    handler: async (args, ctx) => {
      const text = await ctx.deviceManager
        .getBrowserAdapter()
        .evaluateJs(args.expression, args.session);
      return textResult(truncateOutput(text));
    },
  }),

  defineTool({
    name: "browser_wait_for_selector",
    description: "Wait for element to appear on page",
    schema: z.object({
      selector: browserSelectorSchema.describe("CSS selector to wait for"),
      timeout: z
        .number()
        .int()
        .min(1)
        .max(120_000)
        .optional()
        .describe("Maximum wait time in milliseconds. Default: 5000"),
      state: z
        .enum(["attached", "visible"])
        .optional()
        .describe("Wait for element to be 'attached' (in DOM) or 'visible'. Default: 'visible'"),
      session: sessionField,
    }),
    handler: async (args, ctx) => {
      await ctx.deviceManager
        .getBrowserAdapter()
        .waitForSelector(args.selector, args.timeout, args.state, args.session);
      return textResult(`Element "${args.selector}" found.`);
    },
  }),

  defineTool({
    name: "browser_clear_session",
    description: "Delete all stored data for a session",
    schema: z.object({
      session: browserSessionSchema.describe("Session name to clear"),
    }),
    handler: async (args, ctx) => {
      await ctx.deviceManager.getBrowserAdapter().clearSessionData(args.session);
      return textResult(`Session "${args.session}" data cleared.`);
    },
  }),
];
