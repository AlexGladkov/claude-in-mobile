/**
 * 12 atomic tool definitions for lite MCP server.
 * ~15 total properties, ~600 tokens overhead.
 * No meta-dispatch, no action parameter, no hints.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { DeviceManager } from "claude-in-mobile/device-manager";
import { formatUiLine, MAX_UI_ELEMENTS } from "./formatter.js";

export interface LiteToolDefinition {
  tool: Tool;
  handler: (args: Record<string, unknown>, dm: DeviceManager) => Promise<unknown>;
}

export function createLiteTools(): LiteToolDefinition[] {
  return [
    // 1. tap
    {
      tool: {
        name: "tap",
        description: "Tap at x,y",
        inputSchema: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
          },
          required: ["x", "y"],
        },
      },
      handler: async (args, dm) => {
        await dm.tap(args.x as number, args.y as number);
        return { text: "OK" };
      },
    },

    // 2. tap_text
    {
      tool: {
        name: "tap_text",
        description: "Find and tap element by text",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to find and tap" },
          },
          required: ["text"],
        },
      },
      handler: async (args, dm) => {
        const searchText = (args.text as string).toLowerCase();
        const uiTree = await dm.getUiHierarchy();
        const lines = uiTree.split("\n");

        // Parse UI tree for coordinates — look for matching text
        for (const line of lines) {
          if (line.toLowerCase().includes(searchText)) {
            // Try to extract coordinates from common UI tree formats
            // Format: bounds="[x1,y1][x2,y2]" or (x,y) or x=N y=N
            const boundsMatch = line.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
            if (boundsMatch) {
              const x = Math.round((parseInt(boundsMatch[1]) + parseInt(boundsMatch[3])) / 2);
              const y = Math.round((parseInt(boundsMatch[2]) + parseInt(boundsMatch[4])) / 2);
              await dm.tap(x, y);
              return { text: `Tapped "${args.text}" at (${x},${y})` };
            }
            const coordMatch = line.match(/\((\d+),\s*(\d+)\)/);
            if (coordMatch) {
              const x = parseInt(coordMatch[1]);
              const y = parseInt(coordMatch[2]);
              await dm.tap(x, y);
              return { text: `Tapped "${args.text}" at (${x},${y})` };
            }
          }
        }

        return { text: `Element "${args.text}" not found. Use get_ui to see available elements.`, isError: true };
      },
    },

    // 3. swipe
    {
      tool: {
        name: "swipe",
        description: "Swipe in a direction",
        inputSchema: {
          type: "object",
          properties: {
            direction: {
              type: "string",
              enum: ["up", "down", "left", "right"],
              description: "Direction",
            },
          },
          required: ["direction"],
        },
      },
      handler: async (args, dm) => {
        await dm.swipeDirection(args.direction as "up" | "down" | "left" | "right");
        return { text: `Swiped ${args.direction}` };
      },
    },

    // 4. type_text
    {
      tool: {
        name: "type_text",
        description: "Type into focused field",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to type" },
          },
          required: ["text"],
        },
      },
      handler: async (args, dm) => {
        await dm.inputText(args.text as string);
        return { text: "OK" };
      },
    },

    // 5. press_key
    {
      tool: {
        name: "press_key",
        description: "Press key",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string", description: "BACK, HOME, ENTER, TAB, DELETE" },
          },
          required: ["key"],
        },
      },
      handler: async (args, dm) => {
        await dm.pressKey(args.key as string);
        return { text: `Pressed ${args.key}` };
      },
    },

    // 6. screenshot
    {
      tool: {
        name: "screenshot",
        description: "Take screenshot",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: async (_args, dm) => {
        // Low quality: 270x480 equivalent, quality 40
        const result = await dm.screenshot(undefined, true, {
          maxWidth: 270,
          maxHeight: 480,
          quality: 40,
        });
        return {
          image: { data: result.data, mimeType: result.mimeType },
        };
      },
    },

    // 7. get_ui
    {
      tool: {
        name: "get_ui",
        description: "Get UI elements on screen",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: async (_args, dm) => {
        const tree = await dm.getUiHierarchy();
        const formatted = formatUiTree(tree);
        return { text: formatted };
      },
    },

    // 8. find_element
    {
      tool: {
        name: "find_element",
        description: "Find element by text",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to search for" },
          },
          required: ["text"],
        },
      },
      handler: async (args, dm) => {
        const searchText = (args.text as string).toLowerCase();
        const tree = await dm.getUiHierarchy();
        const lines = tree.split("\n");
        const matches: string[] = [];

        let idx = 0;
        for (const line of lines) {
          if (line.toLowerCase().includes(searchText)) {
            matches.push(formatUiLine(idx, line));
            idx++;
            if (idx >= MAX_UI_ELEMENTS) break;
          }
        }

        if (matches.length === 0) {
          return { text: `No element matching "${args.text}" found.`, isError: true };
        }
        return { text: matches.join("\n") };
      },
    },

    // 9. launch_app
    {
      tool: {
        name: "launch_app",
        description: "Launch app",
        inputSchema: {
          type: "object",
          properties: {
            package: { type: "string", description: "Package name or bundle ID" },
          },
          required: ["package"],
        },
      },
      handler: async (args, dm) => {
        const result = dm.launchApp(args.package as string);
        return { text: result };
      },
    },

    // 10. go_back
    {
      tool: {
        name: "go_back",
        description: "Press back button",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: async (_args, dm) => {
        await dm.pressKey("BACK");
        return { text: "OK" };
      },
    },

    // 11. wait
    {
      tool: {
        name: "wait",
        description: "Wait milliseconds",
        inputSchema: {
          type: "object",
          properties: {
            ms: { type: "number", description: "Ms to wait, default 1000" },
          },
        },
      },
      handler: async (args, _dm) => {
        const ms = (args.ms as number) ?? 1000;
        await new Promise((resolve) => setTimeout(resolve, ms));
        return { text: `Waited ${ms}ms` };
      },
    },

    // 12. device_info
    {
      tool: {
        name: "device_info",
        description: "Get device info",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: async (_args, dm) => {
        const info = await dm.getSystemInfo();
        return { text: info };
      },
    },
  ];
}

/** Format raw UI tree into compact lines, max MAX_UI_ELEMENTS */
function formatUiTree(rawTree: string): string {
  const lines = rawTree.split("\n").filter((l) => l.trim().length > 0);
  const result: string[] = [];

  for (let i = 0; i < lines.length && result.length < MAX_UI_ELEMENTS; i++) {
    result.push(formatUiLine(result.length, lines[i]));
  }

  if (lines.length > MAX_UI_ELEMENTS) {
    result.push(`... ${lines.length - MAX_UI_ELEMENTS} more elements`);
  }

  return result.join("\n");
}
