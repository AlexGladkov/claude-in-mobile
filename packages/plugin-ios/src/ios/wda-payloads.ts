/**
 * Pure WDA-side payload/coordinate builders. No I/O.
 */

import type { LocatorStrategy } from "./wda/wda-types.js";

export type SwipeDirection = "up" | "down" | "left" | "right";

export interface SwipeCoords {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Build start/end coordinates for a directional swipe centred at (cx, cy)
 * with the given pixel distance.
 */
export function buildSwipeCoords(
  direction: SwipeDirection,
  cx: number,
  cy: number,
  distance: number,
): SwipeCoords {
  const half = distance / 2;
  switch (direction) {
    case "up":
      return { x1: cx, y1: cy + half, x2: cx, y2: cy - half };
    case "down":
      return { x1: cx, y1: cy - half, x2: cx, y2: cy + half };
    case "left":
      return { x1: cx + half, y1: cy, x2: cx - half, y2: cy };
    case "right":
      return { x1: cx - half, y1: cy, x2: cx + half, y2: cy };
  }
}

/**
 * Map a high-level find-elements criteria object into the list of
 * (using, value) WDA selector tuples used to query the agent.
 */
export interface FindElementsCriteria {
  text?: string;
  label?: string;
  type?: string;
  visible?: boolean;
}

export interface WdaSelector {
  using: LocatorStrategy;
  value: string;
}

export function buildFindElementsSelectors(criteria: FindElementsCriteria): WdaSelector[] {
  const selectors: WdaSelector[] = [];
  if (criteria.text) selectors.push({ using: "name", value: criteria.text });
  if (criteria.label) selectors.push({ using: "accessibility id", value: criteria.label });
  if (criteria.type) selectors.push({ using: "class name", value: criteria.type });
  return selectors;
}
