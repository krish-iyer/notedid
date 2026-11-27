import { execFile } from 'node:child_process';
import { rmdir } from 'node:fs/promises';
import path from 'node:path';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { Hono } from 'hono';
import { wasmDatabase } from '../browser/wasmSqlite.ts';
import { createApp } from '../server/app.ts';
import { EventHub } from '../server/events.ts';
import { GitBackup } from '../server/git.ts';
import { NodeDisk } from '../server/nodeDisk.ts';
import { NoteIndex } from '../server/noteIndex.ts';
import { NoteService } from '../server/notes.ts';
import { PaperService } from '../server/papers.ts';
import { SettingsStore } from '../server/settings.ts';
import { SyncService } from '../server/sync.ts';
import { NoteStore } from '../server/storage.ts';
import { VaultStore } from '../server/vault.ts';
import { VersionHistory } from '../server/versions.ts';
import { watchFolder } from '../server/watcher.ts';

export interface DesktopBackend {
  /** Answers the app's /api requests. */
  app: Hono;
  /** The notes folder's real path. */
  notesDir: string;
  notes: number;
  git: boolean;
  /** Keeps the versions not kept yet and commits the git backup, then stops watching the folder. */
  stop: () => Promise<void>;
}

/**
 * Whether git can be used without side effects. On a Mac without the developer tools, /usr/bin/git
 * only asks to install them, in a dialog of its own.
 */
function gitUsable(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(true);
  return new Promise((resolve) => execFile('xcode-select', ['-p'], (err) => resolve(!err)));
}

/**
 * The app's backend in the desktop app: the server's own code, over the notes folder on this
 * computer. The search index is SQLite in WebAssembly (as in the browser), so the app has no
 * native modules to build for each system.
 */
export async function startDesktopBackend(notesDir: string, options: { host: string; origin: string; sqliteWasm: Uint8Array }): Promise<DesktopBackend> {
  const disk = new NodeDisk(notesDir);
  await disk.init();
  const store = new NoteStore(disk);
  const sqlite3 = await (sqlite3InitModule as unknown as (options: { wasmBinary: Uint8Array }) => ReturnType<typeof sqlite3InitModule>)({ wasmBinary: options.sqliteWasm });
  const index = new NoteIndex(wasmDatabase(sqlite3));
  const events = new EventHub();
  const versions = new VersionHistory(store);
  const backup = new GitBackup(disk.base);
  const backupOn = (await gitUsable()) && (await backup.init().catch(() => false));
  const git = backupOn ? backup : null;
  const notes = new NoteService({ store, index, events, versions, git });
  const count = await notes.loadAll();
  const vault = new VaultStore(disk);
  const papers = new PaperService({ store, index, notes, fetch });
  const settings = new SettingsStore(disk);
  if (await settings.migrate()) git?.touch();
  // The folder the app used before it was named notedid, once its settings have moved out (rmdir only removes an empty folder).
  await rmdir(path.join(disk.base, '.notesapp')).catch(() => undefined);
  const sync = new SyncService({ disk, notes, versions, events, fetch });
  const stopWatching = watchFolder(disk.base, (rel) => notes.onFileEvent(rel));
  const app = createApp({ store, index, events, notes, settings, papers, vault, versions, git, sync, fetch }, { port: 0, hosts: [options.host], allowedOrigins: [options.origin] });
  return {
    app,
    notesDir: disk.base,
    notes: count,
    git: backupOn,
    stop: async () => {
      stopWatching();
      await Promise.all([versions.flush(), git?.flush()]);
    },
  };
}
