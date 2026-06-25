import type { CoreTopics, EventBus, Unsubscribe } from "@mcp-devices/plugin-api";

type Handler<P> = (payload: P) => void;

export class InMemoryEventBus implements EventBus {
  private readonly handlers = new Map<keyof CoreTopics, Set<Handler<unknown>>>();

  emit<T extends keyof CoreTopics>(topic: T, payload: CoreTopics[T]): void {
    const set = this.handlers.get(topic);
    if (!set) return;
    for (const h of set) {
      try {
        (h as Handler<CoreTopics[T]>)(payload);
      } catch {
        // handlers must never throw into the bus; swallow to keep other
        // subscribers alive. Logger isn't available at this layer.
      }
    }
  }

  on<T extends keyof CoreTopics>(
    topic: T,
    handler: (payload: CoreTopics[T]) => void
  ): Unsubscribe {
    let set = this.handlers.get(topic);
    if (!set) {
      set = new Set();
      this.handlers.set(topic, set);
    }
    set.add(handler as Handler<unknown>);
    return () => {
      set!.delete(handler as Handler<unknown>);
    };
  }

  clear(): void {
    this.handlers.clear();
  }
}
