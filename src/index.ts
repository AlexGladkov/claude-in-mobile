#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { DeviceManager, Platform } from "./device-manager.js";
import { desktopClient } from "./desktop/client.js";
import { annotateScreenshot } from "./utils/image.js";
import {
  parseUiHierarchy,
  findByText,
  findByResourceId,
  findElements,
  formatUiTree,
  formatElement,
  analyzeScreen,
  findBestMatch,
  formatScreenAnalysis,
  UiElement,
} from "./adb/ui-parser.js";
import { ElementNotFoundError } from "./errors.js";

// Initialize device manager
const deviceManager = new DeviceManager();

// Platform parameter schema (reused across tools)
const platformParam = {
  type: "string",
  enum: ["android", "ios", "desktop", "aurora"],
  description: "Target platform. If not specified, uses the active target.",
};

// Define tools
const tools: Tool[] = [
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
        monitorIndex: {
          type: "number",
          description: "Monitor index for multi-monitor desktop setups (Desktop only). If not specified, captures all monitors.",
        },
      },
    },
  },
  {
    name: "annotate_screenshot",
    description: "Take a screenshot with colored bounding boxes and numbered labels overlaid on UI elements. Green = clickable, Red = non-clickable. Returns annotated image + element index. Useful for visual understanding of UI layout. Android and iOS only.",
    inputSchema: {
      type: "object",
      properties: {
        platform: platformParam,
        maxWidth: {
          type: "number",
          description: "Max width in pixels (default: 800)",
          default: 800,
        },
        maxHeight: {
          type: "number",
          description: "Max height in pixels (default: 1400)",
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
          description: "Android: Element text. iOS: Element name (less reliable than label)",
        },
        label: {
          type: "string",
          description: "iOS only: Accessibility label (most reliable)",
        },
        resourceId: {
          type: "string",
          description: "Find element with this resource ID and tap it (Android only)",
        },
        index: {
          type: "number",
          description: "Tap element by index from get_ui output (Android only)",
        },
        targetPid: {
          type: "number",
          description: "Desktop only: PID of target process. When provided, sends tap without stealing window focus.",
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
        targetPid: {
          type: "number",
          description: "Desktop only: PID of target process. When provided, sends input without stealing window focus.",
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
        targetPid: {
          type: "number",
          description: "Desktop only: PID of target process. When provided, sends key without stealing window focus.",
        },
        platform: platformParam,
      },
      required: ["key"],
    },
  },
  {
    name: "find_element",
    description: "Find UI elements by text, resource ID, or other criteria. Android: resourceId, className. iOS: label (accessibility id)",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Find by text (partial match, case-insensitive)",
        },
        label: {
          type: "string",
          description: "iOS: Find by accessibility label",
        },
        resourceId: {
          type: "string",
          description: "Android: Find by resource ID (partial match)",
        },
        className: {
          type: "string",
          description: "Find by class name (Android: full class, iOS: XCUIElementType*)",
        },
        clickable: {
          type: "boolean",
          description: "Android: Filter by clickable state",
        },
        visible: {
          type: "boolean",
          description: "iOS: Filter by visibility",
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
    name: "grant_permission",
    description: "Grant a permission to an app. Android: runtime permissions (e.g., android.permission.CAMERA). iOS: privacy services (e.g., camera, microphone, photos, location, contacts, calendar, reminders)",
    inputSchema: {
      type: "object",
      properties: {
        package: {
          type: "string",
          description: "Package name (Android) or bundle ID (iOS)",
        },
        permission: {
          type: "string",
          description: "Permission to grant. Android: android.permission.CAMERA, android.permission.ACCESS_FINE_LOCATION, etc. iOS: camera, microphone, photos, location, contacts, calendar, reminders, motion, health, speech-recognition",
        },
        platform: platformParam,
      },
      required: ["package", "permission"],
    },
  },
  {
    name: "revoke_permission",
    description: "Revoke a permission from an app. Android: runtime permissions. iOS: privacy services",
    inputSchema: {
      type: "object",
      properties: {
        package: {
          type: "string",
          description: "Package name (Android) or bundle ID (iOS)",
        },
        permission: {
          type: "string",
          description: "Permission to revoke. Same values as grant_permission",
        },
        platform: platformParam,
      },
      required: ["package", "permission"],
    },
  },
  {
    name: "reset_permissions",
    description: "Reset all permissions for an app. Android: resets runtime permissions. iOS: resets all privacy settings",
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
  // ============ Desktop Tools ============
  {
    name: "set_target",
    description: "Switch the active target between Android, iOS, Desktop, and Aurora platforms",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          enum: ["android", "ios", "desktop", "aurora"],
          description: "Target platform to switch to",
        },
      },
      required: ["target"],
    },
  },
  {
    name: "get_target",
    description: "Get the current active target and its status",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "launch_desktop_app",
    description: "Start desktop automation. Optionally also launches a Compose Desktop application via Gradle.",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: {
          type: "string",
          description: "Path to the Gradle project directory. If provided, also launches the user's app.",
        },
        task: {
          type: "string",
          description: "Gradle task to run (e.g., ':desktopApp:run'). Auto-detected if not specified.",
        },
        jvmArgs: {
          type: "array",
          items: { type: "string" },
          description: "JVM arguments to pass to the app",
        },
      },
    },
  },
  {
    name: "stop_desktop_app",
    description: "Stop the running desktop application",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_window_info",
    description: "Get information about desktop windows (Desktop only)",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "focus_window",
    description: "Focus a specific desktop window (Desktop only)",
    inputSchema: {
      type: "object",
      properties: {
        windowId: {
          type: "string",
          description: "Window ID from get_window_info",
        },
      },
      required: ["windowId"],
    },
  },
  {
    name: "resize_window",
    description: "Resize a desktop window (Desktop only)",
    inputSchema: {
      type: "object",
      properties: {
        windowId: {
          type: "string",
          description: "Window ID (optional, uses focused window if not specified)",
        },
        width: {
          type: "number",
          description: "New window width in pixels",
        },
        height: {
          type: "number",
          description: "New window height in pixels",
        },
      },
      required: ["width", "height"],
    },
  },
  {
    name: "get_clipboard",
    description: "Get clipboard text content (Desktop only)",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "set_clipboard",
    description: "Set clipboard text content (Desktop only)",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Text to set in clipboard",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "get_performance_metrics",
    description: "Get memory and CPU usage metrics (Desktop only)",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_monitors",
    description: "Get list of all connected monitors with their dimensions and positions (Desktop only, multi-monitor support)",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  // ============ Smart Android UI Tools ============
  {
    name: "analyze_screen",
    description: "Get structured analysis of the current screen without taking a screenshot. Returns buttons, input fields, text content, and scrollable areas. Much cheaper than screenshot for understanding screen layout. (Android only)",
    inputSchema: {
      type: "object",
      properties: {
        platform: platformParam,
      },
    },
  },
  {
    name: "find_and_tap",
    description: "Smart tap by element description. Uses fuzzy matching to find the best element by text, content description, or resource ID, then taps it. More reliable than exact text matching. (Android only)",
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "Natural language description of the element to tap, e.g., 'submit button', 'settings', 'back'",
        },
        minConfidence: {
          type: "number",
          description: "Minimum confidence score (0-100) to accept a match (default: 30)",
          default: 30,
        },
        platform: platformParam,
      },
      required: ["description"],
    },
  },
  {
    name: "tap_by_text",
    description: "Tap an element by its text content using Accessibility API. Does NOT move cursor - perfect for background automation. (Desktop/macOS only)",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Text to search for (partial match, case-insensitive)",
        },
        pid: {
          type: "number",
          description: "Process ID of the target application. Get from get_window_info.",
        },
        exactMatch: {
          type: "boolean",
          description: "If true, requires exact text match (default: false)",
          default: false,
        },
      },
      required: ["text", "pid"],
    },
  },
  // ============ Aurora Tools ============
  {
    name: "push_file",
    description: "Upload file to Aurora OS device",
    inputSchema: {
      type: "object",
      properties: {
        platform: { ...platformParam, const: "aurora" },
        localPath: { type: "string", description: "Local file path" },
        remotePath: { type: "string", description: "Remote destination path" },
      },
      required: ["localPath", "remotePath"],
    },
  },
  {
    name: "pull_file",
    description: "Download file from Aurora OS device",
    inputSchema: {
      type: "object",
      properties: {
        platform: { const: "aurora" },
        remotePath: { type: "string", description: "Path to the remote file" },
        localPath: { type: "string", description: "Optional local path" },
      },
      required: ["remotePath"],
    },
  },
  {
    name: "list_apps",
    description: "List installed applications on Aurora OS device",
    inputSchema: {
      type: "object",
      properties: {
        platform: { const: "aurora" },
      },
      required: [],
    },
  },
  // ============ Reliability Tools ============
  {
    name: "wait_for_element",
    description: "Wait for a UI element to appear. Polls the UI hierarchy until the element is found or timeout. Much more reliable than manual wait(ms) for animations and loading.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Element text to wait for (partial match, case-insensitive)",
        },
        resourceId: {
          type: "string",
          description: "Android: resource ID to wait for (partial match)",
        },
        className: {
          type: "string",
          description: "Class name to wait for",
        },
        timeout: {
          type: "number",
          description: "Max wait time in ms (default: 5000)",
          default: 5000,
        },
        interval: {
          type: "number",
          description: "Poll interval in ms (default: 500)",
          default: 500,
        },
        platform: platformParam,
      },
    },
  },
  {
    name: "assert_visible",
    description: "Assert that a UI element is visible on screen. Returns pass/fail without taking a screenshot. Much cheaper than visual verification.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Element text to check for (partial match)",
        },
        resourceId: {
          type: "string",
          description: "Android: resource ID to check for",
        },
        platform: platformParam,
      },
    },
  },
  {
    name: "assert_not_exists",
    description: "Assert that a UI element does NOT exist on screen. Useful for verifying elements were removed, dialogs dismissed, etc.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Element text that should NOT be present",
        },
        resourceId: {
          type: "string",
          description: "Android: resource ID that should NOT be present",
        },
        platform: platformParam,
      },
    },
  },
  {
    name: "batch_commands",
    description: "Execute multiple commands in a single MCP round-trip. Commands run sequentially on the server. 2-4x faster than individual tool calls for multi-step automation.",
    inputSchema: {
      type: "object",
      properties: {
        commands: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Tool name (e.g., 'tap', 'wait', 'input_text')" },
              arguments: { type: "object", description: "Tool arguments" },
            },
            required: ["name"],
          },
          description: "Array of commands to execute sequentially",
        },
        stopOnError: {
          type: "boolean",
          description: "Stop execution on first error (default: true)",
          default: true,
        },
      },
      required: ["commands"],
    },
  },
  {
    name: "get_webview",
    description: "Inspect WebView content in the current Android app via Chrome DevTools Protocol. Lists available WebView pages with their URLs and titles. (Android only)",
    inputSchema: {
      type: "object",
      properties: {
        platform: platformParam,
      },
    },
  },
];

