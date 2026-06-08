/**
 * UI element scoring rules, extracted from `ui-parser.ts`.
 *
 * The scoring table used to be 7 inline `if/else` branches with raw magic
 * numbers. Hoisting it into a declarative array makes A/B-ing the weights
 * trivial and the unit tests self-documenting.
 *
 * Rules run top-to-bottom; the first match wins. Returning `null` means
 * "no match" and the next rule is tried.
 */

import type { UiElement } from "./ui-parser.js";

export interface ScoringInput {
  /** lower-cased element.text */
  text: string;
  /** lower-cased element.contentDesc */
  contentDesc: string;
  /** lower-cased short resource id, underscores replaced with spaces */
  id: string;
  /** lower-cased query string */
  desc: string;
  /** original element for reason strings */
  element: UiElement;
}

export interface ScoringHit {
  score: number;
  reason: string;
}

export interface ScoringRule {
  match: (i: ScoringInput) => ScoringHit | null;
}

/** Boost applied on top of any positive score when the element is clickable. */
export const CLICKABLE_BOOST = 10;

export const DEFAULT_SCORING_RULES: ReadonlyArray<ScoringRule> = [
  {
    match: ({ text, desc, element }) =>
      text === desc ? { score: 100, reason: `exact text match: "${element.text}"` } : null,
  },
  {
    match: ({ contentDesc, desc, element }) =>
      contentDesc === desc
        ? { score: 95, reason: `exact description: "${element.contentDesc}"` }
        : null,
  },
  {
    match: ({ text, desc, element }) =>
      text.includes(desc) ? { score: 80, reason: `text contains: "${element.text}"` } : null,
  },
  {
    match: ({ contentDesc, desc, element }) =>
      contentDesc.includes(desc)
        ? { score: 75, reason: `description contains: "${element.contentDesc}"` }
        : null,
  },
  {
    match: ({ id, desc, element }) =>
      id.includes(desc) || id.includes(desc.replace(/ /g, "_"))
        ? { score: 60, reason: `ID match: "${element.resourceId}"` }
        : null,
  },
  {
    match: ({ text, desc, element }) => {
      const hit = desc.split(" ").some((w) => w.length > 2 && text.includes(w));
      return hit ? { score: 40, reason: `partial text match: "${element.text}"` } : null;
    },
  },
  {
    match: ({ contentDesc, desc, element }) => {
      const hit = desc.split(" ").some((w) => w.length > 2 && contentDesc.includes(w));
      return hit
        ? { score: 35, reason: `partial description match: "${element.contentDesc}"` }
        : null;
    },
  },
];

export function scoreElement(
  input: ScoringInput,
  rules: ReadonlyArray<ScoringRule> = DEFAULT_SCORING_RULES,
): ScoringHit {
  for (const rule of rules) {
    const hit = rule.match(input);
    if (hit) {
      return input.element.clickable
        ? { score: hit.score + CLICKABLE_BOOST, reason: hit.reason }
        : hit;
    }
  }
  return { score: 0, reason: "" };
}
