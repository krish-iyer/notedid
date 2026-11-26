import { useSyncExternalStore } from 'react';

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
  action?: { label: string; run: () => void };
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Shows a short message at the bottom of the screen for a few seconds. */
export function showToast(message: string, kind: Toast['kind'] = 'info', action?: Toast['action']): void {
  const toast: Toast = { id: nextId++, message, kind, ...(action ? { action } : {}) };
  toasts = [...toasts, toast].slice(-4);
  emit();
  setTimeout(() => dismissToast(toast.id), kind === 'error' ? 8000 : 4000);
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => toasts,
  );
}
