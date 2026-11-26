import type { NoteDoc } from '../shared/api.ts';
import { fetchNote, SaveConflict, saveNote } from './api.ts';
import { messageOf } from './util.ts';

export type SaveStatus = 'loading' | 'saved' | 'unsaved' | 'saving' | 'conflict' | 'error' | 'gone';

export interface SessionState {
  status: SaveStatus;
  /** The last load or save error, if any. */
  error: string | null;
  /** The version on disk, when it changed underneath an edit. */
  conflict: NoteDoc | null;
  /** What the editor shows. A new `version` means the editor must take `content` (keeping the cursor where it can). */
  editor: { content: string; version: number } | null;
}

export const INITIAL_SESSION_STATE: SessionState = { status: 'loading', error: null, conflict: null, editor: null };

const AUTOSAVE_DELAY_MS = 800;
const RETRY_DELAY_MS = 5_000;
/** Browsers cap the body of a keepalive request (used while a page closes) at 64 KiB. */
const KEEPALIVE_MAX_BYTES = 60_000;

/**
 * Loads one note and keeps it saved while it is edited. Saves run one at a time, and each
 * sends the hash of the version it builds on, so changes made elsewhere are never silently
 * overwritten: the server answers with a conflict instead. Changes made elsewhere while the
 * note is open are loaded straight in when there are no unsaved edits.
 */
export class NoteSession {
  readonly path: string;
  readonly #onState: (state: SessionState) => void;
  readonly #abort = new AbortController();
  #state: SessionState = INITIAL_SESSION_STATE;
  #loaded = false;
  #closed = false;
  #saving = false;
  #pendingRemote: string | null = null;
  #draft = '';
  /** Content known to be on disk, at #baseHash. */
  #saved = '';
  #baseHash: string | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #queue: Promise<void> = Promise.resolve();

  constructor(path: string, onState: (state: SessionState) => void) {
    this.path = path;
    this.#onState = onState;
  }

  /** The text as last edited (saved or not). */
  get content(): string {
    return this.#draft;
  }

  get exists(): boolean {
    return this.#baseHash !== null;
  }

  async load(): Promise<void> {
    try {
      const doc = await fetchNote(this.path, this.#abort.signal);
      if (this.#closed) return;
      this.#loaded = true;
      this.#baseHash = doc.hash;
      this.#draft = doc.content;
      this.#saved = doc.content;
      this.#set({ status: 'saved', error: null, editor: { content: doc.content, version: 1 } });
    } catch (err) {
      if (!this.#closed) this.#set({ status: 'error', error: messageOf(err) });
    }
  }

  /** The editor calls this on every change. */
  edit(content: string): void {
    if (!this.#loaded || this.#closed || content === this.#draft) return;
    this.#draft = content;
    if (this.#state.status === 'conflict' || this.#state.status === 'gone') return;
    this.#set({ status: content === this.#saved ? 'saved' : 'unsaved' });
    this.#schedule(AUTOSAVE_DELAY_MS);
  }

  /** Saves pending changes now instead of after the autosave delay. */
  flush(options: { keepalive?: boolean } = {}): Promise<void> {
    this.#cancelTimer();
    this.#queue = this.#queue.then(() => this.#save(options.keepalive ?? false));
    return this.#queue;
  }

  /** The server says the note changed on disk (maybe by us). */
  remoteChanged(hash: string): void {
    if (this.#closed || !this.#loaded) return;
    if (this.#saving) {
      this.#pendingRemote = hash;
      return;
    }
    if (hash !== this.#baseHash) void this.#reload();
  }

  remoteDeleted(): void {
    if (!this.#closed && this.#loaded) this.#set({ status: 'gone' });
  }

  async #reload(): Promise<void> {
    let doc: NoteDoc;
    try {
      doc = await fetchNote(this.path);
    } catch {
      return;
    }
    if (this.#closed || doc.hash === this.#baseHash) return;
    if (this.#draft === this.#saved) {
      this.#baseHash = doc.hash;
      this.#draft = doc.content;
      this.#saved = doc.content;
      this.#set({ status: 'saved', conflict: null, editor: { content: doc.content, version: (this.#state.editor?.version ?? 0) + 1 } });
    } else {
      this.#set({ status: 'conflict', conflict: doc });
    }
  }

  resolveConflict(choice: 'disk' | 'mine'): void {
    const current = this.#state.conflict;
    if (!current || this.#closed) return;
    this.#baseHash = current.hash;
    this.#saved = current.content;
    if (choice === 'disk') {
      this.#draft = current.content;
      this.#set({ status: 'saved', conflict: null, editor: { content: current.content, version: (this.#state.editor?.version ?? 0) + 1 } });
    } else {
      this.#set({ status: 'unsaved', conflict: null });
      void this.flush();
    }
  }

  /** Stops autosaving after one last save of anything pending. */
  close(): void {
    if (this.#closed) return;
    this.#abort.abort();
    void this.flush({ keepalive: true });
    this.#closed = true;
  }

  async #save(keepalive: boolean): Promise<void> {
    if (!this.#loaded || this.#state.status === 'conflict' || this.#state.status === 'gone') return;
    const content = this.#draft;
    if (content === this.#saved) {
      this.#set({ status: 'saved', error: null });
      return;
    }
    this.#set({ status: 'saving' });
    const request = { path: this.path, content, baseHash: this.#baseHash };
    const fitsKeepalive = new TextEncoder().encode(JSON.stringify(request)).length < KEEPALIVE_MAX_BYTES;
    this.#saving = true;
    try {
      const result = await saveNote(request, { keepalive: keepalive && fitsKeepalive });
      this.#baseHash = result.hash;
      this.#saved = content;
      const dirty = this.#draft !== content;
      this.#set({ status: dirty ? 'unsaved' : 'saved', error: null });
      if (dirty) this.#schedule(AUTOSAVE_DELAY_MS);
    } catch (err) {
      if (err instanceof SaveConflict) {
        this.#set({ status: 'conflict', conflict: err.current });
      } else {
        this.#set({ status: 'error', error: messageOf(err) });
        this.#schedule(RETRY_DELAY_MS);
      }
    } finally {
      this.#saving = false;
      const remote = this.#pendingRemote;
      this.#pendingRemote = null;
      if (remote && remote !== this.#baseHash) void this.#reload();
    }
  }

  #schedule(delayMs: number): void {
    if (this.#closed) return;
    this.#cancelTimer();
    this.#timer = setTimeout(() => void this.flush(), delayMs);
  }

  #cancelTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #set(patch: Partial<SessionState>): void {
    if (this.#closed) return;
    const changed = (Object.keys(patch) as (keyof SessionState)[]).some((key) => patch[key] !== this.#state[key]);
    if (!changed) return;
    this.#state = { ...this.#state, ...patch };
    this.#onState(this.#state);
  }
}
