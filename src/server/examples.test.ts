import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PaperSummary, SearchResponse, TaskItem } from '../shared/api.ts';
import { parseBoard } from '../shared/board.ts';
import { findCards } from '../shared/cards.ts';
import { parseComments } from '../shared/comments.ts';
import { analyzeBody, splitFrontmatter } from '../shared/markdown.ts';
import { noteIdOf } from '../shared/noteIds.ts';
import { EXAMPLES_START, examplePaths } from './examples.ts';
import { makeTestServer, ORIGIN, type TestServer } from './testkit.ts';

const TODAY = '2026-11-26';
const servers: TestServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.cleanup();
});

async function withExamples(files: Record<string, string> = {}): Promise<{ s: TestServer; added: string[]; kept: string[] }> {
  const s = await makeTestServer({ files });
  servers.push(s);
  const res = await s.post(`/api/examples?today=${TODAY}`, {});
  expect(res.status).toBe(200);
  return { s, ...((await res.json()) as { added: string[]; kept: string[] }) };
}

describe('the example notes', () => {
  it('adds every example, with ids, and never over a file that is there', async () => {
    const { s, added, kept } = await withExamples({ 'notes/examples/tables.md': '# My own tables\n' });
    expect(kept).toEqual(['notes/examples/tables.md']);
    expect(added.sort()).toEqual(examplePaths().filter((p) => p !== 'notes/examples/tables.md').sort());
    expect(await s.read('notes/examples/tables.md')).toBe('# My own tables\n');
    for (const rel of added.filter((p) => p.endsWith('.md'))) expect(noteIdOf(await s.read(rel)), rel).toMatch(/^[a-z][0-9a-z]{11}$/);
    // Again: nothing new.
    const again = (await (await s.post(`/api/examples?today=${TODAY}`, {})).json()) as { added: string[] };
    expect(again.added).toEqual([]);
  });

  it('links only to each other (but for the one link that shows a missing note)', async () => {
    const { s } = await withExamples();
    const broken: string[] = [];
    for (const rel of examplePaths().filter((p) => p.endsWith('.md'))) {
      const content = await s.read(rel);
      const { bodyOffset } = splitFrontmatter(content);
      for (const link of analyzeBody(content.slice(bodyOffset)).links) {
        if (link.kind !== 'wiki') continue;
        const target = s.index.resolve(link.target, rel);
        if (!target || !examplePaths().includes(target)) broken.push(`${rel} → ${link.target}`);
      }
    }
    expect(broken).toEqual(["notes/examples/writing-and-linking.md → Example · A note that doesn't exist yet"]);
    expect(s.index.get(EXAMPLES_START)?.title).toBe('Examples: start here');
  });

  it('has tasks overdue, due today, coming up, without a date and done', async () => {
    const { s } = await withExamples();
    const tasks = (await (await s.get(`/api/tasks?today=${TODAY}`)).json()) as TaskItem[];
    const mine = tasks.filter((t) => t.path === 'notes/examples/tasks-and-dates.md');
    expect(mine.map((t) => [t.text.replace(/ (due|done):\S+| #\S+/g, ''), t.due, t.done])).toEqual([
      ['Send the response to the reviewers', '2026-11-24', false],
      ['Book the lab for the experiment', TODAY, false],
      ['Read the related work section', '2026-11-27', false],
      ['Prepare the group meeting slides', '2026-12-01', false],
      ['Order more coffee', null, false],
      ['Install notedid', null, true],
    ]);
    const search = (await (await s.get(`/api/search?q=${encodeURIComponent('tag:example')}&today=${TODAY}`)).json()) as SearchResponse;
    expect(search.notes.length).toBeGreaterThanOrEqual(10);
    // The board's live search finds the project's open tasks.
    const project = (await (await s.get(`/api/search?q=${encodeURIComponent('is:open tag:example-project')}&today=${TODAY}`)).json()) as SearchResponse;
    expect(project.tasks?.map((t) => t.text.replace(/ (due|done):\S+| #\S+/g, ''))).toEqual(['Send the response to the reviewers', 'Book the lab for the experiment', 'Prepare the group meeting slides']);
  });

  it('has a board with every kind of card and a tray, a dashboard, cards and a paper with its PDF', async () => {
    const { s } = await withExamples();
    const board = parseBoard(await s.read('boards/example-project.md'));
    expect(board.tag).toBe('example-project');
    expect(board.clusters.map((c) => c.title)).toEqual(['To do', 'Doing', 'Done']);
    const kinds = new Set(board.clusters.flatMap((c) => c.entries.flatMap((e) => (e.type === 'card' ? [e.card.kind] : []))));
    expect([...kinds].sort()).toEqual(['link', 'note', 'query', 'text']);
    // The tasks note is tagged for the board but not on it: it waits in the tray.
    expect(s.index.get('notes/examples/tasks-and-dates.md')?.tags).toContain('example-project');

    const dashboard = parseBoard(await s.read('dashboards/example-dashboard.md'));
    expect(dashboard.clusters.map((c) => c.title)).toEqual(['Reading', 'Project', 'How it works']);
    expect(dashboard.clusters[0]?.entries.flatMap((e) => (e.type === 'card' ? [e.card.attrs] : []))).toEqual([['full'], ['half'], ['half']]);

    const sets = findCards((await s.read('notes/examples/cards.md')).split('\n'));
    expect(sets.flatMap((set) => set.cards.map((c) => c.properties.find((p) => p.key === 'status')?.value))).toEqual(['needs answer', 'in progress', 'done', 'disagree']);

    const papers = (await (await s.get('/api/papers')).json()) as PaperSummary[];
    const paper = papers.find((p) => p.title === 'An example paper');
    expect(paper).toMatchObject({ path: 'papers/example-paper.md', pdf: 'papers/example-paper.pdf' });
    const pdf = await fs.readFile(path.join(s.dir, 'papers/example-paper.pdf'), 'latin1');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('(An example paper) Tj');
    expect(pdf).toMatch(/startxref\n\d+\n%%EOF\n$/);

    const reading = await s.read('notes/examples/reading-view-and-comments.md');
    const comments = parseComments(await s.read('notes/examples/reading-view-and-comments.comments.md'));
    expect(comments).toHaveLength(1);
    expect(reading).toContain(comments[0]?.quote ?? 'missing');
  });

  it('removes them all to the trash, and nothing else', async () => {
    const { s } = await withExamples({ 'notes/mine.md': '# Mine\n\nSee [[Example · Tables]].\n' });
    const res = await s.app.request(`${ORIGIN}/api/examples`, { method: 'DELETE', headers: { origin: ORIGIN } });
    expect(((await res.json()) as { removed: string[] }).removed.sort()).toEqual(examplePaths().sort());
    for (const rel of examplePaths()) {
      await expect(fs.stat(path.join(s.dir, rel))).rejects.toThrow();
      expect((await fs.stat(path.join(s.dir, 'trash', rel))).isFile()).toBe(true);
    }
    expect(s.index.list().map((n) => n.path)).toEqual(['notes/mine.md']);
    expect(await s.read('notes/mine.md')).toBe('# Mine\n\nSee [[Example · Tables]].\n');
  });
});
