/**
 * Navigation Graph — stores screens (nodes) and transitions (edges)
 * discovered during app exploration.
 */

import type {
  ScreenNode,
  NavigationEdge,
  NavigationGraphData,
  ExplorationAction,
} from "./types.js";

export class NavigationGraph {
  private readonly screens = new Map<string, ScreenNode>();
  private readonly edges: NavigationEdge[] = [];

  // ── Mutation ──

  addScreen(screen: ScreenNode): void {
    this.screens.set(screen.id, screen);
  }

  addEdge(
    fromScreenId: string,
    toScreenId: string,
    action: ExplorationAction,
  ): void {
    // Avoid duplicate edges for same transition + action type
    const exists = this.edges.some(
      (e) =>
        e.fromScreenId === fromScreenId &&
        e.toScreenId === toScreenId &&
        e.action.type === action.type &&
        e.action.elementIndex === action.elementIndex,
    );
    if (exists) return;

    this.edges.push({
      fromScreenId,
      toScreenId,
      action,
      timestamp: new Date().toISOString(),
    });
  }

  // ── Query ──

  getScreen(id: string): ScreenNode | undefined {
    return this.screens.get(id);
  }

  getScreenByFingerprint(fingerprint: string): ScreenNode | undefined {
    for (const screen of this.screens.values()) {
      if (screen.fingerprint === fingerprint) return screen;
    }
    return undefined;
  }

  hasScreen(fingerprint: string): boolean {
    return this.getScreenByFingerprint(fingerprint) !== undefined;
  }

  getEdgesFrom(screenId: string): NavigationEdge[] {
    return this.edges.filter((e) => e.fromScreenId === screenId);
  }

  get screenCount(): number {
    return this.screens.size;
  }

  get edgeCount(): number {
    return this.edges.length;
  }

  /**
   * Find all unique paths through the graph using DFS.
   * Returns arrays of screen IDs representing each path.
   * Limits paths to avoid combinatorial explosion.
   */
  getAllPaths(maxPaths = 50): string[][] {
    const paths: string[][] = [];
    const screenIds = [...this.screens.keys()];
    if (screenIds.length === 0) return paths;

    const startId = screenIds[0];

    const dfs = (current: string, visited: Set<string>, path: string[]): void => {
      if (paths.length >= maxPaths) return;

      path.push(current);
      visited.add(current);

      const outEdges = this.getEdgesFrom(current);
      const unvisitedEdges = outEdges.filter((e) => !visited.has(e.toScreenId));

      if (unvisitedEdges.length === 0) {
        // Leaf — record this path
        paths.push([...path]);
      } else {
        for (const edge of unvisitedEdges) {
          if (paths.length >= maxPaths) break;
          dfs(edge.toScreenId, new Set(visited), path.slice());
        }
      }
    };

    dfs(startId, new Set<string>(), []);
    return paths;
  }

  // ── Serialization ──

  toJSON(): NavigationGraphData {
    return {
      screens: [...this.screens.values()],
      edges: [...this.edges],
    };
  }

  static fromJSON(data: NavigationGraphData): NavigationGraph {
    const graph = new NavigationGraph();
    for (const screen of data.screens) {
      graph.screens.set(screen.id, screen);
    }
    for (const edge of data.edges) {
      graph.edges.push(edge);
    }
    return graph;
  }
}
