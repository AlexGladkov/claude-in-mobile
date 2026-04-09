import WebSocket from "ws";

type MsgListener = (data: Record<string, unknown>) => void;

export class SonicWsClient {
  private ws: WebSocket | null = null;
  private msgListeners = new Map<string, MsgListener>();
  private binaryResolve: ((buf: Buffer) => void) | null = null;
  private binaryReject: ((err: Error) => void) | null = null;

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
        return;
      }
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        const key = msg["msg"] as string | undefined;
        if (key) this.msgListeners.get(key)?.(msg);
      } catch { /* ignore malformed frames */ }
    });
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
        reject(new Error("SonicWsClient sendForBinary timeout"));
      }, timeout);

      this.binaryResolve = (buf) => { clearTimeout(timer); resolve(buf); };
      this.binaryReject = reject;
      this.send(payload);
    });
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }
}
