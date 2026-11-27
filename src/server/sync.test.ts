import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import type { HistoryResponse, SyncStatus } from '../shared/api.ts';
import { sha256Hex } from '../shared/sha256.ts';
import { contentHash, headerJson } from './dropbox.ts';
import { FakeDropbox } from './fakeDropbox.ts';
import { makeTestServer, type TestServer } from './testkit.ts';

const ID = 'k7q9m2vbfz4r';
const note = (body: string, id = ID) => `---\nid: ${id}\n---\n# A\n\n${body}\n`;
const servers: TestServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.cleanup();
});

/** A device: a notes folder of its own, connected to the shared fake Dropbox. */
async function device(dropbox: FakeDropbox, files: Record<string, string> = {}): Promise<TestServer> {
  const s = await makeTestServer({ dropbox: dropbox.fetch, files });
  servers.push(s);
  const res = await s.post('/api/sync/connect', { appKey: 'testappkey1', code: 'code-from-dropbox', verifier: 'v'.repeat(43) });
  expect(res.status).toBe(200);
  return s;
}

async function sync(s: TestServer, body: Record<string, string> = {}): Promise<SyncStatus> {
  const res = await s.post('/api/sync', body);
  const result = (await res.json()) as { status: SyncStatus; more: boolean; error?: string };
  if (res.status !== 200) throw new Error(result.error);
  expect(result.more).toBe(false);
  expect(result.status.running).toBe(false);
  return result.status;
}

async function save(s: TestServer, rel: string, content: string): Promise<void> {
  const doc = (await (await s.get(`/api/note?path=${encodeURIComponent(rel)}`)).json()) as { hash: string | null };
  expect((await s.put('/api/note', { path: rel, content, baseHash: doc.hash })).status).toBe(200);
}

const exists = (s: TestServer, rel: string) => fs.stat(path.join(s.dir, rel)).then(() => true, () => false);
const age = (s: TestServer, rel: string, ms: number) => fs.utimes(path.join(s.dir, rel), ms / 1000, ms / 1000);

describe('Dropbox details', () => {
  it('computes Dropbox’s content hash: SHA-256 over the 4 MB blocks’ SHA-256s', () => {
    const big = new Uint8Array(9 * 1024 * 1024).map((_, i) => i % 251);
    const blocks = [0, 1, 2].map((i) => createHash('sha256').update(big.subarray(i * 4 * 1024 * 1024, (i + 1) * 4 * 1024 * 1024)).digest());
    expect(contentHash(big)).toBe(createHash('sha256').update(Buffer.concat(blocks)).digest('hex'));
    expect(contentHash(new Uint8Array())).toBe(sha256Hex(createHash('sha256').update(new Uint8Array()).digest()));
  });

  it('writes header JSON with only ASCII', () => {
    expect(headerJson({ path: '/notes/café ü 😀.md' })).toBe('{"path":"/notes/caf\\u00e9 \\u00fc \\ud83d\\ude00.md"}');
    expect(JSON.parse(headerJson({ path: '/notes/café.md' }))).toEqual({ path: '/notes/café.md' });
  });
});

