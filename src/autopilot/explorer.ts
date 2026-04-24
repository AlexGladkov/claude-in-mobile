/**
 * Exploration engine — automatically navigates an app, building a navigation graph.
 *
 * Supports BFS, DFS, and smart strategies for screen discovery.
 * Uses screen fingerprinting to detect duplicate screens.
 * Enforces blocklist for destructive actions.
 */

import type { UiElement } from "../adb/ui-parser.js";
import type { ToolContext } from "../tools/context.js";
import type { Platform } from "../device-manager.js";
import type {
  ExplorationConfig,
  ExplorationResult,
  ExplorationAction,
  ScreenNode,
  ExplorationStats,
} from "./types.js";
import { DESTRUCTIVE_PATTERNS } from "./types.js";
import { NavigationGraph } from "./nav-graph.js";
import { generateScreenFingerprint } from "./screen-fingerprint.js";
import { getUiElements } from "../tools/helpers/get-elements.js";
import { detectScreenTitle } from "../adb/ui-parser.js";
import { ExplorationLimitError } from "../errors.js";

/**
 * Check whether an element's text matches any destructive pattern.
 */
function isDestructiveElement(el: UiElement): boolean {
  const text = (el.text || el.contentDesc || "").toLowerCase();
  if (!text) return false;
  return DESTRUCTIVE_PATTERNS.some((pattern) => text.includes(pattern));
}

/**
 * Extract actionable elements from a screen, filtering out
 * destructive ones and non-interactive elements.
 */
function getActionableElements(elements: UiElement[]): UiElement[] {
  return elements.filter(
    (el) =>
      el.clickable &&
      el.enabled &&
      el.width > 0 &&
      el.height > 0 &&
      !isDestructiveElement(el),
  );
}

/**
 * Build an ExplorationAction from a UI element tap.
 */
function buildTapAction(el: UiElement): ExplorationAction {
  return {
    type: "tap",
    elementIndex: el.index,
    elementText: el.text || undefined,
    elementResourceId: el.resourceId || undefined,
    elementClassName: el.className,
    x: el.centerX,
    y: el.centerY,
  };
}

/**
 * Capture the current screen state and return a ScreenNode.
 */
async function captureScreen(
  ctx: ToolContext,
  platform: Platform | string,
  graph: NavigationGraph,
): Promise<ScreenNode> {
  const { elements } = await getUiElements(ctx, platform as Platform);
  const fingerprint = generateScreenFingerprint(elements);

  // Check if this screen already exists
  const existing = graph.getScreenByFingerprint(fingerprint);
  if (existing) return existing;

  const title = detectScreenTitle(elements);
  const id = `screen_${graph.screenCount}`;

  const screen: ScreenNode = {
    id,
    fingerprint,
    elements,
    title: title ?? undefined,
    visitedAt: new Date().toISOString(),
  };

  graph.addScreen(screen);
  return screen;
}

/**
 * Explore an app using BFS strategy.
 */
async function exploreBFS(
  ctx: ToolContext,
  platform: Platform | string,
  config: ExplorationConfig,
  graph: NavigationGraph,
): Promise<ExplorationStats> {
  let actionsPerformed = 0;
  const queue: string[] = [];

  // Capture initial screen
  const startScreen = await captureScreen(ctx, platform, graph);
  queue.push(startScreen.id);
  const visitedScreenActions = new Set<string>();

  while (queue.length > 0) {
    if (graph.screenCount >= config.maxScreens || actionsPerformed >= config.maxActions) break;

    const currentId = queue.shift()!;
    const currentScreen = graph.getScreen(currentId);
    if (!currentScreen) continue;

    const actionable = getActionableElements(currentScreen.elements);

    for (const el of actionable) {
      if (graph.screenCount >= config.maxScreens || actionsPerformed >= config.maxActions) break;

      const actionKey = `${currentId}:${el.index}`;
      if (visitedScreenActions.has(actionKey)) continue;
      visitedScreenActions.add(actionKey);

      if (!config.dryRun) {
        const action = buildTapAction(el);

        // Perform the tap
        await ctx.handleTool("input", {
          action: "tap",
          x: el.centerX,
          y: el.centerY,
          platform,
        });
        actionsPerformed++;

        // Brief wait for UI to settle
        await new Promise((r) => setTimeout(r, 500));

        // Capture new screen
        const newScreen = await captureScreen(ctx, platform, graph);
        graph.addEdge(currentId, newScreen.id, action);

        if (newScreen.id !== currentId && !queue.includes(newScreen.id)) {
          queue.push(newScreen.id);
        }

        // Navigate back to continue exploration
        await ctx.handleTool("input", {
          action: "key",
          key: "back",
          platform,
        });
        await new Promise((r) => setTimeout(r, 300));
      } else {
        actionsPerformed++;
      }
    }
  }

  return {
    screensFound: graph.screenCount,
    edgesFound: graph.edgeCount,
    actionsPerformed,
    maxScreensReached: graph.screenCount >= config.maxScreens,
    maxActionsReached: actionsPerformed >= config.maxActions,
    dryRun: config.dryRun,
  };
}

