#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { DeviceManager } from "./device-manager.js";
import { parseUiHierarchy, findByText, findByResourceId, findElements, formatUiTree, formatElement, } from "./adb/ui-parser.js";
// Initialize device manager
const deviceManager = new DeviceManager();
// Platform parameter schema (reused across tools)
const platformParam = {
    type: "string",
    enum: ["android", "ios"],
    description: "Target platform. If not specified, uses the active device.",
};
// Define tools
const tools = [
    {
        name: "list_devices",
        description: "List all connected Android devices/emulators and iOS simulators",
        inputSchema: {
            type: "object",
            properties: {
                platform: {
                    ...platformParam,
                    description: "Filter by platform (android/ios). If not specified, shows all.",
                },
            },
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
                platform: platformParam,
            },
            required: ["deviceId"],
        },
    },
    {
        name: "screenshot",
        description: "Take a screenshot of the device screen. Images are automatically compressed for optimal LLM processing.",
        inputSchema: {
            type: "object",
            properties: {
                platform: platformParam,
                compress: {
                    type: "boolean",
                    description: "Compress image (default: true). Set false for original quality.",
                    default: true,
                },
                maxWidth: {
                    type: "number",
                    description: "Max width in pixels (default: 800, max 2000 for API)",
                    default: 800,
                },
                maxHeight: {
                    type: "number",
                    description: "Max height in pixels (default: 1400, max 2000 for API)",
                    default: 1400,
                },
                quality: {
                    type: "number",
                    description: "JPEG quality 1-100 (default: 70)",
                    default: 70,
                },
            },
        },
    },
    {
        name: "get_ui",
        description: "Get the current UI hierarchy (accessibility tree). Shows all interactive elements with their text, IDs, and coordinates. Note: Limited on iOS.",
        inputSchema: {
            type: "object",
            properties: {
                showAll: {
                    type: "boolean",
                    description: "Show all elements including non-interactive ones",
                    default: false,
                },
                platform: platformParam,
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
                    description: "Find element containing this text and tap it (Android only)",
                },
                resourceId: {
                    type: "string",
                    description: "Find element with this resource ID and tap it (Android only)",
                },
                index: {
                    type: "number",
                    description: "Tap element by index from get_ui output (Android only)",
                },
                platform: platformParam,
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
                    description: "Find element by text (Android only)",
                },
                duration: {
                    type: "number",
                    description: "Duration in milliseconds (default: 1000)",
                    default: 1000,
                },
                platform: platformParam,
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
                platform: platformParam,
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
                platform: platformParam,
            },
            required: ["text"],
        },
    },
    {
        name: "press_key",
        description: "Press a key button. Android: BACK, HOME, ENTER, etc. iOS: HOME, VOLUME_UP, VOLUME_DOWN",
        inputSchema: {
            type: "object",
            properties: {
                key: {
                    type: "string",
                    description: "Key name: BACK, HOME, ENTER, TAB, DELETE, MENU, POWER, VOLUME_UP, VOLUME_DOWN, etc.",
                },
                platform: platformParam,
            },
            required: ["key"],
        },
    },
    {
        name: "find_element",
        description: "Find UI elements by text, resource ID, or other criteria (Android only)",
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
                platform: platformParam,
            },
        },
    },
    {
        name: "launch_app",
        description: "Launch an app by package name (Android) or bundle ID (iOS)",
        inputSchema: {
            type: "object",
            properties: {
                package: {
                    type: "string",
                    description: "Package name (Android) or bundle ID (iOS), e.g., com.android.settings or com.apple.Preferences",
                },
                platform: platformParam,
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
                    description: "Package name (Android) or bundle ID (iOS)",
                },
                platform: platformParam,
            },
            required: ["package"],
        },
    },
    {
        name: "install_app",
        description: "Install an app. APK for Android, .app bundle for iOS simulator",
        inputSchema: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "Path to APK (Android) or .app bundle (iOS)",
                },
                platform: platformParam,
            },
            required: ["path"],
        },
    },
    {
        name: "get_current_activity",
        description: "Get the currently active app/activity (Android only)",
        inputSchema: {
            type: "object",
            properties: {
                platform: platformParam,
            },
        },
    },
    {
        name: "shell",
        description: "Execute shell command. ADB shell for Android, simctl for iOS",
        inputSchema: {
            type: "object",
            properties: {
                command: {
                    type: "string",
                    description: "Shell command to execute",
                },
                platform: platformParam,
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
    {
        name: "open_url",
        description: "Open URL in device browser",
        inputSchema: {
            type: "object",
            properties: {
                url: {
                    type: "string",
                    description: "URL to open",
                },
                platform: platformParam,
            },
            required: ["url"],
        },
    },
    {
        name: "get_logs",
        description: "Get device logs (logcat for Android, system log for iOS). Useful for debugging app issues, crashes, and errors.",
        inputSchema: {
            type: "object",
            properties: {
                platform: platformParam,
                level: {
                    type: "string",
                    description: "Log level filter. Android: V/D/I/W/E/F (Verbose/Debug/Info/Warning/Error/Fatal). iOS: debug/info/default/error/fault",
                },
                tag: {
                    type: "string",
                    description: "Filter by tag (Android only)",
                },
                lines: {
                    type: "number",
                    description: "Number of lines to return (default: 100)",
                    default: 100,
                },
                package: {
                    type: "string",
                    description: "Filter by package/bundle ID",
                },
            },
        },
    },
    {
        name: "clear_logs",
        description: "Clear device log buffer (Android only)",
        inputSchema: {
            type: "object",
            properties: {
                platform: platformParam,
            },
        },
    },
    {
        name: "get_system_info",
        description: "Get device system info: battery level, memory usage (Android only)",
        inputSchema: {
            type: "object",
            properties: {
                platform: platformParam,
            },
        },
    },
];
// Cache for UI elements (to support tap by index)
let cachedElements = [];
// Tool handlers
async function handleTool(name, args) {
    const platform = args.platform;
    switch (name) {
        case "list_devices": {
            const devices = deviceManager.getDevices(platform);
            if (devices.length === 0) {
                return { text: "No devices connected. Make sure ADB/Xcode is running and a device/emulator/simulator is connected." };
            }
            const activeDevice = deviceManager.getActiveDevice();
            // Group by platform
            const android = devices.filter(d => d.platform === "android");
            const ios = devices.filter(d => d.platform === "ios");
            let result = "Connected devices:\n";
            if (android.length > 0) {
                result += "\nAndroid:\n";
                for (const d of android) {
                    const active = activeDevice?.id === d.id ? " [ACTIVE]" : "";
                    const type = d.isSimulator ? "emulator" : "physical";
                    result += `  • ${d.id} - ${d.name} (${type}, ${d.state})${active}\n`;
                }
            }
            if (ios.length > 0) {
                result += "\niOS:\n";
                for (const d of ios) {
                    const active = activeDevice?.id === d.id ? " [ACTIVE]" : "";
                    const type = d.isSimulator ? "simulator" : "physical";
                    result += `  • ${d.id} - ${d.name} (${type}, ${d.state})${active}\n`;
                }
            }
            return { text: result.trim() };
        }
        case "set_device": {
            const device = deviceManager.setDevice(args.deviceId, platform);
            return { text: `Device set to: ${device.name} (${device.platform}, ${device.id})` };
        }
        case "screenshot": {
            const compress = args.compress !== false;
            const options = {
                maxWidth: args.maxWidth,
                maxHeight: args.maxHeight,
                quality: args.quality,
            };
            const result = await deviceManager.screenshot(platform, compress, options);
            return {
                image: {
                    data: result.data,
                    mimeType: result.mimeType,
                },
            };
        }
        case "get_ui": {
            const currentPlatform = platform ?? deviceManager.getCurrentPlatform();
            if (currentPlatform === "ios") {
                return { text: "iOS UI hierarchy is limited. Use screenshot + tap by coordinates, or integrate WebDriverAgent for full UI inspection." };
            }
            const xml = deviceManager.getUiHierarchy(platform);
            cachedElements = parseUiHierarchy(xml);
            const tree = formatUiTree(cachedElements, {
                showAll: args.showAll,
            });
            return { text: tree };
        }
        case "tap": {
            let x = args.x;
            let y = args.y;
            const currentPlatform = platform ?? deviceManager.getCurrentPlatform();
            // Find by index from cached elements (Android only)
            if (args.index !== undefined && currentPlatform === "android") {
                const idx = args.index;
                if (cachedElements.length === 0) {
                    const xml = deviceManager.getUiHierarchy("android");
                    cachedElements = parseUiHierarchy(xml);
                }
                const el = cachedElements.find(e => e.index === idx);
                if (!el) {
                    return { text: `Element with index ${idx} not found. Run get_ui first.` };
                }
                x = el.centerX;
                y = el.centerY;
            }
            // Find by text or resourceId (Android only)
            if ((args.text || args.resourceId) && currentPlatform === "android") {
                const xml = deviceManager.getUiHierarchy("android");
                cachedElements = parseUiHierarchy(xml);
                let found = [];
                if (args.text) {
                    found = findByText(cachedElements, args.text);
                }
                else if (args.resourceId) {
                    found = findByResourceId(cachedElements, args.resourceId);
                }
                if (found.length === 0) {
                    return { text: `Element not found: ${args.text || args.resourceId}` };
                }
                const clickable = found.filter(el => el.clickable);
                const target = clickable[0] ?? found[0];
                x = target.centerX;
                y = target.centerY;
            }
            if (x === undefined || y === undefined) {
                return { text: "Please provide x,y coordinates, text, resourceId, or index" };
            }
            deviceManager.tap(x, y, platform);
            return { text: `Tapped at (${x}, ${y})` };
        }
        case "long_press": {
            let x = args.x;
            let y = args.y;
            const duration = args.duration ?? 1000;
            const currentPlatform = platform ?? deviceManager.getCurrentPlatform();
            if (args.text && currentPlatform === "android") {
                const xml = deviceManager.getUiHierarchy("android");
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
            deviceManager.longPress(x, y, duration, platform);
            return { text: `Long pressed at (${x}, ${y}) for ${duration}ms` };
        }
        case "swipe": {
            if (args.direction) {
                deviceManager.swipeDirection(args.direction, platform);
                return { text: `Swiped ${args.direction}` };
            }
            if (args.x1 !== undefined && args.y1 !== undefined &&
                args.x2 !== undefined && args.y2 !== undefined) {
                const duration = args.duration ?? 300;
                deviceManager.swipe(args.x1, args.y1, args.x2, args.y2, duration, platform);
                return { text: `Swiped from (${args.x1}, ${args.y1}) to (${args.x2}, ${args.y2})` };
            }
            return { text: "Please provide direction or x1,y1,x2,y2 coordinates" };
        }
        case "input_text": {
            deviceManager.inputText(args.text, platform);
            return { text: `Entered text: "${args.text}"` };
        }
        case "press_key": {
            deviceManager.pressKey(args.key, platform);
            return { text: `Pressed key: ${args.key}` };
        }
        case "find_element": {
            const currentPlatform = platform ?? deviceManager.getCurrentPlatform();
            if (currentPlatform === "ios") {
                return { text: "find_element is only available for Android. Use screenshot + tap by coordinates for iOS." };
            }
            const xml = deviceManager.getUiHierarchy("android");
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
            return { text: `Found ${found.length} element(s):\n${list}${found.length > 20 ? "\n..." : ""}` };
        }
        case "launch_app": {
            const result = deviceManager.launchApp(args.package, platform);
            return { text: result };
        }
        case "stop_app": {
            deviceManager.stopApp(args.package, platform);
            return { text: `Stopped: ${args.package}` };
        }
        case "install_app": {
            const result = deviceManager.installApp(args.path, platform);
            return { text: result };
        }
        case "get_current_activity": {
            const currentPlatform = platform ?? deviceManager.getCurrentPlatform();
            if (currentPlatform === "ios") {
                return { text: "get_current_activity is only available for Android." };
            }
            const activity = deviceManager.getAndroidClient().getCurrentActivity();
            return { text: `Current activity: ${activity}` };
        }
        case "shell": {
            const output = deviceManager.shell(args.command, platform);
            return { text: output || "(no output)" };
        }
        case "wait": {
            const ms = args.ms ?? 1000;
            await new Promise(resolve => setTimeout(resolve, ms));
            return { text: `Waited ${ms}ms` };
        }
        case "open_url": {
            const currentPlatform = platform ?? deviceManager.getCurrentPlatform();
            if (currentPlatform === "android") {
                deviceManager.getAndroidClient().shell(`am start -a android.intent.action.VIEW -d "${args.url}"`);
            }
            else {
                deviceManager.getIosClient().openUrl(args.url);
            }
            return { text: `Opened URL: ${args.url}` };
        }
        case "get_logs": {
            const logs = deviceManager.getLogs({
                platform,
                level: args.level,
                tag: args.tag,
                lines: args.lines ?? 100,
                package: args.package,
            });
            return { text: logs || "(no logs)" };
        }
        case "clear_logs": {
            const result = deviceManager.clearLogs(platform);
            return { text: result };
        }
        case "get_system_info": {
            const info = deviceManager.getSystemInfo(platform);
            return { text: info };
        }
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}
// Create server
const server = new Server({
    name: "claude-mobile",
    version: "2.1.1",
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
    console.error("Claude Mobile MCP server running (Android + iOS)");
}
main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map