describe('syncing with Dropbox', () => {
  it('connects with the code Dropbox shows, and keeps the sign-in out of exports and statuses', async () => {
    const dropbox = new FakeDropbox();
    const a = await device(dropbox, { 'notes/a.md': note('one') });
    const status = (await (await a.get('/api/sync')).json()) as SyncStatus;
    expect(status).toMatchObject({ connected: true, account: { name: 'Test Person', email: 'person@example.com' }, lastSync: null });
    expect(JSON.stringify(status)).not.toMatch(/refresh|access-/);
    expect(await exists(a, '.notedid/sync/account.json')).toBe(true);
    const zip = unzipSync(new Uint8Array(await (await a.get('/api/export')).arrayBuffer()));
    expect(Object.keys(zip).some((name) => name.includes('sync'))).toBe(false);
    expect((await a.post('/api/sync/connect', { appKey: 'x', code: 'c', verifier: 'v'.repeat(43) })).status).toBe(400);
  });

  it('uploads everything the first time, and a second device gets it all, versions included', async () => {
    const dropbox = new FakeDropbox();
    const a = await device(dropbox, { 'notes/a.md': note('one'), 'journal/2026-11-26.md': 'Today.\n', 'notes/café ü.md': '# Café\n' });
    await fs.mkdir(path.join(a.dir, 'papers'), { recursive: true });
    await fs.writeFile(path.join(a.dir, 'papers/x.pdf'), new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 255]));
    await age(a, 'notes/a.md', Date.now() - 3_600_000);
    await save(a, 'notes/a.md', note('two'));
    await a.versions.flush();
    const status = await sync(a);
    const uploaded = dropbox.paths();
    expect(uploaded).toEqual(expect.arrayContaining(['notes/a.md', 'journal/2026-11-26.md', 'notes/café ü.md', 'papers/x.pdf']));
    expect(uploaded.filter((p) => p.startsWith('.notedid/history/'))).toHaveLength(2);
    expect(status.last).toEqual({ up: uploaded.length, down: 0, deleted: 0 });

    const b = await device(dropbox);
    expect((await sync(b)).last).toEqual({ up: 0, down: uploaded.length, deleted: 0 });
    expect(await b.read('notes/a.md')).toBe(note('two'));
    expect(await b.read('notes/café ü.md')).toBe('# Café\n');
    expect([...(await fs.readFile(path.join(b.dir, 'papers/x.pdf')))]).toEqual([0x25, 0x50, 0x44, 0x46, 0, 255]);
    expect(b.index.get('notes/a.md')?.id).toBe(ID);
    const history = (await (await b.get('/api/history?path=notes/a.md')).json()) as HistoryResponse;
    expect(history.versions).toHaveLength(2);
    // In sync now: nothing to do either way.
    expect((await sync(a)).last).toEqual({ up: 0, down: 0, deleted: 0 });
    expect((await sync(b)).last).toEqual({ up: 0, down: 0, deleted: 0 });
  });

  it('transfers nothing for files both sides have the same at the first sync', async () => {
    const dropbox = new FakeDropbox();
    const files = { 'notes/a.md': note('one'), 'notes/b.md': '# B\n' };
    const a = await device(dropbox, files);
    await sync(a);
    const b = await device(dropbox, files);
    dropbox.calls.length = 0;
    expect((await sync(b)).last).toEqual({ up: 0, down: 0, deleted: 0 });
    expect(dropbox.calls.filter((c) => /upload|download/.test(c))).toEqual([]);
  });

  it('brings a change, a new note and a deletion from one device to the other', async () => {
    const dropbox = new FakeDropbox();
    const a = await device(dropbox, { 'notes/a.md': note('one'), 'notes/gone.md': '# Gone\n' });
    await sync(a);
    const b = await device(dropbox);
    await sync(b);

    await save(a, 'notes/a.md', note('changed on a'));
    await save(a, 'notes/new.md', '# New\n');
    expect((await a.post('/api/note/delete', { path: 'notes/gone.md' })).status).toBe(200);
    expect((await sync(a)).last).toEqual({ up: 3, down: 0, deleted: 1 });
    expect(dropbox.paths()).not.toContain('notes/gone.md');

    expect((await sync(b)).last).toEqual({ up: 0, down: 3, deleted: 1 });
    expect(await b.read('notes/a.md')).toBe(note('changed on a'));
    expect(await b.read('notes/new.md')).toBe('# New\n');
    expect(await exists(b, 'notes/gone.md')).toBe(false);
    expect(await b.read('trash/notes/gone.md')).toBe('# Gone\n');
    expect(b.index.get('notes/gone.md')).toBeNull();
    expect(b.received).toContainEqual({ type: 'deleted', path: 'notes/gone.md' });
    expect(b.received).toContainEqual(expect.objectContaining({ type: 'changed', path: 'notes/a.md' }));
    // A note synced in is no version of its own: its versions come from the device it was written on.
    await b.versions.flush();
    expect(((await (await b.get('/api/history?path=notes/a.md')).json()) as HistoryResponse).versions).toEqual([]);
  });

  it('merges a note changed on two devices in different places', async () => {
    const dropbox = new FakeDropbox();
    const start = note('line one\n\nline two\n\nline three');
    const a = await device(dropbox, { 'notes/a.md': start });
    await sync(a);
    const b = await device(dropbox);
    await sync(b);
    await save(a, 'notes/a.md', start.replace('line one', 'line one, from a'));
    await save(b, 'notes/a.md', start.replace('line three', 'line three, from b'));
    await sync(a);
    const status = await sync(b);
    const merged = note('line one, from a\n\nline two\n\nline three, from b');
    expect(await b.read('notes/a.md')).toBe(merged);
    expect(status.conflicts).toEqual([]);
    await sync(a);
    expect(await a.read('notes/a.md')).toBe(merged);
    expect(dropbox.text('notes/a.md')).toBe(merged);
  });

  it('keeps the newer text when both changed the same lines, and the other as a version', async () => {
    const dropbox = new FakeDropbox();
    const a = await device(dropbox, { 'notes/a.md': note('the line') });
    await sync(a);
    const b = await device(dropbox);
    await sync(b);
    await save(a, 'notes/a.md', note('the line, as a wrote it'));
    await sync(a);
    await save(b, 'notes/a.md', note('the line, as b wrote it earlier'));
    // b's edit is the older one.
    await age(b, 'notes/a.md', Date.now() - 600_000);
    const status = await sync(b);
    expect(await b.read('notes/a.md')).toBe(note('the line, as a wrote it'));
    expect(status.conflicts.map((c) => c.path)).toEqual(['notes/a.md']);
    const history = (await (await b.get('/api/history?path=notes/a.md')).json()) as HistoryResponse;
    const kept = await Promise.all(history.versions.map(async (v) => ((await (await b.get(`/api/history/version?path=notes/a.md&version=${encodeURIComponent(v.version)}`)).json()) as { content: string }).content));
    expect(kept).toContain(note('the line, as b wrote it earlier'));
    // The other device gets that version too.
    await sync(b);
    await sync(a);
    const onA = (await (await a.get('/api/history?path=notes/a.md')).json()) as HistoryResponse;
    expect(onA.versions.map((v) => v.version)).toEqual(history.versions.map((v) => v.version));
  });

  it('keeps both drawings when a whiteboard changed on two devices', async () => {
    const board = (text: string) => `${JSON.stringify({ type: 'excalidraw', version: 2, elements: [{ id: 't', type: 'text', text, originalText: text }], appState: {}, files: {} })}\n`;
    const rel = 'whiteboards/Plan.excalidraw';
    const dropbox = new FakeDropbox();
    const a = await device(dropbox, { [rel]: board('first') });
    await sync(a);
    const b = await device(dropbox);
    await sync(b);
    const saveBoard = async (s: TestServer, text: string) => {
      const doc = (await (await s.get(`/api/whiteboard?path=${encodeURIComponent(rel)}`)).json()) as { hash: string | null };
      expect((await s.put('/api/whiteboard', { path: rel, content: board(text), baseHash: doc.hash })).status).toBe(200);
    };
    await saveBoard(a, 'drawn on a');
    await sync(a);
    await saveBoard(b, 'drawn on b, earlier');
    await age(b, rel, Date.now() - 600_000);
    const status = await sync(b);
    expect(await b.read(rel)).toBe(board('drawn on a'));
    expect(status.conflicts.map((c) => c.path)).toEqual([rel]);
    const copies = (await fs.readdir(path.join(b.dir, 'whiteboards'))).filter((f) => f.startsWith('Plan (other device '));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/\.excalidraw$/);
    expect(await b.read(`whiteboards/${copies[0]}`)).toBe(board('drawn on b, earlier'));
    // The copy reaches the other device too.
    await sync(b);
    await sync(a);
    expect(await exists(a, `whiteboards/${copies[0]}`)).toBe(true);
  });

  it('lets a change win over a deletion, both ways', async () => {
    const dropbox = new FakeDropbox();
    const a = await device(dropbox, { 'notes/a.md': note('one'), 'notes/b.md': '# B\n' });
    await sync(a);
    const b = await device(dropbox);
    await sync(b);
    // a deletes what b changes, and the other way round.
    await a.post('/api/note/delete', { path: 'notes/a.md' });
    await save(a, 'notes/b.md', '# B, changed on a\n');
    await save(b, 'notes/a.md', note('changed on b'));
    await b.post('/api/note/delete', { path: 'notes/b.md' });
    await sync(a);
    await sync(b);
    await sync(a);
    for (const s of [a, b]) {
      expect(await s.read('notes/a.md')).toBe(note('changed on b'));
      expect(await s.read('notes/b.md')).toBe('# B, changed on a\n');
    }
  });

  it('asks before deleting many files on Dropbox, and can bring them back instead', async () => {
    const dropbox = new FakeDropbox();
    const files = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`notes/n${i}.md`, `# N${i}\n`]));
    const a = await device(dropbox, files);
    await sync(a);
    // This device lost most of its notes (cleared browser storage, say).
    for (let i = 0; i < 15; i++) await fs.rm(path.join(a.dir, `notes/n${i}.md`));
    const status = await sync(a);
    expect(status.confirmDeletes).toBe(15);
    expect(dropbox.paths().filter((p) => p.startsWith('notes/'))).toHaveLength(20);
    expect((await sync(a, { deletes: 'restore' })).confirmDeletes).toBeNull();
    expect(await a.read('notes/n3.md')).toBe('# N3\n');
    // Deleting them on purpose.
    for (let i = 0; i < 15; i++) await fs.rm(path.join(a.dir, `notes/n${i}.md`));
    await sync(a, { deletes: 'allow' });
    expect(dropbox.paths().filter((p) => p.startsWith('notes/'))).toHaveLength(5);
  });

  it('renews its access by itself, and says so when Dropbox no longer lets it in', async () => {
    const dropbox = new FakeDropbox();
    const a = await device(dropbox, { 'notes/a.md': note('one') });
    dropbox.expireTokens();
    await sync(a);
    expect(dropbox.text('notes/a.md')).toBe(note('one'));
    dropbox.expireTokens();
    dropbox.refreshTokens.clear();
    const res = await a.post('/api/sync', {});
    expect(res.status).toBe(502);
    expect(((await (await a.get('/api/sync')).json()) as SyncStatus).lastError).toMatch(/connect again/);
  });

  it('says which permission the Dropbox app is missing', async () => {
    const dropbox = new FakeDropbox();
    const a = await device(dropbox, { 'notes/a.md': note('one') });
    dropbox.scopes.delete('files.content.write');
    expect((await a.post('/api/sync', {})).status).toBe(502);
    expect(((await (await a.get('/api/sync')).json()) as SyncStatus).lastError).toMatch(/needs the permission files\.content\.write: tick it/);
  });

  it('carries on where it stopped', async () => {
    const dropbox = new FakeDropbox();
    const a = await device(dropbox, { 'notes/a.md': note('one'), 'notes/b.md': '# B\n' });
    const result = await a.sync.run({ budgetMs: 0 });
    expect(result.more).toBe(true);
    expect(dropbox.paths()).toEqual([]);
    await sync(a);
    expect(dropbox.paths()).toEqual(expect.arrayContaining(['notes/a.md', 'notes/b.md']));
  });

  it('forgets the account when disconnected, deleting nothing', async () => {
    const dropbox = new FakeDropbox();
    const a = await device(dropbox, { 'notes/a.md': note('one') });
    await sync(a);
    const status = (await (await a.app.request('http://127.0.0.1:4321/api/sync/connect', { method: 'DELETE', headers: { origin: 'http://127.0.0.1:4321' } })).json()) as SyncStatus;
    expect(status.connected).toBe(false);
    expect(await exists(a, '.notedid/sync/account.json')).toBe(false);
    expect(await a.read('notes/a.md')).toBe(note('one'));
    expect(dropbox.text('notes/a.md')).toBe(note('one'));
    expect((await a.post('/api/sync', {})).status).toBe(409);
  });
});
