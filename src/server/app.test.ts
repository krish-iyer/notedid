import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BacklinksResponse, ConflictResponse, NoteDoc, NoteSummary, SearchResponse, Settings, TaskItem } from '../shared/api.ts';
import { noteIdOf } from '../shared/noteIds.ts';
import { hashContent } from './storage.ts';
import { makeTestServer, ORIGIN, type TestServer } from './testkit.ts';

let s: TestServer;

beforeEach(async () => {
  s = await makeTestServer({
    files: {
      'notes/groceries.md': '# Groceries\n\n- [ ] milk\n- [ ] eggs\n',
      'notes/fpga-ideas.md': '---\ntags: [fpga]\n---\n# FPGA ideas\n\nTile HBM reads to avoid bank conflicts. See [[Groceries]].\n',
      'journal/2026-11-24.md': '- 09:00 talked about FPGA ideas with the team\n- [ ] email committee due:2026-11-25 #admin\n',
    },
  });
});

afterEach(() => s.cleanup());

describe('request checks', () => {
  it('only answers to localhost host names', async () => {
    expect((await s.app.request('http://evil.example:4321/api/health')).status).toBe(421);
    expect((await s.get('/api/health')).status).toBe(200);
  });

  it('refuses state-changing requests from other sites', async () => {
    const res = await s.put('/api/note', { path: 'notes/a.md', content: 'x', baseHash: null }, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });

  it('rejects paths outside the notes folder and malformed bodies', async () => {
    expect((await s.get('/api/note?path=../secret.md')).status).toBe(400);
    expect((await s.put('/api/note', { path: '../x.md', content: 'x', baseHash: null })).status).toBe(400);
    expect((await s.put('/api/note', { path: 'notes/a.md', content: 42, baseHash: null })).status).toBe(400);
    const notJson = await s.app.request(`${ORIGIN}/api/note`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'hi' });
    expect(notJson.status).toBe(400);
    expect((await s.get('/api/nope')).status).toBe(404);
  });
});

