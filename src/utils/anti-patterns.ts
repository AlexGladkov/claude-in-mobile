/**
 * Anti-pattern detector for AI agent tool usage.
 * Tracks recent calls and emits hints when inefficient patterns are detected.
 */

interface CallRecord {
  toolName: string;
  timestamp: number;
  depth: number;
}

const callWindow: CallRecord[] = [];
const WINDOW_SIZE = 5;
const HINT_COOLDOWN = 3; // don't repeat same hint within N calls
let lastHint: { text: string; callIndex: number } | null = null;
let callCounter = 0;

/** Record a tool call for pattern analysis */
export function recordCall(name: string, depth: number): void {
  callCounter++;
  callWindow.push({ toolName: name, timestamp: Date.now(), depth });
  if (callWindow.length > WINDOW_SIZE) callWindow.shift();
}

/** Detect anti-patterns in recent call history. Returns hint text or null. */
export function detectAntiPattern(): string | null {
  if (process.env.MOBILE_DISABLE_HINTS === "true") return null;
  if (callWindow.length < 2) return null;

  const recent = callWindow.map(c => c.toolName);

  // Rule 1: 3+ consecutive screenshots without interaction
  const screenshotNames = new Set(["screen_capture", "screenshot"]);
  const interactionNames = new Set(["input_tap", "input_text", "input_swipe", "input_key", "tap", "swipe", "click", "type_text"]);
  let consecutiveScreenshots = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (screenshotNames.has(recent[i])) {
      consecutiveScreenshots++;
    } else if (interactionNames.has(recent[i])) {
      break;
    } else {
      break;
    }
  }
  if (consecutiveScreenshots >= 3) {
    return emitHint("Use ui(action:'tree') — 10x cheaper than repeated screenshots");
  }

  // Rule 2: ui_tree + screen_capture in same window without interaction between
  const lastTwo = recent.slice(-2);
  const treeNames = new Set(["ui_tree", "get_ui"]);
  if (
    (treeNames.has(lastTwo[0]) && screenshotNames.has(lastTwo[1])) ||
    (screenshotNames.has(lastTwo[0]) && treeNames.has(lastTwo[1]))
  ) {
    return emitHint("Pick one: tree OR screenshot, not both");
  }

  // Rule 3: flow_batch with 1 command (checked via call pattern — if batch was the last call
  // and only 1 sub-call happened, we can't detect that here; skip this rule for now)

  // Rule 4: 3+ consecutive ui_tree without interaction
  let consecutiveTrees = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (treeNames.has(recent[i])) {
      consecutiveTrees++;
    } else if (interactionNames.has(recent[i])) {
      break;
    } else {
      break;
    }
  }
  if (consecutiveTrees >= 3) {
    return emitHint("UI unchanged — act on current elements instead of re-fetching tree");
  }

  return null;
}

function emitHint(text: string): string | null {
  if (lastHint && lastHint.text === text && (callCounter - lastHint.callIndex) < HINT_COOLDOWN) {
    return null; // Don't repeat same hint too soon
  }
  lastHint = { text, callIndex: callCounter };
  return text;
}

/** Reset state (for testing) */
export function resetAntiPatterns(): void {
  callWindow.length = 0;
  lastHint = null;
  callCounter = 0;
}
