import type { SyncStatus } from '../shared/api.ts';
import { merge3 } from '../shared/merge3.ts';
import { isWhiteboardPath } from '../shared/whiteboards.ts';
import { importable } from './archive.ts';
import type { Disk } from './disk.ts';
import { contentHash, DROPBOX, Dropbox, type DropboxEndpoints, DropboxError, type DropboxTokens, type RemoteFile, tokensFromCode } from './dropbox.ts';
import type { EventHub } from './events.ts';
import { NoteService } from './notes.ts';
import { SettingsStore } from './settings.ts';
import { HISTORY_FOLDER, historyIdOf, isVersionFile, type VersionHistory } from './versions.ts';
import type { FetchFn } from './web.ts';

/**
 * Two-way sync of the notes folder with a Dropbox app folder. Each file is compared three ways:
 * as it is here, as it is on Dropbox, and as both were when it was last in sync (kept in
 * `.notedid/sync/state.json`). A change on one side goes to the other; a deletion too, unless the
 * other side changed the file (then the change wins). A note changed on both sides is merged line
 * by line; if both changed the same lines, the newer text stays and the other is kept as a version
 * in the note's history. For other files the newer one wins (Dropbox keeps the one it replaced).
 *
 * Every step is safe to repeat, so a sync that stops halfway (a closed tab, a time limit) carries
 * on where it was the next time. Versions are synced like any file, so a note's history is the
 * same on every device.
 */

const ACCOUNT_FILE = '.notedid/sync/account.json';
const STATE_FILE = '.notedid/sync/state.json';
/** Dropbox takes files up to this size in one upload. */
const MAX_UPLOAD = 150 * 1024 * 1024;

interface Account extends DropboxTokens {
  name: string;
  email: string;
  endpoints?: DropboxEndpoints;
}

/** A file as both sides had it when it was last in sync. */
interface Synced {
  path: string;
  rev: string;
  hash: string;
  /** Its size and last change here, to tell it is unchanged without reading it. */
  size: number;
  mtime: number;
}

interface State {
  /** Dropbox's place in its list of changes; null before the first sync. */
  cursor: string | null;
  files: Record<string, Synced>;
  lastSync: string | null;
  lastError: string | null;
  conflicts: { path: string; at: string }[];
  last: { up: number; down: number; deleted: number } | null;
  confirmDeletes: number | null;
}

const EMPTY: State = { cursor: null, files: {}, lastSync: null, lastError: null, conflicts: [], last: null, confirmDeletes: null };

export interface SyncOptions {
  /** What to do when the sync would delete many files on Dropbox: ask (default), delete them, or bring them back here. */
  deletes?: 'ask' | 'allow' | 'restore';
  /** Stop after about this long; the next run carries on. */
  budgetMs?: number;
}

export interface SyncResult {
  status: SyncStatus;
  /** It stopped before it was done: run again. */
  more: boolean;
}

export class NotConnected extends Error {
  override name = 'NotConnected';
}

interface Local {
  path: string;
  size: number;
  mtime: number;
  hash: string;
}

const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encode = (s: string) => new TextEncoder().encode(s);
const isNote = (rel: string) => rel.toLowerCase().endsWith('.md') && !isVersionFile(rel);

export class SyncService {
  readonly #disk: Disk;
  readonly #notes: NoteService;
  readonly #versions: VersionHistory;
  readonly #events: EventHub;
  readonly #fetch: FetchFn;
  #running: Promise<SyncResult> | null = null;

  constructor(deps: { disk: Disk; notes: NoteService; versions: VersionHistory; events: EventHub; fetch: FetchFn }) {
    this.#disk = deps.disk;
    this.#notes = deps.notes;
    this.#versions = deps.versions;
    this.#events = deps.events;
    this.#fetch = deps.fetch;
  }

