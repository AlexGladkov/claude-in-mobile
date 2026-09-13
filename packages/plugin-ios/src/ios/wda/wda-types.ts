export interface WDASession {
  sessionId: string;
  capabilities: Record<string, unknown>;
}

export interface WDAElement {
  ELEMENT: string;
  "element-6066-11e4-a52e-4f735466cecf"?: string;
}

export interface WDARect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UITreeNode {
  type: string;
  label?: string;
  value?: string;
  enabled?: boolean;
  visible?: boolean;
  rect?: WDARect;
  children?: UITreeNode[];
}

/**
 * Thrown when a WebDriverAgent response cannot be interpreted as the internal
 * shape the caller expects.
 *
 * WDA is an untrusted external process on localhost:8100. On session
 * degradation it still answers HTTP 200 but with a `{status:0, value:null,
 * sessionId}` envelope. The historical `response.value || response` unwrap used
 * a falsy check, so a `value:null` envelope leaked through and was cast to a
 * tree/element/rect as if it were real data — the corruption only surfaced far
 * downstream (or, worse, silently produced `[]`). This error is raised at the
 * WDA trust boundary, where the response is first coerced to an internal type,
 * so degradation fails loud and local instead of poisoning callers.
 */
export class WdaTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WdaTreeError";
  }
}

/**
 * Structural predicate: does `v` look like a real WDA payload (tree node,
 * element, rect, size) rather than the bare degraded envelope
 * (`{status, value:null, sessionId}`)? Any non-null object that is not a plain
 * envelope wrapper qualifies — the guard only exists to reject `null`/`undefined`
 * and the envelope-shaped placeholder.
 */
function isMeaningfulWdaValue(v: unknown): boolean {
  return typeof v === "object" && v !== null;
}

/**
 * Validate + unwrap a WDA HTTP envelope at the trust boundary.
 *
 * Accepts either a raw payload or the `{value}` envelope and returns the
 * payload, or throws {@link WdaTreeError} when the response is a degraded
 * envelope / null / non-object. Replaces the `response.value || response`
 * falsy-unwrap that let `value:null` masquerade as valid data.
 */
export function unwrapWdaValue<T>(response: unknown, context: string): T {
  if (
    typeof response === "object" &&
    response !== null &&
    "value" in response
  ) {
    const value = (response as { value?: unknown }).value;
    if (isMeaningfulWdaValue(value)) {
      return value as T;
    }
    throw new WdaTreeError(
      `WDA returned an empty/degraded response for ${context} ` +
        "(value is null/absent). The WebDriverAgent session may have been " +
        "backgrounded or lost.",
    );
  }

  if (isMeaningfulWdaValue(response)) {
    return response as T;
  }

  throw new WdaTreeError(
    `WDA response for ${context} is not usable ` +
      `(got ${response === null ? "null" : typeof response}).`,
  );
}

export type LocatorStrategy =
  | "name"
  | "accessibility id"
  | "class name"
  | "xpath"
  | "predicate string";

export interface TouchAction {
  action: "tap" | "press" | "moveTo" | "wait" | "release";
  options?: {
    x?: number;
    y?: number;
    element?: string;
    ms?: number;
  };
}

export interface WDAInstanceInfo {
  pid: number;
  port: number;
  deviceId: string;
}
