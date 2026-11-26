import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { EventHub } from './events.ts';
import { GitHistory } from './git.ts';
import { NodeDisk } from './nodeDisk.ts';
import { memoryDatabase } from './nodeSqlite.ts';
import { NoteIndex } from './noteIndex.ts';
import { NoteService } from './notes.ts';
import { PaperService } from './papers.ts';
import { SettingsStore } from './settings.ts';
import { NoteStore } from './storage.ts';
import { VaultStore } from './vault.ts';
import { watchFolder } from './watcher.ts';

const config = loadConfig();
const disk = new NodeDisk(config.notesDir);
await disk.init();
const store = new NoteStore(disk);

const index = new NoteIndex(memoryDatabase());
const events = new EventHub();
const history = new GitHistory(disk.base, { delayMs: config.historyDelayMs });
const historyOn = await history.init().catch((err: unknown) => {
  console.warn('Note history is off:', err instanceof Error ? err.message : err);
  return false;
});
const notes = new NoteService({ store, index, events, history: historyOn ? history : null });
const started = Date.now();
const count = await notes.loadAll();
const vault = new VaultStore(disk);
const papers = new PaperService({ store, index, notes, fetch });
const settings = new SettingsStore(disk);
if (await settings.migrate()) history.touch();
// The folder the app used before it was named notedid, once its settings have moved out (rmdir only removes an empty folder).
await rmdir(path.join(disk.base, '.notesapp')).catch(() => undefined);
const stopWatching = watchFolder(disk.base, (rel) => notes.onFileEvent(rel));

const app = createApp(
  { store, index, events, notes, settings, papers, vault, history: historyOn ? history : null, fetch },
  { port: config.port, allowedOrigins: config.allowedOrigins },
);

if (config.production) {
  // Serve the built web client, and index.html for every other non-API path.
  const indexHtml = await readFile(path.join(config.webDist, 'index.html'), 'utf8').catch(() => null);
  if (indexHtml === null) {
    throw new Error(`No built web client in ${config.webDist}. Run "npm run build" first.`);
  }
  app.use('*', serveStatic({ root: path.relative(process.cwd(), config.webDist) }));
  app.get('*', (c) => c.html(indexHtml));
}

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  const shownHost = config.host === '::1' ? '[::1]' : config.host;
  const devHint = config.production ? '' : ` (open the web app at http://localhost:${config.webPort})`;
  console.log(`notedid API on http://${shownHost}:${info.port}${devHint}`);
  console.log(`notes folder: ${config.notesDir} (${count} notes indexed in ${Date.now() - started} ms, history ${historyOn ? 'on' : 'off'})`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopWatching();
    setTimeout(() => process.exit(0), 3000).unref();
    void history.flush().finally(() => server.close(() => process.exit(0)));
  });
}
