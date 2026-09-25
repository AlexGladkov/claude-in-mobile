import { EventEmitter } from "node:events";

import type {
  CDPAccessibilityNode,
  CDPBoxModel,
  CDPEvaluateResult,
  CDPClientInterface,
  CDPEventSubscription,
  CDPEventUnsubscribe,
} from "./cdp-types.js";
import type { RemoteDebuggingPipes } from "./types.js";

const PIPE_MESSAGE_TERMINATOR = 0;
export const MAX_PIPE_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_PIPE_METHOD_BYTES = 256;
const MAX_PIPE_PENDING_COMMANDS = 4_096;
const MAX_PIPE_EVENT_WAITERS = 128;
const INITIAL_INPUT_BUFFER_BYTES = 1_024;

type JsonRecord = Record<string, unknown>;

type PendingCommand = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

type EventWaiter = {
  method: string;
  listener: (params: unknown, sessionId?: string) => void;
  reject: (reason: unknown) => void;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === "string" && error.length > 0 ? error : fallback);
}


/**
 * A minimal Chrome DevTools Protocol client for Chrome's remote-debugging-pipe.
 *
 * chrome-remote-interface only supports the unauthenticated HTTP/WebSocket
 * endpoint. Chrome's pipe is process-private: chrome-launcher wires the two
 * anonymous child-process pipes directly to Chrome and frames each JSON value
 * with a NUL byte. The pipe endpoint is the browser target, so this client
 * attaches to the first page target and sends page commands with its sessionId.
 */
export class PipeCdpClient extends EventEmitter implements CDPClientInterface {
  readonly Page: CDPClientInterface["Page"];
  readonly Runtime: CDPClientInterface["Runtime"];
  readonly DOM: CDPClientInterface["DOM"];
  readonly Network: CDPClientInterface["Network"];
  readonly Tracing: CDPClientInterface["Tracing"];
  readonly IO: CDPClientInterface["IO"];
  readonly HeapProfiler: CDPClientInterface["HeapProfiler"];
  readonly Accessibility: CDPClientInterface["Accessibility"];
  readonly Input: CDPClientInterface["Input"];

  private readonly incoming: NodeJS.ReadableStream;
  private readonly outgoing: NodeJS.WritableStream;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly eventWaiters = new Set<EventWaiter>();
  private inputBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private inputLength = 0;
  private nextCommandId = 1;
  private sessionId: string | undefined;
  private closed = false;

  private readonly onData = (chunk: unknown): void => {
    try {
      let bytes: Buffer;
      if (typeof chunk === "string") {
        const byteLength = Buffer.byteLength(chunk);
        if (byteLength > MAX_PIPE_MESSAGE_BYTES) {
          throw new Error("Chrome DevTools pipe message exceeds the configured size limit");
        }
        bytes = Buffer.from(chunk);
      } else if (Buffer.isBuffer(chunk)) {
        bytes = chunk;
      } else if (chunk instanceof Uint8Array) {
        // This creates a view over the incoming bytes instead of copying the
        // whole chunk before we have checked each NUL-delimited frame.
        bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      } else {
        throw new Error("Chrome DevTools pipe returned a non-byte chunk");
      }
      this.consumeChunk(bytes);
    } catch (error) {
      const reason = error instanceof Error
        ? error
        : typeof error === "string"
          ? new Error(error)
          : new Error("Invalid Chrome DevTools pipe message");
      this.fail(reason);
    }
  };

  private readonly onEnd = (): void => {
    this.fail(new Error("Chrome DevTools pipe closed"));
  };

  private readonly onStreamError = (error: Error): void => {
    this.fail(error);
  };

