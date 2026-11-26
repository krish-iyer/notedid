import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import type { CaptureRequest, ConflictResponse, ErrorResponse, SaveNoteRequest } from '../shared/api.ts';
import { newBoardContent } from '../shared/board.ts';
import { newDashboardContent } from '../shared/dashboard.ts';
import { addDays, isISODate, localISODate } from '../shared/dates.ts';
import { parseQuery } from '../shared/query.ts';
import { slugify, tagify } from '../shared/slug.ts';
import { exportZip, importZip } from './archive.ts';
import type { EventHub } from './events.ts';
import type { GitBackup } from './git.ts';
import type { NoteIndex } from './noteIndex.ts';
import { basename, extname } from './posixPath.ts';
import { NotFoundError, type NoteService } from './notes.ts';
import { type PaperService, UpstreamError } from './papers.ts';
import type { SettingsStore } from './settings.ts';
import { ConflictError, DATA_EXTENSIONS, EncodingError, FILE_EXTENSIONS, type NoteStore, normalizeNotePath, normalizePath, PathError } from './storage.ts';
import { VaultConflict, type VaultStore } from './vault.ts';
import type { VersionHistory } from './versions.ts';
import { type FetchFn, fetchPageTitle } from './web.ts';

const MB = 1024 * 1024;

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

export interface AppContext {
  store: NoteStore;
  index: NoteIndex;
  events: EventHub;
  notes: NoteService;
  settings: SettingsStore;
  papers: PaperService;
  vault: VaultStore;
  /** The notes' versions. */
  versions: VersionHistory;
  /** A backup of the whole folder, where git is installed. */
  git: GitBackup | null;
  fetch: FetchFn;
}

export interface AppOptions {
  /** Port the server listens on; part of the host names it answers to. */
  port: number;
  /** The host names (with port) it answers to, if not localhost on `port` (e.g. the web app's own, in a browser). */
  hosts?: readonly string[];
  /** Browser origins allowed to send state-changing requests. */
  allowedOrigins: readonly string[];
}

/** A malformed request. */
export class BadRequest extends Error {
  override name = 'BadRequest';
}

type Shape = Record<string, 'string' | 'string?' | 'string|null' | 'number' | 'any'>;

/** Reads a JSON body and checks its fields' types. Requiring JSON also makes browsers preflight cross-site requests. */
async function jsonBody<T>(c: Context, shape: Shape): Promise<T> {
  if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) throw new BadRequest('Expected a JSON body');
  const body: unknown = await c.req.json().catch(() => undefined);
  if (typeof body !== 'object' || body === null) throw new BadRequest('Expected a JSON object');
  const record = body as Record<string, unknown>;
  for (const [key, type] of Object.entries(shape)) {
    const value = record[key];
    const ok =
      type === 'any' ||
      (type === 'string' && typeof value === 'string') ||
      (type === 'string?' && (value === undefined || typeof value === 'string')) ||
      (type === 'string|null' && (value === null || typeof value === 'string')) ||
      (type === 'number' && typeof value === 'number' && Number.isFinite(value));
    if (!ok) throw new BadRequest(`Expected "${key}" to be ${type}`);
  }
  return body as T;
}

function todayFrom(value: unknown): string {
  return typeof value === 'string' && isISODate(value) ? value : localISODate();
}

