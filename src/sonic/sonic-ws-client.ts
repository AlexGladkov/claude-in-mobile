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
