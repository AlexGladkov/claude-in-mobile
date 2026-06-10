import { PROFILE_VISIBLE, ALL_HIDEABLE_MODULES, type MobileProfile } from "../profiles.js";

/** Build dynamic MCP instructions based on active profile and turbo setting */
export function buildInstructions(profile: MobileProfile, turbo: boolean): string {
  const lines: string[] = [
    "Mobile, desktop, browser automation + store management.",
    "",
    "TOKEN COST (cheapest→expensive): ui(action:'tree',format:'semantic') ~60 tokens | ui(action:'tree',compact:true) ~100 tokens | ui(action:'tree') ~200 tokens | ui(action:'find') ~150 tokens | screen(action:'capture',preset:'low') ~1500 tokens | screen(action:'capture') ~3000 tokens | screen(action:'annotate') ~4000 tokens.",
    "",
    "EFFICIENT PATTERNS: 1) ui_tree first — text-based, ~10x cheaper than screenshots. 2) hints are ON by default — input actions return UI diff, no follow-up needed. Set hints:false only for rapid sequences. 3) screen(preset:'low') for quick visual checks. 4) flow(action:'batch')/flow(action:'run') for multi-step sequences (2-4x faster). 5) screen(diff:true) after actions — returns only changes. 6) ui(action:'tree',compact:true) — interactive elements only, shortest format.",
    "",
    "ANTI-PATTERNS: 1) screenshot after every tap (use hints instead). 2) ui_tree + screenshot together (pick one). 3) Full ui_tree when you only need one element (use ui(action:'find')). 4) screen(preset:'high') unless user requests visual detail.",
    "",
    "ERROR RECOVERY: On errors, [RECOVERY: ...] block contains suggested next tool calls as JSON.",
  ];

  // Hidden modules hint
  const hiddenCount = ALL_HIDEABLE_MODULES.length - PROFILE_VISIBLE[profile].length;
  if (hiddenCount > 0) {
    lines.push(
      "",
      `Optional modules (${hiddenCount} hidden) — device(action:'enable_module',module:'browser') to load. device(action:'enable_module',category:'platform') for batch. device(action:'list_modules') to see all.`,
    );
  }

  if (profile === "minimal") {
    lines.push(
      "",
      "MINIMAL profile active — only device+screen loaded. Use device(action:'enable_module') to load modules as needed.",
    );
  }

  if (turbo) {
    lines.push(
      "",
      "TURBO MODE (experimental): flow(action:'run') returns rich UI context per step. For multi-step operations (E2E testing, navigation sequences, form filling), ALWAYS use flow(action:'run', steps:[...]) instead of calling tools individually. One flow call replaces 10-50 individual calls.",
    );
  }

  return lines.join("\n");
}
