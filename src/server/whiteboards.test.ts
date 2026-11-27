import { unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BacklinksResponse, NoteDoc, NoteSummary, SearchResponse, TaskItem } from '../shared/api.ts';
import { makeTestServer, type TestServer } from './testkit.ts';

/** A drawing as Excalidraw saves one. */
function scene(elements: Record<string, unknown>[]): string {
  return `${JSON.stringify({ type: 'excalidraw', version: 2, source: 'test', elements, appState: { viewBackgroundColor: '#ffffff' }, files: {} }, null, 2)}\n`;
}

const plan = scene([
  { id: 'f1', type: 'frame', name: 'Architecture' },
  { id: 't1', type: 'text', text: 'Reconfigure the FPGA kernels', originalText: 'Reconfigure the FPGA kernels', frameId: 'f1' },
  { id: 't2', type: 'text', text: 'See [[Groceries]]\n- [ ] not a task', originalText: 'See [[Groceries]]\n- [ ] not a task', frameId: null },
]);

let s: TestServer;

beforeEach(async () => {
  s = await makeTestServer({
    files: {
      'notes/groceries.md': '# Groceries\n\n- [ ] milk\n',
      'notes/meeting.md': '# Meeting\n\nThe plan: [[Project plan#Architecture]], and [[whiteboards/Project plan]].\n',
      'whiteboards/Project plan.excalidraw': plan,
    },
  });
});

afterEach(() => s.cleanup());

const list = async () => (await (await s.get('/api/notes')).json()) as NoteSummary[];

describe('whiteboards', () => {
  it('are in the index as notes of their own kind, named by their file, with no tasks', async () => {
    const board = (await list()).find((n) => n.path === 'whiteboards/Project plan.excalidraw');
    expect(board).toMatchObject({ kind: 'whiteboard', title: 'Project plan', openTasks: 0 });
    const tasks = (await (await s.get('/api/tasks?today=2026-11-27')).json()) as TaskItem[];
    expect(tasks.map((t) => t.text)).not.toContain('not a task');
  });

  it('are found by the text on them, and their links count both ways', async () => {
    const found = (await (await s.get('/api/search?q=reconfigure')).json()) as SearchResponse;
    expect(found.notes.map((n) => n.path)).toContain('whiteboards/Project plan.excalidraw');
    const toBoard = (await (await s.get(`/api/backlinks?path=${encodeURIComponent('whiteboards/Project plan.excalidraw')}`)).json()) as BacklinksResponse;
    expect(toBoard.linked.map((l) => l.path)).toEqual(['notes/meeting.md']);
    const fromBoard = (await (await s.get('/api/backlinks?path=notes/groceries.md')).json()) as BacklinksResponse;
    expect(fromBoard.linked.map((l) => l.path)).toContain('whiteboards/Project plan.excalidraw');
  });

  it('are made with a name, and two of the same name get numbers', async () => {
    const first = (await (await s.post('/api/whiteboard/create', { title: 'Lab layout' })).json()) as { path: string };
    expect(first.path).toBe('whiteboards/Lab layout.excalidraw');
    expect(JSON.parse(await s.read(first.path))).toMatchObject({ type: 'excalidraw', elements: [] });
    const second = (await (await s.post('/api/whiteboard/create', { title: 'Lab layout' })).json()) as { path: string };
    expect(second.path).toBe('whiteboards/Lab layout 2.excalidraw');
    expect((await s.post('/api/whiteboard/create', { title: '  ' })).status).toBe(400);
  });

  it('save what Excalidraw sends, refuse anything else, and report a change made elsewhere', async () => {
    const rel = 'whiteboards/Project plan.excalidraw';
    const doc = (await (await s.get(`/api/whiteboard?path=${encodeURIComponent(rel)}`)).json()) as NoteDoc;
    expect(doc.content).toBe(plan);
    const next = scene([{ id: 't9', type: 'text', text: 'Bank conflicts', originalText: 'Bank conflicts' }]);
    const saved = await s.put('/api/whiteboard', { path: rel, content: next, baseHash: doc.hash });
    expect(saved.status).toBe(200);
    expect(await s.read(rel)).toBe(next);
    // Saved over the newer file by one that hadn't seen it: refused.
    expect((await s.put('/api/whiteboard', { path: rel, content: scene([]), baseHash: doc.hash })).status).toBe(409);
    expect((await s.put('/api/whiteboard', { path: rel, content: 'not a drawing', baseHash: null })).status).toBe(400);
    expect((await s.put('/api/whiteboard', { path: 'notes/x.md', content: next, baseHash: null })).status).toBe(400);
    const found = (await (await s.get('/api/search?q=bank')).json()) as SearchResponse;
    expect(found.notes.map((n) => n.path)).toContain(rel);
    expect(s.received.some((e) => e.type === 'changed' && e.path === rel)).toBe(true);
  });

  it('are renamed with their file, and links to them follow', async () => {
    const res = await s.post('/api/note/rename', { path: 'whiteboards/Project plan.excalidraw', title: 'Roadmap' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { path: string }).path).toBe('whiteboards/Roadmap.excalidraw');
    expect(await s.read('whiteboards/Roadmap.excalidraw')).toBe(plan);
    expect(await s.read('notes/meeting.md')).toBe('# Meeting\n\nThe plan: [[Roadmap#Architecture]], and [[whiteboards/Roadmap]].\n');
    expect((await list()).map((n) => n.path)).not.toContain('whiteboards/Project plan.excalidraw');
  });

  it('go to the trash when deleted', async () => {
    const res = await s.post('/api/note/delete', { path: 'whiteboards/Project plan.excalidraw' });
    expect(((await res.json()) as { trashPath: string }).trashPath).toBe('trash/whiteboards/Project plan.excalidraw');
    expect((await list()).map((n) => n.path)).not.toContain('whiteboards/Project plan.excalidraw');
  });

  it('dropped into the folder by another app show up', async () => {
    await s.write('whiteboards/From excalidraw.com.excalidraw', scene([{ id: 'x', type: 'text', text: 'Hello', originalText: 'Hello' }]));
    await s.notes.refresh('whiteboards/From excalidraw.com.excalidraw');
    expect((await list()).find((n) => n.title === 'From excalidraw.com')?.kind).toBe('whiteboard');
  });

  it('are in the export', async () => {
    const zip = unzipSync(new Uint8Array(await (await s.get('/api/export')).arrayBuffer()));
    expect(Object.keys(zip)).toContain('whiteboards/Project plan.excalidraw');
  });
});
