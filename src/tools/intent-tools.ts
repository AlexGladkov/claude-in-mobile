import type { ToolDefinition } from "./registry.js";
import { defineTool, z } from "./define-tool.js";
import { platformEnum, deviceIdField } from "./common-schema.js";
import { validatePackageName, validateUrl } from "../utils/sanitize.js";
import { ValidationError } from "../errors.js";
import { truncateOutput } from "../utils/truncate.js";
import { parseCommonArgs } from "../utils/parse-common-args.js";
import { textResult } from "../utils/tool-result.js";
import { dispatchByPlatform } from "./helpers/dispatch.js";
import { buildDeviceShellCommand } from "../utils/device-shell.js";

// ─── Validation helpers ───────────────────────────────────────────────────────

const INTENT_ACTION_RE = /^[a-zA-Z][a-zA-Z0-9_.]*$/;
const COMPONENT_RE = /^[a-zA-Z][a-zA-Z0-9_.]*\/[a-zA-Z0-9_.]*$/;

function validateIntentAction(action: string): void {
  if (!INTENT_ACTION_RE.test(action)) {
    throw new ValidationError("Invalid intent action.");
  }
}

function validateComponent(component: string): void {
  if (!COMPONENT_RE.test(component)) {
    throw new ValidationError("Invalid Android component.");
  }
}

function validateDeepLink(uri: string): void {
  if (uri.length > 8192 || /[\u0000-\u001f\u007f]/.test(uri)) {
    throw new ValidationError("Invalid deep-link URI.");
  }
  try {
    new URL(uri);
  } catch {
    throw new ValidationError("Invalid deep-link URI.");
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
  if (Object.hasOwn(FLAG_MAP, flag)) return FLAG_MAP[flag]!;
  const num = Number(flag);
  if (Number.isSafeInteger(num) && num > 0 && num <= 0xffff_ffff) return num;
  throw new ValidationError(
    `Unknown flag. Valid flags: ${Object.keys(FLAG_MAP).join(", ")}`,
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

function buildExtrasArgs(extras: ExtraItem[]): string[] {
  return extras.flatMap(({ key, value, type }) => {
    if (
      key.length === 0 ||
      key.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(key)
    ) {
      throw new ValidationError("Invalid extra key.");
    }
    if (typeof value === "string" && (value.length > 8192 || value.includes("\0"))) {
      throw new ValidationError("Invalid extra value.");
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
    return [flag, key, String(value)];
  });
}

// ─── Schema helpers ───────────────────────────────────────────────────────────

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

      return dispatchByPlatform(platform, {
        android: () => {
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

          const commandArgs: string[] = ["am", "start"];

          if (intentAction) commandArgs.push("-a", intentAction);
          if (component) commandArgs.push("-n", component);
          if (data) commandArgs.push("-d", data);
          if (data) validateDeepLink(data);
          if (category) {
            if (!INTENT_ACTION_RE.test(category)) {
              throw new ValidationError("Invalid intent category.");
            }
            commandArgs.push("-c", category);
          }
          commandArgs.push(...buildExtrasArgs(extras));
          if (flags.length > 0) {
            const combined = flags.reduce((acc, f) => acc | resolveFlag(f), 0);
            commandArgs.push("-f", `0x${combined.toString(16)}`);
          }
          if (pkg) commandArgs.push("-p", pkg);

          const result = ctx.deviceManager.shell(
            buildDeviceShellCommand(commandArgs),
            "android",
            deviceId,
          );
          return textResult(truncateOutput(result || "Activity launched."));
        },
        ios: () =>
          textResult(
            "iOS does not support Android-style intent launching. Use intent_deeplink with a URI to open content on iOS via xcrun simctl openurl.",
          ),
        unsupported: (p) =>
          textResult(`intent_start is only supported on Android (current platform: ${p}).`),
      });
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

      const commandArgs: string[] = ["am", "broadcast", "-a", intentAction];
      if (component) commandArgs.push("-n", component);
      if (pkg) commandArgs.push("-p", pkg);
      commandArgs.push(...buildExtrasArgs(extras));

      const result = ctx.deviceManager.shell(
        buildDeviceShellCommand(commandArgs),
        "android",
        deviceId,
      );
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

      validateDeepLink(uri);

      if (pkg) validatePackageName(pkg);

      return dispatchByPlatform(platform, {
        android: () => {
          const commandArgs = [
            "am",
            "start",
            "-a",
            "android.intent.action.VIEW",
            "-d",
            uri,
          ];
          if (pkg) commandArgs.push("-p", pkg);
          const result = ctx.deviceManager.shell(
            buildDeviceShellCommand(commandArgs),
            "android",
            deviceId,
          );
          return textResult(truncateOutput(result || "Deep link opened."));
        },
        ios: () => {
          if (uri.startsWith("http://") || uri.startsWith("https://")) validateUrl(uri);
          ctx.deviceManager.getIosClient(deviceId).openUrl(uri);
          return textResult("Deep link opened.");
        },
        unsupported: (p) =>
          textResult(
            `intent_deeplink is only supported on Android and iOS (current platform: ${p}).`,
          ),
      });
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

      const raw = ctx.deviceManager.shell(command, "android", deviceId);

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
