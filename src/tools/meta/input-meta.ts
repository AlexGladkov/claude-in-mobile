import { createMetaTool } from "./create-meta-tool.js";
import { interactionTools } from "../interaction-tools.js";

const { meta, aliases } = createMetaTool({
  name: "input",
  description:
    "Input actions. tap/double_tap/long_press: coords or text/id/label/index. swipe: direction or coords. text: type text. key: press key.",
  tools: interactionTools,
  prefix: "input_",
  extraSchema: {
    x: { type: "number", description: "X coordinate" },
    y: { type: "number", description: "Y coordinate" },
    x1: { type: "number", description: "Start X (for custom swipe)" },
    y1: { type: "number", description: "Start Y (for custom swipe)" },
    x2: { type: "number", description: "End X (for custom swipe)" },
    y2: { type: "number", description: "End Y (for custom swipe)" },
    text: { type: "string", description: "Element text (tap) or text to type (text action)" },
    resourceId: { type: "string", description: "Find element by resource ID (Android only)" },
    label: { type: "string", description: "iOS only: Accessibility label" },
    index: { type: "number", description: "Tap element by index from ui_tree output (Android only)" },
    key: { type: "string", description: "Key name: BACK, HOME, ENTER, TAB, DELETE, etc." },
    direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Swipe direction" },
    duration: { type: "number", description: "Duration in ms (long_press default: 1000, swipe default: 300)" },
    interval: { type: "number", description: "Delay between taps in ms for double_tap (default: 100)" },
    targetPid: { type: "number", description: "Desktop only: PID of target process" },
    hints: { type: "boolean", description: "Return hints about what changed after the action (default: true, set false to disable)", default: true },
    platform: {
      type: "string",
      enum: ["android", "ios", "desktop", "aurora", "browser"],
      description: "Target platform. If not specified, uses the active target.",
    },
  },
});

export const inputMeta = meta;
export const inputAliases = aliases;
