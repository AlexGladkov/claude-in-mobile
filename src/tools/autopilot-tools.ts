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

const getStore = createLazySingleton(() => new ExplorationStore());

// ── Defaults ──

const DEFAULT_STRATEGY: ExplorationStrategy = "smart";
const DEFAULT_MAX_SCREENS = 20;
const DEFAULT_MAX_ACTIONS = 100;
const DEFAULT_CONFIDENCE = 0.6;
const VALID_STRATEGIES = new Set(["bfs", "dfs", "smart"]);
const VALID_FORMATS = new Set(["flow_run", "steps"]);

// ── Helpers ──

function resolvePlatform(
  argPlatform: string | undefined,
  ctx: Parameters<ToolDefinition["handler"]>[1],
): string {
  return argPlatform ?? ctx.deviceManager.getCurrentPlatform() ?? "android";
}

function formatExplorationSummary(
  result: { id: string; package: string; date: string; screens: number },
): string {
  return `${result.id} — ${result.package} — ${result.screens} screens — ${result.date.split("T")[0]}`;
}

// ── Tool definitions ──

export const autopilotTools: ToolDefinition[] = [
  // 1. explore
  {
    tool: {
      name: "autopilot_explore",
      description:
        "Automatically navigate the app, building a navigation graph of screens and transitions. Uses screen fingerprinting to avoid revisiting screens.",
      inputSchema: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["android", "ios", "desktop"],
            description: "Target platform",
          },
          package: {
            type: "string",
            description: "App package name (e.g. 'com.example.app')",
          },
          strategy: {
            type: "string",
            enum: ["bfs", "dfs", "smart"],
            description: "Exploration strategy (default: smart). BFS for breadth, DFS for depth, smart for hybrid.",
          },
          maxScreens: {
            type: "number",
            description: "Maximum screens to discover (default: 20, max: 100)",
          },
          maxActions: {
            type: "number",
            description: "Maximum actions to perform (default: 100, max: 500)",
          },
          dryRun: {
            type: "boolean",
            description: "Analyze without performing actions (default: false)",
          },
        },
        required: ["package"],
      },
    },
    handler: async (args, ctx) => {
      const platform = resolvePlatform(args.platform as string | undefined, ctx);
      const pkg = args.package as string;
      if (!pkg) throw new ValidationError("package is required for explore");
      validatePackageName(pkg);

      const strategy = (args.strategy as string | undefined) ?? DEFAULT_STRATEGY;
      if (!VALID_STRATEGIES.has(strategy)) {
        throw new ValidationError(
          `Invalid strategy: "${strategy}". Valid: bfs, dfs, smart`,
        );
      }

      const maxScreens = Math.min(
        Math.max((args.maxScreens as number) ?? DEFAULT_MAX_SCREENS, 1),
        100,
      );
      const maxActions = Math.min(
        Math.max((args.maxActions as number) ?? DEFAULT_MAX_ACTIONS, 1),
        500,
      );
      const dryRun = args.dryRun === true;

      const result = await explore(ctx, platform, {
        package: pkg,
        strategy: strategy as ExplorationStrategy,
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

      return { text: truncateOutput(lines.join("\n")) };
    },
  },

  // 2. generate
  {
    tool: {
      name: "autopilot_generate",
      description:
        "Generate test scenarios from exploration data. Creates flow_run-compatible test steps for all unique paths.",
      inputSchema: {
        type: "object",
        properties: {
          explorationId: {
            type: "string",
            description: "Exploration ID from a previous explore run",
          },
          format: {
            type: "string",
            enum: ["flow_run", "steps"],
            description: "Output format (default: flow_run). flow_run: ready for flow(action:'run'). steps: human-readable.",
          },
        },
        required: ["explorationId"],
      },
    },
    handler: async (args) => {
      const explorationId = args.explorationId as string;
      if (!explorationId) throw new ValidationError("explorationId is required for generate");

      const format = (args.format as string | undefined) ?? "flow_run";
      if (!VALID_FORMATS.has(format)) {
        throw new ValidationError(
          `Invalid format: "${format}". Valid: flow_run, steps`,
        );
      }

      const exploration = await getStore().getExploration(explorationId);
      const suite = generateTests(exploration, format as TestFormat);

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

      return { text: truncateOutput(lines.join("\n")) };
    },
  },

  // 3. heal
  {
    tool: {
      name: "autopilot_heal",
      description:
        "Self-heal a broken test step by finding the best matching element on the current screen. Uses fuzzy matching on text, resourceId, className, and bounds.",
      inputSchema: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["android", "ios", "desktop"],
            description: "Target platform",
          },
          originalSelector: {
            type: "object",
            description: "Original selector that no longer matches",
            properties: {
              text: { type: "string", description: "Original text" },
              resourceId: { type: "string", description: "Original resource ID" },
              className: { type: "string", description: "Original class name" },
              bounds: {
                type: "object",
                description: "Original bounds",
                properties: {
                  x1: { type: "number" },
                  y1: { type: "number" },
                  x2: { type: "number" },
                  y2: { type: "number" },
                },
              },
            },
          },
          confidence: {
            type: "number",
            description: "Minimum confidence threshold 0-1 (default: 0.6)",
          },
        },
        required: ["originalSelector"],
      },
    },
    handler: async (args, ctx) => {
      const platform = resolvePlatform(args.platform as string | undefined, ctx);
      const selector = args.originalSelector as OriginalSelector | undefined;
      if (!selector) throw new ValidationError("originalSelector is required for heal");

      const confidence = Math.min(
        Math.max((args.confidence as number) ?? DEFAULT_CONFIDENCE, 0),
        1,
      );

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

      return { text: lines.join("\n") };
    },
  },

  // 4. status
  {
    tool: {
      name: "autopilot_status",
      description:
        "Get exploration status. If explorationId is provided, shows details. Otherwise lists all explorations.",
      inputSchema: {
        type: "object",
        properties: {
          explorationId: {
            type: "string",
            description: "Specific exploration ID (optional — omit to list all)",
          },
        },
      },
    },
    handler: async (args) => {
      const explorationId = args.explorationId as string | undefined;

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

        return { text: truncateOutput(lines.join("\n")) };
      }

      // List all explorations
      const explorations = await getStore().listExplorations();
      if (explorations.length === 0) {
        return { text: "No explorations found. Use autopilot(action:'explore') to start." };
      }

      const lines: string[] = [
        `Explorations (${explorations.length}):`,
        "",
      ];
      for (const e of explorations) {
        lines.push(formatExplorationSummary(e));
      }

      return { text: lines.join("\n") };
    },
  },

  // 5. tests
  {
    tool: {
      name: "autopilot_tests",
      description:
        "List or get generated test scenarios for an exploration.",
      inputSchema: {
        type: "object",
        properties: {
          explorationId: {
            type: "string",
            description: "Exploration ID",
          },
          testId: {
            type: "string",
            description: "Specific test ID (optional — omit to list all)",
          },
        },
        required: ["explorationId"],
      },
    },
    handler: async (args) => {
      const explorationId = args.explorationId as string;
      if (!explorationId) throw new ValidationError("explorationId is required for tests");

      const testId = args.testId as string | undefined;
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

        return { text: truncateOutput(lines.join("\n")) };
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

      return { text: lines.join("\n") };
    },
  },
];
