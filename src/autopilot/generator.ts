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
} from "./types.js";
import { NavigationGraph } from "./nav-graph.js";
import { TestGenerationError } from "../errors.js";

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

    const startName = startScreen?.title ?? path[0];
    const endName = endScreen?.title ?? path[path.length - 1];

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

      const label = action.elementText
        ? `Tap "${action.elementText}"`
        : action.elementResourceId
          ? `Tap ${action.elementResourceId}`
          : `${action.type} @ (${action.x}, ${action.y})`;

      steps.push({
        action: stepAction,
        args,
        expectedScreen: toScreen?.title ?? toId,
        label,
      });
    } else {
      // steps format: human-readable description
      const label = action.elementText
        ? `Tap "${action.elementText}"`
        : action.elementResourceId
          ? `Tap element ${action.elementResourceId}`
          : `${action.type} at (${action.x}, ${action.y})`;

      steps.push({
        action: action.type,
        args: {
          elementText: action.elementText,
          elementResourceId: action.elementResourceId,
          x: action.x,
          y: action.y,
        },
        expectedScreen: toScreen?.title ?? toId,
        label,
      });
    }
  }

  return steps;
}
