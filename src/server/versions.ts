import type { HistoryEntry, HistoryResponse } from '../shared/api.ts';
import { noteIdOf } from '../shared/noteIds.ts';
import type { NoteStore } from './storage.ts';

/**
 * A note's history as plain files. Every so often the note's text is kept as a version: a file of
 * its own in `.notedid/history/<note id>/`, named after when the note had that text, in UTC
 * (`2026-11-26 14.05.33 UTC.md`). Versions are ordinary markdown files, so any editor opens them,
 * and they go wherever the notes go (export, sync). The folder is named after the note's permanent
 * id, so a renamed or moved note keeps its history.
 *
 * When a version is kept:
 * - a minute or so after a note stops changing, and every few minutes while it keeps changing;
 * - just before a note changes, if its text then has been left alone a while and isn't kept yet
 *   (the version from before an edit is always there to go back to, even when the app stopped
 *   before it could keep it).
 *
 * Older versions thin out: all of the last day's stay, then the last of each hour for a week,
 * then the last of each day.
 */

export const HISTORY_FOLDER = '.notedid/history';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A version's name: when the note had that text, in UTC, to the second. */
const VERSION_NAME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})\.(\d{2})\.(\d{2}) UTC$/;
/** Ids that can name a folder (the ones the app makes, and most people would write). */
const FOLDER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const VERSION_FILE = /^\.notedid\/history\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/(\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2} UTC)\.md$/;

const two = (n: number) => String(n).padStart(2, '0');

