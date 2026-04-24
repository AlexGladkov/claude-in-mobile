/**
 * Self-healing — finds the best matching element when a test step's
 * original selector no longer matches the current UI.
 *
 * Uses fuzzy matching across text, resourceId, className, and bounds proximity.
 */

import type { UiElement } from "../adb/ui-parser.js";
import type { OriginalSelector, HealingResult } from "./types.js";
import { HealingFailedError } from "../errors.js";

/**
 * Calculate string similarity using Levenshtein distance normalized to 0-1.
 */
function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;

  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return 0.95;

  const maxLen = Math.max(la.length, lb.length);
  if (maxLen === 0) return 1;

  // Simple Levenshtein
  const matrix: number[][] = [];
  for (let i = 0; i <= la.length; i++) {
    matrix[i] = [i];
    for (let j = 1; j <= lb.length; j++) {
      if (i === 0) {
        matrix[i][j] = j;
      } else {
        const cost = la[i - 1] === lb[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost,
        );
      }
    }
  }

  const distance = matrix[la.length][lb.length];
  return 1 - distance / maxLen;
}

/**
 * Calculate bounds proximity score (0-1).
 * Returns 1 if bounds are identical, decreasing with distance.
 */
function boundsProximity(
  a: { x1: number; y1: number; x2: number; y2: number },
  b: { x1: number; y1: number; x2: number; y2: number },
): number {
  const dx = Math.abs(a.x1 - b.x1) + Math.abs(a.x2 - b.x2);
  const dy = Math.abs(a.y1 - b.y1) + Math.abs(a.y2 - b.y2);
  const totalDist = dx + dy;

  // Normalize: 0 distance = 1.0, 200px total distance = ~0.3
  return Math.max(0, 1 - totalDist / 300);
}

/**
 * Score an element against the original selector.
 * Returns a confidence score 0-1 and a reason string.
 */
function scoreElement(
  el: UiElement,
  selector: OriginalSelector,
): { score: number; reason: string } {
  let score = 0;
  let weights = 0;
  const reasons: string[] = [];

  // Text match (weight: 0.35)
  if (selector.text) {
    const textSim = Math.max(
      stringSimilarity(selector.text, el.text),
      stringSimilarity(selector.text, el.contentDesc),
    );
    score += textSim * 0.35;
    weights += 0.35;
    if (textSim > 0.5) reasons.push(`text: ${(textSim * 100).toFixed(0)}%`);
  }

  // Resource ID match (weight: 0.3)
  if (selector.resourceId) {
    const idSim = stringSimilarity(selector.resourceId, el.resourceId);
    score += idSim * 0.3;
    weights += 0.3;
    if (idSim > 0.5) reasons.push(`id: ${(idSim * 100).toFixed(0)}%`);
  }

  // Class name match (weight: 0.15)
  if (selector.className) {
    const classSim = stringSimilarity(selector.className, el.className);
    score += classSim * 0.15;
    weights += 0.15;
    if (classSim > 0.5) reasons.push(`class: ${(classSim * 100).toFixed(0)}%`);
  }

  // Bounds proximity (weight: 0.2)
  if (selector.bounds) {
    const boundsSim = boundsProximity(selector.bounds, el.bounds);
    score += boundsSim * 0.2;
    weights += 0.2;
    if (boundsSim > 0.3) reasons.push(`bounds: ${(boundsSim * 100).toFixed(0)}%`);
  }

  // Normalize if not all criteria provided
  const normalizedScore = weights > 0 ? score / weights : 0;

  return {
    score: Math.round(normalizedScore * 100) / 100,
    reason: reasons.length > 0 ? reasons.join(", ") : "no match",
  };
}

/**
 * Find the best matching element for a broken selector.
 *
 * @param elements Current UI elements
 * @param selector Original selector that no longer matches
 * @param confidenceThreshold Minimum confidence to accept (0-1)
 */
export function healSelector(
  elements: UiElement[],
  selector: OriginalSelector,
  confidenceThreshold: number = 0.6,
): HealingResult {
  if (!selector.text && !selector.resourceId && !selector.className && !selector.bounds) {
    throw new HealingFailedError(
      "Original selector has no criteria. Provide at least one of: text, resourceId, className, bounds.",
    );
  }

  // Filter to visible, enabled elements
  const candidates = elements.filter(
    (el) => el.enabled && el.width > 0 && el.height > 0,
  );

  if (candidates.length === 0) {
    throw new HealingFailedError("No visible elements on screen to heal against.");
  }

  // Score all candidates
  const scored = candidates
    .map((el) => {
      const { score, reason } = scoreElement(el, selector);
      return { element: el, score, reason };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];

  if (best.score < confidenceThreshold) {
    throw new HealingFailedError(
      `Best match confidence ${(best.score * 100).toFixed(0)}% is below threshold ${(confidenceThreshold * 100).toFixed(0)}%. ` +
        `Best candidate: [${best.element.index}] "${best.element.text || best.element.resourceId}" (${best.reason}).`,
    );
  }

  return {
    healed: true,
    confidence: best.score,
    originalSelector: selector,
    healedSelector: {
      index: best.element.index,
      text: best.element.text,
      resourceId: best.element.resourceId,
      className: best.element.className,
      bounds: best.element.bounds,
      centerX: best.element.centerX,
      centerY: best.element.centerY,
    },
    reason: best.reason,
  };
}
