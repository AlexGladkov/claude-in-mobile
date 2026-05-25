import type { ToolDefinition } from "./registry.js";
import type { Platform } from "../device-manager.js";
import { validatePackageName, sanitizeForShell, validateUrl } from "../utils/sanitize.js";
import { ValidationError } from "../errors.js";
import { truncateOutput } from "../utils/truncate.js";

// ─── Validation helpers ───────────────────────────────────────────────────────

const INTENT_ACTION_RE = /^[a-zA-Z][a-zA-Z0-9_.]*$/;
const COMPONENT_RE = /^[a-zA-Z][a-zA-Z0-9_.]*\/[a-zA-Z0-9_.]*$/;

function validateIntentAction(action: string): void {
  if (!INTENT_ACTION_RE.test(action)) {
    throw new ValidationError(
      `Invalid intent action: "${action}". Only alphanumeric characters, dots, and underscores are allowed. Must start with a letter.`,
    );
  }
}

function validateComponent(component: string): void {
  if (!COMPONENT_RE.test(component)) {
    throw new ValidationError(
      `Invalid component: "${component}". Expected format: com.example.app/com.example.app.MainActivity`,
    );
  }
}

// ─── Flag mapping ─────────────────────────────────────────────────────────────

const FLAG_MAP: Record<string, number> = {
  FLAG_ACTIVITY_NEW_TASK: 0x10000000,
  FLAG_ACTIVITY_CLEAR_TOP: 0x04000000,
  FLAG_ACTIVITY_SINGLE_TOP: 0x20000000,
  FLAG_ACTIVITY_CLEAR_TASK: 0x00008000,
  FLAG_ACTIVITY_NO_HISTORY: 0x40000000,
  FLAG_ACTIVITY_NO_ANIMATION: 0x00010000,
};

function resolveFlag(flag: string): number {
  // Accept either a named constant or a numeric hex/decimal string
  if (flag in FLAG_MAP) return FLAG_MAP[flag]!;
  const num = Number(flag);
  if (!isNaN(num) && num > 0) return num;
  throw new ValidationError(
    `Unknown flag: "${flag}". Valid flags: ${Object.keys(FLAG_MAP).join(", ")}`,
  );
}

// ─── Extra argument builder ───────────────────────────────────────────────────

interface ExtraItem {
  key: string;
  value: string | number | boolean;
  type?: "string" | "int" | "bool" | "float" | "long" | "uri";
}

const EXTRA_TYPE_FLAG: Record<string, string> = {
  string: "--es",
  int: "--ei",
  bool: "--ez",
  float: "--ef",
  long: "--el",
  uri: "--eu",
};

