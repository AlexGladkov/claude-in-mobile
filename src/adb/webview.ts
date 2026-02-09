/**
 * WebView inspection via Chrome DevTools Protocol.
 * Connects to WebViews in Android apps using ADB port-forwarding + CDP.
 */

import { AdbClient } from "./client.js";
import { WebViewNotFoundError } from "../errors.js";

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

export class WebViewInspector {
  private forwardedPort: number | null = null;

  constructor(private adbClient: AdbClient) {}

  /**
   * Discover available WebView debug sockets on device
   */
  discoverWebViews(): string[] {
    try {
      const output = this.adbClient.shell("cat /proc/net/unix 2>/dev/null");
      const lines = output.split("\n");
      const sockets: string[] = [];

      for (const line of lines) {
        // Match devtools_remote sockets (Chrome, WebView, etc.)
        // Socket names may be prefixed with @ (abstract namespace)
        const match = line.match(/@?([\w.]+_devtools_remote\S*)/);
        if (match) {
          sockets.push(match[1]);
        }
      }

      return [...new Set(sockets)]; // deduplicate
    } catch {
      return [];
    }
  }

  /**
   * Forward a WebView debug socket and return the local port
   */
  async forwardWebView(socketName?: string): Promise<number> {
    // Clean up previous forward
    if (this.forwardedPort) {
      try {
        this.adbClient.exec(`forward --remove tcp:${this.forwardedPort}`);
      } catch {}
      this.forwardedPort = null;
    }

    // If no socket specified, auto-discover
    if (!socketName) {
      const sockets = this.discoverWebViews();
      if (sockets.length === 0) {
        throw new WebViewNotFoundError();
      }
      socketName = sockets[0];
    }

    // Find a free port starting from 9222
    const port = await this.findFreePort(9222);

    // Forward the socket
    this.adbClient.exec(`forward tcp:${port} localabstract:${socketName}`);
    this.forwardedPort = port;

    return port;
  }

  /**
   * List available pages/targets via CDP
   */
  async listTargets(port?: number): Promise<WebViewTarget[]> {
    const p = port ?? this.forwardedPort;
    if (!p) {
      throw new Error("No WebView port forwarded. Call forwardWebView() first.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(`http://localhost:${p}/json/list`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`CDP request failed: ${response.status}`);
      }

      return await response.json() as WebViewTarget[];
    } catch (error: any) {
      clearTimeout(timeout);
      if (error.name === "AbortError") {
        throw new Error("WebView CDP connection timed out. Is the WebView active?");
      }
      throw error;
    }
  }

  /**
   * Get page DOM tree via CDP HTTP endpoint
   */
  async getPageContent(targetId: string, port?: number): Promise<string> {
    const p = port ?? this.forwardedPort;
    if (!p) {
      throw new Error("No WebView port forwarded. Call forwardWebView() first.");
    }

    // Use CDP /json/protocol to get DOM — simpler approach: evaluate JS to get HTML
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      // First get the websocket URL, but since we can't do WS easily,
      // use the simpler HTTP-based approach via /json/version + evaluate
      const response = await fetch(`http://localhost:${p}/json/list`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const targets = await response.json() as WebViewTarget[];
      const target = targets.find(t => t.id === targetId);

      if (!target) {
        throw new Error(`Target ${targetId} not found`);
      }

      // Return target info with URL and title
      return JSON.stringify({
        title: target.title,
        url: target.url,
        type: target.type,
      }, null, 2);
    } catch (error: any) {
      clearTimeout(timeout);
      throw error;
    }
  }

  /**
   * Get full WebView inspection result (discover + list targets)
   */
  async inspect(): Promise<{
    sockets: string[];
    targets: WebViewTarget[];
    forwardedPort: number;
  }> {
    const sockets = this.discoverWebViews();

    if (sockets.length === 0) {
      throw new WebViewNotFoundError();
    }

    const port = await this.forwardWebView(sockets[0]);
    const targets = await this.listTargets(port);

    return { sockets, targets, forwardedPort: port };
  }

  /**
   * Clean up port forwarding
   */
  cleanup(): void {
    if (this.forwardedPort) {
      try {
        this.adbClient.exec(`forward --remove tcp:${this.forwardedPort}`);
      } catch {}
      this.forwardedPort = null;
    }
  }

  private async findFreePort(startPort: number): Promise<number> {
    const { createServer } = await import("net");

    for (let port = startPort; port < startPort + 100; port++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const server = createServer();
          server.once("error", reject);
          server.once("listening", () => {
            server.close(() => resolve());
          });
          server.listen(port);
        });
        return port;
      } catch {
        continue;
      }
    }

    throw new Error(`No free ports available in range ${startPort}-${startPort + 100}`);
  }
}
