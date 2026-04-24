import type { UiElement } from "../adb/ui-parser.js";

// ── Exploration types ──

export type ExplorationStrategy = "bfs" | "dfs" | "smart";

export interface ExplorationConfig {
  package: string;
  strategy: ExplorationStrategy;
  maxScreens: number;
  maxActions: number;
  dryRun: boolean;
}

export interface ScreenNode {
  id: string;
  fingerprint: string;
  elements: UiElement[];
  screenshotBase64?: string;
  activity?: string;
  title?: string;
  visitedAt: string;
}

export interface NavigationEdge {
  fromScreenId: string;
  toScreenId: string;
  action: ExplorationAction;
  timestamp: string;
}

export interface ExplorationAction {
  type: "tap" | "long_press" | "swipe" | "key";
  elementIndex?: number;
  elementText?: string;
  elementResourceId?: string;
  elementClassName?: string;
  x?: number;
  y?: number;
  key?: string;
  direction?: "up" | "down" | "left" | "right";
}

export interface NavigationGraphData {
  screens: ScreenNode[];
  edges: NavigationEdge[];
}

export interface ExplorationResult {
  id: string;
  package: string;
  strategy: ExplorationStrategy;
  startedAt: string;
  completedAt: string;
  graph: NavigationGraphData;
  stats: ExplorationStats;
}

export interface ExplorationStats {
  screensFound: number;
  edgesFound: number;
  actionsPerformed: number;
  maxScreensReached: boolean;
  maxActionsReached: boolean;
  dryRun: boolean;
}

// ── Test generation types ──

export type TestFormat = "flow_run" | "steps";

export interface GeneratedTest {
  id: string;
  name: string;
  description: string;
  path: string[];
  steps: TestStep[];
  format: TestFormat;
}

export interface TestStep {
  action: string;
  args: Record<string, unknown>;
  expectedScreen?: string;
  label?: string;
}

export interface GeneratedTestSuite {
  explorationId: string;
  generatedAt: string;
  tests: GeneratedTest[];
}

// ── Self-healing types ──

export interface OriginalSelector {
  text?: string;
  resourceId?: string;
  className?: string;
  bounds?: { x1: number; y1: number; x2: number; y2: number };
}

export interface HealingResult {
  healed: boolean;
  confidence: number;
  originalSelector: OriginalSelector;
  healedSelector: {
    index: number;
    text: string;
    resourceId: string;
    className: string;
    bounds: { x1: number; y1: number; x2: number; y2: number };
    centerX: number;
    centerY: number;
  };
  reason: string;
}

// ── Blocklist ──

export const DESTRUCTIVE_PATTERNS = [
  "delete",
  "remove",
  "logout",
  "log out",
  "sign out",
  "signout",
  "uninstall",
  "format",
  "reset",
  "clear all",
] as const;
