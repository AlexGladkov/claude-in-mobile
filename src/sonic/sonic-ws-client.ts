import WebSocket from "ws";

type MsgListener = (data: Record<string, unknown>) => void;

export class SonicWsClient {
  private ws: WebSocket | null = null;
  private msgListeners = new Map<string, MsgListener>();
  private binaryResolve: ((buf: Buffer) => void) | null = null;
  private binaryReject: ((err: Error) => void) | null = null;
  private binaryTimer: ReturnType<typeof setTimeout> | null = null;

  async connect(url: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });

    this.ws!.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        this.binaryResolve?.(data as Buffer);
        this.binaryResolve = null;
        this.binaryReject = null;
        if (this.binaryTimer) {
          clearTimeout(this.binaryTimer);
          this.binaryTimer = null;
        }
        return;
      }
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        const key = msg["msg"] as string | undefined;
        if (key) this.msgListeners.get(key)?.(msg);
      } catch { /* ignore malformed frames */ }
    });

    this.ws!.on("close", () => this.cleanupPending("WebSocket closed"));
    this.ws!.on("error", (err) => this.cleanupPending(`WebSocket error: ${err.message}`));
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(payload: object): void {
    this.ws?.send(JSON.stringify(payload));
  }

  async sendAndWait(
    payload: object,
    expectedMsg: string,
    timeout = 10_000,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.msgListeners.delete(expectedMsg);
        reject(new Error(`SonicWsClient sendAndWait timeout waiting for msg="${expectedMsg}"`));
      }, timeout);

      this.msgListeners.set(expectedMsg, (data) => {
        clearTimeout(timer);
        this.msgListeners.delete(expectedMsg);
        resolve(data);
      });

      this.send(payload);
    });
  }

  async sendForBinary(payload: object, timeout = 10_000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.binaryResolve = null;
        this.binaryReject = null;
        this.binaryTimer = null;
        reject(new Error("SonicWsClient sendForBinary timeout"));
      }, timeout);

      this.binaryResolve = (buf) => {
        clearTimeout(timer);
        this.binaryTimer = null;
        resolve(buf);
      };
      this.binaryReject = reject;
      this.binaryTimer = timer;
      this.send(payload);
    });
  }

  async sendAndCollect(
    payload: object,
    streamMsg: string,
    doneMsg: string,
    timeout = 30_000,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const lines: string[] = [];
      const timer = setTimeout(() => {
        this.msgListeners.delete(streamMsg);
        this.msgListeners.delete(doneMsg);
        reject(new Error(`sendAndCollect timeout waiting for "${doneMsg}"`));
      }, timeout);

      this.msgListeners.set(streamMsg, (data) => {
        lines.push(String(data["detail"] ?? ""));
      });
      this.msgListeners.set(doneMsg, () => {
        clearTimeout(timer);
        this.msgListeners.delete(streamMsg);
        this.msgListeners.delete(doneMsg);
        resolve(lines.join("\n"));
      });

      this.send(payload);
    });
  }

  /**
   * Send message and collect a list of responses until a completion message.
   * Used for app list, process list, etc.
   */
  async sendAndCollectList<T>(
    payload: object,
    itemMsg: string,
    doneMsg: string,
    timeout = 30_000,
  ): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const items: T[] = [];
      const timer = setTimeout(() => {
        this.msgListeners.delete(itemMsg);
        this.msgListeners.delete(doneMsg);
        reject(new Error(`sendAndCollectList timeout waiting for "${doneMsg}"`));
      }, timeout);

      this.msgListeners.set(itemMsg, (data: Record<string, unknown>) => {
        const detail = data["detail"] as T;
        if (detail) items.push(detail);
      });

      this.msgListeners.set(doneMsg, () => {
        clearTimeout(timer);
        this.msgListeners.delete(itemMsg);
        this.msgListeners.delete(doneMsg);
        resolve(items);
      });

      this.send(payload);
    });
  }

  /**
   * Send message and collect list responses with timeout-based completion.
   * Used when the server doesn't send a completion message (like Android appList).
   * Waits for messages and returns after timeout with collected items.
   */
  async sendAndCollectListWithTimeout<T>(
    payload: object,
    itemMsg: string,
    timeout = 30_000,
  ): Promise<T[]> {
    return new Promise((resolve) => {
      const items: T[] = [];

      const timer = setTimeout(() => {
        this.msgListeners.delete(itemMsg);
        resolve(items);
      }, timeout);

      this.msgListeners.set(itemMsg, (data: Record<string, unknown>) => {
        const detail = data["detail"] as T;
        if (detail) items.push(detail);
      });

      this.send(payload);
    });
  }

  /**
   * Send message and wait for response with enhanced error handling.
   * Handles screenshotError and other error responses.
   */
  async sendAndWaitWithError(
    payload: object,
    expectedMsg: string,
    errorMsg: string,
    timeout = 10_000,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.msgListeners.delete(expectedMsg);
        this.msgListeners.delete(errorMsg);
        reject(new Error(`Timeout waiting for "${expectedMsg}"`));
      }, timeout);

      this.msgListeners.set(expectedMsg, (data) => {
        clearTimeout(timer);
        this.msgListeners.delete(expectedMsg);
        this.msgListeners.delete(errorMsg);
        resolve(data);
      });

      this.msgListeners.set(errorMsg, (data) => {
        clearTimeout(timer);
        this.msgListeners.delete(expectedMsg);
        this.msgListeners.delete(errorMsg);
        const error = data["error"] || "Unknown error";
        reject(new Error(`${errorMsg}: ${error}`));
      });

      this.send(payload);
    });
  }

  disconnect(): void {
    this.cleanupPending("Client disconnected");
    this.ws?.close();
    this.ws = null;
  }

  private cleanupPending(reason: string): void {
    // Reject pending binary request
    if (this.binaryReject) {
      this.binaryReject(new Error(`SonicWsClient: ${reason}`));
    }
    this.binaryResolve = null;
    this.binaryReject = null;
    if (this.binaryTimer) {
      clearTimeout(this.binaryTimer);
      this.binaryTimer = null;
    }
    // Reject pending message listeners
    for (const [key, listener] of this.msgListeners) {
      // Extract the reject function from closure - we need to reject with error
      // Since we can't access the reject directly, clear the listener and let timeout handle it
      // Actually, the timeout will fire and reject. Just clear them.
      this.msgListeners.delete(key);
    }
  }
}
