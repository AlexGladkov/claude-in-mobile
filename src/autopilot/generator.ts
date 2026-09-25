/**
 * Test scenario generator — creates test scenarios from exploration data.
 *
 * Reads a NavigationGraph and generates flow_run-compatible test steps
 * for all unique paths through the app.
 */

import type {
  ExplorationResult,
  GeneratedTest,
  GeneratedTestSuite,
  TestStep,
  TestFormat,
  ExplorationAction,
  ScreenNode,
} from "./types.js";
import { NavigationGraph } from "./nav-graph.js";
import { isSensitiveElement, REDACTED } from "../ui-tree/ui-parser/formatters/redact.js";
import { TestGenerationError } from "../errors.js";

function secureMarker(value: string): boolean {
  const lower = value.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, "");
  return lower.includes("password")
    || compact.includes("securetextfield")
    || compact.includes("securetextbox")
    || compact === "secure";
}

function isSecureAction(action: ExplorationAction, screen?: ScreenNode): boolean {
  const source = screen?.elements.find((el) => el.index === action.elementIndex);
  return Boolean(source && isSensitiveElement(source))
    || secureMarker(`${action.elementClassName ?? ""} ${action.elementResourceId ?? ""}`);
}

function safeScreenTitle(screen?: ScreenNode): string | undefined {
  if (!screen?.title) return screen?.title;
  let title = screen.title;
  for (const element of screen.elements) {
    if (!isSensitiveElement(element)) continue;
    for (const value of [element.text, element.contentDesc, element.resourceId]) {
      if (value && value !== REDACTED) title = title.replaceAll(value, REDACTED);
    }
  }
  return title;
}

/**
 * Generate test scenarios from exploration data.
 */
export function generateTests(
  exploration: ExplorationResult,
  format: TestFormat = "flow_run",
): GeneratedTestSuite {
  const graph = NavigationGraph.fromJSON(exploration.graph);
  const paths = graph.getAllPaths(50);

  if (paths.length === 0) {
    throw new TestGenerationError(
      "No paths found in navigation graph. Run autopilot(action:'explore') first.",
    );
  }

  const tests: GeneratedTest[] = paths.map((path, idx) => {
    const steps = buildStepsForPath(path, graph, format);
    const startScreen = graph.getScreen(path[0]);
    const endScreen = graph.getScreen(path[path.length - 1]);

    const startName = safeScreenTitle(startScreen) ?? path[0];
    const endName = safeScreenTitle(endScreen) ?? path[path.length - 1];

    return {
      id: `test_${idx}`,
      name: `${startName} -> ${endName}`,
      description: `Navigate from "${startName}" to "${endName}" (${path.length} screens, ${steps.length} steps)`,
      path,
      steps,
      format,
    };
  });

  return {
    explorationId: exploration.id,
    generatedAt: new Date().toISOString(),
    tests,
  };
}

/**
 * Build test steps for a given path through the navigation graph.
 */
function buildStepsForPath(
  path: string[],
  graph: NavigationGraph,
  format: TestFormat,
): TestStep[] {
  const steps: TestStep[] = [];

  for (let i = 0; i < path.length - 1; i++) {
    const fromId = path[i];
    const toId = path[i + 1];

    const edges = graph.getEdgesFrom(fromId);
    const edge = edges.find((e) => e.toScreenId === toId);
    if (!edge) continue;

    const action = edge.action;
    const fromScreen = graph.getScreen(fromId);
    const secure = isSecureAction(action, fromScreen);
    const elementText = secure ? REDACTED : action.elementText;
    const elementResourceId = secure ? REDACTED : action.elementResourceId;
    const toScreen = graph.getScreen(toId);
    if (format === "flow_run") {
      // flow_run format: action name + args compatible with flow(action:'run')
      const stepAction = action.type === "tap" ? "input_tap" : `input_${action.type}`;
      const args: Record<string, unknown> = {};

      if (action.type === "tap" && action.x !== undefined && action.y !== undefined) {
        args.x = action.x;
        args.y = action.y;
      } else if (action.type === "key" && action.key) {
        args.key = action.key;
      } else if (action.type === "swipe" && action.direction) {
        args.direction = action.direction;
      }

      const label = elementText
        ? `Tap "${elementText}"`
        : elementResourceId
          ? `Tap ${elementResourceId}`
          : `${action.type} @ (${action.x}, ${action.y})`;

      steps.push({
        action: stepAction,
        args,
        expectedScreen: safeScreenTitle(toScreen) ?? toId,
        label,
      });
    } else {
      // steps format: human-readable description
      const label = elementText
        ? `Tap "${elementText}"`
        : elementResourceId
          ? `Tap element ${elementResourceId}`
          : `${action.type} at (${action.x}, ${action.y})`;

      steps.push({
        action: action.type,
        args: {
          elementText,
          elementResourceId,
          x: action.x,
          y: action.y,
        },
        expectedScreen: safeScreenTitle(toScreen) ?? toId,
        label,
      });
    }
  }

  return steps;
}
