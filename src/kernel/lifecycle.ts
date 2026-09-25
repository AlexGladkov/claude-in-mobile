import type {
  EventBus,
  Logger,
  PluginContext,
  ToolDefinition,
} from "@mcp-devices/plugin-api";
import type { PluginRegistry, RegistryEntry } from "./registry.js";
import { sanitizeErrorMessage } from "../utils/sanitize.js";

export const DEFAULT_INIT_TIMEOUT_MS = 10_000;
export const DEFAULT_DISPOSE_TIMEOUT_MS = 5_000;
export const DEFAULT_CANCEL_GRACE_MS = 100;

export interface LifecycleDeps {
  registry: PluginRegistry;
  eventBus: EventBus;
  logger: Logger;
  configFor(pluginId: string): Record<string, unknown>;
  registerTools(pluginId: string, defs: readonly ToolDefinition[]): void;
  initTimeoutMs?: number;
  disposeTimeoutMs?: number;
  cancelGraceMs?: number;
}

interface InitAttempt {
  readonly controller: AbortController;
  open: boolean;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${what} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer!: ReturnType<typeof setTimeout>;
  await Promise.race([
    promise.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

export class LifecycleOrchestrator {
  private readonly initOperations = new WeakMap<RegistryEntry, Promise<void>>();
  private readonly disposeOperations = new WeakMap<RegistryEntry, Promise<void>>();
  private readonly pendingInitWork = new WeakMap<RegistryEntry, Promise<unknown>>();
  private readonly attempts = new WeakMap<RegistryEntry, InitAttempt>();

  constructor(private readonly deps: LifecycleDeps) {
    const boundedTimeouts = [
      ["initTimeoutMs", deps.initTimeoutMs, 300_000],
      ["disposeTimeoutMs", deps.disposeTimeoutMs, 300_000],
      ["cancelGraceMs", deps.cancelGraceMs, 10_000],
    ] as const;
    for (const [name, value, maximum] of boundedTimeouts) {
      if (
        value !== undefined
        && (!Number.isSafeInteger(value) || value < 0 || value > maximum)
      ) {
        throw new Error(`${name} is out of range.`);
      }
    }
  }

  async initAll(): Promise<void> {
    for (const entry of this.deps.registry.list()) {
      await this.initOne(entry);
    }
  }

  async initOne(entry: RegistryEntry): Promise<void> {
    const existing = this.initOperations.get(entry);
    if (existing) return existing;
    if (entry.state !== "registered") return;

    const operation = this.runInit(entry);
    this.initOperations.set(entry, operation);
    try {
      await operation;
    } finally {
      if (this.initOperations.get(entry) === operation) {
        this.initOperations.delete(entry);
      }
    }
  }

  private async runInit(entry: RegistryEntry): Promise<void> {
    if (entry.state !== "registered") return;

    const id = entry.plugin.manifest.id;
    const attempt: InitAttempt = {
      controller: new AbortController(),
      open: true,
    };
    const staged: ToolDefinition[] = [];
    this.attempts.set(entry, attempt);
    entry.state = "initializing";

    const context: PluginContext = {
      logger: this.deps.logger,
      config: Object.freeze(this.deps.configFor(id) ?? {}),
      eventBus: this.deps.eventBus,
      signal: attempt.controller.signal,
      registerTool: (def) => {
        if (!attempt.open || attempt.controller.signal.aborted) {
          throw new Error(`plugin "${id}" tool registration is closed`);
        }
        staged.push(def);
      },
    };

    const timeout = this.deps.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    try {
      const initPromise = Promise.resolve().then(() => entry.plugin.init(context));
      this.pendingInitWork.set(entry, initPromise);
      void initPromise.then(
        () => {
          if (this.pendingInitWork.get(entry) === initPromise) {
            this.pendingInitWork.delete(entry);
          }
        },
        () => {
          if (this.pendingInitWork.get(entry) === initPromise) {
            this.pendingInitWork.delete(entry);
          }
        },
      );
      await withTimeout(
        initPromise,
        timeout,
        `plugin "${id}" init`,
        () => {
          attempt.open = false;
          attempt.controller.abort();
        },
      );
      attempt.open = false;
      if (attempt.controller.signal.aborted || entry.state !== "initializing") {
        throw new Error(`plugin "${id}" init was cancelled`);
      }
      this.deps.registerTools(id, staged);
      entry.state = "active";
      entry.lastError = undefined;
      this.deps.eventBus.emit("plugin.initialized", { pluginId: id });
    } catch (error) {
      attempt.open = false;
      attempt.controller.abort();
      if (entry.state === "initializing") {
        entry.state = "failed";
        entry.lastError = sanitizeErrorMessage(
          error instanceof Error ? error.message : String(error),
        ).slice(0, 1000);
        this.deps.eventBus.emit("plugin.failed", {
          pluginId: id,
          error: entry.lastError,
        });
        this.deps.logger.error("plugin init failed", {
          pluginId: id,
          error: entry.lastError,
        });
      }
    } finally {
      attempt.open = false;
      if (entry.state !== "active" && this.attempts.get(entry) === attempt) {
        this.attempts.delete(entry);
      }
    }
  }

  async disposeAll(): Promise<void> {
    const entries = [...this.deps.registry.list()].reverse();
    for (const entry of entries) {
      await this.disposeOne(entry);
    }
  }

  async disposeOne(entry: RegistryEntry): Promise<void> {
    const existing = this.disposeOperations.get(entry);
    if (existing) return existing;
    if (entry.state === "disposed" || entry.state === "unregistered") return;

    const attempt = this.attempts.get(entry);
    if (attempt) {
      attempt.open = false;
      attempt.controller.abort();
    }

    const operation = Promise.resolve().then(() => this.runDispose(entry));
    this.disposeOperations.set(entry, operation);
    try {
      await operation;
    } finally {
      if (this.disposeOperations.get(entry) === operation) {
        this.disposeOperations.delete(entry);
      }
    }
  }

  private async runDispose(entry: RegistryEntry): Promise<void> {
    const id = entry.plugin.manifest.id;
    const initWork = this.pendingInitWork.get(entry);
    if (initWork) {
      const grace = this.deps.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
      await settleWithin(initWork, grace);
    }
    if (entry.state === "disposed" || entry.state === "unregistered") return;

    entry.state = "disposing";
    const timeout = this.deps.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS;
    try {
      const pluginDispose = entry.plugin.dispose;
      if (typeof pluginDispose === "function") {
        await withTimeout(
          Promise.resolve().then(() => pluginDispose.call(entry.plugin)),
          timeout,
          `plugin "${id}" dispose`,
        );
      } else {
        const adapter = entry.plugin.adapter;
        const adapterDispose = adapter?.dispose;
        if (adapter && typeof adapterDispose === "function") {
          await withTimeout(
            Promise.resolve().then(() => adapterDispose.call(adapter)),
            timeout,
            `plugin "${id}" adapter dispose`,
          );
        }
      }
    } catch (error) {
      this.deps.logger.warn("plugin dispose threw", {
        pluginId: id,
        error: sanitizeErrorMessage(
          error instanceof Error ? error.message : String(error),
        ).slice(0, 1000),
      });
    } finally {
      entry.state = "disposed";
      this.deps.eventBus.emit("plugin.disposed", { pluginId: id });
      this.attempts.delete(entry);
    }
  }
}