// Per-platform cache for UI elements (to support tap by index)
// Keyed by platform string to avoid cross-device contamination
const cachedElementsMap: Map<string, UiElement[]> = new Map();

function getCachedElements(platform: string): UiElement[] {
  return cachedElementsMap.get(platform) ?? [];
}

function setCachedElements(platform: string, elements: UiElement[]): void {
  cachedElementsMap.set(platform, elements);
}

// Helper to format iOS UI tree
/**
 * Convert iOS accessibility tree (from WDA) to UiElement[] for annotation
 */
function iosTreeToUiElements(tree: any, elements: UiElement[] = [], index = { value: 0 }): UiElement[] {
  if (tree.rect) {
    const x = tree.rect.x ?? 0;
    const y = tree.rect.y ?? 0;
    const w = tree.rect.width ?? 0;
    const h = tree.rect.height ?? 0;

    if (w > 0 && h > 0) {
      elements.push({
        index: index.value++,
        resourceId: tree.identifier ?? "",
        className: tree.type ?? "",
        packageName: "",
        text: tree.label ?? tree.value ?? "",
        contentDesc: tree.name ?? "",
        checkable: false,
        checked: false,
        clickable: tree.enabled !== false && (tree.type?.includes("Button") || tree.type?.includes("Link") || tree.type?.includes("Cell")),
        enabled: tree.enabled !== false,
        focusable: tree.enabled !== false,
        focused: false,
        scrollable: tree.type?.includes("ScrollView") ?? false,
        longClickable: false,
        password: tree.type?.includes("SecureTextField") ?? false,
        selected: tree.selected ?? false,
        bounds: { x1: x, y1: y, x2: x + w, y2: y + h },
        centerX: Math.floor(x + w / 2),
        centerY: Math.floor(y + h / 2),
        width: w,
        height: h,
      });
    }
  }

  if (tree.children) {
    for (const child of tree.children) {
      iosTreeToUiElements(child, elements, index);
    }
  }

  return elements;
}