  private constructor(pipes: RemoteDebuggingPipes) {
    super();
    this.incoming = pipes.incoming;
    this.outgoing = pipes.outgoing;

    this.incoming.on("data", this.onData);
    this.incoming.on("end", this.onEnd);
    this.incoming.on("close", this.onEnd);
    this.incoming.on("error", this.onStreamError);
    this.outgoing.on("close", this.onEnd);
    this.outgoing.on("error", this.onStreamError);
    this.Page = {
      enable: () => this.sendCommand<void>("Page.enable"),
      navigate: (params) => this.sendCommand<unknown>("Page.navigate", params),
      loadEventFired: ((
        callback?: (params: unknown) => void,
      ) => {
        const subscribe = this.eventMethod<unknown>("Page.loadEventFired");
        if (callback) return subscribe(callback);
        return subscribe();
      }) as CDPEventSubscription<unknown>,
      frameNavigated: (callback) => {
        return this.eventMethod<unknown>("Page.frameNavigated")(callback);
      },
      reload: () => this.sendCommand<void>("Page.reload"),
      captureScreenshot: (params) => this.sendCommand<{ data: string }>("Page.captureScreenshot", params),
    };
    this.Runtime = {
      enable: () => this.sendCommand<void>("Runtime.enable"),
      evaluate: (params) => this.sendCommand<CDPEvaluateResult>("Runtime.evaluate", params),
      callFunctionOn: (params) =>
        this.sendCommand<CDPEvaluateResult>("Runtime.callFunctionOn", params),
    };
    this.DOM = {
      enable: () => this.sendCommand<void>("DOM.enable"),
      getDocument: (params) => this.sendCommand<{ root: { nodeId: number } }>("DOM.getDocument", params),
      querySelector: (params) => this.sendCommand<{ nodeId: number }>("DOM.querySelector", params),
      resolveNode: (params) => this.sendCommand<{ object: { objectId: string } }>("DOM.resolveNode", params),
      pushNodesByBackendIdsToFrontend: (params) =>
        this.sendCommand<{ nodeIds: number[] }>("DOM.pushNodesByBackendIdsToFrontend", params),
      getBoxModel: (params) => this.sendCommand<{ model: CDPBoxModel }>("DOM.getBoxModel", params),
      focus: (params) => this.sendCommand<void>("DOM.focus", params),
    };
    this.Network = {
      enable: () => this.sendCommand<void>("Network.enable"),
    };
    this.Tracing = {
      start: (params) => this.sendCommand<void>("Tracing.start", params),
      end: () => this.sendCommand<void>("Tracing.end"),
      tracingComplete: () => this.eventMethod<{
        dataLossOccurred?: boolean;
        stream?: string;
      }>("Tracing.tracingComplete")() as Promise<{
        dataLossOccurred?: boolean;
        stream?: string;
      }>,
    };
    this.IO = {
      read: (params) => this.sendCommand<{
        data: string;
        eof?: boolean;
        base64Encoded?: boolean;
      }>("IO.read", params),
      close: (params) => this.sendCommand<void>("IO.close", params),
    };
    this.HeapProfiler = {
      enable: () => this.sendCommand<void>("HeapProfiler.enable"),
      disable: () => this.sendCommand<void>("HeapProfiler.disable"),
      takeHeapSnapshot: (params) => this.sendCommand<void>("HeapProfiler.takeHeapSnapshot", params),
    };
    this.Accessibility = {
      getFullAXTree: () => this.sendCommand<{ nodes: CDPAccessibilityNode[] }>("Accessibility.getFullAXTree"),
    };
    this.Input = {
      dispatchMouseEvent: (params) => this.sendCommand<void>("Input.dispatchMouseEvent", params),
      dispatchKeyEvent: (params) => this.sendCommand<void>("Input.dispatchKeyEvent", params),
      insertText: (params) => this.sendCommand<void>("Input.insertText", params),
    };
  }

