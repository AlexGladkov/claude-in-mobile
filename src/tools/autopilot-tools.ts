/**
 * AI Test Autopilot tools.
 *
 * Provides 5 tool handlers:
 *   - autopilot_explore: automatically navigate and build navigation graph
 *   - autopilot_generate: generate test scenarios from exploration data
 *   - autopilot_heal: self-heal a broken test step selector
 *   - autopilot_status: get exploration status
 *   - autopilot_tests: list/get generated tests
 */

import type { ToolDefinition } from "./registry.js";
import type { Platform } from "../device-manager.js";
import type {
  ExplorationStrategy,
  TestFormat,
  OriginalSelector,
} from "../autopilot/types.js";
import { explore } from "../autopilot/explorer.js";
import { generateTests } from "../autopilot/generator.js";
import { healSelector } from "../autopilot/healer.js";
import { ExplorationStore } from "../utils/exploration-store.js";
import { getUiElements } from "./helpers/get-elements.js";
import { createLazySingleton } from "../utils/lazy.js";
import { truncateOutput } from "../utils/truncate.js";
import { ValidationError } from "../errors.js";
import { validatePackageName } from "../utils/sanitize.js";
import { defineTool, z } from "./define-tool.js";
import { parseCommonArgs } from "../utils/parse-common-args.js";
import { textResult } from "../utils/tool-result.js";

const getStore = createLazySingleton(() => new ExplorationStore());

// ── Defaults ──

const DEFAULT_STRATEGY: ExplorationStrategy = "smart";
const DEFAULT_MAX_SCREENS = 20;
const DEFAULT_MAX_ACTIONS = 100;
const DEFAULT_CONFIDENCE = 0.6;

// Shared zod fragments
const platformEnum = z
  .enum(["android", "ios", "desktop"])
  .describe("Target platform")
  .optional();
const deviceIdField = z
  .string()
  .describe("Target device ID for multi-device. If omitted, uses active device.")
  .optional();

const originalSelectorSchema = z
  .object({
    text: z.string().optional().describe("Original text"),
    resourceId: z.string().optional().describe("Original resource ID"),
    className: z.string().optional().describe("Original class name"),
    bounds: z
      .object({
        x1: z.number(),
        y1: z.number(),
        x2: z.number(),
        y2: z.number(),
      })
      .optional()
      .describe("Original bounds"),
  })
  .describe("Original selector that no longer matches");

// ── Helpers ──

function formatExplorationSummary(
  result: { id: string; package: string; date: string; screens: number },
): string {
  return `${result.id} — ${result.package} — ${result.screens} screens — ${result.date.split("T")[0]}`;
}

// ── Tool definitions ──

