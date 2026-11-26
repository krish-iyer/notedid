import { EVENTS_CHANNEL, type ServerEvent } from '../shared/api.ts';

type Listener = (event: ServerEvent) => void;

const listeners = new Set<Listener>();
let source: EventSource | BroadcastChannel | null = null;

function connect(): void {
  if (source) return;
  if (__BROWSER_APP__) {
    // The browser-only app's backend (a service worker) reports changes to every tab on a channel.
    const channel = new BroadcastChannel(EVENTS_CHANNEL);
    channel.onmessage = (message: MessageEvent<ServerEvent>) => {
      for (const listener of listeners) listener(message.data);
    };
    source = channel;
    return;
  }
  const events = new EventSource('/api/events');
  source = events;
  events.addEventListener('change', (message) => {
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
