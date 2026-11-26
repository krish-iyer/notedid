import type { ServerEvent } from '../shared/api.ts';

type Listener = (event: ServerEvent) => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;

function connect(): void {
  if (source) return;
  source = new EventSource('/api/events');
  source.addEventListener('change', (message) => {
    let event: ServerEvent;
    try {
      event = JSON.parse((message as MessageEvent<string>).data) as ServerEvent;
    } catch {
      return;
    }
    for (const listener of listeners) listener(event);
  });
  // EventSource reconnects on its own after errors.
}

/** Calls `listener` for every change the server reports (notes saved, deleted, settings changed). */
export function onServerEvent(listener: Listener): () => void {
  listeners.add(listener);
  connect();
  return () => listeners.delete(listener);
}
