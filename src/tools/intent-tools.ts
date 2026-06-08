import type { ToolDefinition } from "./registry.js";
import { defineTool, z } from "./define-tool.js";
import { validatePackageName, sanitizeForShell, validateUrl } from "../utils/sanitize.js";
import { ValidationError } from "../errors.js";
import { truncateOutput } from "../utils/truncate.js";
import { parseCommonArgs } from "../utils/parse-common-args.js";
import { textResult } from "../utils/tool-result.js";

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
      const safeKey = sanitizeForShell(String(key));
      if (!safeKey || safeKey.length === 0) {
        throw new ValidationError(`Extra key must not be empty after sanitization: "${key}"`);
      }

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

// ─── Schema helpers ───────────────────────────────────────────────────────────

const platformEnum = z
  .enum(["android", "ios", "desktop", "aurora", "browser"])
  .describe("Target platform. If not specified, uses the active target.")
  .optional();

const deviceIdField = z
  .string()
  .describe("Target device ID for multi-device. If omitted, uses active device.")
  .optional();

const extraItemSchema = z.object({
  key: z.string().describe("Extra key name."),
  value: z.union([z.string(), z.number(), z.boolean()]).describe(
    "Extra value (string, number, or boolean).",
  ),
  type: z
    .enum(["string", "int", "bool", "float", "long", "uri"])
    .optional()
    .describe("Value type for am start flag selection. Inferred from value type when omitted."),
});

// ─── Tool definitions ─────────────────────────────────────────────────────────

export const intentTools: ToolDefinition[] = [
  defineTool({
    name: "intent_start",
    description:
      "Launch an Activity with a structured Android Intent. Supports action, component, data URI, category, typed extras, and activity flags. Android only; use intent_deeplink for iOS.",
    schema: z.object({
      intentAction: z
        .string()
        .optional()
        .describe(
          "Android Intent action (e.g. 'android.intent.action.VIEW'). Not to be confused with the meta-tool 'action' routing field.",
        ),
      component: z
        .string()
        .optional()
        .describe(
          "Explicit component in 'package/activity' format (e.g. 'com.example.app/com.example.app.MainActivity').",
        ),
      data: z
        .string()
        .optional()
        .describe("Data URI for the intent (e.g. 'https://example.com' or 'content://...')."),
      category: z
        .string()
        .optional()
        .describe("Intent category (e.g. 'android.intent.category.DEFAULT')."),
      extras: z
        .array(extraItemSchema)
        .optional()
        .describe("Typed key-value extras to attach to the intent."),
      flags: z
        .array(z.string())
        .optional()
        .describe("Activity flags (e.g. ['FLAG_ACTIVITY_NEW_TASK', 'FLAG_ACTIVITY_CLEAR_TOP'])."),
      package: z.string().optional().describe("Target package name to restrict resolution."),
      platform: platformEnum,
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);

      if (platform === "ios") {
        return textResult(
          "iOS does not support Android-style intent launching. Use intent_deeplink with a URI to open content on iOS via xcrun simctl openurl.",
        );
      }

      if (platform !== "android") {
        return textResult(
          `intent_start is only supported on Android (current platform: ${platform}).`,
        );
      }

      const intentAction = args.intentAction;
      const component = args.component;
      const data = args.data;
      const category = args.category;
      const extras = (args.extras as ExtraItem[] | undefined) ?? [];
      const flags = args.flags ?? [];
      const pkg = args.package;

      if (intentAction) validateIntentAction(intentAction);
      if (component) validateComponent(component);
      if (pkg) validatePackageName(pkg);

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
        const combined = flags.reduce((acc, f) => acc | resolveFlag(f), 0);
        parts.push(`-f 0x${combined.toString(16)}`);
      }
      if (pkg) parts.push(`-p ${pkg}`);

      const command = parts.join(" ");
      const result = ctx.deviceManager.getAndroidClient(deviceId).shell(command);
      return textResult(truncateOutput(result || "Activity launched."));
    },
  }),

  defineTool({
    name: "intent_broadcast",
    description:
      "Send an Android broadcast intent. Useful for triggering system events or communicating with broadcast receivers. Android only.",
    schema: z.object({
      intentAction: z
        .string()
        .describe(
          "Broadcast action string (e.g. 'android.intent.action.BOOT_COMPLETED', 'com.example.MY_EVENT').",
        ),
      extras: z
        .array(extraItemSchema)
        .optional()
        .describe("Typed key-value extras attached to the broadcast."),
      package: z.string().optional().describe("Target package for explicit broadcasts."),
      component: z
        .string()
        .optional()
        .describe("Explicit receiver component ('package/receiver')."),
      platform: platformEnum,
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);

      if (platform !== "android") {
        return textResult(`intent_broadcast is Android-only. Current platform: ${platform}.`);
      }

      const intentAction = args.intentAction;
      const extras = (args.extras as ExtraItem[] | undefined) ?? [];
      const pkg = args.package;
      const component = args.component;

      validateIntentAction(intentAction);
      if (pkg) validatePackageName(pkg);
      if (component) validateComponent(component);

      const parts: string[] = ["am broadcast", `-a ${intentAction}`];

      if (component) parts.push(`-n ${component}`);
      if (pkg) parts.push(`-p ${pkg}`);
      if (extras.length > 0) parts.push(buildExtrasArgs(extras));

      const command = parts.join(" ");
      const result = ctx.deviceManager.getAndroidClient(deviceId).shell(command);
      return textResult(truncateOutput(result || "Broadcast sent."));
    },
  }),

  defineTool({
    name: "intent_deeplink",
    description:
      "Open a deep link URI on Android or iOS. On Android uses 'am start -a VIEW', on iOS uses 'xcrun simctl openurl'.",
    schema: z.object({
      uri: z
        .string()
        .describe(
          "Deep link URI to open (e.g. 'https://example.com/path', 'myapp://screen/details').",
        ),
      package: z
        .string()
        .optional()
        .describe(
          "Target package to handle the deep link (Android only). Restricts resolution to a specific app.",
        ),
      platform: platformEnum,
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const uri = args.uri;
      const pkg = args.package;

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
        return textResult(truncateOutput(result || `Deep link opened: ${uri}`));
      }

      if (platform === "ios") {
        if (uri.startsWith("http://") || uri.startsWith("https://")) {
          validateUrl(uri);
        }
        ctx.deviceManager.getIosClient(deviceId).openUrl(uri);
        return textResult(`Deep link opened on iOS: ${uri}`);
      }

      return textResult(
        `intent_deeplink is only supported on Android and iOS (current platform: ${platform}).`,
      );
    },
  }),

  defineTool({
    name: "intent_services",
    description:
      "List running Android services. Optionally filter by package name. Android only.",
    schema: z.object({
      package: z
        .string()
        .optional()
        .describe("Filter results to services belonging to this package."),
      platform: platformEnum,
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);

      if (platform !== "android") {
        return textResult(`intent_services is Android-only. Current platform: ${platform}.`);
      }

      const pkg = args.package;
      if (pkg) validatePackageName(pkg);

      const command = pkg
        ? `dumpsys activity services ${pkg}`
        : "dumpsys activity services";

      const raw = ctx.deviceManager.getAndroidClient(deviceId).shell(command);

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
          if (trimmed.length === 0) {
            blockDepth++;
            if (blockDepth > 2) {
              inServiceBlock = false;
              serviceLines.push("");
            }
            continue;
          }
          blockDepth = 0;
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

      return textResult(truncateOutput(output));
    },
  }),
];