describe('notes', () => {
  it('saves and loads a note, and reports conflicts', async () => {
    const save = await s.put('/api/note', { path: 'journal/2026-11-25.md', content: '- 09:00 hello\n', baseHash: null });
    expect(save.status).toBe(200);
    const loaded = (await (await s.get('/api/note?path=journal/2026-11-25.md')).json()) as NoteDoc;
    expect(loaded).toEqual({ path: 'journal/2026-11-25.md', content: '- 09:00 hello\n', hash: hashContent('- 09:00 hello\n') });

    const stale = await s.put('/api/note', { path: 'journal/2026-11-25.md', content: 'other device', baseHash: null });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as ConflictResponse).current.content).toBe('- 09:00 hello\n');
    expect(s.received).toContainEqual({ type: 'changed', path: 'journal/2026-11-25.md', hash: loaded.hash });
  });

  it('lists notes with titles, kinds, tags and open tasks', async () => {
    const list = (await (await s.get('/api/notes')).json()) as NoteSummary[];
    const groceries = list.find((n) => n.path === 'notes/groceries.md');
    expect(groceries).toMatchObject({ title: 'Groceries', kind: 'note', openTasks: 2 });
    expect(list.find((n) => n.path === 'journal/2026-11-24.md')).toMatchObject({ kind: 'journal', date: '2026-11-24', tags: ['admin'] });
    expect(list.find((n) => n.path === 'notes/fpga-ideas.md')?.tags).toEqual(['fpga']);
  });

  it('creates notes with unique file names', async () => {
    const first = (await (await s.post('/api/note/create', { title: 'Meeting with Ana' })).json()) as { path: string };
    const second = (await (await s.post('/api/note/create', { title: 'Meeting with Ana' })).json()) as { path: string };
    expect(first.path).toBe('notes/meeting-with-ana.md');
    expect(second.path).toBe('notes/meeting-with-ana-2.md');
    // New notes are made with a permanent id in their front matter, each its own.
    const firstText = await s.read(first.path);
    expect(firstText).toMatch(/^---\nid: [a-z][0-9a-z]{11}\n---\n# Meeting with Ana\n\n$/);
    expect(noteIdOf(await s.read(second.path))).not.toBe(noteIdOf(firstText));
    expect(s.index.list().find((n) => n.path === first.path)?.id).toBe(noteIdOf(firstText));
    const board = (await (await s.post('/api/note/create', { title: 'Thesis', kind: 'board' })).json()) as { path: string };
    expect(board.path).toBe('boards/thesis.md');
    expect(await s.read(board.path)).toMatch(/^---\nid: [a-z0-9]{12}\ntype: board\ntag: thesis\n/);
    const dashboard = (await (await s.post('/api/note/create', { title: 'Research', kind: 'dashboard' })).json()) as { path: string };
    expect(dashboard.path).toBe('dashboards/research.md');
    expect(await s.read(dashboard.path)).toMatch(/^---\nid: [a-z0-9]{12}\ntype: dashboard\n---\n# Research\n\n## Overview\n$/);
    expect(s.index.list().find((n) => n.path === dashboard.path)?.kind).toBe('dashboard');
  });

  it('renames a note and updates links to it', async () => {
    const res = await s.post('/api/note/rename', { path: 'notes/groceries.md', title: 'Shopping list' });
    expect(await res.json()).toEqual({ path: 'notes/shopping-list.md', updated: ['notes/fpga-ideas.md'] });
    expect(await s.read('notes/shopping-list.md')).toBe('# Shopping list\n\n- [ ] milk\n- [ ] eggs\n');
    expect(await s.read('notes/fpga-ideas.md')).toContain('See [[Shopping list]].');
    expect(s.index.hashOf('notes/groceries.md')).toBeNull();
  });

  it('renames a paper together with its highlights and reading comments', async () => {
    const p = await makeTestServer({
      files: {
        'papers/x.md': '---\ntype: paper\ntitle: X paper\npdf: x.pdf\n---\n## Summary\n',
        'papers/x.highlights.json': '[{"id":"a"}]',
        'papers/x.comments.md': '# Comments on [[X paper]]\n',
      },
    });
    try {
      const res = await p.post('/api/note/rename', { path: 'papers/x.md', title: 'Better title' });
      expect(((await res.json()) as { path: string }).path).toBe('papers/better-title.md');
      expect(await p.read('papers/better-title.md')).toContain('title: "Better title"\npdf: x.pdf');
      expect(await p.read('papers/better-title.highlights.json')).toBe('[{"id":"a"}]');
      expect(await p.read('papers/better-title.comments.md')).toBe('# Comments on [[Better title]]\n');
      expect(p.index.hashOf('papers/x.comments.md')).toBeNull();
      expect(p.index.hashOf('papers/better-title.comments.md')).not.toBeNull();
    } finally {
      await p.cleanup();
    }
  });

  it('moves deleted notes to the trash', async () => {
    const res = await s.post('/api/note/delete', { path: 'notes/groceries.md' });
    expect(await res.json()).toEqual({ trashPath: 'trash/notes/groceries.md' });
    expect(await s.read('trash/notes/groceries.md')).toContain('milk');
    expect(s.index.hashOf('notes/groceries.md')).toBeNull();
    expect(s.received).toContainEqual({ type: 'deleted', path: 'notes/groceries.md' });
  });
});

