/**
 * Screen fingerprinting for deduplication during exploration.
 *
 * Creates a deterministic hash from sorted element class names and key text
 * to identify screens across multiple visits.
 */

import { createHash } from "crypto";
import type { UiElement } from "../adb/ui-parser.js";

/**
 * Generate a deterministic fingerprint for a screen based on its UI elements.
 *
 * Strategy: collect short class names + key text from all visible elements,
 * sort them alphabetically, then SHA-256 hash the result.
 * This is resilient to element reordering and minor text changes.
 */
export function generateScreenFingerprint(elements: UiElement[]): string {
  const parts: string[] = [];

  for (const el of elements) {
    // Skip invisible elements
    if (el.width <= 0 || el.height <= 0) continue;

    const shortClass = el.className.split(".").pop() ?? el.className;
    const keyText = el.text.slice(0, 30) || el.contentDesc.slice(0, 30);
    const entry = keyText ? `${shortClass}:${keyText}` : shortClass;
    parts.push(entry);
  }

  parts.sort();

  const raw = parts.join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/**
 * Check whether two fingerprints match (same screen).
 */
export function isSameScreen(fp1: string, fp2: string): boolean {
  return fp1 === fp2;
}