/**
 * Explore an app using DFS strategy.
 */
async function exploreDFS(
  ctx: ToolContext,
  platform: Platform | string,
  config: ExplorationConfig,
  graph: NavigationGraph,
): Promise<ExplorationStats> {
  let actionsPerformed = 0;
  const stack: string[] = [];

  const startScreen = await captureScreen(ctx, platform, graph);
  stack.push(startScreen.id);
  const visitedScreenActions = new Set<string>();

  while (stack.length > 0) {
    if (graph.screenCount >= config.maxScreens || actionsPerformed >= config.maxActions) break;

    const currentId = stack[stack.length - 1];
    const currentScreen = graph.getScreen(currentId);
    if (!currentScreen) {
      stack.pop();
      continue;
    }

    const actionable = getActionableElements(currentScreen.elements);
    let exploredAny = false;

    for (const el of actionable) {
      if (graph.screenCount >= config.maxScreens || actionsPerformed >= config.maxActions) break;

      const actionKey = `${currentId}:${el.index}`;
      if (visitedScreenActions.has(actionKey)) continue;
      visitedScreenActions.add(actionKey);

      if (!config.dryRun) {
        const action = buildTapAction(el);

        await ctx.handleTool("input", {
          action: "tap",
          x: el.centerX,
          y: el.centerY,
          platform,
        });
        actionsPerformed++;
        await new Promise((r) => setTimeout(r, 500));

        const newScreen = await captureScreen(ctx, platform, graph);
        graph.addEdge(currentId, newScreen.id, action);

        if (newScreen.id !== currentId) {
          stack.push(newScreen.id);
          exploredAny = true;
          break; // DFS: go deep immediately
        }
      } else {
        actionsPerformed++;
      }
    }

    if (!exploredAny) {
      stack.pop();
      if (!config.dryRun && stack.length > 0) {
        await ctx.handleTool("input", {
          action: "key",
          key: "back",
          platform,
        });
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  return {
    screensFound: graph.screenCount,
    edgesFound: graph.edgeCount,
    actionsPerformed,
    maxScreensReached: graph.screenCount >= config.maxScreens,
    maxActionsReached: actionsPerformed >= config.maxActions,
    dryRun: config.dryRun,
  };
}

/**
 * Smart exploration: BFS for breadth, then DFS into unexplored branches.
 * Prioritizes elements with unique text/IDs over generic ones.
 */
async function exploreSmart(
  ctx: ToolContext,
  platform: Platform | string,
  config: ExplorationConfig,
  graph: NavigationGraph,
): Promise<ExplorationStats> {
  // Smart strategy starts with BFS for the first half of budget,
  // then switches to DFS for deeper exploration.
  const bfsConfig: ExplorationConfig = {
    ...config,
    maxActions: Math.floor(config.maxActions / 2),
    maxScreens: config.maxScreens,
  };

  const bfsStats = await exploreBFS(ctx, platform, bfsConfig, graph);

  if (bfsStats.maxScreensReached || bfsStats.actionsPerformed >= config.maxActions) {
    return {
      ...bfsStats,
      maxActionsReached: bfsStats.actionsPerformed >= config.maxActions,
    };
  }

  // Continue with DFS for remaining budget
  const dfsConfig: ExplorationConfig = {
    ...config,
    maxActions: config.maxActions - bfsStats.actionsPerformed,
    maxScreens: config.maxScreens,
  };

  const dfsStats = await exploreDFS(ctx, platform, dfsConfig, graph);

  return {
    screensFound: graph.screenCount,
    edgesFound: graph.edgeCount,
    actionsPerformed: bfsStats.actionsPerformed + dfsStats.actionsPerformed,
    maxScreensReached: graph.screenCount >= config.maxScreens,
    maxActionsReached:
      bfsStats.actionsPerformed + dfsStats.actionsPerformed >= config.maxActions,
    dryRun: config.dryRun,
  };
}

/**
 * Run exploration with the configured strategy.
 */
export async function explore(
  ctx: ToolContext,
  platform: Platform | string,
  config: ExplorationConfig,
): Promise<ExplorationResult> {
  if (config.maxScreens < 1 || config.maxScreens > 100) {
    throw new ExplorationLimitError("maxScreens must be between 1 and 100");
  }
  if (config.maxActions < 1 || config.maxActions > 500) {
    throw new ExplorationLimitError("maxActions must be between 1 and 500");
  }

  const graph = new NavigationGraph();
  const startedAt = new Date().toISOString();

  let stats: ExplorationStats;

  switch (config.strategy) {
    case "bfs":
      stats = await exploreBFS(ctx, platform, config, graph);
      break;
    case "dfs":
      stats = await exploreDFS(ctx, platform, config, graph);
      break;
    case "smart":
    default:
      stats = await exploreSmart(ctx, platform, config, graph);
      break;
  }

  const id = `${config.package}-${Date.now()}`;

  return {
    id,
    package: config.package,
    strategy: config.strategy,
    startedAt,
    completedAt: new Date().toISOString(),
    graph: graph.toJSON(),
    stats,
  };
}