/** The name of a version kept at `ms`. */
export function versionName(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}.${two(d.getUTCMinutes())}.${two(d.getUTCSeconds())} UTC`;
}

/** When a version is from (ms since 1970), or null if `name` isn't a version's name. */
export function versionTime(name: string): number | null {
  const m = VERSION_NAME.exec(name);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  return versionName(ms) === name ? ms : null;
}

/** Whether `rel` is a version file (for import). */
export function isVersionFile(rel: string): boolean {
  const m = VERSION_FILE.exec(rel);
  return m !== null && versionTime(m[2] ?? '') !== null;
}

/** The id a note's versions are kept under, or null when it has none (or one that can't name a folder). */
export function historyIdOf(content: string): string | null {
  const id = noteIdOf(content);
  return id !== null && FOLDER_ID.test(id) ? id : null;
}

/**
 * The versions to remove from one note's history at `now`: of those older than a day, all but the
 * last of each hour, and of those older than a week, all but the last of each day.
 */
export function versionsToThin(names: readonly string[], now: number): string[] {
  const kept = new Map<string, { name: string; time: number }>();
  const thinned: string[] = [];
  for (const name of names) {
    const time = versionTime(name);
    if (time === null || now - time < DAY) continue;
    const bucket = now - time < 7 * DAY ? `hour ${Math.floor(time / HOUR)}` : `day ${Math.floor(time / DAY)}`;
    const best = kept.get(bucket);
    if (!best) kept.set(bucket, { name, time });
    else if (time > best.time) {
      thinned.push(best.name);
      kept.set(bucket, { name, time });
    } else thinned.push(name);
  }
  return thinned;
}

export interface VersionOptions {
  /** Keep a version once a note has been left alone this long. */
  delayMs?: number;
  /** …and at least this often while it keeps changing. */
  maxWaitMs?: number;
  /** The clock (for tests). */
  now?: () => number;
}

interface Note {
  id: string;
  content: string;
  hash: string;
  mtime: number;
}

interface Newest {
  time: number;
  hash: string;
}

export class VersionHistory {
  readonly #store: NoteStore;
  readonly #delayMs: number;
  readonly #maxWaitMs: number;
  readonly #now: () => number;
  /** Notes changed since their last version, kept once changes settle. */
  readonly #pending = new Set<string>();
  #pendingSince: number | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Settles when the pending notes' versions are kept. */
  #idle: { promise: Promise<void>; resolve: () => void } | null = null;
  /** The newest version of each note (by id) looked at so far, so a save rarely reads the history. */
  readonly #newest = new Map<string, Newest | null>();
  /** One change to the history at a time. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(store: NoteStore, options: VersionOptions = {}) {
    this.#store = store;
    this.#delayMs = options.delayMs ?? 60_000;
    this.#maxWaitMs = Math.max(this.#delayMs, options.maxWaitMs ?? 180_000);
    this.#now = options.now ?? Date.now;
  }

  /**
   * Call just before a note changes. Its text so far is kept as a version if it has been left alone
   * for a while (or the newest version is getting old), unless it is the newest version already.
   * `always` keeps it however new it is (before a version replaces it: a restore).
   */
  async beforeChange(rel: string, options: { always?: boolean } = {}): Promise<void> {
    // Its text is a moment old, and a version follows once the changes settle.
    if (this.#pending.has(rel) && !options.always) return;
    await this.#serially(async () => {
      const note = await this.#note(rel);
      if (!note) return;
      const newest = await this.#newestOf(note.id);
      if (newest?.hash === note.hash) return;
      const now = this.#now();
      const settled = now - note.mtime >= this.#delayMs;
      const overdue = newest !== null && now - newest.time >= this.#maxWaitMs;
      if (options.always || settled || overdue) await this.#keep(note);
    });
  }

  /** Call after a note changed: its version is kept once it has been left alone for a while. */
  touch(rel: string): void {
    this.#pending.add(rel);
    const now = this.#now();
    this.#pendingSince ??= now;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    const wait = Math.min(this.#delayMs, Math.max(0, this.#pendingSince + this.#maxWaitMs - now));
    this.#timer = setTimeout(() => void this.flush(), wait);
    // A server can still stop while the timer runs (it keeps what is pending first, see main.ts).
    (this.#timer as { unref?: () => void }).unref?.();
    if (!this.#idle) {
      let resolve = () => {};
      const promise = new Promise<void>((r) => (resolve = r));
      this.#idle = { promise, resolve };
    }
  }

  /** Settles once the versions of the notes changed so far are kept (a service worker waits for it). */
  idle(): Promise<void> {
    return this.#idle?.promise ?? Promise.resolve();
  }

  /** Keeps the versions of the changed notes now, without waiting for them to settle. */
  async flush(): Promise<void> {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pendingSince = null;
    const done = this.#idle;
    this.#idle = null;
    const notes = [...this.#pending];
    this.#pending.clear();
    for (const rel of notes) {
      await this.#serially(async () => {
        const note = await this.#note(rel);
        if (note && (await this.#newestOf(note.id))?.hash !== note.hash) await this.#keep(note);
      }).catch((err: unknown) => console.error(`Could not keep a version of ${rel}:`, err));
    }
    done?.resolve();
  }

  /** A note's id (null: it has none, so no versions) and its versions, newest first. */
  async log(rel: string): Promise<HistoryResponse> {
    const doc = await this.#store.read(rel);
    const id = doc.hash === null ? null : historyIdOf(doc.content);
    if (id === null) return { id: null, versions: [] };
    const versions: HistoryEntry[] = (await this.#versions(id)).map(({ name, time }) => ({ version: name, date: new Date(time).toISOString() }));
    return { id, versions };
  }

  /** The text of one of a note's versions, or null if there is no such version. */
  async show(rel: string, version: string): Promise<string | null> {
    if (versionTime(version) === null) return null;
    const doc = await this.#store.read(rel);
    const id = doc.hash === null ? null : historyIdOf(doc.content);
    if (id === null) return null;
    const kept = await this.#store.readText(`${HISTORY_FOLDER}/${id}/${version}.md`);
    return kept.hash === null ? null : kept.content;
  }

  /** Forgets what it knows of the history folders (after versions came in from elsewhere: an import, a sync). */
  forget(): void {
    this.#newest.clear();
  }

  /** A note with an id it can keep versions under, or null. */
  async #note(rel: string): Promise<Note | null> {
    let doc;
    try {
      doc = await this.#store.read(rel);
    } catch {
      return null; // gone, or not text
    }
    const id = doc.hash === null ? null : historyIdOf(doc.content);
    const stat = id === null ? null : await this.#store.stat(rel);
    if (id === null || doc.hash === null || stat === null) return null;
    return { id, content: doc.content, hash: doc.hash, mtime: stat.mtime };
  }

  /** A note's versions, newest first. */
  async #versions(id: string): Promise<{ name: string; time: number }[]> {
    const files = await this.#store.disk.list(`${HISTORY_FOLDER}/${id}`);
    return files
      .flatMap((rel) => {
        const name = rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/, '');
        const time = versionTime(name);
        return time === null || !rel.endsWith('.md') ? [] : [{ name, time }];
      })
      .sort((a, b) => b.time - a.time);
  }

  async #newestOf(id: string): Promise<Newest | null> {
    const known = this.#newest.get(id);
    if (known !== undefined) return known;
    const top = (await this.#versions(id))[0];
    const doc = top ? await this.#store.readText(`${HISTORY_FOLDER}/${id}/${top.name}.md`) : null;
    const newest = top && doc?.hash ? { time: top.time, hash: doc.hash } : null;
    this.#newest.set(id, newest);
    return newest;
  }

  /** Keeps the note's text as a version from when it was saved, then thins out the older ones. */
  async #keep(note: Note): Promise<void> {
    const folder = `${HISTORY_FOLDER}/${note.id}`;
    const names = new Set((await this.#versions(note.id)).map((v) => v.name));
    // Two versions within a second: the later one is a second on.
    let time = Math.floor(note.mtime / 1000) * 1000;
    while (names.has(versionName(time))) time += 1000;
    const name = versionName(time);
    await this.#store.disk.write(`${folder}/${name}.md`, new TextEncoder().encode(note.content));
    names.add(name);
    const newest = this.#newest.get(note.id);
    if (!newest || time >= newest.time) this.#newest.set(note.id, { time, hash: note.hash });
    for (const old of versionsToThin([...names], this.#now())) await this.#store.disk.remove(`${folder}/${old}.md`);
  }

  #serially(task: () => Promise<void>): Promise<void> {
    const result = this.#queue.then(task, task);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}
