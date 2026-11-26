import type { ServerEvent } from '../shared/api.ts';

/** Fans server events (note changed, deleted, …) out to every connected browser. */
export class EventHub {
  readonly #listeners = new Set<(event: ServerEvent) => void>();

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: ServerEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('event listener failed', err);
      }
    }
  }
}
