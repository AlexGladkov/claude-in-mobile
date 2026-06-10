/**
 * RuntimeContext — encapsulates module-level mutable state that previously
 * lived as `let`/`const` declarations across several modules.
 *
 * MCP stdio transport is single-session in practice, so a process-wide
 * default singleton is provided via `getDefaultRuntimeContext()`. All legacy
 * top-level functions in `registry.ts`, `recorder-tools.ts`, and
 * `context/shared-state.ts` delegate to that singleton, so existing
 * call-sites continue to work unchanged.
 *
 * For tests that need clean state, use `setDefaultRuntimeContext(createRuntimeContext())`.
 */

import { ToolRegistry } from "../tools/tool-registry.js";
import { RecorderState } from "../tools/recorder-state.js";
import { SharedState } from "../tools/context/shared-state-class.js";

export interface RuntimeContext {
  readonly registry: ToolRegistry;
  readonly recorder: RecorderState;
  readonly sharedState: SharedState;
}

export function createRuntimeContext(): RuntimeContext {
  return {
    registry: new ToolRegistry(),
    recorder: new RecorderState(),
    sharedState: new SharedState(),
  };
}

let defaultCtx: RuntimeContext | null = null;

export function getDefaultRuntimeContext(): RuntimeContext {
  if (!defaultCtx) defaultCtx = createRuntimeContext();
  return defaultCtx;
}

export function setDefaultRuntimeContext(ctx: RuntimeContext): void {
  defaultCtx = ctx;
}

/** Reset the default context (helper for tests). */
export function resetDefaultRuntimeContext(): void {
  defaultCtx = createRuntimeContext();
}
