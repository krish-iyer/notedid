import { useSyncExternalStore } from 'react';

export interface Dialog {
  id: number;
  kind: 'prompt' | 'confirm';
  title: string;
  message?: string;
  initial?: string;
  placeholder?: string;
  confirmLabel: string;
  danger?: boolean;
  resolve: (value: string | null) => void;
}

let dialogs: Dialog[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function open(dialog: Omit<Dialog, 'id' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => {
    const id = nextId++;
    dialogs = [
      ...dialogs,
      {
        ...dialog,
        id,
        resolve: (value) => {
          dialogs = dialogs.filter((d) => d.id !== id);
          emit();
          resolve(value);
        },
      },
    ];
    emit();
  });
}

/** Asks for a line of text. Resolves to null if cancelled. */
export function askText(options: { title: string; message?: string; initial?: string; placeholder?: string; confirmLabel?: string }): Promise<string | null> {
  return open({ kind: 'prompt', confirmLabel: 'OK', ...options }).then((v) => (v === null ? null : v.trim() || null));
}

export async function askConfirm(options: { title: string; message?: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return (await open({ kind: 'confirm', confirmLabel: 'OK', ...options })) !== null;
}

export function useDialogs(): Dialog[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => dialogs,
  );
}
