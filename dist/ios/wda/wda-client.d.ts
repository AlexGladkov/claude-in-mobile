import { WDAElement, WDARect, UITreeNode, LocatorStrategy } from "./wda-types.js";
export declare class WDAClient {
    private baseUrl;
    private sessionId;
    private readonly operationTimeout;
    constructor(port: number);
    ensureSession(deviceId: string): Promise<void>;
    private createSession;
    deleteSession(): Promise<void>;
    getAccessibleSource(): Promise<UITreeNode>;
    findElement(strategy: LocatorStrategy, selector: string): Promise<WDAElement>;
    findElements(strategy: LocatorStrategy, selector: string): Promise<WDAElement[]>;
    clickElement(elementId: string): Promise<void>;
    tapByCoordinates(x: number, y: number): Promise<void>;
    longPress(x: number, y: number, durationMs?: number): Promise<void>;
    getWindowSize(): Promise<{
        width: number;
        height: number;
    }>;
    swipe(x1: number, y1: number, x2: number, y2: number, duration?: number): Promise<void>;
    getElementRect(elementId: string): Promise<WDARect>;
    getElementText(elementId: string): Promise<string>;
    isElementDisplayed(elementId: string): Promise<boolean>;
    private request;
}
//# sourceMappingURL=wda-client.d.ts.map