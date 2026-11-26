import { useSyncExternalStore } from 'react';
import type { SyncStatus } from '../shared/api.ts';
import { api } from './api.ts';
import { onServerEvent } from './live.ts';
import { showToast } from './toast.ts';
import { messageOf } from './util.ts';

/**
 * Keeps this device in sync with Dropbox while the app is open: right away, a little after you
 * change something, every minute, and when you come back to the app or the network does. The work
 * happens in the backend (`server/sync.ts`); this decides when, and holds the status for the screens.
 */

const MINUTE = 60_000;
/** Notes that lost a conflict are announced once (the newest one seen is kept). */
const SEEN_KEY = 'notesapp-sync-conflicts-seen';

let status: SyncStatus | null = null;
let failure: string | null = null;
const listeners = new Set<() => void>();
let running: Promise<void> | null = null;
let soon: ReturnType<typeof setTimeout> | undefined;
let started = false;

function set(next: SyncStatus | null, error: string | null = failure): void {
  status = next;
  failure = error;
  for (const listener of listeners) listener();
}

const snapshot = () => status;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The sync status (null until known). */
export function useSyncStatus(): SyncStatus | null {
  return useSyncExternalStore(subscribe, snapshot);
}

/** Why the last sync request failed (it may not have reached the backend). */
export function useSyncFailure(): string | null {
  return useSyncExternalStore(subscribe, () => failure);
}

export async function refreshSyncStatus(): Promise<SyncStatus | null> {
  try {
    set(await api.syncStatus());
  } catch (err) {
    set(status, messageOf(err));
  }
  return status;
}

function announceConflicts(next: SyncStatus): void {
  let seen = '';
  try {
    seen = localStorage.getItem(SEEN_KEY) ?? '';
  } catch {
    // private window: announce again next time
  }
  const fresh = next.conflicts.filter((c) => c.at > seen);
  if (fresh.length === 0) return;
  try {
    localStorage.setItem(SEEN_KEY, fresh[0]?.at ?? seen);
  } catch {
    // as above
  }
  const which = fresh.length === 1 ? fresh[0]?.path : `${fresh.length} notes`;
  showToast(`${which} changed on two devices in the same place. The newer text stayed; the other is in the note’s History.`, 'info');
}

/** Syncs now (and again while the backend says there is more). One sync at a time. */
export function syncNow(options: { deletes?: 'allow' | 'restore'; quiet?: boolean } = {}): Promise<void> {
  running ??= (async () => {
    try {
      for (let round = 0; round < 50; round++) {
        const result = await api.syncRun(options.deletes);
        set(result.status, null);
        if (!result.more) break;
      }
      if (status) announceConflicts(status);
    } catch (err) {
      await refreshSyncStatus();
      set(status, messageOf(err));
      if (!options.quiet) showToast(`Could not sync: ${messageOf(err)}`, 'error');
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

const canSync = () => status?.connected === true && document.visibilityState === 'visible' && navigator.onLine;

/** Starts syncing in the background, if Dropbox is connected. */
export function startSync(): void {
  if (started) return;
  started = true;
  void refreshSyncStatus().then(() => {
    if (canSync()) void syncNow({ quiet: true });
  });
  setInterval(() => canSync() && void syncNow({ quiet: true }), MINUTE);
  document.addEventListener('visibilitychange', () => canSync() && void syncNow({ quiet: true }));
  window.addEventListener('online', () => canSync() && void syncNow({ quiet: true }));
  // A change here goes out a few seconds after the typing stops (changes sync itself makes don't count).
  onServerEvent((event) => {
    if ((event.type !== 'changed' && event.type !== 'deleted') || running || !status?.connected) return;
    if (soon) clearTimeout(soon);
    soon = setTimeout(() => canSync() && void syncNow({ quiet: true }), 8_000);
  });
}

/** After connecting or disconnecting. */
export function setSyncStatus(next: SyncStatus): void {
  set(next, null);
}
