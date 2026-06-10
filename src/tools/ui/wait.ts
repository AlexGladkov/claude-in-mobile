import { defineTool, z } from "../define-tool.js";
import { platformEnum, deviceIdField } from "../common-schema.js";
import { findElements, formatElement } from "../../adb/ui-parser.js";
import { DeviceNotFoundError, DeviceOfflineError, AdbNotInstalledError } from "../../errors.js";
import { getUiElements } from "../helpers/get-elements.js";
import { parseCommonArgs } from "../../utils/parse-common-args.js";
import { textResult } from "../../utils/tool-result.js";
import { sleep } from "../../utils/sleep.js";

export const uiWait = defineTool({
  name: "ui_wait",
  description: "Wait for UI element to appear (polling with timeout)",
  schema: z.object({
    text: z.string().optional().describe("Element text to wait for (partial match, case-insensitive)"),
    resourceId: z.string().optional().describe("Android: resource ID to wait for (partial match)"),
    className: z.string().optional().describe("Class name to wait for"),
    timeout: z.number().default(5000).describe("Max wait time in ms (default: 5000)"),
    interval: z.number().default(500).describe("Poll interval in ms (default: 500)"),
    platform: platformEnum,
    deviceId: deviceIdField,
  }),
  handler: async (args, ctx) => {
    const { platform: currentPlatform } = parseCommonArgs(args as Record<string, unknown>, ctx);
    const timeout = args.timeout;
    const interval = args.interval;
    const searchText = args.text;
    const searchId = args.resourceId;
    const searchClass = args.className;

    if (!searchText && !searchId && !searchClass) {
      return textResult("Provide at least one search criteria: text, resourceId, or className");
    }

    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const { elements: lastElements } = await getUiElements(ctx, currentPlatform);

        const found = findElements(lastElements, {
          text: searchText,
          resourceId: searchId,
          className: searchClass,
        });

        if (found.length > 0) {
          const elapsed = Date.now() - startTime;
          return textResult(
            `Element found after ${elapsed}ms:\n${formatElement(found[0])}\n` +
              (found.length > 1 ? `(${found.length} total matches)` : ""),
          );
        }
      } catch (pollErr: unknown) {
        if (pollErr instanceof DeviceNotFoundError || pollErr instanceof DeviceOfflineError || pollErr instanceof AdbNotInstalledError) {
          throw pollErr;
        }
      }

      await sleep(interval);
    }

    return textResult(
      `Timeout after ${timeout}ms: element not found (text=${searchText ?? ""}, resourceId=${searchId ?? ""}, className=${searchClass ?? ""})`,
    );
  },
});
