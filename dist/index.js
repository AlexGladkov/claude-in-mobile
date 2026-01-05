#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { AdbClient } from "./adb/client.js";
import { parseUiHierarchy, findByText, findByResourceId, findElements, formatUiTree, formatElement, } from "./adb/ui-parser.js";
// Initialize ADB client
const adb = new AdbClient();
// Define tools
const tools = [
    {
        name: "list_devices",
        description: "List all connected Android devices and emulators",
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
    {
        name: "set_device",
        description: "Select which device to use for subsequent commands",
        inputSchema: {
            type: "object",
            properties: {
                deviceId: {
                    type: "string",
                    description: "Device ID from list_devices",
                },
            },
            required: ["deviceId"],
        },
    },
    {
        name: "screenshot",
        description: "Take a screenshot of the Android device screen. Returns base64 encoded PNG image.",
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
    {
        name: "get_ui",
        description: "Get the current UI hierarchy (accessibility tree). Shows all interactive elements with their text, IDs, and coordinates.",
        inputSchema: {
            type: "object",
            properties: {
                showAll: {
                    type: "boolean",
                    description: "Show all elements including non-interactive ones",
                    default: false,
                },
            },
        },
    },
    {
        name: "tap",
        description: "Tap at specific coordinates or find an element by text/id and tap it",
        inputSchema: {
            type: "object",
            properties: {
                x: {
                    type: "number",
                    description: "X coordinate to tap",
                },
                y: {
                    type: "number",
                    description: "Y coordinate to tap",
                },
                text: {
                    type: "string",
                    description: "Find element containing this text and tap it",
                },
                resourceId: {
                    type: "string",
                    description: "Find element with this resource ID and tap it",
                },
                index: {
                    type: "number",
                    description: "Tap element by index from get_ui output",
                },
            },
        },
    },
    {
        name: "long_press",
        description: "Long press at coordinates or on an element",
        inputSchema: {
            type: "object",
            properties: {
                x: {
                    type: "number",
                    description: "X coordinate",
                },
                y: {
                    type: "number",
                    description: "Y coordinate",
                },
                text: {
                    type: "string",
                    description: "Find element by text",
                },
                duration: {
                    type: "number",
                    description: "Duration in milliseconds (default: 1000)",
                    default: 1000,
                },
            },
        },
    },
    {
        name: "swipe",
        description: "Perform a swipe gesture",
        inputSchema: {
            type: "object",
            properties: {
                direction: {
                    type: "string",
                    enum: ["up", "down", "left", "right"],
                    description: "Swipe direction",
                },
                x1: {
                    type: "number",
                    description: "Start X (for custom swipe)",
                },
                y1: {
                    type: "number",
                    description: "Start Y (for custom swipe)",
                },
                x2: {
                    type: "number",
                    description: "End X (for custom swipe)",
                },
                y2: {
                    type: "number",
                    description: "End Y (for custom swipe)",
                },
                duration: {
                    type: "number",
                    description: "Duration in ms (default: 300)",
                    default: 300,
                },
            },
        },
    },
    {
        name: "input_text",
        description: "Type text into the currently focused input field",
        inputSchema: {
            type: "object",
            properties: {
                text: {
                    type: "string",
                    description: "Text to type",
                },
            },
            required: ["text"],
        },
    },
    {
        name: "press_key",
        description: "Press a key button (BACK, HOME, ENTER, TAB, DELETE, VOLUME_UP, VOLUME_DOWN, etc.)",
        inputSchema: {
            type: "object",
            properties: {
                key: {
                    type: "string",
                    description: "Key name: BACK, HOME, ENTER, TAB, DELETE, MENU, POWER, VOLUME_UP, VOLUME_DOWN, ESCAPE, SPACE, or numeric keycode",
                },
            },
            required: ["key"],
        },
    },
    {
        name: "find_element",
        description: "Find UI elements by text, resource ID, or other criteria",
        inputSchema: {
            type: "object",
            properties: {
                text: {
                    type: "string",
                    description: "Find by text (partial match, case-insensitive)",
                },
                resourceId: {
                    type: "string",
                    description: "Find by resource ID (partial match)",
                },
                className: {
                    type: "string",
                    description: "Find by class name",
                },
                clickable: {
                    type: "boolean",
                    description: "Filter by clickable state",
                },
            },
        },
    },
    {
        name: "launch_app",
        description: "Launch an app by package name",
        inputSchema: {
            type: "object",
            properties: {
                package: {
                    type: "string",
                    description: "Package name (e.g., com.android.settings)",
                },
            },
            required: ["package"],
        },
    },
    {
        name: "stop_app",
        description: "Force stop an app",
        inputSchema: {
            type: "object",
            properties: {
                package: {
                    type: "string",
                    description: "Package name to stop",
                },
            },
            required: ["package"],
        },
    },
    {
        name: "install_apk",
        description: "Install an APK file",
        inputSchema: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "Path to APK file",
                },
            },
            required: ["path"],
        },
    },
    {
        name: "get_current_activity",
        description: "Get the currently active app/activity",
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
    {
        name: "shell",
        description: "Execute arbitrary ADB shell command",
        inputSchema: {
            type: "object",
            properties: {
                command: {
                    type: "string",
                    description: "Shell command to execute",
                },
            },
            required: ["command"],
        },
    },
    {
        name: "wait",
        description: "Wait for specified duration",
        inputSchema: {
            type: "object",
            properties: {
                ms: {
                    type: "number",
                    description: "Duration in milliseconds",
                    default: 1000,
                },
            },
        },
    },
];
// Cache for UI elements (to support tap by index)
let cachedElements = [];
// Tool handlers
async function handleTool(name, args) {
    switch (name) {
        case "list_devices": {
            const devices = adb.getDevices();
            if (devices.length === 0) {
                return { text: "No devices connected. Make sure ADB is running and a device/emulator is connected." };
            }
            const list = devices.map(d => `${d.id} - ${d.state}${d.model ? ` (${d.model})` : ""}`).join("\n");
            return { text: `Connected devices:\n${list}` };
        }
        case "set_device": {
            adb.setDevice(args.deviceId);
            return { text: `Device set to: ${args.deviceId}` };
        }
        case "screenshot": {
            const base64 = adb.screenshot();
            return {
                image: {
                    data: base64,
                    mimeType: "image/png",
                },
            };
        }
        case "get_ui": {
            const xml = adb.getUiHierarchy();
            cachedElements = parseUiHierarchy(xml);
            const tree = formatUiTree(cachedElements, {
                showAll: args.showAll,
            });
            return { text: tree };
        }
        case "tap": {
            let x = args.x;
            let y = args.y;
            // Find by index from cached elements
            if (args.index !== undefined) {
                const idx = args.index;
                if (cachedElements.length === 0) {
                    // Refresh cache
                    const xml = adb.getUiHierarchy();
                    cachedElements = parseUiHierarchy(xml);
                }
                const el = cachedElements.find(e => e.index === idx);
                if (!el) {
                    return { text: `Element with index ${idx} not found. Run get_ui first.` };
                }
                x = el.centerX;
                y = el.centerY;
            }
            // Find by text or resourceId
            if (args.text || args.resourceId) {
                const xml = adb.getUiHierarchy();
                cachedElements = parseUiHierarchy(xml);
                let found = [];
                if (args.text) {
                    found = findByText(cachedElements, args.text);
                }
                else if (args.resourceId) {
                    found = findByResourceId(cachedElements, args.resourceId);
                }
                if (found.length === 0) {
                    return {
                        text: `Element not found: ${args.text || args.resourceId}`,
                    };
                }
                // Prefer clickable elements
                const clickable = found.filter(el => el.clickable);
                const target = clickable[0] ?? found[0];
                x = target.centerX;
                y = target.centerY;
            }
            if (x === undefined || y === undefined) {
                return { text: "Please provide x,y coordinates, text, resourceId, or index" };
            }
            adb.tap(x, y);
            return { text: `Tapped at (${x}, ${y})` };
        }
        case "long_press": {
            let x = args.x;
            let y = args.y;
            const duration = args.duration ?? 1000;
            if (args.text) {
                const xml = adb.getUiHierarchy();
                cachedElements = parseUiHierarchy(xml);
                const found = findByText(cachedElements, args.text);
                if (found.length === 0) {
                    return { text: `Element not found: ${args.text}` };
                }
                x = found[0].centerX;
                y = found[0].centerY;
            }
            if (x === undefined || y === undefined) {
                return { text: "Please provide x,y coordinates or text" };
            }
            adb.longPress(x, y, duration);
            return { text: `Long pressed at (${x}, ${y}) for ${duration}ms` };
        }
        case "swipe": {
            if (args.direction) {
                adb.swipeDirection(args.direction);
                return { text: `Swiped ${args.direction}` };
            }
            if (args.x1 !== undefined && args.y1 !== undefined &&
                args.x2 !== undefined && args.y2 !== undefined) {
                const duration = args.duration ?? 300;
                adb.swipe(args.x1, args.y1, args.x2, args.y2, duration);
                return {
                    text: `Swiped from (${args.x1}, ${args.y1}) to (${args.x2}, ${args.y2})`,
                };
            }
            return { text: "Please provide direction or x1,y1,x2,y2 coordinates" };
        }
        case "input_text": {
            adb.inputText(args.text);
            return { text: `Entered text: "${args.text}"` };
        }
        case "press_key": {
            adb.pressKey(args.key);
            return { text: `Pressed key: ${args.key}` };
        }
        case "find_element": {
            const xml = adb.getUiHierarchy();
            cachedElements = parseUiHierarchy(xml);
            const found = findElements(cachedElements, {
                text: args.text,
                resourceId: args.resourceId,
                className: args.className,
                clickable: args.clickable,
            });
            if (found.length === 0) {
                return { text: "No elements found matching criteria" };
            }
            const list = found.slice(0, 20).map(formatElement).join("\n");
            return {
                text: `Found ${found.length} element(s):\n${list}${found.length > 20 ? "\n..." : ""}`,
            };
        }
        case "launch_app": {
            const result = adb.launchApp(args.package);
            return { text: result };
        }
        case "stop_app": {
            adb.stopApp(args.package);
            return { text: `Stopped: ${args.package}` };
        }
        case "install_apk": {
            const result = adb.installApk(args.path);
            return { text: result };
        }
        case "get_current_activity": {
            const activity = adb.getCurrentActivity();
            return { text: `Current activity: ${activity}` };
        }
        case "shell": {
            const output = adb.shell(args.command);
            return { text: output || "(no output)" };
        }
        case "wait": {
            const ms = args.ms ?? 1000;
            await new Promise(resolve => setTimeout(resolve, ms));
            return { text: `Waited ${ms}ms` };
        }
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}
// Create server
const server = new Server({
    name: "claude-in-android",
    version: "1.0.0",
}, {
    capabilities: {
        tools: {},
    },
});
// Handle tool list request
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
});
// Handle tool call request
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        const result = await handleTool(name, args ?? {});
        // Handle image response
        if (typeof result === "object" && result !== null && "image" in result) {
            const img = result.image;
            return {
                content: [
                    {
                        type: "image",
                        data: img.data,
                        mimeType: img.mimeType,
                    },
                ],
            };
        }
        // Handle text response
        const text = typeof result === "object" && result !== null && "text" in result
            ? result.text
            : JSON.stringify(result);
        return {
            content: [
                {
                    type: "text",
                    text,
                },
            ],
        };
    }
    catch (error) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error: ${error.message}`,
                },
            ],
            isError: true,
        };
    }
});
// Start server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Claude in Android MCP server running");
}
main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map