export const autopilotTools: ToolDefinition[] = [
  // 1. explore
  defineTool({
    name: "autopilot_explore",
    description:
      "Automatically navigate the app, building a navigation graph of screens and transitions. Uses screen fingerprinting to avoid revisiting screens.",
    schema: z.object({
      platform: platformEnum,
      package: z
        .string()
        .min(1, "package is required for explore")
        .describe("App package name (e.g. 'com.example.app')"),
      strategy: z
        .enum(["bfs", "dfs", "smart"])
        .optional()
        .describe(
          "Exploration strategy (default: smart). BFS for breadth, DFS for depth, smart for hybrid.",
        ),
      maxScreens: z
        .number()
        .optional()
        .describe("Maximum screens to discover (default: 20, max: 100)"),
      maxActions: z
        .number()
        .optional()
        .describe("Maximum actions to perform (default: 100, max: 500)"),
      dryRun: z
        .boolean()
        .optional()
        .describe("Analyze without performing actions (default: false)"),
    }),
    handler: async (args, ctx) => {
      const { platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const pkg = args.package;
      validatePackageName(pkg);

      const strategy = (args.strategy ?? DEFAULT_STRATEGY) as ExplorationStrategy;

      const maxScreens = Math.min(Math.max(args.maxScreens ?? DEFAULT_MAX_SCREENS, 1), 100);
      const maxActions = Math.min(Math.max(args.maxActions ?? DEFAULT_MAX_ACTIONS, 1), 500);
      const dryRun = args.dryRun === true;

      const result = await explore(ctx, platform, {
        package: pkg,
        strategy,
        maxScreens,
        maxActions,
        dryRun,
      });

      // Save exploration
      await getStore().saveExploration(result);

      const lines: string[] = [
        `Exploration complete: ${result.id}`,
        "",
        `Strategy: ${result.strategy}`,
        `Screens found: ${result.stats.screensFound}`,
        `Edges found: ${result.stats.edgesFound}`,
        `Actions performed: ${result.stats.actionsPerformed}`,
        `Dry run: ${result.stats.dryRun}`,
        "",
      ];

      if (result.stats.maxScreensReached) {
        lines.push(`Note: maxScreens limit (${maxScreens}) reached.`);
      }
      if (result.stats.maxActionsReached) {
        lines.push(`Note: maxActions limit (${maxActions}) reached.`);
      }

      lines.push("");
      lines.push("Screens:");
      for (const screen of result.graph.screens) {
        lines.push(`  ${screen.id}: ${screen.title ?? "(untitled)"} [${screen.elements.length} elements]`);
      }

      lines.push("");
      lines.push(`Next: autopilot(action:'generate', explorationId:'${result.id}') to create test scenarios.`);

      return textResult(truncateOutput(lines.join("\n")));
    },
  }),

  // 2. generate
  defineTool({
    name: "autopilot_generate",
    description:
      "Generate test scenarios from exploration data. Creates flow_run-compatible test steps for all unique paths.",
    schema: z.object({
      explorationId: z
        .string()
        .min(1, "explorationId is required for generate")
        .describe("Exploration ID from a previous explore run"),
      format: z
        .enum(["flow_run", "steps"])
        .optional()
        .describe(
          "Output format (default: flow_run). flow_run: ready for flow(action:'run'). steps: human-readable.",
        ),
    }),
    handler: async (args) => {
      const explorationId = args.explorationId;
      const format = (args.format ?? "flow_run") as TestFormat;

      const exploration = await getStore().getExploration(explorationId);
      const suite = generateTests(exploration, format);

      await getStore().saveTests(suite);

      const lines: string[] = [
        `Generated ${suite.tests.length} test scenarios for ${explorationId}`,
        `Format: ${format}`,
        "",
      ];

      for (const test of suite.tests) {
        lines.push(`${test.id}: ${test.name} (${test.steps.length} steps)`);
        lines.push(`  ${test.description}`);
      }

      lines.push("");
      lines.push(`Tests saved. Use autopilot(action:'tests', explorationId:'${explorationId}') to view.`);

      return textResult(truncateOutput(lines.join("\n")));
    },
  }),

  // 3. heal
  defineTool({
    name: "autopilot_heal",
    description:
      "Self-heal a broken test step by finding the best matching element on the current screen. Uses fuzzy matching on text, resourceId, className, and bounds.",
    schema: z.object({
      platform: platformEnum,
      originalSelector: originalSelectorSchema,
      confidence: z
        .number()
        .optional()
        .describe("Minimum confidence threshold 0-1 (default: 0.6)"),
    }),
    handler: async (args, ctx) => {
      const { platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const selector = args.originalSelector as OriginalSelector;

      const confidence = Math.min(Math.max(args.confidence ?? DEFAULT_CONFIDENCE, 0), 1);

      const { elements } = await getUiElements(ctx, platform as Platform);
      const result = healSelector(elements, selector, confidence);

      const lines: string[] = [
        `Healed: ${result.healed ? "YES" : "NO"}`,
        `Confidence: ${(result.confidence * 100).toFixed(0)}%`,
        `Reason: ${result.reason}`,
        "",
        "Healed selector:",
        `  index: ${result.healedSelector.index}`,
        `  text: "${result.healedSelector.text}"`,
        `  resourceId: "${result.healedSelector.resourceId}"`,
        `  className: "${result.healedSelector.className}"`,
        `  bounds: [${result.healedSelector.bounds.x1},${result.healedSelector.bounds.y1}][${result.healedSelector.bounds.x2},${result.healedSelector.bounds.y2}]`,
        `  center: (${result.healedSelector.centerX}, ${result.healedSelector.centerY})`,
      ];

      return textResult(lines.join("\n"));
    },
  }),

  // 4. status
  defineTool({
    name: "autopilot_status",
    description:
      "Get exploration status. If explorationId is provided, shows details. Otherwise lists all explorations.",
    schema: z.object({
      explorationId: z
        .string()
        .optional()
        .describe("Specific exploration ID (optional — omit to list all)"),
    }),
    handler: async (args) => {
      const explorationId = args.explorationId;

      if (explorationId) {
        const exploration = await getStore().getExploration(explorationId);
        const lines: string[] = [
          `Exploration: ${exploration.id}`,
          `Package: ${exploration.package}`,
          `Strategy: ${exploration.strategy}`,
          `Started: ${exploration.startedAt}`,
          `Completed: ${exploration.completedAt}`,
          "",
          `Screens: ${exploration.stats.screensFound}`,
          `Edges: ${exploration.stats.edgesFound}`,
          `Actions: ${exploration.stats.actionsPerformed}`,
          `Dry run: ${exploration.stats.dryRun}`,
          `Max screens reached: ${exploration.stats.maxScreensReached}`,
          `Max actions reached: ${exploration.stats.maxActionsReached}`,
          "",
          "Screens:",
        ];

        for (const screen of exploration.graph.screens) {
          lines.push(`  ${screen.id}: ${screen.title ?? "(untitled)"} [${screen.elements.length} elements]`);
        }

        return textResult(truncateOutput(lines.join("\n")));
      }

      // List all explorations
      const explorations = await getStore().listExplorations();
      if (explorations.length === 0) {
        return textResult("No explorations found. Use autopilot(action:'explore') to start.");
      }

      const lines: string[] = [
        `Explorations (${explorations.length}):`,
        "",
      ];
      for (const e of explorations) {
        lines.push(formatExplorationSummary(e));
      }

      return textResult(lines.join("\n"));
    },
  }),

  // 5. tests
  defineTool({
    name: "autopilot_tests",
    description: "List or get generated test scenarios for an exploration.",
    schema: z.object({
      explorationId: z
        .string()
        .min(1, "explorationId is required for tests")
        .describe("Exploration ID"),
      testId: z
        .string()
        .optional()
        .describe("Specific test ID (optional — omit to list all)"),
    }),
    handler: async (args) => {
      const explorationId = args.explorationId;
      const testId = args.testId;
      const suite = await getStore().getTests(explorationId);

      if (testId) {
        const test = suite.tests.find((t) => t.id === testId);
        if (!test) {
          throw new ValidationError(
            `Test "${testId}" not found in exploration "${explorationId}". Available: ${suite.tests.map((t) => t.id).join(", ")}`,
          );
        }

        const lines: string[] = [
          `Test: ${test.id}`,
          `Name: ${test.name}`,
          `Description: ${test.description}`,
          `Format: ${test.format}`,
          `Path: ${test.path.join(" -> ")}`,
          "",
          "Steps:",
        ];

        for (let i = 0; i < test.steps.length; i++) {
          const step = test.steps[i];
          const label = step.label ?? step.action;
          lines.push(`  ${i + 1}. ${label}`);
          lines.push(`     action: ${step.action}`);
          lines.push(`     args: ${JSON.stringify(step.args)}`);
          if (step.expectedScreen) {
            lines.push(`     expected: ${step.expectedScreen}`);
          }
        }

        return textResult(truncateOutput(lines.join("\n")));
      }

      // List all tests
      const lines: string[] = [
        `Tests for ${explorationId} (${suite.tests.length}):`,
        `Generated: ${suite.generatedAt}`,
        "",
      ];

      for (const test of suite.tests) {
        lines.push(`${test.id}: ${test.name} (${test.steps.length} steps)`);
      }

      return textResult(lines.join("\n"));
    },
  }),
];