describe('search and links', () => {
  it('finds notes by words, with highlighted snippets', async () => {
    const res = (await (await s.get('/api/search?q=bank%20confl')).json()) as SearchResponse;
    expect(res.mode).toBe('notes');
    expect(res.notes.map((n) => n.path)).toEqual(['notes/fpga-ideas.md']);
    expect(res.notes[0]?.snippet).toContain('\u0001bank\u0002');
  });

  it('filters by tag, place and exclusions', async () => {
    const byTag = (await (await s.get('/api/search?q=tag:fpga')).json()) as SearchResponse;
    expect(byTag.notes.map((n) => n.path)).toEqual(['notes/fpga-ideas.md']);
    const journal = (await (await s.get('/api/search?q=fpga%20in:journal')).json()) as SearchResponse;
    expect(journal.notes.map((n) => n.path)).toEqual(['journal/2026-11-24.md']);
    const excluded = (await (await s.get('/api/search?q=fpga%20-bank')).json()) as SearchResponse;
    expect(excluded.notes.map((n) => n.path)).toEqual(['journal/2026-11-24.md']);
  });

  it('lists tasks for task queries', async () => {
    const open = (await (await s.get('/api/search?q=is:open&today=2026-11-25')).json()) as SearchResponse;
    expect(open.mode).toBe('tasks');
    expect(open.tasks.map((t) => t.text)).toEqual(['email committee due:2026-11-25 #admin', 'milk', 'eggs']);
    const dueToday = (await (await s.get('/api/search?q=due:today&today=2026-11-25')).json()) as SearchResponse;
    expect(dueToday.tasks.map((t) => t.text)).toEqual(['email committee due:2026-11-25 #admin']);
    const tagged = (await (await s.get('/api/search?q=is:open%20tag:admin')).json()) as SearchResponse;
    expect(tagged.tasks).toHaveLength(1);
  });

  it('shows backlinks and unlinked mentions, and links a mention on request', async () => {
    const links = (await (await s.get('/api/backlinks?path=notes/fpga-ideas.md')).json()) as BacklinksResponse;
    expect(links.linked).toEqual([]);
    expect(links.unlinked).toEqual([
      { path: 'journal/2026-11-24.md', title: '2026-11-24', line: 1, context: '- 09:00 talked about FPGA ideas with the team', term: 'FPGA ideas' },
    ]);
    const res = await s.post('/api/link-mention', { path: 'journal/2026-11-24.md', line: 1, term: 'FPGA ideas', target: 'notes/fpga-ideas.md' });
    expect(res.status).toBe(200);
    expect(await s.read('journal/2026-11-24.md')).toContain('talked about [[FPGA ideas]] with the team');
    const after = (await (await s.get('/api/backlinks?path=notes/fpga-ideas.md')).json()) as BacklinksResponse;
    expect(after.linked.map((l) => l.path)).toEqual(['journal/2026-11-24.md']);
    expect(after.unlinked).toEqual([]);
  });

  it('links a day to the notes that mention its date', async () => {
    const links = (await (await s.get('/api/backlinks?path=journal/2026-11-25.md')).json()) as BacklinksResponse;
    expect(links.linked).toEqual([]); // no note for that day yet, so no keys
    await s.put('/api/note', { path: 'journal/2026-11-25.md', content: 'today\n', baseHash: null });
    const after = (await (await s.get('/api/backlinks?path=journal/2026-11-25.md')).json()) as BacklinksResponse;
    expect(after.linked.map((l) => [l.path, l.line])).toEqual([['journal/2026-11-24.md', 2]]);
  });
});

describe('tasks and capture', () => {
  it('ticks a task in its note, recording the day', async () => {
    const tasks = (await (await s.get('/api/tasks?today=2026-11-25')).json()) as TaskItem[];
    const milk = tasks.find((t) => t.text === 'milk');
    expect(milk).toMatchObject({ path: 'notes/groceries.md', line: 3, raw: '- [ ] milk', done: false });
    const res = await s.post('/api/tasks/toggle', { path: milk?.path, line: milk?.line, raw: milk?.raw, today: '2026-11-25' });
    expect(res.status).toBe(200);
    expect(await s.read('notes/groceries.md')).toBe('# Groceries\n\n- [x] milk done:2026-11-25\n- [ ] eggs\n');
    const stale = await s.post('/api/tasks/toggle', { path: 'notes/groceries.md', line: 3, raw: '- [ ] milk', today: '2026-11-25' });
    expect(stale.status).toBe(409);
  });

  it('adds captures to the right day, once', async () => {
    const capture = { text: 'call the dentist', capturedAt: '2026-11-25T23:50:00+03:00', id: 'c1' };
    expect(await (await s.post('/api/capture', capture)).json()).toEqual({ path: 'journal/2026-11-25.md' });
    await s.post('/api/capture', capture);
    await s.post('/api/capture', { text: 'todo book flights', capturedAt: '2026-11-25T23:51:00+03:00' });
    // The day's first capture made its journal note, with an id; later captures leave the id alone.
    expect(await s.read('journal/2026-11-25.md')).toMatch(/^---\nid: [a-z0-9]{12}\n---\n- 23:50 call the dentist\n- \[ \] book flights\n$/);
    await s.post('/api/capture', { text: '[ ] bread', target: 'notes/groceries.md' });
    expect(await s.read('notes/groceries.md')).toBe('# Groceries\n\n- [ ] milk\n- [ ] eggs\n- [ ] bread\n');
  });
});

