import type { AgentEvent } from "@t3os/core";

export type EventListener = (event: AgentEvent) => void;

export class EventBus {
  #listeners = new Map<string, Set<EventListener>>();

  subscribe(sessionId: string, listener: EventListener): () => void {
    let set = this.#listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.#listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#listeners.delete(sessionId);
    };
  }

  publish(sessionId: string, event: AgentEvent): void {
    const set = this.#listeners.get(sessionId);
    if (!set) return;
    for (const listener of set) listener(event);
  }

  subscriberCount(sessionId: string): number {
    return this.#listeners.get(sessionId)?.size ?? 0;
  }
}