export function createApp(ctx: AppContext, options: AppOptions): Hono {
  const app = new Hono();
  const allowedHosts = new Set(options.hosts ?? ['localhost', '127.0.0.1', '[::1]'].map((name) => `${name}:${options.port}`));
  const allowedOrigins = new Set(options.allowedOrigins);

  // Answer only to our own host names, so a web page can't reach this server through DNS rebinding.
  app.use('*', async (c, next) => {
    const host = new URL(c.req.url).host.toLowerCase();
    if (!allowedHosts.has(host)) return c.json({ error: 'Unknown host' } satisfies ErrorResponse, 421);
    await next();
  });

  // Refuse state-changing requests sent from other sites' pages (CSRF).
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin');
      if (origin !== undefined && !allowedOrigins.has(origin)) {
        return c.json({ error: 'Requests from this origin are not allowed' } satisfies ErrorResponse, 403);
      }
    }
    await next();
  });

  const smallBody = bodyLimit({ maxSize: 8 * MB, onError: (c) => c.json({ error: 'Too large' } satisfies ErrorResponse, 413) });
  const uploadBody = bodyLimit({ maxSize: 100 * MB, onError: (c) => c.json({ error: 'The file is larger than 100 MB' } satisfies ErrorResponse, 413) });

  app.get('/api/health', (c) => c.json({ ok: true, notes: ctx.index.size, git: ctx.git !== null }));

  // ---- Notes -------------------------------------------------------------------------------

  app.get('/api/note', async (c) => c.json(await ctx.store.read(c.req.query('path') ?? '')));

  app.put('/api/note', smallBody, async (c) => {
    const body = await jsonBody<SaveNoteRequest>(c, { path: 'string', content: 'string', baseHash: 'string|null' });
    return c.json(await ctx.notes.save(normalizeNotePath(body.path), body.content, body.baseHash));
  });

  // Note ids: how many notes have none yet (or share a copy's), and giving them ids.
  app.get('/api/ids', async (c) => c.json(await ctx.notes.idStatus()));
  app.post('/api/ids', async (c) => c.json(await ctx.notes.assignIds()));

  app.post('/api/note/create', smallBody, async (c) => {
    const body = await jsonBody<{ title: string; folder?: string; kind?: string; tag?: string }>(c, { title: 'string', folder: 'string?', kind: 'string?', tag: 'string?' });
    if (body.kind === 'board') {
      const tag = tagify(body.tag ?? '') || tagify(body.title) || slugify(body.title);
      return c.json({ path: await ctx.notes.create(body.title, 'boards', newBoardContent(body.title.trim(), tag)) });
    }
    if (body.kind === 'dashboard') return c.json({ path: await ctx.notes.create(body.title, 'dashboards', newDashboardContent(body.title.trim())) });
    return c.json({ path: await ctx.notes.create(body.title, body.folder ?? 'notes') });
  });

  app.post('/api/note/rename', smallBody, async (c) => {
    const body = await jsonBody<{ path: string; title: string }>(c, { path: 'string', title: 'string' });
    return c.json(await ctx.notes.rename(normalizeNotePath(body.path), body.title));
  });

  app.post('/api/note/delete', smallBody, async (c) => {
    const body = await jsonBody<{ path: string }>(c, { path: 'string' });
    return c.json({ trashPath: await ctx.notes.remove(normalizeNotePath(body.path)) });
  });

  app.post('/api/note/restore', smallBody, async (c) => {
    const body = await jsonBody<{ path: string; version: string }>(c, { path: 'string', version: 'string' });
    const rel = normalizeNotePath(body.path);
    const content = await ctx.versions.show(rel, body.version);
    if (content === null) throw new NotFoundError('That version is not in the history');
    return c.json(await ctx.notes.restore(rel, content));
  });

  app.get('/api/notes', (c) => c.json(ctx.index.list()));

  app.get('/api/tags', (c) => c.json(ctx.index.tags()));

  app.get('/api/search', async (c) => {
    const today = todayFrom(c.req.query('today'));
    const { pinned } = await ctx.settings.load();
    return c.json(ctx.index.search(parseQuery(c.req.query('q') ?? '', today), { today, pinned }));
  });

  app.get('/api/backlinks', (c) => c.json(ctx.index.backlinks(normalizeNotePath(c.req.query('path')))));

  app.post('/api/link-mention', smallBody, async (c) => {
    const body = await jsonBody<{ path: string; line: number; term: string; target: string }>(c, { path: 'string', line: 'number', term: 'string', target: 'string' });
    return c.json(await ctx.notes.linkMention(normalizeNotePath(body.path), body.line, body.term, normalizeNotePath(body.target)));
  });

  // ---- Tasks and capture -----------------------------------------------------------------------

  app.get('/api/tasks', (c) => c.json(ctx.index.tasks(addDays(todayFrom(c.req.query('today')), -14))));

  app.post('/api/tasks/toggle', smallBody, async (c) => {
    const body = await jsonBody<{ path: string; line: number; raw: string; today?: string }>(c, { path: 'string', line: 'number', raw: 'string', today: 'string?' });
    return c.json(await ctx.notes.toggleTask(normalizeNotePath(body.path), body.line, body.raw, todayFrom(body.today)));
  });

  app.post('/api/capture', smallBody, async (c) => {
    const body = await jsonBody<CaptureRequest>(c, { text: 'string', capturedAt: 'string?', target: 'string?', id: 'string?' });
    return c.json(await ctx.notes.capture(body));
  });

  // ---- History, settings, live events -------------------------------------------------------------

  app.get('/api/history', async (c) => c.json(await ctx.versions.log(normalizeNotePath(c.req.query('path')))));

  app.get('/api/history/version', async (c) => {
    const content = await ctx.versions.show(normalizeNotePath(c.req.query('path')), c.req.query('version') ?? '');
    if (content === null) throw new NotFoundError('That version is not in the history');
    return c.json({ content });
  });

  app.get('/api/settings', async (c) => c.json(await ctx.settings.load()));

  app.put('/api/settings', smallBody, async (c) => {
    const body = await jsonBody<Record<string, unknown>>(c, {});
    const saved = await ctx.settings.save(body);
    ctx.git?.touch();
    ctx.events.emit({ type: 'settings' });
    return c.json(saved);
  });

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = ctx.events.subscribe((event) => {
        void stream.writeSSE({ event: 'change', data: JSON.stringify(event) }).catch(() => undefined);
      });
      stream.onAbort(unsubscribe);
      await stream.writeSSE({ event: 'ready', data: '{}' });
      while (!stream.aborted) {
        await stream.sleep(25_000);
        if (!stream.aborted) await stream.writeSSE({ event: 'ping', data: '' }).catch(() => undefined);
      }
      unsubscribe();
    }),
  );

  app.post('/api/unfurl', smallBody, async (c) => {
    const body = await jsonBody<{ url: string }>(c, { url: 'string' });
    return c.json({ title: await fetchPageTitle(body.url, ctx.fetch) });
  });

  // ---- Files and data files ----------------------------------------------------------------------

  app.get('/api/file', async (c) => {
    const rel = normalizePath(c.req.query('path'), FILE_EXTENSIONS);
    const bytes = await ctx.store.readBytes(rel);
    if (!bytes) throw new NotFoundError('No such file');
    return c.body(new Uint8Array(bytes), 200, {
      'content-type': MIME[extname(rel).toLowerCase()] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      // Opened directly, a file (an SVG, say) can't run scripts in the app's origin.
      'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      'cache-control': 'private, no-cache',
    });
  });

  app.post('/api/files', uploadBody, async (c) => {
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw new BadRequest('Expected a file');
    const ext = extname(file.name).toLowerCase();
    if (!(FILE_EXTENSIONS as readonly string[]).includes(ext)) throw new BadRequest(`Files can be: ${FILE_EXTENSIONS.join(', ')}`);
    const base = slugify(basename(file.name, extname(file.name)), 40);
    const suffix = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, '0')).join('');
    const rel = `files/${new Date().getFullYear()}/${base}-${suffix}${ext}`;
    await ctx.store.createBytes(rel, new Uint8Array(await file.arrayBuffer()));
    ctx.git?.touch();
    return c.json({ path: rel });
  });

  app.get('/api/data', async (c) => {
    const rel = normalizePath(c.req.query('path'), DATA_EXTENSIONS);
    const doc = await ctx.store.readText(rel);
    let data: unknown = null;
    if (doc.hash) {
      try {
        data = JSON.parse(doc.content);
      } catch {
        data = null;
      }
    }
    return c.json({ path: rel, data, hash: doc.hash });
  });

  app.put('/api/data', smallBody, async (c) => {
    const body = await jsonBody<{ path: string; data: unknown; baseHash: string | null }>(c, { path: 'string', data: 'any', baseHash: 'string|null' });
    const rel = normalizePath(body.path, DATA_EXTENSIONS);
    const saved = await ctx.store.writeText(rel, `${JSON.stringify(body.data, null, 2)}\n`, body.baseHash);
    ctx.git?.touch();
    return c.json(saved);
  });

  // ---- Export and import: the whole notes folder as a zip ----------------------------------------

  app.get('/api/export', async (c) =>
    c.body(new Uint8Array(await exportZip(ctx.store.disk)), 200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="notes-${localISODate()}.zip"`,
      'cache-control': 'no-store',
    }),
  );

  app.post('/api/import', bodyLimit({ maxSize: 1024 * MB, onError: (c) => c.json({ error: 'The zip is larger than 1 GB' } satisfies ErrorResponse, 413) }), async (c) => {
    if (c.req.header('content-type') !== 'application/zip') throw new BadRequest('Expected a zip file');
    const result = await importZip(ctx.store.disk, new Uint8Array(await c.req.arrayBuffer()));
    // The notes come as they are, with whatever versions came with them.
    ctx.versions.forget();
    await ctx.notes.rescan({ version: false });
    ctx.git?.touch();
    // Settings or a vault may have come with the notes.
    ctx.events.emit({ type: 'settings' });
    ctx.events.emit({ type: 'vault' });
    return c.json(result);
  });

  // ---- Papers ----------------------------------------------------------------------------------

  app.get('/api/papers', async (c) => c.json(await ctx.papers.list()));

  app.post('/api/papers/import', smallBody, async (c) => {
    const body = await jsonBody<{ source: string }>(c, { source: 'string' });
    return c.json(await ctx.papers.import(body.source));
  });

  app.post('/api/papers/upload', uploadBody, async (c) => {
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw new BadRequest('Expected a PDF file');
    const title = typeof form.title === 'string' ? form.title : undefined;
    return c.json(await ctx.papers.upload(file.name, new Uint8Array(await file.arrayBuffer()), title));
  });

  app.post('/api/papers/attach', uploadBody, async (c) => {
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File) || typeof form.path !== 'string') throw new BadRequest('Expected a PDF file and the paper');
    return c.json(await ctx.papers.attachPdf(normalizeNotePath(form.path), new Uint8Array(await file.arrayBuffer())));
  });

  // ---- Vault (ciphertext only) -------------------------------------------------------------------

  app.get('/api/vault/key', async (c) => {
    const key = await ctx.vault.keyFile();
    return c.json(key ?? { text: null, hash: null });
  });

  app.put('/api/vault/key', smallBody, async (c) => {
    const body = await jsonBody<{ text: string; baseHash: string | null }>(c, { text: 'string', baseHash: 'string|null' });
    const saved = await ctx.vault.saveKeyFile(body.text, body.baseHash);
    ctx.git?.touch();
    return c.json(saved);
  });

  app.get('/api/vault/items', async (c) => c.json(await ctx.vault.list()));

  app.get('/api/vault/item/:id', async (c) => {
    const item = await ctx.vault.read(c.req.param('id'));
    if (!item) throw new NotFoundError('No such vault item');
    return c.body(new Uint8Array(item.bytes), 200, { 'content-type': 'application/octet-stream', 'x-hash': item.hash, 'cache-control': 'no-store' });
  });

  app.put('/api/vault/item/:id', bodyLimit({ maxSize: 16 * MB }), async (c) => {
    if (c.req.header('content-type') !== 'application/octet-stream') throw new BadRequest('Expected application/octet-stream');
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const saved = await ctx.vault.write(c.req.param('id'), bytes, c.req.header('x-base-hash') || null);
    ctx.git?.touch();
    ctx.events.emit({ type: 'vault' });
    return c.json(saved);
  });

  app.delete('/api/vault/item/:id', async (c) => {
    await ctx.vault.remove(c.req.param('id'));
    ctx.git?.touch();
    ctx.events.emit({ type: 'vault' });
    return c.json({ ok: true });
  });

  app.all('/api/*', (c) => c.json({ error: 'Not found' } satisfies ErrorResponse, 404));

  app.onError((err, c) => {
    if (err instanceof ConflictError) return c.json({ error: 'conflict', current: err.current } satisfies ConflictResponse, 409);
    if (err instanceof VaultConflict) return c.json({ error: 'conflict', currentHash: err.currentHash }, 409);
    if (err instanceof PathError || err instanceof BadRequest) return c.json({ error: err.message } satisfies ErrorResponse, 400);
    if (err instanceof NotFoundError) return c.json({ error: err.message } satisfies ErrorResponse, 404);
    if (err instanceof EncodingError) return c.json({ error: err.message } satisfies ErrorResponse, 422);
    if (err instanceof UpstreamError) return c.json({ error: err.message } satisfies ErrorResponse, 502);
    console.error(err);
    return c.json({ error: 'Something went wrong on the server' } satisfies ErrorResponse, 500);
  });

  return app;
}
