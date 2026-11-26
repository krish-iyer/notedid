import { useSyncExternalStore } from 'react';
import type { NoteSummary, Settings, TagCount } from '../shared/api.ts';
import { linkKey } from '../shared/markdown.ts';
import { api } from './api.ts';
import { refreshAllEditors } from './editor/registry.ts';
import { onServerEvent } from './live.ts';
import { dirname, joinPath } from './util.ts';

/** A tiny observable value for React's useSyncExternalStore. */
class Store<T> {
  #value: T;
  readonly #listeners = new Set<() => void>();

  constructor(value: T) {
    this.#value = value;
  }

  get = (): T => this.#value;

  set(value: T): void {
    this.#value = value;
    for (const listener of this.#listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
}

export const notesStore = new Store<NoteSummary[] | null>(null);
export const settingsStore = new Store<Settings | null>(null);
export const tagsStore = new Store<TagCount[]>([]);

const EMPTY: NoteSummary[] = [];

export async function refreshNotes(): Promise<void> {
  try {
    notesStore.set(await api.notes());
    refreshAllEditors();
  } catch (err) {
    console.warn('could not load the notes list', err);
  }
}

export async function refreshTags(): Promise<void> {
  try {
    tagsStore.set(await api.tags());
  } catch (err) {
    console.warn('could not load tags', err);
  }
}

export async function refreshSettings(): Promise<void> {
  try {
    settingsStore.set(await api.settings());
  } catch (err) {
    console.warn('could not load settings', err);
  }
}

/** Saves a change to the settings, showing it right away. */
export async function updateSettings(change: (settings: Settings) => Settings): Promise<void> {
  const current = settingsStore.get() ?? (await api.settings());
  const next = change(current);
  settingsStore.set(next);
  settingsStore.set(await api.saveSettings(next));
}

let started = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Loads the shared lists and keeps them fresh as the server reports changes. */
export function startStores(): void {
  if (started) return;
  started = true;
  void refreshNotes();
  void refreshTags();
  void refreshSettings();
  onServerEvent((event) => {
    if (event.type === 'changed' || event.type === 'deleted') {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void refreshNotes();
        void refreshTags();
      }, 300);
    } else if (event.type === 'settings') {
      void refreshSettings();
    }
  });
}

export function useNotes(): NoteSummary[] {
  return useSyncExternalStore(notesStore.subscribe, notesStore.get) ?? EMPTY;
}

export function useNotesLoaded(): boolean {
  return useSyncExternalStore(notesStore.subscribe, notesStore.get) !== null;
}

export function useSettings(): Settings | null {
  return useSyncExternalStore(settingsStore.subscribe, settingsStore.get);
}

export function useTags(): TagCount[] {
  return useSyncExternalStore(tagsStore.subscribe, tagsStore.get);
}

export function useNote(path: string): NoteSummary | null {
  return useNotes().find((n) => n.path === path) ?? null;
}

// ---- Link resolution, mirroring the server: path, then title, then file name, alias, PDF name. ----

let cacheFor: NoteSummary[] | null = null;
let lookup = new Map<string, NoteSummary>();

function buildLookup(notes: NoteSummary[]): Map<string, NoteSummary> {
  const map = new Map<string, { note: NoteSummary; priority: number }>();
  const add = (key: string, note: NoteSummary, priority: number) => {
    const existing = map.get(key);
    if (!existing || existing.priority > priority || (existing.priority === priority && existing.note.path > note.path)) map.set(key, { note, priority });
  };
  for (const note of notes) {
    add(linkKey(note.path), note, 0);
    add(linkKey(note.title), note, 1);
    add(linkKey(note.path.split('/').pop() ?? ''), note, 2);
    const aliases = Array.isArray(note.meta.aliases) ? note.meta.aliases : [];
    for (const alias of aliases) add(linkKey(String(alias)), note, 3);
    if (note.kind === 'paper' && typeof note.meta.pdf === 'string') {
      add(note.meta.pdf.toLowerCase(), note, 4);
      add(`${dirname(note.path)}/${note.meta.pdf}`.toLowerCase(), note, 4);
    }
  }
  return new Map([...map].map(([key, value]) => [key, value.note]));
}

/** The note a [[link]] or relative link points at, or null. */
export function resolveNote(target: string, fromPath?: string): NoteSummary | null {
  const notes = notesStore.get() ?? EMPTY;
  if (cacheFor !== notes) {
    lookup = buildLookup(notes);
    cacheFor = notes;
  }
  if (fromPath && /^\.{1,2}\//.test(target)) return lookup.get(linkKey(joinPath(dirname(fromPath), target))) ?? null;
  return lookup.get(/\.pdf$/i.test(target) ? target.toLowerCase() : linkKey(target)) ?? null;
}