  async status(): Promise<SyncStatus> {
    const [account, state] = await Promise.all([this.#account(), this.#state()]);
    return {
      connected: account !== null,
      account: account ? { name: account.name, email: account.email } : null,
      running: this.#running !== null,
      lastSync: state.lastSync,
      lastError: state.lastError,
      conflicts: state.conflicts,
      last: state.last,
      confirmDeletes: state.confirmDeletes,
    };
  }

  /** Connects a Dropbox account with the code Dropbox showed (PKCE: `verifier` is the one its challenge came from). */
  async connect(appKey: string, code: string, verifier: string, endpoints?: DropboxEndpoints): Promise<SyncStatus> {
    const tokens = await tokensFromCode(appKey, code, verifier, this.#fetch, endpoints ?? DROPBOX);
    let account: Account = { ...tokens, name: '', email: '', ...(endpoints ? { endpoints } : {}) };
    const who = await this.#dropbox(account).account();
    account = { ...account, ...who };
    await this.#write(ACCOUNT_FILE, `${JSON.stringify(account, null, 2)}\n`);
    // A new account starts afresh: the first sync compares every file by its content.
    await this.#saveState(EMPTY);
    return this.status();
  }

  /** Forgets the account here. Nothing is deleted, here or on Dropbox. */
  async disconnect(): Promise<SyncStatus> {
    await this.#running?.catch(() => null);
    await this.#disk.remove(ACCOUNT_FILE);
    await this.#disk.remove(STATE_FILE);
    return this.status();
  }

  /** Syncs now (one run at a time: a second caller gets the running one's result). */
  run(options: SyncOptions = {}): Promise<SyncResult> {
    this.#running ??= this.#run(options).finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #account(): Promise<Account | null> {
    const bytes = await this.#disk.read(ACCOUNT_FILE);
    if (!bytes) return null;
    try {
      return JSON.parse(text.decode(bytes)) as Account;
    } catch {
      return null;
    }
  }

  async #state(): Promise<State> {
    const bytes = await this.#disk.read(STATE_FILE);
    if (!bytes) return structuredClone(EMPTY);
    try {
      return { ...structuredClone(EMPTY), ...(JSON.parse(text.decode(bytes)) as Partial<State>) };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  async #saveState(state: State): Promise<void> {
    await this.#write(STATE_FILE, JSON.stringify(state));
  }

  async #write(rel: string, content: string): Promise<void> {
    await this.#disk.write(rel, encode(content));
  }

  #dropbox(account: Account): Dropbox {
    return new Dropbox(account, this.#fetch, async (tokens) => this.#write(ACCOUNT_FILE, `${JSON.stringify({ ...account, ...tokens }, null, 2)}\n`), account.endpoints ?? DROPBOX);
  }

  async #run(options: SyncOptions): Promise<SyncResult> {
    const account = await this.#account();
    if (!account) throw new NotConnected('Not connected to Dropbox');
    const state = await this.#state();
    const started = Date.now();
    const budget = options.budgetMs ?? 45_000;
    try {
      const done = await this.#pass(this.#dropbox(account), state, options, () => Date.now() - started >= budget);
      state.lastError = null;
      if (done) state.lastSync = new Date().toISOString();
      await this.#saveState(state);
      // This run is over, though it is still the running one until it returns.
      return { status: { ...(await this.status()), running: false }, more: !done };
    } catch (err) {
      state.lastError =
        err instanceof DropboxError && err.missingScope
          ? `The Dropbox app needs the permission ${err.missingScope}: tick it on the app’s Permissions tab at dropbox.com/developers/apps, then disconnect here and connect again.`
          : err instanceof DropboxError && err.signedOut
            ? 'Dropbox no longer lets the app in: connect again.'
            : err instanceof Error
              ? err.message
              : String(err);
      await this.#saveState(state);
      throw err;
    }
  }

  /** One pass over every file. False when it stopped early (out of time). */
  async #pass(dropbox: Dropbox, state: State, options: SyncOptions, outOfTime: () => boolean): Promise<boolean> {
    // 1. What is on Dropbox: what changed since the last sync, or everything the first time.
    let full = state.cursor === null;
    let changes;
    try {
      changes = await dropbox.changes(state.cursor);
    } catch (err) {
      if (!(err instanceof DropboxError && err.reset)) throw err;
      full = true;
      changes = await dropbox.changes(null);
    }
    const remote = new Map<string, RemoteFile | null>();
    // In a full listing, a file it doesn't list is gone.
    if (full) for (const key of Object.keys(state.files)) remote.set(key, null);
    for (const { key, file } of changes.entries) {
      if (file) {
        if (importable(file.path)) remote.set(key, file);
        continue;
      }
      remote.set(key, null);
      // A deleted folder takes everything in it.
      for (const known of Object.keys(state.files)) if (known.startsWith(`${key}/`)) remote.set(known, null);
    }

    // 2. What is here.
    const locals = new Map<string, Local>();
    const here = [...(await this.#disk.list('')), SettingsStore.FILE, ...(await this.#disk.list(HISTORY_FOLDER))];
    for (const rel of here) {
      const key = rel.toLowerCase();
      if (!importable(rel) || locals.has(key)) continue;
      const stat = await this.#disk.stat(rel);
      if (!stat) continue;
      const synced = state.files[key];
      let hash = synced && synced.size === stat.size && synced.mtime === stat.mtime ? synced.hash : null;
      if (hash === null) {
        const bytes = await this.#disk.read(rel);
        if (!bytes) continue;
        hash = contentHash(bytes);
      }
      locals.set(key, { path: rel, size: stat.size, mtime: stat.mtime, hash });
    }

    // 3. File by file: versions first (so notes changed below find their history), then the rest.
    const keys = [...new Set([...Object.keys(state.files), ...locals.keys(), ...remote.keys()])].sort((a, b) => Number(!a.startsWith(HISTORY_FOLDER)) - Number(!b.startsWith(HISTORY_FOLDER)) || a.localeCompare(b));
    const plan = keys.map((key) => {
      const synced = state.files[key] ?? null;
      const there = remote.has(key) ? (remote.get(key) ?? null) : synced && { path: synced.path, key, rev: synced.rev, hash: synced.hash, size: synced.size, modified: 0 };
      return { key, synced, local: locals.get(key) ?? null, remote: there };
    });
    // Deleting many files on Dropbox at once waits for a yes: this browser may have lost its notes.
    const deletions = plan.filter((p) => p.synced && !p.local && p.remote && p.remote.hash === p.synced.hash).length;
    const tooMany = deletions > 10 && deletions > Object.keys(state.files).length / 4;
    const deletes = tooMany ? (options.deletes ?? 'ask') : 'allow';
    state.confirmDeletes = tooMany && deletes === 'ask' ? deletions : null;

    const counts = { up: 0, down: 0, deleted: 0 };
    let historyChanged = false;
    let settingsChanged = false;
    let vaultChanged = false;
    let unsaved = 0;
    for (const { key, synced, local, remote: there } of plan) {
      if (outOfTime()) {
        await this.#saveState(state);
        return false;
      }
      const localChanged = local ? !synced || local.hash !== synced.hash : synced !== null;
      const remoteChanged = there ? !synced || there.hash !== synced.hash : synced !== null;
      const record = (file: RemoteFile, stat: { size: number; mtime: number } | null, path = local?.path ?? file.path) => {
        if (stat) state.files[key] = { path, rev: file.rev, hash: file.hash, size: stat.size, mtime: stat.mtime };
      };
      const pulled = async (rel: string, file: RemoteFile, bytes: Uint8Array) => {
        await this.#disk.write(rel, bytes);
        record(file, await this.#disk.stat(rel), rel);
        await this.#pulled(rel);
        counts.down++;
        if (rel.startsWith(HISTORY_FOLDER)) historyChanged = true;
        if (rel === SettingsStore.FILE) settingsChanged = true;
        if (rel.startsWith('vault/')) vaultChanged = true;
      };
      try {
        if (!localChanged && !remoteChanged) {
          // The same content. Dropbox may have a newer revision of it, and the file here a newer date.
          if (synced && there) synced.rev = there.rev;
          if (synced && local) Object.assign(synced, { size: local.size, mtime: local.mtime });
          continue;
        }
        if (localChanged && !remoteChanged) {
          if (local) {
            const bytes = await this.#disk.read(local.path);
            if (!bytes || bytes.length > MAX_UPLOAD) continue;
            const file = await dropbox.upload(local.path, bytes, there ? there.rev : null);
            record(file, local);
            counts.up++;
          } else if (synced) {
            if (deletes === 'ask') continue;
            if (deletes === 'restore' && there) {
              const { bytes, file } = await dropbox.download(there.path);
              await pulled(synced.path, file, bytes);
              continue;
            }
            await dropbox.remove(synced.path, synced.rev);
            delete state.files[key];
            counts.deleted++;
          }
        } else if (!localChanged && remoteChanged) {
          if (there) {
            const { bytes, file } = await dropbox.download(there.path);
            // Changed here meanwhile: leave it for the next run.
            if (local && !(await this.#unchanged(local))) continue;
            await pulled(local?.path ?? file.path, file, bytes);
          } else if (local && synced) {
            if (!(await this.#unchanged(local))) continue;
            await this.#disk.remove(local.path);
            await this.#pulled(local.path);
            delete state.files[key];
            counts.deleted++;
          }
        } else if (!local && !there) {
          delete state.files[key];
        } else if (local && there && local.hash === there.hash) {
          record(there, local);
        } else if (local && !there) {
          // Deleted on Dropbox, changed here: the change wins.
          const bytes = await this.#disk.read(local.path);
          if (!bytes || bytes.length > MAX_UPLOAD) continue;
          record(await dropbox.upload(local.path, bytes, null), local);
          counts.up++;
        } else if (!local && there) {
          // Deleted here, changed on Dropbox: the change wins.
          const { bytes, file } = await dropbox.download(there.path);
          await pulled(file.path, file, bytes);
        } else if (local && there) {
          const result = await this.#conflict(dropbox, key, synced, local, there, state);
          if (result === 'down') counts.down++;
          if (result === 'up') counts.up++;
          if (result === 'both') {
            counts.up++;
            counts.down++;
          }
        }
      } catch (err) {
        // The file changed on Dropbox while we worked on it: the next run sees the new version.
        if (err instanceof DropboxError && (err.conflict || err.notFound || (err.status === 409 && !err.reset))) continue;
        throw err;
      }
      if (++unsaved >= 25) {
        await this.#saveState(state);
        unsaved = 0;
      }
    }
    if (historyChanged) this.#versions.forget();
    if (settingsChanged) this.#events.emit({ type: 'settings' });
    if (vaultChanged) this.#events.emit({ type: 'vault' });
    state.cursor = changes.cursor;
    state.last = counts;
    return true;
  }

  /** Whether a file here is still as it was listed (it may have been saved meanwhile). */
  async #unchanged(local: Local): Promise<boolean> {
    const stat = await this.#disk.stat(local.path);
    if (stat && stat.size === local.size && stat.mtime === local.mtime) return true;
    const bytes = await this.#disk.read(local.path);
    return bytes !== null && contentHash(bytes) === local.hash;
  }

  /** Tells the rest of the app about a file sync changed here. */
  async #pulled(rel: string): Promise<void> {
    if (NoteService.indexable(rel) && !isVersionFile(rel)) await this.#notes.refresh(rel, { version: false });
  }

  /**
   * Both sides changed a file differently. A note is merged with the text both had last; if both
   * changed the same lines (or there is no such text), the newer text stays and the other is kept
   * as a version in its history. Other files: the newer one stays.
   */
  async #conflict(dropbox: Dropbox, key: string, synced: Synced | null, local: Local, there: RemoteFile, state: State): Promise<'up' | 'down' | 'both' | null> {
    const { bytes: theirBytes, file } = await dropbox.download(there.path);
    const ourBytes = await this.#disk.read(local.path);
    if (!ourBytes || !(await this.#unchanged(local))) return null;
    const keep = async (rel: string, bytes: Uint8Array, upload: boolean) => {
      await this.#disk.write(rel, bytes);
      const stat = await this.#disk.stat(rel);
      const uploaded = upload ? await dropbox.upload(rel, bytes, file.rev) : file;
      if (stat) state.files[key] = { path: rel, rev: uploaded.rev, hash: contentHash(bytes), size: stat.size, mtime: stat.mtime };
      await this.#pulled(rel);
    };
    const newer = there.modified > local.mtime ? 'theirs' : 'ours';

    if (isNote(local.path)) {
      let ours: string;
      let theirs: string;
      try {
        ours = text.decode(ourBytes);
        theirs = text.decode(theirBytes);
      } catch {
        return null;
      }
      const base = synced ? await dropbox.download(synced.path, synced.rev).then((r) => text.decode(r.bytes)).catch(() => null) : null;
      if (base !== null) {
        const merged = merge3(base, ours, theirs);
        if (merged.clean) {
          await keep(local.path, encode(merged.text), merged.text !== theirs);
          return merged.text === ours ? 'up' : merged.text === theirs ? 'down' : 'both';
        }
      }
      const [winner, loser, loserTime] = newer === 'theirs' ? [theirs, ours, local.mtime] : [ours, theirs, there.modified];
      await this.#keepAside(local.path, winner, loser, loserTime);
      state.conflicts = [{ path: local.path, at: new Date().toISOString() }, ...state.conflicts.filter((c) => c.path !== local.path)].slice(0, 20);
      await keep(local.path, encode(winner), newer === 'ours');
      return newer === 'ours' ? 'up' : 'down';
    }
    if (isWhiteboardPath(local.path)) {
      // A drawing changed on both: the newer stays, and the other is kept beside it, not lost.
      const [winner, loser, loserTime] = newer === 'theirs' ? [theirBytes, ourBytes, local.mtime] : [ourBytes, theirBytes, there.modified];
      await this.#copyBeside(local.path, loser, loserTime);
      state.conflicts = [{ path: local.path, at: new Date().toISOString() }, ...state.conflicts.filter((c) => c.path !== local.path)].slice(0, 20);
      await keep(local.path, winner, newer === 'ours');
      return newer === 'ours' ? 'up' : 'down';
    }
    if (newer === 'theirs') {
      await keep(local.path, theirBytes, false);
      return 'down';
    }
    const uploaded = await dropbox.upload(local.path, ourBytes, file.rev);
    state.files[key] = { path: local.path, rev: uploaded.rev, hash: local.hash, size: local.size, mtime: local.mtime };
    return 'up';
  }

  /** Keeps the text that lost a conflict: as a version of the note, or as a copy beside it when the note has no id. */
  async #keepAside(rel: string, winner: string, loser: string, at: number): Promise<void> {
    const id = historyIdOf(winner) ?? historyIdOf(loser);
    if (id !== null) {
      await this.#versions.keepText(id, loser, at);
      return;
    }
    await this.#copyBeside(rel, encode(loser), at);
  }

  /** Writes `bytes` next to `rel`, as "name (other device 2026-11-27 10.30).md" (or .excalidraw). */
  async #copyBeside(rel: string, bytes: Uint8Array, at: number): Promise<void> {
    const stamp = new Date(at).toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
    const ext = /\.excalidraw$/i.test(rel) ? rel.slice(-'.excalidraw'.length) : rel.slice(-'.md'.length);
    const base = rel.slice(0, -ext.length);
    let copy = `${base} (other device ${stamp})${ext}`;
    for (let n = 2; (await this.#disk.stat(copy)) !== null; n++) copy = `${base} (other device ${stamp} ${n})${ext}`;
    await this.#disk.write(copy, bytes);
    await this.#pulled(copy);
  }
}