function formatIOSUITree(tree: any, indent = 0): string {
  const lines: string[] = [];
  const prefix = '  '.repeat(indent);

  if (tree.type) {
    const parts: string[] = [`<${tree.type}>`];

    // Add label (accessibility label)
    if (tree.label) parts.push(`label="${tree.label}"`);

    // Add value (text content)
    if (tree.value) parts.push(`value="${tree.value}"`);

    // Add name (element name/identifier)
    if (tree.name) parts.push(`name="${tree.name}"`);

    // Add identifier (accessibility id)
    if (tree.identifier) parts.push(`id="${tree.identifier}"`);

    // Add enabled state
    if (tree.enabled !== undefined) parts.push(`enabled=${tree.enabled}`);

    // Add coordinates
    if (tree.rect) parts.push(`@ (${tree.rect.x}, ${tree.rect.y})`);

    lines.push(`${prefix}${parts.join(' ')}`);
  }

  if (tree.children) {
    for (const child of tree.children) {
      lines.push(formatIOSUITree(child, indent + 1));
    }
  }

  return lines.join('\n');
}

// Tool handlers
async function handleTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const platform = args.platform as Platform | undefined;

  switch (name) {
    case "list_devices": {
      const devices = deviceManager.getDevices(platform);
      if (devices.length === 0) {
        return { text: "No devices connected. Make sure ADB/Xcode is running and a device/emulator/simulator is connected." };
      }

      const activeDevice = deviceManager.getActiveDevice();
      const { target: activeTarget } = deviceManager.getTarget();

      // Group by platform
      const android = devices.filter(d => d.platform === "android");
      const ios = devices.filter(d => d.platform === "ios");
      const desktop = devices.filter(d => d.platform === "desktop");
      const aurora = devices.filter(d => d.platform === "aurora");

      let result = "Connected devices:\n";

      if (android.length > 0) {
        result += "\nAndroid:\n";
        for (const d of android) {
          const active = activeDevice?.id === d.id && activeTarget === "android" ? " [ACTIVE]" : "";
          const type = d.isSimulator ? "emulator" : "physical";
          result += `  • ${d.id} - ${d.name} (${type}, ${d.state})${active}\n`;
        }
      }

      if (ios.length > 0) {
        result += "\niOS:\n";
        for (const d of ios) {
          const active = activeDevice?.id === d.id && activeTarget === "ios" ? " [ACTIVE]" : "";
          const type = d.isSimulator ? "simulator" : "physical";
          result += `  • ${d.id} - ${d.name} (${type}, ${d.state})${active}\n`;
        }
      }

      if (desktop.length > 0) {
        result += "\nDesktop:\n";
        for (const d of desktop) {
          const active = activeTarget === "desktop" ? " [ACTIVE]" : "";
          result += `  • ${d.id} - ${d.name} (${d.state})${active}\n`;
        }
      }

      if (aurora.length > 0) {
        result += "\nAurora:\n";
        for (const d of aurora) {
          const active = activeDevice?.id === d.id && activeTarget === "aurora" ? " [ACTIVE]" : "";
          result += `  • ${d.id} - ${d.name} (${d.state})${active}\n`;
        }
      }

      return { text: result.trim() };
    }

    case "set_device": {
      const device = deviceManager.setDevice(args.deviceId as string, platform);
      return { text: `Device set to: ${device.name} (${device.platform}, ${device.id})` };
    }

    case "screenshot": {
      const compress = args.compress !== false;
      const options = {
        maxWidth: args.maxWidth as number | undefined,
        maxHeight: args.maxHeight as number | undefined,
        quality: args.quality as number | undefined,
        monitorIndex: args.monitorIndex as number | undefined,
      };
      const result = await deviceManager.screenshot(platform, compress, options);
      return {
        image: {
          data: result.data,
          mimeType: result.mimeType,
        },
      };
    }

    case "annotate_screenshot": {
      const currentPlat = platform ?? deviceManager.getCurrentPlatform();
      if (currentPlat === "desktop") {
        return { text: "annotate_screenshot is not supported for desktop platform. Use screenshot + get_ui instead." };
      }

      // Get raw screenshot buffer (async for Android)
      const pngBuffer = await deviceManager.getScreenshotBufferAsync(currentPlat);

      // Get UI elements
      let uiElements: UiElement[] = [];
      if (currentPlat === "android" || !currentPlat) {
        const xml = await deviceManager.getUiHierarchyAsync("android");
        uiElements = parseUiHierarchy(xml);
      } else if (currentPlat === "ios") {
        try {
          const json = await deviceManager.getUiHierarchy("ios");
          const tree = JSON.parse(json);
          uiElements = iosTreeToUiElements(tree);
        } catch {
          // Fall back to screenshot only
        }
      }

      if (uiElements.length === 0) {
        // No UI elements available, return plain screenshot
        const result = await deviceManager.screenshot(currentPlat, true, {
          maxWidth: args.maxWidth as number | undefined,
          maxHeight: args.maxHeight as number | undefined,
          quality: args.quality as number | undefined,
        });
        return {
          image: { data: result.data, mimeType: result.mimeType },
          text: "No UI elements found to annotate. Returning plain screenshot.",
        };
      }

      const annotResult = await annotateScreenshot(pngBuffer, uiElements, {
        maxWidth: args.maxWidth as number | undefined,
        maxHeight: args.maxHeight as number | undefined,
        quality: args.quality as number | undefined,
      });

      const elementsList = annotResult.elements
        .map(el => `  ${el.index}: ${el.clickable ? "[clickable] " : ""}${el.label} @ (${el.center.x}, ${el.center.y})`)
        .join("\n");

      return {
        image: {
          data: annotResult.image.data,
          mimeType: annotResult.image.mimeType,
        },
        text: `Annotated ${annotResult.elements.length} elements:\n${elementsList}`,
      };
    }

    case "get_ui": {
      const currentPlatform = platform ?? deviceManager.getCurrentPlatform();

      if (currentPlatform === "ios") {
        try {
          const json = await deviceManager.getUiHierarchy("ios");
          const tree = JSON.parse(json);
          const formatted = formatIOSUITree(tree);
          return { text: formatted };
        } catch (error: any) {
          return {
            text: `iOS UI inspection requires WebDriverAgent.\n\n` +
                  `Install: npm install -g appium && appium driver install xcuitest\n\n` +
                  `Error: ${error.message}`
          };
        }
      }

      // Desktop returns pre-formatted text from DeviceManager
      const xml = await deviceManager.getUiHierarchyAsync(platform);

      if (currentPlatform === "desktop") {
        return { text: xml };
      }

      // Android: parse XML and format
      const parsedElements = parseUiHierarchy(xml);
      setCachedElements("android", parsedElements);
      const tree = formatUiTree(parsedElements, {
        showAll: args.showAll as boolean,
      });
      return { text: tree };
    }

    case "tap": {
      let x: number | undefined = args.x as number;
      let y: number | undefined = args.y as number;
      const currentPlatform = platform ?? deviceManager.getCurrentPlatform();

      // iOS element-based tap (precedence: label > text > coordinates)
      if (currentPlatform === "ios" && (args.label || args.text)) {
        try {
          const iosClient = deviceManager.getIosClient();
          const element = await iosClient.findElement({
            text: args.text as string,
            label: args.label as string
          });
          await iosClient.tapElement(element.ELEMENT);
          return { text: `Tapped element: ${args.label || args.text}` };
        } catch (error: any) {
          return { text: `Element not found: ${args.label || args.text}\n${error.message}` };
        }
      }

      // Find by index from cached elements (Android only)
      if (args.index !== undefined && currentPlatform === "android") {
        const idx = args.index as number;
        let elements = getCachedElements("android");
        if (elements.length === 0) {
          const xml = await deviceManager.getUiHierarchyAsync("android");
          elements = parseUiHierarchy(xml);
          setCachedElements("android", elements);
        }
        const el = elements.find(e => e.index === idx);
        if (!el) {
          return { text: `Element with index ${idx} not found. Run get_ui first.` };
        }
        x = el.centerX;
        y = el.centerY;
      }

      // Find by text or resourceId (Android only)
      if ((args.text || args.resourceId) && currentPlatform === "android") {
        const xml = await deviceManager.getUiHierarchyAsync("android");
        const elements = parseUiHierarchy(xml);
        setCachedElements("android", elements);

        let found: UiElement[] = [];
        if (args.text) {
          found = findByText(elements, args.text as string);
        } else if (args.resourceId) {
          found = findByResourceId(elements, args.resourceId as string);
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
        return { text: "Please provide x,y coordinates, text, resourceId, label, or index" };
      }

      const targetPid = args.targetPid as number | undefined;
      await deviceManager.tap(x, y, platform, targetPid);
      return { text: `Tapped at (${x}, ${y})` };
    }

    case "long_press": {
      let x: number | undefined = args.x as number;
      let y: number | undefined = args.y as number;
      const duration = (args.duration as number) ?? 1000;
      const currentPlatform = platform ?? deviceManager.getCurrentPlatform();

      if (args.text && currentPlatform === "android") {
        const xml = await deviceManager.getUiHierarchyAsync("android");
        const elements = parseUiHierarchy(xml);
        setCachedElements("android", elements);
        const found = findByText(elements, args.text as string);
        if (found.length === 0) {
          return { text: `Element not found: ${args.text}` };
        }
        x = found[0].centerX;
        y = found[0].centerY;
      }

      if (x === undefined || y === undefined) {
        return { text: "Please provide x,y coordinates or text" };
      }

      await deviceManager.longPress(x, y, duration, platform);
      return { text: `Long pressed at (${x}, ${y}) for ${duration}ms` };
    }

    case "swipe": {
      if (args.direction) {
        await deviceManager.swipeDirection(args.direction as "up" | "down" | "left" | "right", platform);
        return { text: `Swiped ${args.direction}` };
      }

      if (args.x1 !== undefined && args.y1 !== undefined &&
          args.x2 !== undefined && args.y2 !== undefined) {
        const duration = (args.duration as number) ?? 300;
        await deviceManager.swipe(
          args.x1 as number,
          args.y1 as number,
          args.x2 as number,
          args.y2 as number,
          duration,
          platform
        );
        return { text: `Swiped from (${args.x1}, ${args.y1}) to (${args.x2}, ${args.y2})` };
      }

      return { text: "Please provide direction or x1,y1,x2,y2 coordinates" };
    }

    case "input_text": {
      const targetPid = args.targetPid as number | undefined;
      await deviceManager.inputText(args.text as string, platform, targetPid);
      return { text: `Entered text: "${args.text}"` };
    }

    case "press_key": {
      const targetPid = args.targetPid as number | undefined;
      await deviceManager.pressKey(args.key as string, platform, targetPid);
      return { text: `Pressed key: ${args.key}` };
    }

    case "find_element": {
      const currentPlatform = platform ?? deviceManager.getCurrentPlatform();

      if (currentPlatform === "ios") {
        try {
          const iosClient = deviceManager.getIosClient();
          const elements = await iosClient.findElements({
            text: args.text as string,
            label: args.label as string,
            type: args.className as string,
            visible: args.visible as boolean
          });

          if (elements.length === 0) {
            return { text: "No elements found" };
          }

          const list = elements.slice(0, 20).map((el, i) =>
            `[${i}] <${el.type}> "${el.label}" @ (${el.rect.x}, ${el.rect.y})`
          ).join('\n');

          return { text: `Found ${elements.length} element(s):\n${list}` };
        } catch (error: any) {
          return {
            text: `Find element failed: ${error.message}\n\n` +
                  `Make sure WebDriverAgent is installed (see get_ui error for details)`
          };
        }
      }

      const xml = await deviceManager.getUiHierarchyAsync("android");
      const parsedEls = parseUiHierarchy(xml);
      setCachedElements("android", parsedEls);

      const found = findElements(parsedEls, {
        text: args.text as string | undefined,
        resourceId: args.resourceId as string | undefined,
        className: args.className as string | undefined,
        clickable: args.clickable as boolean | undefined,
      });

      if (found.length === 0) {
        return { text: "No elements found matching criteria" };
      }

      const list = found.slice(0, 20).map(formatElement).join("\n");
      return { text: `Found ${found.length} element(s):\n${list}${found.length > 20 ? "\n..." : ""}` };
    }

    case "launch_app": {
      const result = deviceManager.launchApp(args.package as string, platform);
      return { text: result };
    }

    case "stop_app": {
      deviceManager.stopApp(args.package as string, platform);
      return { text: `Stopped: ${args.package}` };
    }

    case "install_app": {
      const result = deviceManager.installApp(args.path as string, platform);
      return { text: result };
    }

    case "grant_permission": {
      const result = deviceManager.grantPermission(
        args.package as string,
        args.permission as string,
        platform
      );
      return { text: result };
    }

    case "revoke_permission": {
      const result = deviceManager.revokePermission(
        args.package as string,
        args.permission as string,
        platform
      );
      return { text: result };
    }

    case "reset_permissions": {
      const result = deviceManager.resetPermissions(
        args.package as string,
        platform
      );
      return { text: result };
    }

    case "list_apps": {
      if (platform !== "aurora") {
        return { text: "list_apps is only available for Aurora OS." };
      }
      const packages = deviceManager.getAuroraClient().listPackages();
      return { text: `Installed packages (${packages.length}):\n${packages.join("\n")}` };
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
      const output = deviceManager.shell(args.command as string, platform);
      return { text: output || "(no output)" };
    }

    case "wait": {
      const ms = (args.ms as number) ?? 1000;
      await new Promise(resolve => setTimeout(resolve, ms));
      return { text: `Waited ${ms}ms` };
    }

    case "open_url": {
      const currentPlatform = platform ?? deviceManager.getCurrentPlatform();

      if (currentPlatform === "android") {
        deviceManager.getAndroidClient().shell(`am start -a android.intent.action.VIEW -d "${args.url}"`);
      } else {
        deviceManager.getIosClient().openUrl(args.url as string);
      }
      return { text: `Opened URL: ${args.url}` };
    }

    case "get_logs": {
      const logs = deviceManager.getLogs({
        platform,
        level: args.level as string | undefined,
        tag: args.tag as string | undefined,
        lines: (args.lines as number) ?? 100,
        package: args.package as string | undefined,
      });
      return { text: logs || "(no logs)" };
    }

    case "clear_logs": {
      const result = deviceManager.clearLogs(platform);
      return { text: result };
    }

    case "get_system_info": {
      const info = await deviceManager.getSystemInfo(platform);
      return { text: info };
    }

    // ============ Desktop Tools ============

    case "set_target": {
      const target = args.target as Platform;
      deviceManager.setTarget(target);
      return { text: `Target set to: ${target}` };
    }

    case "get_target": {
      const { target, status } = deviceManager.getTarget();
      return { text: `Current target: ${target} (${status})` };
    }

    case "launch_desktop_app": {
      const result = await deviceManager.launchDesktopApp({
        projectPath: args.projectPath as string | undefined,
        task: args.task as string | undefined,
        jvmArgs: args.jvmArgs as string[] | undefined,
      });
      return { text: result };
    }

    case "stop_desktop_app": {
      await deviceManager.stopDesktopApp();
      return { text: "Desktop app stopped" };
    }

    case "get_window_info": {
      if (!deviceManager.isDesktopRunning()) {
        return { text: "Desktop app is not running. Use launch_desktop_app first." };
      }
      const windowInfo = await deviceManager.getDesktopClient().getWindowInfo();
      if (windowInfo.windows.length === 0) {
        return { text: "No windows found" };
      }
      let result = "Desktop windows:\n";
      for (const w of windowInfo.windows) {
        const focused = w.focused ? " [FOCUSED]" : "";
        const pid = (w as any).processId ? ` PID:${(w as any).processId}` : "";
        result += `  • ${w.id} - ${w.title}${focused}${pid} (${w.bounds.width}x${w.bounds.height})\n`;
      }
      return { text: result.trim() };
    }

    case "focus_window": {
      if (!deviceManager.isDesktopRunning()) {
        return { text: "Desktop app is not running. Use launch_desktop_app first." };
      }
      await deviceManager.getDesktopClient().focusWindow(args.windowId as string);
      return { text: `Focused window: ${args.windowId}` };
    }

    case "resize_window": {
      if (!deviceManager.isDesktopRunning()) {
        return { text: "Desktop app is not running. Use launch_desktop_app first." };
      }
      await deviceManager.getDesktopClient().resizeWindow(
        args.width as number,
        args.height as number,
        args.windowId as string | undefined
      );
      return { text: `Resized window to ${args.width}x${args.height}` };
    }

    case "get_clipboard": {
      if (!deviceManager.isDesktopRunning()) {
        return { text: "Desktop app is not running. Use launch_desktop_app first." };
      }
      const clipboardText = await deviceManager.getDesktopClient().getClipboard();
      return { text: clipboardText || "(empty)" };
    }

    case "set_clipboard": {
      if (!deviceManager.isDesktopRunning()) {
        return { text: "Desktop app is not running. Use launch_desktop_app first." };
      }
      await deviceManager.getDesktopClient().setClipboard(args.text as string);
      return { text: "Clipboard set" };
    }

    case "get_performance_metrics": {
      if (!deviceManager.isDesktopRunning()) {
        return { text: "Desktop app is not running. Use launch_desktop_app first." };
      }
      const metrics = await deviceManager.getDesktopClient().getPerformanceMetrics();
      let result = "Performance metrics:\n";
      result += `  Memory: ${metrics.memoryUsageMb} MB\n`;
      if (metrics.cpuPercent !== undefined) {
        result += `  CPU: ${metrics.cpuPercent}%\n`;
      }
      return { text: result.trim() };
    }

    case "get_monitors": {
      if (!deviceManager.isDesktopRunning()) {
        return { text: "Desktop app is not running. Use launch_desktop_app first." };
      }
      const monitors = await deviceManager.getDesktopClient().getMonitors();
      if (monitors.length === 0) {
        return { text: "No monitors found" };
      }
      let result = `Connected monitors (${monitors.length}):\n`;
      for (const m of monitors) {
        const primary = m.isPrimary ? " [PRIMARY]" : "";
        result += `  • Monitor ${m.index}${primary}: ${m.width}x${m.height} at (${m.x}, ${m.y}) - ${m.name}\n`;
      }
      return { text: result.trim() };
    }

    // ============ Smart Android UI Tools ============

    case "analyze_screen": {
      const currentPlatform = platform ?? deviceManager.getCurrentPlatform();

      if (currentPlatform !== "android") {
        return { text: "analyze_screen is only available for Android. Use screenshot for iOS/Desktop." };
      }

      const xml = await deviceManager.getUiHierarchyAsync("android");
      const screenElements = parseUiHierarchy(xml);
      setCachedElements("android", screenElements);

      // Get current activity for context
      let activity: string | undefined;
      try {
        activity = deviceManager.getAndroidClient().getCurrentActivity();
      } catch {
        // Ignore - activity is optional
      }

      const analysis = analyzeScreen(screenElements, activity);
      return { text: formatScreenAnalysis(analysis) };
    }

    case "find_and_tap": {
      const currentPlatform = platform ?? deviceManager.getCurrentPlatform();

      if (currentPlatform !== "android") {
        return { text: "find_and_tap is only available for Android. Use tap with coordinates for iOS/Desktop." };
      }

      const description = args.description as string;
      const minConfidence = (args.minConfidence as number) ?? 30;

      // Get fresh UI hierarchy
      const xml = await deviceManager.getUiHierarchyAsync("android");
      const tapElements = parseUiHierarchy(xml);
      setCachedElements("android", tapElements);

      // Find best matching element
      const match = findBestMatch(tapElements, description);

      if (!match) {
        return { text: `No element found matching "${description}". Try using get_ui or analyze_screen to see available elements.` };
      }

      if (match.confidence < minConfidence) {
        return {
          text: `Best match has low confidence (${match.confidence}%): ${match.reason}\n` +
                `Element: ${formatElement(match.element)}\n` +
                `Set minConfidence lower or use tap with coordinates.`
        };
      }

      // Tap the element
      await deviceManager.tap(match.element.centerX, match.element.centerY, "android");

      return {
        text: `Tapped "${description}" (${match.confidence}% confidence)\n` +
              `Match: ${match.reason}\n` +
              `Coordinates: (${match.element.centerX}, ${match.element.centerY})`
      };
    }

    case "tap_by_text": {
      const currentPlatform = platform ?? deviceManager.getCurrentPlatform();

      if (currentPlatform !== "desktop") {
        return { text: "tap_by_text is only available for Desktop (macOS). Use find_and_tap for Android or tap with coordinates for iOS." };
      }

      const text = args.text as string;
      const pid = args.pid as number;
      const exactMatch = (args.exactMatch as boolean) ?? false;

      if (!text) {
        return { text: "Missing required parameter: text" };
      }
      if (!pid) {
        return { text: "Missing required parameter: pid. Use get_window_info to find the process ID." };
      }

      const result = await desktopClient.tapByText(text, pid, exactMatch);

      if (result.success) {
        return {
          text: `✅ Tapped "${text}" (element: ${result.elementRole ?? "unknown"})\n` +
                `Cursor was NOT moved - background automation successful.`
        };
      } else {
        return {
          text: `❌ Failed to tap "${text}": ${result.error}`
        };
      }
    }

    // ============ Aurora Tools ============

    case "push_file": {
      const result = await deviceManager.getAuroraClient().pushFile(
        args.localPath as string,
        args.remotePath as string
      );
      return { text: result };
    }

    case "pull_file": {
      const buffer = await deviceManager.getAuroraClient().pullFile(
        args.remotePath as string,
        args.localPath as string | undefined
      );
      return { text: `Downloaded ${args.remotePath} (${buffer.length} bytes)` };
    }

    // ============ Reliability & Batch Tools ============

    case "wait_for_element": {
      const currentPlatform = platform ?? deviceManager.getCurrentPlatform();
      const timeout = (args.timeout as number) ?? 5000;
      const interval = (args.interval as number) ?? 500;
      const searchText = args.text as string | undefined;
      const searchId = args.resourceId as string | undefined;
      const searchClass = args.className as string | undefined;

      if (!searchText && !searchId && !searchClass) {
        return { text: "Provide at least one search criteria: text, resourceId, or className" };
      }

      const startTime = Date.now();
      let lastElements: UiElement[] = [];

      while (Date.now() - startTime < timeout) {
        try {
          if (currentPlatform === "android") {
            const xml = await deviceManager.getUiHierarchyAsync("android");
            lastElements = parseUiHierarchy(xml);
            setCachedElements("android", lastElements);
          } else if (currentPlatform === "ios") {
            const json = await deviceManager.getUiHierarchyAsync("ios");
            const tree = JSON.parse(json);
            lastElements = iosTreeToUiElements(tree);
          }

          const found = findElements(lastElements, {
            text: searchText,
            resourceId: searchId,
            className: searchClass,
          });

          if (found.length > 0) {
            const elapsed = Date.now() - startTime;
            return {
              text: `Element found after ${elapsed}ms:\n${formatElement(found[0])}\n` +
                    (found.length > 1 ? `(${found.length} total matches)` : "")
            };
          }
        } catch {
          // UI hierarchy not available yet, keep polling
        }

        await new Promise(resolve => setTimeout(resolve, interval));
      }

      return { text: `Timeout after ${timeout}ms: element not found (text=${searchText ?? ""}, resourceId=${searchId ?? ""}, className=${searchClass ?? ""})` };
    }

    case "assert_visible": {
      const currentPlatform = platform ?? deviceManager.getCurrentPlatform();
      const searchText = args.text as string | undefined;
      const searchId = args.resourceId as string | undefined;

      if (!searchText && !searchId) {
        return { text: "Provide text or resourceId to assert" };
      }

      let elements: UiElement[] = [];
      if (currentPlatform === "android") {
        const xml = await deviceManager.getUiHierarchyAsync("android");
        elements = parseUiHierarchy(xml);
        setCachedElements("android", elements);
      } else if (currentPlatform === "ios") {
        const json = await deviceManager.getUiHierarchyAsync("ios");
        const tree = JSON.parse(json);
        elements = iosTreeToUiElements(tree);
      }

      const found = findElements(elements, {
        text: searchText,
        resourceId: searchId,
      });

      if (found.length > 0) {
        return { text: `PASS: Element visible — ${formatElement(found[0])}` };
      }
      return { text: `FAIL: Element not visible (text=${searchText ?? ""}, resourceId=${searchId ?? ""})` };
    }

    case "assert_not_exists": {
      const currentPlatform = platform ?? deviceManager.getCurrentPlatform();
      const searchText = args.text as string | undefined;
      const searchId = args.resourceId as string | undefined;

      if (!searchText && !searchId) {
        return { text: "Provide text or resourceId to assert absence" };
      }

      let elements: UiElement[] = [];
      if (currentPlatform === "android") {
        const xml = await deviceManager.getUiHierarchyAsync("android");
        elements = parseUiHierarchy(xml);
        setCachedElements("android", elements);
      } else if (currentPlatform === "ios") {
        const json = await deviceManager.getUiHierarchyAsync("ios");
        const tree = JSON.parse(json);
        elements = iosTreeToUiElements(tree);
      }

      const found = findElements(elements, {
        text: searchText,
        resourceId: searchId,
      });

      if (found.length === 0) {
        return { text: `PASS: Element not present (text=${searchText ?? ""}, resourceId=${searchId ?? ""})` };
      }
      return { text: `FAIL: Element exists — ${formatElement(found[0])}` };
    }

    case "batch_commands": {
      const commands = args.commands as Array<{ name: string; arguments?: Record<string, unknown> }>;
      const stopOnError = args.stopOnError !== false;

      if (!commands || commands.length === 0) {
        return { text: "No commands provided" };
      }

      const results: Array<{ command: string; success: boolean; result: string }> = [];

      for (const cmd of commands) {
        try {
          const result = await handleTool(cmd.name, cmd.arguments ?? {});
          const text = typeof result === "object" && result !== null && "text" in result
            ? (result as { text: string }).text
            : JSON.stringify(result);

          results.push({ command: cmd.name, success: true, result: text });
        } catch (error: any) {
          results.push({ command: cmd.name, success: false, result: error.message });
          if (stopOnError) {
            break;
          }
        }
      }

      const output = results.map((r, i) =>
        `${i + 1}. ${r.command}: ${r.success ? "OK" : "ERROR"} — ${r.result}`
      ).join("\n");

      const failed = results.filter(r => !r.success).length;
      const summary = failed > 0
        ? `Batch: ${results.length}/${commands.length} executed, ${failed} failed`
        : `Batch: ${results.length} commands OK`;

      return { text: `${summary}\n\n${output}` };
    }

    case "get_webview": {
      const currentPlatform = platform ?? deviceManager.getCurrentPlatform();

      if (currentPlatform !== "android") {
        return { text: "get_webview is only available for Android." };
      }

      try {
        const inspector = deviceManager.getWebViewInspector();
        const result = await inspector.inspect();

        let output = `WebView sockets found: ${result.sockets.join(", ")}\n`;
        output += `Forwarded to port: ${result.forwardedPort}\n\n`;

        if (result.targets.length === 0) {
          output += "No active pages found in WebView.";
        } else {
          output += `Pages (${result.targets.length}):\n`;
          for (const target of result.targets) {
            output += `  • [${target.type}] "${target.title}"\n`;
            output += `    URL: ${target.url}\n`;
            output += `    ID: ${target.id}\n`;
          }
        }

        return { text: output };
      } catch (error: any) {
        return { text: `WebView inspection failed: ${error.message}` };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Create server
const server = new Server(
  {
    name: "claude-mobile",
    version: "2.11.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handle tool list request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool call request
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const result = await handleTool(name, args ?? {});

    // Handle image response (optionally with text)
    if (typeof result === "object" && result !== null && "image" in result) {
      const img = (result as { image: { data: string; mimeType: string }; text?: string }).image;
      const text = (result as { text?: string }).text;
      const content: Array<{ type: string; data?: string; mimeType?: string; text?: string }> = [
        {
          type: "image",
          data: img.data,
          mimeType: img.mimeType,
        },
      ];
      if (text) {
        content.push({ type: "text", text });
      }
      return { content };
    }

    // Handle text response
    const text = typeof result === "object" && result !== null && "text" in result
      ? (result as { text: string }).text
      : JSON.stringify(result);

    return {
      content: [
        {
          type: "text",
          text,
        },
      ],
    };
  } catch (error: any) {
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
  console.error("Claude Mobile MCP server running (Android + iOS + Desktop + Aurora)");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
