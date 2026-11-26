import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm?url';
import type { Hono } from 'hono';
import { EVENTS_CHANNEL } from '../shared/api.ts';
import { createApp } from '../server/app.ts';
import { EventHub } from '../server/events.ts';
import { NoteIndex } from '../server/noteIndex.ts';
import { NoteService } from '../server/notes.ts';
import { PaperService } from '../server/papers.ts';
import { SettingsStore } from '../server/settings.ts';
import { NoteStore } from '../server/storage.ts';
import { VaultStore } from '../server/vault.ts';
import type { FetchFn } from '../server/web.ts';
import { IdbDisk, openNotesDatabase } from './idbDisk.ts';
import { wasmDatabase } from './wasmSqlite.ts';

/** fetch() from the browser, without the User-Agent header the server sends (browsers set their own). */
const browserFetch: FetchFn = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.delete('user-agent');
  return fetch(input, { ...init, headers });
};

/**
 * The app's backend, in the browser: the same code as the server's, with the notes in IndexedDB
 * and the search index in SQLite compiled to WebAssembly. It answers the same /api requests.
 * There is no git here, so no history yet.
 */
export async function startBackend(): Promise<Hono> {
  const disk = new IdbDisk(await openNotesDatabase());
  const store = new NoteStore(disk);
  const sqlite3 = await (sqlite3InitModule as unknown as (options: { locateFile: () => string }) => ReturnType<typeof sqlite3InitModule>)({ locateFile: () => wasmUrl });
  const index = new NoteIndex(wasmDatabase(sqlite3));
  const events = new EventHub();
  const notes = new NoteService({ store, index, events, history: null });
  await notes.loadAll();
  const vault = new VaultStore(disk);
  const papers = new PaperService({ store, index, notes, fetch: browserFetch });
  const settings = new SettingsStore(disk);
  await settings.migrate();
  const channel = new BroadcastChannel(EVENTS_CHANNEL);
  events.subscribe((event) => channel.postMessage(event));
  return createApp(
    { store, index, events, notes, settings, papers, vault, history: null, fetch: browserFetch },
    { port: Number(location.port) || (location.protocol === 'https:' ? 443 : 80), hosts: [location.host], allowedOrigins: [location.origin] },
  );
}
