import { z } from "zod";
import { unwrapWdaValue } from "./wda-types.js";
import type {
  WDAElement,
  WDARect,
  UITreeNode,
  LocatorStrategy,
} from "./wda-types.js";

const MAX_WDA_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_WDA_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_WDA_IDENTIFIER_LENGTH = 1024;

const wdaResponseSchema = z.object({
  status: z.number().int().safe().nonnegative().optional(),
  value: z.unknown().optional(),
  sessionId: z.string().max(MAX_WDA_IDENTIFIER_LENGTH).optional(),
}).passthrough();
type WdaResponse = z.infer<typeof wdaResponseSchema>;
const wdaSessionValueSchema = z.object({
  sessionId: z.string().max(MAX_WDA_IDENTIFIER_LENGTH).optional(),
}).passthrough();
const wdaElementReferenceSchema = z.object({
  ELEMENT: z.string().max(MAX_WDA_IDENTIFIER_LENGTH).optional(),
  element: z.string().max(MAX_WDA_IDENTIFIER_LENGTH).optional(),
  "element-6066-11e4-a52e-4f735466cecf": z
    .string()
    .max(MAX_WDA_IDENTIFIER_LENGTH)
    .optional(),
}).passthrough();

function pathSegment(value: string, label: string): string {
  if (
    value.length === 0
    || value.length > MAX_WDA_IDENTIFIER_LENGTH
    || /[\u0000-\u001f\u007f]/.test(value)
    || !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  return encodeURIComponent(value);
}

async function readWdaResponse(response: Response): Promise<WdaResponse> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WDA_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("WebDriverAgent response exceeded the size limit.");
  }
  if (!response.body) throw new Error("WebDriverAgent returned no response body.");

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_WDA_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("WebDriverAgent response exceeded the size limit.");
    }
    chunks.push(Buffer.from(value));
  }

  const result = wdaResponseSchema.safeParse(
    JSON.parse(Buffer.concat(chunks, total).toString("utf8")),
  );
  if (!result.success) {
    throw new Error("WebDriverAgent returned an invalid response.");
  }
  return result.data;
}

export class WDAClient {
  private baseUrl: string;
  private sessionId: string | null = null;
  private readonly operationTimeout = 10000;
  private ensureSessionPromise?: Promise<void>;