  static async connect(pipes: RemoteDebuggingPipes): Promise<PipeCdpClient> {
    const client = new PipeCdpClient(pipes);
    try {
      await client.attachToFirstPage();
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    const sessionId = this.sessionId;
    if (sessionId) {
      let timeout: NodeJS.Timeout | undefined;
      try {
        const detach = this.sendCommand<void>(
          "Target.detachFromTarget",
          { sessionId },
          null,
        );
        await Promise.race([
          detach,
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, 1_000);
          }),
        ]);
      } catch {
        // Chrome may already have closed; local pipe cleanup still follows.
      } finally {
        clearTimeout(timeout);
      }
    }
    this.sessionId = undefined;
    this.fail(new Error("Chrome DevTools pipe closed by client"));
  }

  private async attachToFirstPage(): Promise<void> {
    const targets = await this.sendCommand<{
      targetInfos?: Array<{ targetId?: string; type?: string }>;
    }>("Target.getTargets");
    let targetId = targets.targetInfos?.find((target) => target.type === "page")?.targetId;

    if (!targetId) {
      const created = await this.sendCommand<{ targetId?: string }>("Target.createTarget", {
        url: "about:blank",
      });
      targetId = created.targetId;
    }
    if (!targetId) {
      throw new Error("Chrome did not expose a page target over the debugging pipe");
    }

    const attached = await this.sendCommand<{ sessionId?: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    if (!attached.sessionId) {
      throw new Error("Chrome did not return a page session over the debugging pipe");
    }
    this.sessionId = attached.sessionId;
  }

  private sendCommand<T = unknown>(
    method: string,
    params?: JsonRecord,
    sessionId: string | null | undefined = this.sessionId,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Chrome DevTools pipe is closed"));
    if (
      method.length === 0
      || Buffer.byteLength(method, "utf8") > MAX_PIPE_METHOD_BYTES
    ) {
      return Promise.reject(new Error("Chrome DevTools command method exceeds the configured size limit"));
    }
    if (this.pending.size >= MAX_PIPE_PENDING_COMMANDS) {
      return Promise.reject(new Error("Too many pending Chrome DevTools commands"));
    }

    const id = this.nextCommandId++;
    const message: JsonRecord = { id, method, params: params ?? {} };
    if (sessionId) message.sessionId = sessionId;

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        this.outgoing.write(`${JSON.stringify(message)}\u0000`, (error?: Error | null) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          pending.reject(error);
        });
      } catch (error) {
        this.pending.delete(id);
        reject(asError(error, `Unable to send Chrome DevTools command ${method}`));
      }
    });
  }

  private appendInput(segment: Buffer): void {
    if (segment.length === 0) return;
    const required = this.inputLength + segment.length;
    if (required > MAX_PIPE_MESSAGE_BYTES) {
      throw new Error("Chrome DevTools pipe message exceeds the configured size limit");
    }

    if (this.inputLength === 0) {
      // A complete frame can be parsed directly from the incoming chunk. This
      // avoids copying a large screenshot or trace response before its bound
      // has been checked.
      this.inputBuffer = segment;
      this.inputLength = segment.length;
      return;
    }

    if (required > this.inputBuffer.length) {
      let capacity = Math.max(this.inputBuffer.length, INITIAL_INPUT_BUFFER_BYTES);
      while (capacity < required) {
        capacity = Math.min(MAX_PIPE_MESSAGE_BYTES, capacity * 2);
      }
      const next = Buffer.allocUnsafe(capacity);
      this.inputBuffer.copy(next, 0, 0, this.inputLength);
      this.inputBuffer = next;
    }
    segment.copy(this.inputBuffer, this.inputLength);
    this.inputLength = required;
  }

  private consumeChunk(bytes: Buffer): void {
    let offset = 0;
    while (offset < bytes.length) {
      const end = bytes.indexOf(PIPE_MESSAGE_TERMINATOR, offset);
      if (end < 0) {
        this.appendInput(bytes.subarray(offset));
        return;
      }
      this.appendInput(bytes.subarray(offset, end));
      this.consumeFrame();
      offset = end + 1;
    }
  }

  private consumeFrame(): void {
    if (this.inputLength > MAX_PIPE_MESSAGE_BYTES) {
      throw new Error("Chrome DevTools pipe message exceeds the configured size limit");
    }
    const frame = this.inputBuffer.subarray(0, this.inputLength);
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.toString("utf8"));
    } catch {
      throw new Error("Chrome DevTools pipe returned invalid JSON");
    }
    this.inputBuffer = Buffer.alloc(0);
    this.inputLength = 0;
    if (!isRecord(parsed)) {
      throw new Error("Chrome DevTools pipe returned a non-object message");
    }
    this.handleMessage(parsed);
  }

  private handleMessage(message: JsonRecord): void {
    if (Object.hasOwn(message, "id")) {
      if (typeof message.id !== "number" || !Number.isSafeInteger(message.id)) {
        throw new Error("Chrome DevTools pipe returned an invalid command id");
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (isRecord(message.error)) {
        const error = new Error(
          typeof message.error.message === "string"
            ? message.error.message
            : `Chrome DevTools command ${pending.method} failed`,
        );
        Object.assign(error, {
          code: message.error.code,
          data: message.error.data,
        });
        pending.reject(error);
      } else {
        // Result payloads intentionally remain unprojected here. Screenshot
        // and trace responses are bounded by the frame limit but may be much
        // larger than ordinary CDP envelopes.
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (
      typeof message.method !== "string"
      || message.method.length === 0
      || Buffer.byteLength(message.method, "utf8") > MAX_PIPE_METHOD_BYTES
    ) {
      throw new Error("Chrome DevTools pipe returned a method outside the configured bounds");
    }
    this.emit(message.method, message.params, message.sessionId);
  }

  private eventMethod<T>(method: string): CDPEventSubscription<T> {
    return ((callback?: (params: T) => void): CDPEventUnsubscribe | Promise<T> => {
      if (callback) {
        if (this.listenerCount(method) >= MAX_PIPE_EVENT_WAITERS) {
          throw new Error("Too many Chrome DevTools event subscriptions");
        }
        const listener = (params: unknown, sessionId?: string): void => {
          if (sessionId && this.sessionId && sessionId !== this.sessionId) return;
          callback(params as T);
        };
        this.on(method, listener);
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          this.removeListener(method, listener);
        };
      }

      return new Promise<T>((resolve, reject) => {
        if (this.eventWaiters.size >= MAX_PIPE_EVENT_WAITERS) {
          reject(new Error("Too many Chrome DevTools event waiters"));
          return;
        }
        let waiter: EventWaiter;
        const listener = (params: unknown, sessionId?: string): void => {
          if (sessionId && this.sessionId && sessionId !== this.sessionId) return;
          this.removeListener(method, listener);
          this.eventWaiters.delete(waiter);
          resolve(params as T);
        };
        waiter = { method, listener, reject };
        this.eventWaiters.add(waiter);
        this.on(method, listener);
      });
    }) as CDPEventSubscription<T>;
  }

  private fail(reason: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.incoming.removeListener("data", this.onData);
    this.incoming.removeListener("end", this.onEnd);
    this.incoming.removeListener("close", this.onEnd);
    this.outgoing.removeListener("close", this.onEnd);

    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
    for (const waiter of this.eventWaiters) {
      this.removeListener(waiter.method, waiter.listener);
      waiter.reject(reason);
    }
    this.eventWaiters.clear();
    this.inputBuffer = Buffer.alloc(0);
    this.inputLength = 0;
    try {
      this.emit("disconnect", reason);
    } finally {
      this.removeAllListeners();

      try {
        this.outgoing.end();
      } catch {
        // The child process may have closed the write side already.
      }
      const incoming = this.incoming as NodeJS.ReadableStream & { destroy?: () => void };
      const outgoing = this.outgoing as NodeJS.WritableStream & { destroy?: () => void };
      incoming.destroy?.();
      outgoing.destroy?.();
    }
  }
}
