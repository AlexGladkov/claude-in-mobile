import { scoreElement } from "../ui-scoring.js";
import type { UiElement } from "./types.js";
import { getShortId } from "./types.js";

/**
 * Find elements by text (partial match, case-insensitive)
 */
export function findByText(elements: UiElement[], text: string): UiElement[] {
  const lowerText = text.toLowerCase();
  return elements.filter(el =>
    el.text.toLowerCase().includes(lowerText) ||
    el.contentDesc.toLowerCase().includes(lowerText)
  );
}

/**
 * Find elements by resource ID (partial match)
 */
export function findByResourceId(elements: UiElement[], id: string): UiElement[] {
  return elements.filter(el => el.resourceId.includes(id));
}

/**
 * Find elements by class name
 */
export function findByClassName(elements: UiElement[], className: string): UiElement[] {
  return elements.filter(el => el.className.includes(className));
}

/**
 * Find clickable elements
 */
export function findClickable(elements: UiElement[]): UiElement[] {
  return elements.filter(el => el.clickable);
}

/**
 * Find elements by multiple criteria
 */
export function findElements(
  elements: UiElement[],
  criteria: {
    text?: string;
    resourceId?: string;
    className?: string;
    clickable?: boolean;
    enabled?: boolean;
    visible?: boolean;
  }
): UiElement[] {
  return elements.filter(el => {
    if (criteria.text && !el.text.toLowerCase().includes(criteria.text.toLowerCase()) &&
        !el.contentDesc.toLowerCase().includes(criteria.text.toLowerCase())) {
      return false;
    }
    if (criteria.resourceId && !el.resourceId.includes(criteria.resourceId)) {
      return false;
    }
    if (criteria.className && !el.className.includes(criteria.className)) {
      return false;
    }
    if (criteria.clickable !== undefined && el.clickable !== criteria.clickable) {
      return false;
    }
    if (criteria.enabled !== undefined && el.enabled !== criteria.enabled) {
      return false;
    }
    if (criteria.visible !== undefined) {
      const isVisible = el.width > 0 && el.height > 0;
      if (isVisible !== criteria.visible) return false;
    }
    return true;
  });
}

/**
 * Find the smallest clickable ancestor whose bounds fully contain the target element.
 * Useful for grid/list items where the visible label (TextView) is non-clickable but
 * the parent ViewGroup carries the TapGestureRecognizer.
 *
 * Returns null if no clickable ancestor exists, or if the only candidate is so large
 * it likely covers the whole screen (heuristic: >75% of any screen dimension).
 */
export function findClickableAncestor(
  target: UiElement,
  all: UiElement[],
  options?: { maxAreaMultiplier?: number }
): UiElement | null {
  if (target.clickable) return null; // already clickable, no walk needed
  const targetArea = Math.max(1, target.width * target.height);
  const maxAreaMultiplier = options?.maxAreaMultiplier ?? 200; // ancestor area ≤ 200× target
  const candidates = all.filter(el =>
    el !== target &&
    el.clickable &&
    el.enabled &&
    el.width > 0 &&
    el.height > 0 &&
    // bounds containment
    el.bounds.x1 <= target.bounds.x1 &&
    el.bounds.y1 <= target.bounds.y1 &&
    el.bounds.x2 >= target.bounds.x2 &&
    el.bounds.y2 >= target.bounds.y2 &&
    // not the whole-screen container
    el.width * el.height <= targetArea * maxAreaMultiplier
  );
  if (candidates.length === 0) return null;
  // smallest by area = most specific ancestor
  candidates.sort((a, b) => (a.width * a.height) - (b.width * b.height));
  return candidates[0];
}

/**
 * Find best element by description (smart fuzzy search).
 * Returns the best match or null.
 */
export function findBestMatch(
  elements: UiElement[],
  description: string,
  options?: { walkToClickable?: boolean }
): { element: UiElement; confidence: number; reason: string } | null {
  const desc = description.toLowerCase().trim();

  // Score each element via the declarative table in `ui-scoring.ts`.
  const scored = elements
    .filter(el => el.enabled && (el.width > 0 && el.height > 0))
    .map(el => {
      const text = el.text.toLowerCase();
      const contentDesc = el.contentDesc.toLowerCase();
      const id = getShortId(el.resourceId).toLowerCase().replace(/_/g, " ");
      const { score, reason } = scoreElement({ text, contentDesc, id, desc, element: el });
      return { element: el, score, reason };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return null;
  }

  const best = scored[0];

  // If matched element isn't clickable, try walking up to a clickable ancestor.
  // Common pattern: grid/list item where visible label is a TextView but the parent
  // ViewGroup owns the TapGestureRecognizer (frequent in MAUI/Compose layouts).
  // Default ON; caller can opt out with walkToClickable: false.
  const walkToClickable = options?.walkToClickable ?? true;
  if (walkToClickable && !best.element.clickable) {
    const ancestor = findClickableAncestor(best.element, elements);
    if (ancestor) {
      return {
        element: ancestor,
        confidence: Math.min(best.score, 95),
        reason: `${best.reason} (via clickable ancestor)`
      };
    }
  }

  return {
    element: best.element,
    confidence: Math.min(best.score, 100),
    reason: best.reason
  };
}