  constructor(port: number) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error("Invalid WebDriverAgent port.");
    }
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async ensureSession(deviceId: string): Promise<void> {
    const inFlight = this.ensureSessionPromise;
    if (inFlight) return inFlight;

    const ensuring = this.ensureSessionNow(deviceId);
    this.ensureSessionPromise = ensuring;
    try {
      await ensuring;
    } finally {
      if (this.ensureSessionPromise === ensuring) {
        this.ensureSessionPromise = undefined;
      }
    }
  }

  private async ensureSessionNow(deviceId: string): Promise<void> {
    if (this.sessionId) {
      try {
        // Verify session is still valid.
        await this.request("GET", `/session/${this.sessionId}`);
        return;
      } catch {
        console.error("WDA session invalid; recreating.");
        this.sessionId = null;
      }
    }

    await this.createSession(deviceId);
  }

  private async createSession(deviceId: string): Promise<void> {
    const response = await this.request("POST", "/session", {
      capabilities: {
        alwaysMatch: {
          platformName: "iOS",
          "appium:automationName": "XCUITest",
          "appium:udid": deviceId,
        },
      },
    });

    const nested = wdaSessionValueSchema.safeParse(response.value);
    const nestedSessionId = nested.success ? nested.data.sessionId : undefined;
    const sessionId = typeof response.sessionId === "string"
      ? response.sessionId
      : typeof nestedSessionId === "string"
        ? nestedSessionId
        : undefined;
    if (!sessionId) {
      throw new Error("Failed to create WebDriverAgent session.");
    }
    pathSegment(sessionId, "WebDriverAgent session ID");
    this.sessionId = sessionId;
  }

  async deleteSession(): Promise<void> {
    // Cleanup must not race a session creation that could otherwise complete
    // after deletion and leave an unowned live session behind.
    try {
      await this.ensureSessionPromise;
    } catch {
      // The caller is already cleaning up the failed transition.
    }
    const sessionId = this.sessionId;
    if (!sessionId) return;
    try {
      await this.request("DELETE", `/session/${sessionId}`);
    } catch {
      // Ignore errors on cleanup.
    }
    if (this.sessionId === sessionId) this.sessionId = null;
  }

  async getSourceTree(): Promise<UITreeNode> {
    if (!this.sessionId) {
      throw new Error("No active WDA session");
    }

    // Page source, not /wda/accessibleSource: the accessibility tree carries no
    // rects, and every consumer downstream drops nodes that have no geometry.
    const response = await this.request(
      "GET",
      `/session/${this.sessionId}/source?format=json`
    );
    // Trust boundary: a degraded session returns 200 with {value:null}. Reject
    // it here instead of casting the envelope to a tree (which yields an empty
    // parse and poisons downstream caches). See WdaTreeError.
    return unwrapWdaValue<UITreeNode>(response, "source");
  }

  async findElement(
    strategy: LocatorStrategy,
    selector: string
  ): Promise<WDAElement> {
    if (!this.sessionId) {
      throw new Error("No active WDA session");
    }

    const response = await this.request(
      "POST",
      `/session/${this.sessionId}/element`,
      {
        using: strategy,
        value: selector,
      }
    );

    return unwrapWdaValue<WDAElement>(response, "findElement");
  }

  async findElements(
    strategy: LocatorStrategy,
    selector: string
  ): Promise<WDAElement[]> {
    if (!this.sessionId) {
      throw new Error("No active WDA session");
    }

    const response = await this.request(
      "POST",
      `/session/${this.sessionId}/elements`,
      {
        using: strategy,
        value: selector,
      }
    );

    // A genuine "no matches" answer is `{value: []}` (a non-null object) and
    // passes validation as an empty array. Only a degraded `{value:null}`
    // envelope throws WdaTreeError — never silently returns the envelope.
    return unwrapWdaValue<WDAElement[]>(response, "findElements");
  }

  async clickElement(elementId: string): Promise<void> {
    if (!this.sessionId) {
      throw new Error("No active WDA session");
    }

    await this.request(
      "POST",
      `/session/${this.sessionId}/element/${pathSegment(elementId, "WebDriverAgent element ID")}/click`
    );
  }

  async tapByCoordinates(x: number, y: number): Promise<void> {
    if (!this.sessionId) {
      throw new Error("No active WDA session");
    }

    // Use W3C WebDriver Actions API for tapping
    await this.request("POST", `/session/${this.sessionId}/actions`, {
      actions: [
        {
          type: "pointer",
          id: "finger1",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x, y },
            { type: "pointerDown", button: 0 },
            { type: "pause", duration: 100 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
  }

  async longPress(x: number, y: number, durationMs: number = 1000): Promise<void> {
    if (!this.sessionId) {
      throw new Error("No active WDA session");
    }

    // Use W3C WebDriver Actions API: pointerDown + pause(duration) + pointerUp
    await this.request("POST", `/session/${this.sessionId}/actions`, {
      actions: [
        {
          type: "pointer",
          id: "finger1",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x, y },
            { type: "pointerDown", button: 0 },
            { type: "pause", duration: durationMs },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
  }

  async typeText(text: string): Promise<void> {
    if (!this.sessionId) {
      throw new Error("No active WDA session");
    }

    // Try WDA-specific /wda/keys first (works on some WDA builds)
    try {
      await this.request("POST", `/session/${this.sessionId}/wda/keys`, {
        value: text.split(""),
      });
      return;
    } catch {
      // Fall through to W3C active element setValue
    }

    // Fallback: W3C standard — find active/focused element and setValue
    const activeEl = await this.request("GET", `/session/${this.sessionId}/element/active`);
    const nested = wdaElementReferenceSchema.safeParse(activeEl.value);
    const topLevel = wdaElementReferenceSchema.safeParse(activeEl);
    const nestedValue = nested.success ? nested.data : undefined;
    const topLevelValue = topLevel.success ? topLevel.data : undefined;
    const elementId = nestedValue?.ELEMENT
      ?? nestedValue?.element
      ?? nestedValue?.["element-6066-11e4-a52e-4f735466cecf"]
      ?? topLevelValue?.ELEMENT
      ?? topLevelValue?.element
      ?? topLevelValue?.["element-6066-11e4-a52e-4f735466cecf"];
    if (typeof elementId !== "string") {
      throw new Error("No focused element found for text input. Tap a text field first.");
    }
    const encodedElementId = pathSegment(elementId, "WebDriverAgent element ID");
    await this.request("POST", `/session/${this.sessionId}/element/${encodedElementId}/value`, {
      text,
      value: text.split(""),
    });
  }

  async getWindowSize(): Promise<{ width: number; height: number }> {
    if (!this.sessionId) {
      throw new Error("No active WDA session");
    }

    const response = await this.request(
      "GET",
      `/session/${this.sessionId}/window/size`
    );
    return unwrapWdaValue<{ width: number; height: number }>(
      response,
      "window/size"
    );
  }

  async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration: number = 300
  ): Promise<void> {
    if (!this.sessionId) {
      throw new Error("No active WDA session");
    }

    // Use W3C WebDriver Actions API for swiping
    await this.request("POST", `/session/${this.sessionId}/actions`, {
      actions: [
        {
          type: "pointer",
          id: "finger1",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: x1, y: y1 },
            { type: "pointerDown", button: 0 },
            { type: "pause", duration: 50 },
            { type: "pointerMove", duration, x: x2, y: y2, origin: "viewport" },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
  }

  async getElementRect(elementId: string): Promise<WDARect> {
    if (!this.sessionId) {
      throw new Error("No active WDA session");
    }

    const response = await this.request(
      "GET",
      `/session/${this.sessionId}/element/${pathSegment(elementId, "WebDriverAgent element ID")}/rect`
    );

    return unwrapWdaValue<WDARect>(response, "element/rect");
  }

  async getElementText(elementId: string): Promise<string> {
    if (!this.sessionId) {
      throw new Error("No active WDA session");
    }

    const response = await this.request(
      "GET",
      `/session/${this.sessionId}/element/${pathSegment(elementId, "WebDriverAgent element ID")}/text`
    );
    if (typeof response.value !== "string") {
      throw new Error("WebDriverAgent returned invalid element text.");
    }
    return response.value;
  }

  async isElementDisplayed(elementId: string): Promise<boolean> {
    if (!this.sessionId) {
      throw new Error("No active WDA session");
    }

    const response = await this.request(
      "GET",
      `/session/${this.sessionId}/element/${pathSegment(elementId, "WebDriverAgent element ID")}/displayed`
    );
    if (typeof response.value !== "boolean") {
      throw new Error("WebDriverAgent returned invalid display state.");
    }
    return response.value;
  }

  /**
   * Capture a screenshot via WDA (`GET /screenshot`). Works for both
   * simulators and physical devices — the only screenshot path that does NOT
   * depend on simctl. Returns a PNG buffer.
   */
  async screenshot(): Promise<Buffer> {
    const data = await this.request("GET", "/screenshot");
    const b64 = typeof data.value === "string" ? data.value : "";
    if (!b64 || b64.length > MAX_WDA_RESPONSE_BYTES) {
      throw new Error("WebDriverAgent returned an invalid screenshot.");
    }
    const png = Buffer.from(b64, "base64");
    if (
      png.length < 8
      || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ) {
      throw new Error("WebDriverAgent returned an invalid screenshot.");
    }
    return png;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<WdaResponse> {
    const serializedBody = body === undefined ? undefined : JSON.stringify(body);
    if (
      serializedBody !== undefined
      && Buffer.byteLength(serializedBody, "utf8") > MAX_WDA_REQUEST_BYTES
    ) {
      throw new Error("WebDriverAgent request exceeded the size limit.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.operationTimeout);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        redirect: "error",
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: serializedBody,
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`WebDriverAgent request failed with HTTP ${response.status}.`);
      }

      const data = await readWdaResponse(response);
      if (data.status !== undefined && data.status !== 0) {
        throw new Error(`WebDriverAgent request failed with status ${data.status}.`);
      }
      return data;
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(
          `WebDriverAgent request timed out after ${this.operationTimeout}ms`
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
