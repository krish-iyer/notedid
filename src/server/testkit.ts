import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ServerEvent } from '../shared/api.ts';
import { createApp } from './app.ts';
import { EventHub } from './events.ts';
import { GitHistory } from './git.ts';
import { NoteIndex } from './noteIndex.ts';
import { NoteService } from './notes.ts';
import { PaperService } from './papers.ts';
import { SettingsStore } from './settings.ts';
import { NoteStore } from './storage.ts';
import { VaultStore } from './vault.ts';
import type { FetchFn } from './web.ts';
import { NodeDisk } from './nodeDisk.ts';
import { memoryDatabase } from './nodeSqlite.ts';

export const ORIGIN = 'http://127.0.0.1:4321';

const offline: FetchFn = async () => new Response('offline', { status: 503 });

/** A complete server over a temporary notes folder, for tests. */
export async function makeTestServer(options: { fetch?: FetchFn; history?: boolean; files?: Record<string, string> } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notesapp-test-'));
  for (const [rel, content] of Object.entries(options.files ?? {})) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
  const disk = new NodeDisk(dir);
  await disk.init();
  const store = new NoteStore(disk);
  const index = new NoteIndex(memoryDatabase());
  const events = new EventHub();
  const history = options.history ? new GitHistory(disk.base, { delayMs: 60_000 }) : null;
  if (history) await history.init();
  const notes = new NoteService({ store, index, events, history });
  await notes.loadAll();
  const vault = new VaultStore(disk);
  const fetchFn = options.fetch ?? offline;
  const papers = new PaperService({ store, index, notes, fetch: fetchFn });
  const settings = new SettingsStore(disk);
  const app = createApp({ store, index, events, notes, settings, papers, vault, history, fetch: fetchFn }, { port: 4321, allowedOrigins: [ORIGIN] });
  const received: ServerEvent[] = [];
  events.subscribe((e) => received.push(e));

  const request = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(`${ORIGIN}${url}`, {
      method,
      headers: body === undefined ? { origin: ORIGIN, ...headers } : { 'content-type': 'application/json', origin: ORIGIN, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  return {
    dir,
    store,
    index,
    notes,
    vault,
    papers,
    history,
    app,
    received,
    get: (url: string) => request('GET', url),
    post: (url: string, body: unknown, headers?: Record<string, string>) => request('POST', url, body, headers),
    put: (url: string, body: unknown, headers?: Record<string, string>) => request('PUT', url, body, headers),
    read: (rel: string) => fs.readFile(path.join(dir, rel), 'utf8'),
    write: async (rel: string, content: string) => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), content);
    },
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

export type TestServer = Awaited<ReturnType<typeof makeTestServer>>;