function buildExtrasArgs(extras: ExtraItem[]): string {
  return extras
    .map(({ key, value, type }) => {
      // Sanitize key — must be safe identifier-like string
      const safeKey = sanitizeForShell(String(key));
      if (!safeKey || safeKey.length === 0) {
        throw new ValidationError(`Extra key must not be empty after sanitization: "${key}"`);
      }

      // Determine type flag, defaulting to type inference
      let flag: string;
      if (type) {
        flag = EXTRA_TYPE_FLAG[type]!;
      } else if (typeof value === "number" && Number.isInteger(value)) {
        flag = "--ei";
      } else if (typeof value === "number") {
        flag = "--ef";
      } else if (typeof value === "boolean") {
        flag = "--ez";
      } else {
        flag = "--es";
      }

      const safeValue = sanitizeForShell(String(value));
      return `${flag} ${safeKey} ${safeValue}`;
    })
    .join(" ");
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export const intentTools: ToolDefinition[] = [
  // ── intent_start ────────────────────────────────────────────────────────────
  {
    tool: {
      name: "intent_start",
      description:
        "Launch an Activity with a structured Android Intent. Supports action, component, data URI, category, typed extras, and activity flags. Android only; use intent_deeplink for iOS.",
      inputSchema: {
        type: "object",
        properties: {
          intentAction: {
            type: "string",
            description:
              "Android Intent action (e.g. 'android.intent.action.VIEW'). Not to be confused with the meta-tool 'action' routing field.",
          },
          component: {
            type: "string",
            description:
              "Explicit component in 'package/activity' format (e.g. 'com.example.app/com.example.app.MainActivity').",
          },
          data: {
            type: "string",
            description: "Data URI for the intent (e.g. 'https://example.com' or 'content://...').",
          },
          category: {
            type: "string",
            description:
              "Intent category (e.g. 'android.intent.category.DEFAULT').",
          },
          extras: {
            type: "array",
            description: "Typed key-value extras to attach to the intent.",
            items: {
              type: "object",
              properties: {
                key: { type: "string", description: "Extra key name." },
                value: {
                  description: "Extra value (string, number, or boolean).",
                },
                type: {
                  type: "string",
                  enum: ["string", "int", "bool", "float", "long", "uri"],
                  description:
                    "Value type for am start flag selection. Inferred from value type when omitted.",
                },
              },
              required: ["key", "value"],
            },
          },
          flags: {
            type: "array",
            description:
              "Activity flags (e.g. ['FLAG_ACTIVITY_NEW_TASK', 'FLAG_ACTIVITY_CLEAR_TOP']).",
            items: { type: "string" },
          },
          package: {
            type: "string",
            description: "Target package name to restrict resolution.",
          },
          platform: {
            type: "string",
            enum: ["android", "ios"],
            description:
              "Target platform. If not specified, uses the active target.",
          },
          deviceId: { type: "string", description: "Target device ID for multi-device. If omitted, uses active device." },
        },
        required: [],
      },
    },
    handler: async (args, ctx) => {
      const deviceId = args.deviceId as string | undefined;
      const platform = (args.platform as Platform | undefined) ?? ctx.deviceManager.getCurrentPlatform();

      if (platform === "ios") {
        // iOS does not support full am start semantics; direct the caller to use intent_deeplink
        return {
          text: "iOS does not support Android-style intent launching. Use intent_deeplink with a URI to open content on iOS via xcrun simctl openurl.",
        };
      }

      if (platform !== "android") {
        return {
          text: `intent_start is only supported on Android (current platform: ${platform}).`,
        };
      }

      const intentAction = args.intentAction as string | undefined;
      const component = args.component as string | undefined;
      const data = args.data as string | undefined;
      const category = args.category as string | undefined;
      const extras = (args.extras as ExtraItem[] | undefined) ?? [];
      const flags = (args.flags as string[] | undefined) ?? [];
      const pkg = args.package as string | undefined;

      // Validate inputs
      if (intentAction) validateIntentAction(intentAction);
      if (component) validateComponent(component);
      if (pkg) validatePackageName(pkg);

      // Build command parts
      const parts: string[] = ["am start"];

      if (intentAction) parts.push(`-a ${intentAction}`);
      if (component) parts.push(`-n ${component}`);
      if (data) {
        const safeData = sanitizeForShell(data);
        parts.push(`-d '${safeData}'`);
      }
      if (category) {
        if (!INTENT_ACTION_RE.test(category)) {
          throw new ValidationError(
            `Invalid category: "${category}". Only alphanumeric characters, dots, and underscores are allowed.`,
          );
        }
        parts.push(`-c ${category}`);
      }
      if (extras.length > 0) {
        parts.push(buildExtrasArgs(extras));
      }
      if (flags.length > 0) {
        // Combine all flags with bitwise OR and pass as a single -f value
        const combined = flags.reduce((acc, f) => acc | resolveFlag(f), 0);
        parts.push(`-f 0x${combined.toString(16)}`);
      }
      if (pkg) parts.push(`-p ${pkg}`);

      const command = parts.join(" ");
      const result = ctx.deviceManager.getAndroidClient(deviceId).shell(command);
      return { text: truncateOutput(result || "Activity launched.") };
    },
  },

  // ── intent_broadcast ────────────────────────────────────────────────────────
  {
    tool: {
      name: "intent_broadcast",
      description:
        "Send an Android broadcast intent. Useful for triggering system events or communicating with broadcast receivers. Android only.",
      inputSchema: {
        type: "object",
        properties: {
          intentAction: {
            type: "string",
            description:
              "Broadcast action string (e.g. 'android.intent.action.BOOT_COMPLETED', 'com.example.MY_EVENT').",
          },
          extras: {
            type: "array",
            description: "Typed key-value extras attached to the broadcast.",
            items: {
              type: "object",
              properties: {
                key: { type: "string", description: "Extra key name." },
                value: {
                  description: "Extra value (string, number, or boolean).",
                },
                type: {
                  type: "string",
                  enum: ["string", "int", "bool", "float", "long", "uri"],
                  description: "Value type override.",
                },
              },
              required: ["key", "value"],
            },
          },
          package: {
            type: "string",
            description: "Target package for explicit broadcasts.",
          },
          component: {
            type: "string",
            description: "Explicit receiver component ('package/receiver').",
          },
          platform: {
            type: "string",
            enum: ["android", "ios"],
            description:
              "Target platform. If not specified, uses the active target.",
          },
          deviceId: { type: "string", description: "Target device ID for multi-device. If omitted, uses active device." },
        },
        required: ["intentAction"],
      },
    },
    handler: async (args, ctx) => {
      const deviceId = args.deviceId as string | undefined;
      const platform = (args.platform as Platform | undefined) ?? ctx.deviceManager.getCurrentPlatform();

      if (platform !== "android") {
        return {
          text: `intent_broadcast is Android-only. Current platform: ${platform}.`,
        };
      }

      const intentAction = args.intentAction as string;
      const extras = (args.extras as ExtraItem[] | undefined) ?? [];
      const pkg = args.package as string | undefined;
      const component = args.component as string | undefined;

      validateIntentAction(intentAction);
      if (pkg) validatePackageName(pkg);
      if (component) validateComponent(component);

      const parts: string[] = ["am broadcast", `-a ${intentAction}`];

      if (component) parts.push(`-n ${component}`);
      if (pkg) parts.push(`-p ${pkg}`);
      if (extras.length > 0) parts.push(buildExtrasArgs(extras));

      const command = parts.join(" ");
      const result = ctx.deviceManager.getAndroidClient(deviceId).shell(command);
      return { text: truncateOutput(result || "Broadcast sent.") };
    },
  },

  // ── intent_deeplink ─────────────────────────────────────────────────────────
  {
    tool: {
      name: "intent_deeplink",
      description:
        "Open a deep link URI on Android or iOS. On Android uses 'am start -a VIEW', on iOS uses 'xcrun simctl openurl'.",
      inputSchema: {
        type: "object",
        properties: {
          uri: {
            type: "string",
            description:
              "Deep link URI to open (e.g. 'https://example.com/path', 'myapp://screen/details').",
          },
          package: {
            type: "string",
            description:
              "Target package to handle the deep link (Android only). Restricts resolution to a specific app.",
          },
          platform: {
            type: "string",
            enum: ["android", "ios"],
            description:
              "Target platform. If not specified, uses the active target.",
          },
          deviceId: { type: "string", description: "Target device ID for multi-device. If omitted, uses active device." },
        },
        required: ["uri"],
      },
    },
    handler: async (args, ctx) => {
      const deviceId = args.deviceId as string | undefined;
      const platform = (args.platform as Platform | undefined) ?? ctx.deviceManager.getCurrentPlatform();
      const uri = args.uri as string;
      const pkg = args.package as string | undefined;

      // Validate URI — allow http/https/custom schemes for deep links
      // Custom schemes (e.g. myapp://) are common; only block shell-injection chars
      const safeUri = sanitizeForShell(uri);
      if (!safeUri || safeUri.length === 0) {
        throw new ValidationError("URI must not be empty or consist solely of blocked characters.");
      }

      if (pkg) validatePackageName(pkg);

      if (platform === "android") {
        const parts: string[] = [
          "am start",
          "-a android.intent.action.VIEW",
          `-d '${safeUri}'`,
        ];
        if (pkg) parts.push(`-p ${pkg}`);

        const command = parts.join(" ");
        const result = ctx.deviceManager.getAndroidClient(deviceId).shell(command);
        return { text: truncateOutput(result || `Deep link opened: ${uri}`) };
      }

      if (platform === "ios") {
        // For http/https URIs validate fully; custom schemes are allowed as-is
        if (uri.startsWith("http://") || uri.startsWith("https://")) {
          validateUrl(uri);
        }
        ctx.deviceManager.getIosClient(deviceId).openUrl(uri);
        return { text: `Deep link opened on iOS: ${uri}` };
      }

      return {
        text: `intent_deeplink is only supported on Android and iOS (current platform: ${platform}).`,
      };
    },
  },

  // ── intent_services ─────────────────────────────────────────────────────────
  {
    tool: {
      name: "intent_services",
      description:
        "List running Android services. Optionally filter by package name. Android only.",
      inputSchema: {
        type: "object",
        properties: {
          package: {
            type: "string",
            description: "Filter results to services belonging to this package.",
          },
          platform: {
            type: "string",
            enum: ["android", "ios"],
            description:
              "Target platform. If not specified, uses the active target.",
          },
          deviceId: { type: "string", description: "Target device ID for multi-device. If omitted, uses active device." },
        },
        required: [],
      },
    },
    handler: async (args, ctx) => {
      const deviceId = args.deviceId as string | undefined;
      const platform = (args.platform as Platform | undefined) ?? ctx.deviceManager.getCurrentPlatform();

      if (platform !== "android") {
        return {
          text: `intent_services is Android-only. Current platform: ${platform}.`,
        };
      }

      const pkg = args.package as string | undefined;
      if (pkg) validatePackageName(pkg);

      const command = pkg
        ? `dumpsys activity services ${pkg}`
        : "dumpsys activity services";

      const raw = ctx.deviceManager.getAndroidClient(deviceId).shell(command);

      // Parse service entries — each block starts with "ServiceRecord{"
      const lines = (raw ?? "").split("\n");
      const serviceLines: string[] = [];
      let inServiceBlock = false;
      let blockDepth = 0;

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed.startsWith("ServiceRecord{")) {
          inServiceBlock = true;
          blockDepth = 0;
          serviceLines.push(trimmed);
          continue;
        }

        if (inServiceBlock) {
          // Track basic indent depth to detect end of block
          if (trimmed.length === 0) {
            blockDepth++;
            if (blockDepth > 2) {
              inServiceBlock = false;
              serviceLines.push("");
            }
            continue;
          }
          blockDepth = 0;
          // Include intent, process, and running info lines
          if (
            trimmed.startsWith("intent=") ||
            trimmed.startsWith("app=") ||
            trimmed.startsWith("baseDir=") ||
            trimmed.startsWith("running=") ||
            trimmed.startsWith("isForeground=") ||
            trimmed.startsWith("startRequested=")
          ) {
            serviceLines.push("  " + trimmed);
          }
        }
      }

      const output = serviceLines.length > 0
        ? serviceLines.join("\n").trim()
        : pkg
          ? `No running services found for package: ${pkg}`
          : "No running services found.";

      return { text: truncateOutput(output) };
    },
  },
];
