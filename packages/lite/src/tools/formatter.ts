/**
 * Simplified response formatter for lite server.
 * - UI tree: max 15 elements, one-line format
 * - Errors: single line, one recovery action
 * - No hints, no diff, no JSON wrapping
 */

export const MAX_UI_ELEMENTS = 15;
export const MAX_RESPONSE_CHARS = 5_000;

/**
 * Format a single UI tree line into compact format:
 * [idx] "text" type (x,y)
 */
export function formatUiLine(idx: number, rawLine: string): string {
  const trimmed = rawLine.trim();

  // Try to extract text content (only text= attribute, not class= or other attrs)
  const textMatch = trimmed.match(/\btext="([^"]*)"/i);
  const text = textMatch ? textMatch[1] : "";

  // Try to extract element type/class
  const classMatch = trimmed.match(/class="([^"]*)"/i) ?? trimmed.match(/<(\w+)/);
  const type = classMatch ? classMatch[1].split(".").pop() ?? "" : "";

  // Try to extract bounds/coordinates
  const boundsMatch = trimmed.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  let coords = "";
  if (boundsMatch) {
    const cx = Math.round((parseInt(boundsMatch[1]) + parseInt(boundsMatch[3])) / 2);
    const cy = Math.round((parseInt(boundsMatch[2]) + parseInt(boundsMatch[4])) / 2);
    coords = `(${cx},${cy})`;
  }

  // Build compact line
  const parts = [`[${idx}]`];
  if (text) parts.push(`"${text}"`);
  if (type) parts.push(type);
  if (coords) parts.push(coords);

  // Fallback: if we couldn't parse anything, show truncated raw
  if (!text && !type && !coords) {
    return `[${idx}] ${trimmed.slice(0, 80)}`;
  }

  return parts.join(" ");
}

/** Truncate response to MAX_RESPONSE_CHARS */
export function truncateResponse(text: string): string {
  if (text.length <= MAX_RESPONSE_CHARS) return text;
  const remaining = text.length - MAX_RESPONSE_CHARS;
  return text.slice(0, MAX_RESPONSE_CHARS) + `\n[truncated, ${remaining} chars remaining]`;
}

/** Format error for lite output — single line, one recovery hint */
export function formatLiteError(code: string, message: string): string {
  // Take first sentence only
  const firstSentence = message.split(/\.\s/)[0];
  return `[${code}] ${firstSentence}`;
}
