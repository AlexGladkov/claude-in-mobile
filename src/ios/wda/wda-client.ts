import {
  WDASession,
  WDAElement,
  WDARect,
  UITreeNode,
  LocatorStrategy,
  TouchAction,
} from "./wda-types.js";

export class WDAClient {
  private baseUrl: string;
  private sessionId: string | null = null;
  private readonly operationTimeout = 10000;

  constructor(port: number) {
    this.baseUrl = `http://localhost:${port}`;
  }

  async ensureSession(deviceId: string): Promise<void> {
    if (this.sessionId) {
      try {
        // Verify session is still valid
        await this.request("GET", `/session/${this.sessionId}`);
        return;
      } catch (error: any) {
        // Session is invalid, clear it
        console.error("WDA session invalid, recreating:", error.message);
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

    this.sessionId = response.sessionId || response.value?.sessionId;
    if (!this.sessionId) {
      throw new Error(
        "Failed to create WebDriverAgent session.\n\n" +
          "Possible causes:\n" +
          "- Simulator is not running (boot with: xcrun simctl boot <UDID>)\n" +
          "- Port in use (check: lsof -i :8100)\n" +
          "- Code signing issues\n\n" +
          "Try restarting the simulator."
      );
    }
  }

  async deleteSession(): Promise<void> {
    if (this.sessionId) {
      try {
        await this.request("DELETE", `/session/${this.sessionId}`);
      } catch {
        // Ignore errors on cleanup
      }
      this.sessionId = null;
    }
  }

  async getAccessibleSource(): Promise<UITreeNode> {
    if (!this.sessionId) {
      throw new Error("No active WDA session");
    }

    const response = await this.request(
      "GET",
      `/session/${this.sessionId}/wda/accessibleSource`
    );
    return response.value || response;
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

    return response.value || response;
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

    return response.value || response || [];
  }

  async clickElement(elementId: string): Promise<void> {
    if (!this.sessionId) {
      throw new Error("No active WDA session");
    }

    await this.request(
      "POST",
      `/session/${this.sessionId}/element/${elementId}/click`
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

  async getWindowSize(): Promise<{ width: number; height: number }> {
    if (!this.sessionId) {
      throw new Error("No active WDA session");
    }

    const response = await this.request(
      "GET",
      `/session/${this.sessionId}/window/size`
    );
    return response.value || response;
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
      `/session/${this.sessionId}/element/${elementId}/rect`
    );

    return response.value || response;
  }

  async getElementText(elementId: string): Promise<string> {
    if (!this.sessionId) {
      throw new Error("No active WDA session");
    }

    const response = await this.request(
      "GET",
      `/session/${this.sessionId}/element/${elementId}/text`
    );

    return response.value || response || "";
  }

  async isElementDisplayed(elementId: string): Promise<boolean> {
    if (!this.sessionId) {
      throw new Error("No active WDA session");
    }

    const response = await this.request(
      "GET",
      `/session/${this.sessionId}/element/${elementId}/displayed`
    );

    return response.value || response || false;
  }

  private async request(
    method: string,
    path: string,
    body?: any
  ): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.operationTimeout);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `WebDriverAgent request failed: ${response.status} ${response.statusText}\n${text}`
        );
      }

      const data: any = await response.json();

      if (data.status !== undefined && data.status !== 0) {
        throw new Error(
          `WebDriverAgent error: ${data.value?.message || JSON.stringify(data)}`
        );
      }

      return data;
    } catch (error: any) {
      clearTimeout(timeout);

      if (error.name === "AbortError") {
        throw new Error(
          `WebDriverAgent request timed out after ${this.operationTimeout}ms`
        );
      }

      throw error;
    }
  }
}
