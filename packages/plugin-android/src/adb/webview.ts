/**
 * WebView inspection via Chrome DevTools Protocol.
 * Connects to WebViews in Android apps using ADB port-forwarding + CDP.
 */

import { z } from "zod";
import { createServer } from "node:net";

import { AdbClient } from "./client.js";
import { WebViewNotFoundError } from "mcp-devices/errors";
const MAX_CDP_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TARGETS = 1000;
const SOCKET_NAME_RE = /^[A-Za-z0-9_.:-]{1,256}$/;
const webViewTargetSchema = z.object({
  description: z.string().max(8192).regex(/^[^\u0000-\u001f\u007f]*$/),
  devtoolsFrontendUrl: z.string().max(8192).regex(/^[^\u0000-\u001f\u007f]*$/),
  id: z.string().max(8192).regex(/^[^\u0000-\u001f\u007f]*$/),
  title: z.string().max(8192).regex(/^[^\u0000-\u001f\u007f]*$/),
  type: z.string().max(8192).regex(/^[^\u0000-\u001f\u007f]*$/),
  url: z.string().max(8192).regex(/^[^\u0000-\u001f\u007f]*$/),
  webSocketDebuggerUrl: z.string().max(8192).regex(/^[^\u0000-\u001f\u007f]*$/),
}).strict();
const webViewTargetsSchema = z.array(webViewTargetSchema).max(MAX_TARGETS);

function parseTargets(value: unknown): WebViewTarget[] {
  const result = webViewTargetsSchema.safeParse(value);
  if (!result.success) {
    throw new Error("Invalid WebView CDP target response.");
  }
  return result.data;
}

async function readTargets(response: Response): Promise<WebViewTarget[]> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`CDP request failed: ${response.status}`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CDP_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("WebView CDP response exceeded the size limit.");
  }
  if (!response.body) throw new Error("WebView CDP response had no body.");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CDP_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("WebView CDP response exceeded the size limit.");
    }
    chunks.push(Buffer.from(value));
  }
  return parseTargets(JSON.parse(Buffer.concat(chunks, total).toString("utf8")));
}

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
  private inspectionPromise: Promise<{
    sockets: string[];
    targets: WebViewTarget[];
  }> | null = null;

  constructor(
    private readonly adbClient: AdbClient,
    private readonly deviceId?: string,
  ) {}

  /**
   * Discover available WebView debug sockets on device
   */
  discoverWebViews(): string[] {
    try {
      const output = this.deviceId === undefined
        ? this.adbClient.shell("cat /proc/net/unix 2>/dev/null")
        : this.adbClient.exec("shell cat /proc/net/unix 2>/dev/null", this.deviceId);
      const lines = output.split("\n");
      const sockets: string[] = [];

      for (const line of lines) {
        // Match devtools_remote sockets (Chrome, WebView, etc.)
        // Socket names may be prefixed with @ (abstract namespace)
        const match = line.match(/@?([A-Za-z0-9_.:-]+_devtools_remote[A-Za-z0-9_.:-]*)/);
        if (match?.[1] && SOCKET_NAME_RE.test(match[1])) {
          sockets.push(match[1]);
          if (sockets.length >= MAX_TARGETS) break;
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
    if (this.forwardedPort !== null) {
      this.cleanup();
    }

    // If no socket specified, auto-discover
    if (!socketName) {
      const sockets = this.discoverWebViews();
      if (sockets.length === 0) {
        throw new WebViewNotFoundError();
      }
      socketName = sockets[0];
    }
    if (!SOCKET_NAME_RE.test(socketName)) {
      throw new Error("Invalid WebView socket name.");
    }

    // Find a free port starting from 9222
    const port = await this.findFreePort(9222);

    // Forward the socket
    this.adbClient.exec(`forward tcp:${port} localabstract:${socketName}`, this.deviceId);
    this.forwardedPort = port;

    return port;
  }

  /**
   * List available pages/targets via CDP
   */
  async listTargets(port?: number): Promise<WebViewTarget[]> {
    const selectedPort = port ?? this.forwardedPort;
    if (!selectedPort || !Number.isSafeInteger(selectedPort) || selectedPort < 1 || selectedPort > 65_535) {
      throw new Error("No valid WebView port forwarded. Call forwardWebView() first.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`http://127.0.0.1:${selectedPort}/json/list`, {
        redirect: "error",
        signal: controller.signal,
      });
      return await readTargets(response);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("WebView CDP connection timed out. Is the WebView active?");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Get page DOM tree via CDP HTTP endpoint
   */
  async getPageContent(targetId: string, port?: number): Promise<string> {
    if (targetId.length === 0 || targetId.length > 1024 || /[\u0000-\u001f\u007f]/.test(targetId)) {
      throw new Error("Invalid WebView target ID.");
    }
    const selectedPort = port ?? this.forwardedPort;
    if (!selectedPort || !Number.isSafeInteger(selectedPort) || selectedPort < 1 || selectedPort > 65_535) {
      throw new Error("No valid WebView port forwarded. Call forwardWebView() first.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`http://127.0.0.1:${selectedPort}/json/list`, {
        redirect: "error",
        signal: controller.signal,
      });
      const targets = await readTargets(response);
      const target = targets.find((candidate) => candidate.id === targetId);
      if (!target) throw new Error("WebView target not found.");
      return JSON.stringify({
        title: target.title,
        url: target.url,
        type: target.type,
      }, null, 2);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Get full WebView inspection result (discover + list targets)
   */
  async inspect(): Promise<{
    sockets: string[];
    targets: WebViewTarget[];
  }> {
    if (this.inspectionPromise) return this.inspectionPromise;

    const inspection = this.performInspection();
    this.inspectionPromise = inspection;
    try {
      return await inspection;
    } finally {
      if (this.inspectionPromise === inspection) {
        this.inspectionPromise = null;
      }
    }
  }

  private async performInspection(): Promise<{
    sockets: string[];
    targets: WebViewTarget[];
  }> {
    const sockets = this.discoverWebViews();

    if (sockets.length === 0) {
      throw new WebViewNotFoundError();
    }

    let inspectionError: unknown;
    try {
      const port = await this.forwardWebView(sockets[0]);
      const targets = await this.listTargets(port);
      return { sockets, targets };
    } catch (error) {
      inspectionError = error;
      throw error;
    } finally {
      try {
        this.cleanup();
      } catch (cleanupError) {
        if (inspectionError !== undefined) {
          throw new AggregateError(
            [inspectionError, cleanupError],
            "WebView inspection failed and the temporary ADB forward could not be removed.",
          );
        }
        throw cleanupError;
      }
    }
  }

  /**
   * Clean up port forwarding
   */
  cleanup(): void {
    if (this.forwardedPort === null) return;
    try {
      this.adbClient.exec(`forward --remove tcp:${this.forwardedPort}`, this.deviceId);
    } catch {
      // Keep the port so a later cleanup attempt can retry removal.
      throw new Error("Unable to remove temporary WebView port forwarding; retry cleanup.");
    }
    this.forwardedPort = null;
  }

  private async findFreePort(startPort: number): Promise<number> {


    for (let port = startPort; port < startPort + 100; port++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const server = createServer();
          server.once("error", reject);
          server.once("listening", () => {
            server.close(() => resolve());
          });
          server.listen(port, "127.0.0.1");
        });
        return port;
      } catch {
        continue;
      }
    }

    throw new Error(`No free ports available in range ${startPort}-${startPort + 100}`);
  }
}
