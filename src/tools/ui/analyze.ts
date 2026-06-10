import { defineTool, z } from "../define-tool.js";
import { platformEnum, deviceIdField } from "../common-schema.js";
import { analyzeScreen, formatScreenAnalysis, UiElement } from "../../adb/ui-parser.js";
import { getUiElements } from "../helpers/get-elements.js";
import { parseCommonArgs } from "../../utils/parse-common-args.js";
import { textResult } from "../../utils/tool-result.js";

export const uiAnalyze = defineTool({
  name: "ui_analyze",
  description: "Structured screen analysis: buttons, inputs, text, scrollable areas, dialogs",
  schema: z.object({
    platform: platformEnum,
    deviceId: deviceIdField,
  }),
  handler: async (args, ctx) => {
    const { deviceId, platform: currentPlatform } = parseCommonArgs(args as Record<string, unknown>, ctx);
    let screenElements: UiElement[] = [];
    let activity: string | undefined;

    try {
      const result = await getUiElements(ctx, currentPlatform);
      screenElements = result.elements;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (currentPlatform === "ios") {
        return textResult(
          `iOS UI inspection requires WebDriverAgent.\n\n` +
            `Install: npm install -g appium && appium driver install xcuitest\n\n` +
            `Error: ${msg}`,
        );
      }
      if (currentPlatform === "desktop") {
        return textResult(`Desktop UI hierarchy not available: ${msg}`);
      }
      throw error;
    }

    if (currentPlatform === "android" || !currentPlatform) {
      try {
        activity = ctx.deviceManager.getAndroidClient(deviceId).getCurrentActivity();
      } catch (actErr: unknown) {
        const actMsg = actErr instanceof Error ? actErr.message : String(actErr);
        console.error(`[analyze_screen] Could not get current activity: ${actMsg}`);
      }
    }

    if (!currentPlatform || !["android", "ios", "desktop"].includes(currentPlatform)) {
      if (currentPlatform) {
        return textResult(`ui(action:'analyze') is not supported for platform: ${currentPlatform}`);
      }
    }

    const analysis = analyzeScreen(screenElements, activity);
    return textResult(formatScreenAnalysis(analysis));
  },
});
