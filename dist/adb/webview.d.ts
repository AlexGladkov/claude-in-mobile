/**
 * WebView inspection via Chrome DevTools Protocol.
 * Connects to WebViews in Android apps using ADB port-forwarding + CDP.
 */
import { AdbClient } from "./client.js";
export interface WebViewTarget {
    description: string;
    devtoolsFrontendUrl: string;
    id: string;
    title: string;
    type: string;
    url: string;
    webSocketDebuggerUrl: string;
}
export interface WebViewDomNode {
    nodeId: number;
    nodeType: number;
    nodeName: string;
    localName: string;
    nodeValue: string;
    childNodeCount?: number;
    attributes?: string[];
    children?: WebViewDomNode[];
}
export declare class WebViewInspector {
    private adbClient;
    private forwardedPort;
    constructor(adbClient: AdbClient);
    /**
     * Discover available WebView debug sockets on device
     */
    discoverWebViews(): string[];
    /**
     * Forward a WebView debug socket and return the local port
     */
    forwardWebView(socketName?: string): Promise<number>;
    /**
     * List available pages/targets via CDP
     */
    listTargets(port?: number): Promise<WebViewTarget[]>;
    /**
     * Get page DOM tree via CDP HTTP endpoint
     */
    getPageContent(targetId: string, port?: number): Promise<string>;
    /**
     * Get full WebView inspection result (discover + list targets)
     */
    inspect(): Promise<{
        sockets: string[];
        targets: WebViewTarget[];
        forwardedPort: number;
    }>;
    /**
     * Clean up port forwarding
     */
    cleanup(): void;
    private findFreePort;
}
//# sourceMappingURL=webview.d.ts.map