export class WDAClient {
    baseUrl;
    sessionId = null;
    operationTimeout = 10000;
    constructor(port) {
        this.baseUrl = `http://localhost:${port}`;
    }
    async ensureSession(deviceId) {
        if (this.sessionId) {
            try {
                // Verify session is still valid
                await this.request("GET", `/session/${this.sessionId}`);
                return;
            }
            catch (error) {
                // Session is invalid, clear it
                console.error("WDA session invalid, recreating:", error.message);
                this.sessionId = null;
            }
        }
        await this.createSession(deviceId);
    }
    async createSession(deviceId) {
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
            throw new Error("Failed to create WebDriverAgent session.\n\n" +
                "Possible causes:\n" +
                "- Simulator is not running (boot with: xcrun simctl boot <UDID>)\n" +
                "- Port in use (check: lsof -i :8100)\n" +
                "- Code signing issues\n\n" +
                "Try restarting the simulator.");
        }
    }
    async deleteSession() {
        if (this.sessionId) {
            try {
                await this.request("DELETE", `/session/${this.sessionId}`);
            }
            catch {
                // Ignore errors on cleanup
            }
            this.sessionId = null;
        }
    }
    async getAccessibleSource() {
        if (!this.sessionId) {
            throw new Error("No active WDA session");
        }
        const response = await this.request("GET", `/session/${this.sessionId}/wda/accessibleSource`);
        return response.value || response;
    }
    async findElement(strategy, selector) {
        if (!this.sessionId) {
            throw new Error("No active WDA session");
        }
        const response = await this.request("POST", `/session/${this.sessionId}/element`, {
            using: strategy,
            value: selector,
        });
        return response.value || response;
    }
    async findElements(strategy, selector) {
        if (!this.sessionId) {
            throw new Error("No active WDA session");
        }
        const response = await this.request("POST", `/session/${this.sessionId}/elements`, {
            using: strategy,
            value: selector,
        });
        return response.value || response || [];
    }
    async clickElement(elementId) {
        if (!this.sessionId) {
            throw new Error("No active WDA session");
        }
        await this.request("POST", `/session/${this.sessionId}/element/${elementId}/click`);
    }
    async tapByCoordinates(x, y) {
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
    async longPress(x, y, durationMs = 1000) {
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
    async getWindowSize() {
        if (!this.sessionId) {
            throw new Error("No active WDA session");
        }
        const response = await this.request("GET", `/session/${this.sessionId}/window/size`);
        return response.value || response;
    }
    async swipe(x1, y1, x2, y2, duration = 300) {
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
    async getElementRect(elementId) {
        if (!this.sessionId) {
            throw new Error("No active WDA session");
        }
        const response = await this.request("GET", `/session/${this.sessionId}/element/${elementId}/rect`);
        return response.value || response;
    }
    async getElementText(elementId) {
        if (!this.sessionId) {
            throw new Error("No active WDA session");
        }
        const response = await this.request("GET", `/session/${this.sessionId}/element/${elementId}/text`);
        return response.value || response || "";
    }
    async isElementDisplayed(elementId) {
        if (!this.sessionId) {
            throw new Error("No active WDA session");
        }
        const response = await this.request("GET", `/session/${this.sessionId}/element/${elementId}/displayed`);
        return response.value || response || false;
    }
    async request(method, path, body) {
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
                throw new Error(`WebDriverAgent request failed: ${response.status} ${response.statusText}\n${text}`);
            }
            const data = await response.json();
            if (data.status !== undefined && data.status !== 0) {
                throw new Error(`WebDriverAgent error: ${data.value?.message || JSON.stringify(data)}`);
            }
            return data;
        }
        catch (error) {
            clearTimeout(timeout);
            if (error.name === "AbortError") {
                throw new Error(`WebDriverAgent request timed out after ${this.operationTimeout}ms`);
            }
            throw error;
        }
    }
}
//# sourceMappingURL=wda-client.js.map