import { useSyncExternalStore } from 'react';
import { journalPath } from '../shared/dates.ts';
import type { Route } from './router.ts';

/**
 * The notes you opened on this device, the latest first: the sidebar's Recent. Kept in the browser
 * (each device has its own), not in the notes folder, and not changed by anything but your visits:
 * a note saved by sync or by a comment doesn't count as one you went to.
 */
const KEY = 'notesapp-recent';
const KEEP = 30;

const listeners = new Set<() => void>();

function load(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string').slice(0, KEEP) : [];
  } catch {
    return [];
  }
}

let visits = load();

function set(next: string[]): void {
  visits = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // A private window may refuse: they're kept until the app closes.
  }
  for (const listener of listeners) listener();
}

// Another tab or window of the app on this device.
window.addEventListener('storage', (event) => {
  if (event.key !== KEY) return;
  visits = load();
  for (const listener of listeners) listener();
});

/** The note a screen shows, if it shows one (today's journal page isn't counted: Today is always there). */
export function visitedPath(route: Route, today: string): string | null {
  switch (route.name) {
    case 'note':
    case 'paper':
    case 'read':
    case 'board':
    case 'dashboard':
      return route.path;
    case 'day':
      return route.date === today ? null : journalPath(route.date);
    default:
      return null;
  }
}

export function recordVisit(path: string): void {
  if (visits[0] !== path) set([path, ...visits.filter((p) => p !== path)].slice(0, KEEP));
}

export function forgetVisit(path: string): void {
  set(visits.filter((p) => p !== path));
}

/** The paths of the notes opened here, the latest first. */
export function useRecentVisits(): string[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => visits,
  );
}
