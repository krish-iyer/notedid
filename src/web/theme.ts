import { useSyncExternalStore } from 'react';

/** Light, dark, or follow the system. Remembered per browser (index.html applies it before the page draws). */
export type ThemeChoice = 'auto' | 'light' | 'dark';

const KEY = 'notesapp-theme';
const listeners = new Set<() => void>();

function stored(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'auto';
  } catch {
    return 'auto';
  }
}

let current = stored();

export function setTheme(choice: ThemeChoice): void {
  current = choice;
  try {
    if (choice === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Private windows may refuse storage; the choice still applies until the page reloads.
  }
  if (choice === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  for (const listener of listeners) listener();
}

export function useTheme(): ThemeChoice {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