describe('settings and data files', () => {
  it('has defaults and saves cleaned-up settings', async () => {
    const defaults = (await (await s.get('/api/settings')).json()) as Settings;
    expect(defaults.views.length).toBeGreaterThan(0);
    const saved = (await (await s.put('/api/settings', { pinned: ['notes/groceries.md', '../x.md'], views: [{ name: 'FPGA', query: 'tag:fpga' }], vaultAutoLockMinutes: 5 })).json()) as Settings;
    expect(saved).toEqual({ pinned: ['notes/groceries.md'], views: [{ name: 'FPGA', query: 'tag:fpga' }], vaultAutoLockMinutes: 5 });
    expect(JSON.parse(await s.read('.notesapp/settings.json'))).toEqual(saved);
  });

  it('stores JSON data files with conflict checks', async () => {
    const empty = (await (await s.get('/api/data?path=papers/x.highlights.json')).json()) as { data: unknown; hash: string | null };
    expect(empty).toEqual({ path: 'papers/x.highlights.json', data: null, hash: null });
    const saved = (await (await s.put('/api/data', { path: 'papers/x.highlights.json', data: [{ id: 'a' }], baseHash: null })).json()) as { hash: string };
    expect((await s.put('/api/data', { path: 'papers/x.highlights.json', data: [], baseHash: null })).status).toBe(409);
    expect((await s.put('/api/data', { path: 'papers/x.highlights.json', data: [], baseHash: saved.hash })).status).toBe(200);
    expect((await s.get('/api/data?path=notes/groceries.md')).status).toBe(400);
  });
});

describe('files', () => {
  it('stores uploads and serves them safely', async () => {
    const form = new FormData();
    form.append('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'Screen shot.png', { type: 'image/png' }));
    const res = await s.app.request(`${ORIGIN}/api/files`, { method: 'POST', body: form, headers: { origin: ORIGIN } });
    const { path } = (await res.json()) as { path: string };
    expect(path).toMatch(/^files\/\d{4}\/screen-shot-[0-9a-f]{6}\.png$/);
    const file = await s.get(`/api/file?path=${encodeURIComponent(path)}`);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect(file.headers.get('content-security-policy')).toContain('sandbox');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    const bad = new FormData();
    bad.append('file', new File(['<script>'], 'evil.html'));
    expect((await s.app.request(`${ORIGIN}/api/files`, { method: 'POST', body: bad, headers: { origin: ORIGIN } })).status).toBe(400);
  });
});

describe('vault storage', () => {
  const id = 'a'.repeat(32);
  const putItem = (bytes: Uint8Array, baseHash = '') =>
    s.app.request(`${ORIGIN}/api/vault/item/${id}`, {
      method: 'PUT',
      body: bytes,
      headers: { origin: ORIGIN, 'content-type': 'application/octet-stream', 'x-base-hash': baseHash },
    });

  it('stores the key file once, then only with the right version', async () => {
    expect(await (await s.get('/api/vault/key')).json()).toEqual({ text: null, hash: null });
    const saved = (await (await s.put('/api/vault/key', { text: '{"version":1}', baseHash: null })).json()) as { hash: string };
    expect((await s.put('/api/vault/key', { text: '{"version":2}', baseHash: null })).status).toBe(409);
    expect((await s.put('/api/vault/key', { text: '{"version":2}', baseHash: saved.hash })).status).toBe(200);
  });

  it('stores opaque items with version checks, and trashes them', async () => {
    const first = (await (await putItem(new Uint8Array([1, 2, 3]))).json()) as { hash: string };
    expect((await putItem(new Uint8Array([9]))).status).toBe(409);
    expect((await putItem(new Uint8Array([4, 5]), first.hash)).status).toBe(200);
    const item = await s.get(`/api/vault/item/${id}`);
    expect(new Uint8Array(await item.arrayBuffer())).toEqual(new Uint8Array([4, 5]));
    expect(item.headers.get('x-hash')).toBe(hashContent(new Uint8Array([4, 5])));
    expect(((await (await s.get('/api/vault/items')).json()) as unknown[]).length).toBe(1);
    await s.app.request(`${ORIGIN}/api/vault/item/${id}`, { method: 'DELETE', headers: { origin: ORIGIN } });
    expect(await (await s.get('/api/vault/items')).json()).toEqual([]);
    expect((await s.get('/api/vault/item/not-an-id')).status).toBe(400);
    expect((await s.get('/api/note?path=vault/key.json')).status).toBe(400);
  });
});
