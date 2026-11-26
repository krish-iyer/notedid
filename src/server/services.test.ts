import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { parseQuery } from '../shared/query.ts';
import { GitHistory } from './git.ts';
import { memoryDatabase } from './nodeSqlite.ts';
import { NoteIndex } from './noteIndex.ts';
import { appendBlock, formatCapture, rewriteLinks } from './notes.ts';
import { isPdf, paperKey, paperNote, parseArxivFeed, parseCrossref, parsePaperId } from './papers.ts';
import { hashContent } from './storage.ts';
import { makeTestServer, ORIGIN } from './testkit.ts';
import { decodeEntities, fetchPageTitle } from './web.ts';

const run = promisify(execFile);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('NoteIndex', () => {
  const index = new NoteIndex(memoryDatabase());
  const add = (p: string, content: string) => index.upsert(p, content, Date.parse('2026-11-20T10:00:00Z'), hashContent(content));
  add('notes/hbm.md', '---\naliases: [High Bandwidth Memory]\ntags: [hardware/memory]\n---\n# HBM\n\nStacked DRAM.\n');
  add('papers/smith2024.md', '---\ntype: paper\npdf: smith2024.pdf\n---\n# Fast kernels\n');
  add('journal/2026-11-20.md', 'Read about high bandwidth memory. [[HBM]] and [[smith2024.pdf#page=4|p. 4]] [x](../notes/hbm.md)\n');

  it('resolves links by path, title, file name, alias and PDF', () => {
    expect(index.resolve('HBM')).toBe('notes/hbm.md');
    expect(index.resolve('notes/hbm')).toBe('notes/hbm.md');
    expect(index.resolve('high bandwidth memory')).toBe('notes/hbm.md');
    expect(index.resolve('smith2024.pdf')).toBe('papers/smith2024.md');
    expect(index.resolve('../notes/hbm.md', 'journal/2026-11-20.md')).toBe('notes/hbm.md');
    expect(index.resolve('nothing')).toBeNull();
  });

  it('collects backlinks of every kind, once per line', () => {
    expect(index.backlinks('notes/hbm.md').linked).toEqual([{ path: 'journal/2026-11-20.md', title: '2026-11-20', line: 1, context: expect.stringContaining('[[HBM]]') }]);
    expect(index.backlinks('papers/smith2024.md').linked.map((l) => l.path)).toEqual(['journal/2026-11-20.md']);
  });

  it('matches nested tags and dates', () => {
    const search = (q: string) => index.search(parseQuery(q, '2026-11-25'), { today: '2026-11-25', pinned: [] }).notes.map((n) => n.path);
    expect(search('tag:hardware')).toEqual(['notes/hbm.md']);
    expect(search('in:journal after:2026-11-20')).toEqual(['journal/2026-11-20.md']);
    expect(search('in:journal before:2026-11-20')).toEqual([]);
    expect(search('has:pdf')).toEqual(expect.arrayContaining(['papers/smith2024.md', 'journal/2026-11-20.md']));
    expect(search('"stacked dram"')).toEqual(['notes/hbm.md']);
  });

  it('forgets a removed note', () => {
    add('notes/tmp.md', 'temporary words');
    expect(index.remove('notes/tmp.md')).toBe(true);
    expect(index.search(parseQuery('temporary', '2026-11-25'), { today: '2026-11-25', pinned: [] }).notes).toEqual([]);
  });
});

describe('note operations', () => {
  it('formats captures', () => {
    expect(formatCapture('call bob', '14:32')).toBe('- 14:32 call bob');
    expect(formatCapture('todo: call bob', '14:32')).toBe('- [ ] call bob');
    expect(formatCapture('[] milk', null)).toBe('- [ ] milk');
    expect(formatCapture('first\nsecond\n\nthird', '09:00')).toBe('- 09:00 first\n  second\n\n  third');
  });

  it('appends without touching existing text, keeping CRLF', () => {
    expect(appendBlock('', '- a')).toBe('- a\n');
    expect(appendBlock('x\n', '- a')).toBe('x\n- a\n');
    expect(appendBlock('x', '- a')).toBe('x\n- a\n');
    expect(appendBlock('x\r\n', '- a\n  b')).toBe('x\r\n- a\r\n  b\r\n');
  });

  it('rewrites links to a renamed note, keeping headings and labels', () => {
    const content = 'See [[Old Name]], [[old name#Part|the part]], [[notes/old-name]], [doc](../notes/old-name.md#x) and `[[Old Name]]`.';
    const keys = new Set(['notes/old-name', 'old name']);
    expect(rewriteLinks(content, 'journal/2026-11-25.md', keys, 'New Name', 'notes/new-name.md')).toBe(
      'See [[New Name]], [[New Name#Part|the part]], [[notes/new-name]], [doc](../notes/new-name.md#x) and `[[Old Name]]`.',
    );
    expect(rewriteLinks('nothing here', 'a.md', keys, 'New', 'notes/new.md')).toBeNull();
  });

  it('ticks a task that moved down after lines were added above it', async () => {
    const s = await makeTestServer({ files: { 'notes/list.md': '- [ ] milk\n' } });
    cleanups.push(s.cleanup);
    await s.write('notes/list.md', 'new first line\n- [ ] milk\n');
    await s.notes.refresh('notes/list.md');
    await s.notes.toggleTask('notes/list.md', 1, '- [ ] milk', '2026-11-25');
    expect(await s.read('notes/list.md')).toBe('new first line\n- [x] milk done:2026-11-25\n');
  });

  it('picks up notes changed outside the app', async () => {
    const s = await makeTestServer({ files: { 'notes/a.md': '# A\n' } });
    cleanups.push(s.cleanup);
    await s.write('notes/a.md', '# A\n\nedited in vim #outside\n');
    await s.write('notes/b.md', '# B\n');
    await s.notes.rescan();
    expect(s.index.get('notes/a.md')?.tags).toEqual(['outside']);
    expect(s.index.get('notes/b.md')?.title).toBe('B');
    expect(s.received.map((e) => e.type)).toEqual(['changed', 'changed']);
  });
});

describe('note history (git)', () => {
  it('keeps versions in the notes folder’s own repository', async () => {
    const outer = await fs.mkdtemp(path.join(os.tmpdir(), 'notesapp-git-'));
    cleanups.push(() => fs.rm(outer, { recursive: true, force: true }));
    // The notes folder sits inside another repository, like dev-notes inside the code repo.
    await run('git', ['init', '-q'], { cwd: outer });
    const s = await makeTestServer({ history: true, files: { 'notes/a.md': 'one\n' } });
    cleanups.push(s.cleanup);
    const nested = path.join(outer, 'notes');
    await fs.rename(s.dir, nested).catch(async () => fs.cp(s.dir, nested, { recursive: true }));
    const history = new GitHistory(nested, { delayMs: 60_000 });
    expect(await history.init()).toBe(true);
    const top = (await run('git', ['rev-parse', '--show-toplevel'], { cwd: nested })).stdout.trim();
    expect(await fs.realpath(top)).toBe(await fs.realpath(nested));

    await fs.writeFile(path.join(nested, 'notes/a.md'), 'two\n');
    const commit = await history.commitNow();
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await history.commitNow()).toBeNull();
    const log = await history.log('notes/a.md');
    expect(log.map((e) => e.message)).toEqual(['Update notes/a.md', 'Notes as they were when history started']);
    expect(await history.show(log[1]?.commit ?? '', 'notes/a.md')).toBe('one\n');
    expect(await history.show('--help', 'notes/a.md')).toBeNull();
  });
});

describe('papers', () => {
  const FEED = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry>
    <id>http://arxiv.org/abs/1706.03762v7</id><published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All You
      Need</title><summary>The dominant sequence &amp; transduction models.</summary>
    <author><name>Ashish Vaswani</name></author><author><name>Noam Shazeer</name></author>
  </entry></feed>`;
  const PDF = new TextEncoder().encode('%PDF-1.4\n% test\n');

  it('recognises arXiv IDs and DOIs', () => {
    expect(parsePaperId('https://arxiv.org/abs/1706.03762v7')).toEqual({ kind: 'arxiv', id: '1706.03762v7' });
    expect(parsePaperId('https://arxiv.org/pdf/2501.01234.pdf')).toEqual({ kind: 'arxiv', id: '2501.01234' });
    expect(parsePaperId('arXiv:2501.01234')).toEqual({ kind: 'arxiv', id: '2501.01234' });
    expect(parsePaperId('hep-th/9901001')).toEqual({ kind: 'arxiv', id: 'hep-th/9901001' });
    expect(parsePaperId('https://doi.org/10.48550/arXiv.2501.01234')).toEqual({ kind: 'arxiv', id: '2501.01234' });
    expect(parsePaperId('https://doi.org/10.1145/3373376.3378519.')).toEqual({ kind: 'doi', id: '10.1145/3373376.3378519' });
    expect(parsePaperId('not a paper')).toBeNull();
  });

  it('reads arXiv and Crossref metadata', () => {
    expect(parseArxivFeed(FEED, '1706.03762')).toMatchObject({ title: 'Attention Is All You Need', authors: ['Ashish Vaswani', 'Noam Shazeer'], year: 2017, abstract: 'The dominant sequence & transduction models.' });
    expect(() => parseArxivFeed('<feed><entry><id>http://arxiv.org/api/errors#x</id></entry></feed>', 'x')).toThrow(/no paper/);
    const crossref = { message: { title: ['A  Paper: with colon'], author: [{ given: 'Ana', family: 'Lopez' }, { name: 'Consortium' }], issued: { 'date-parts': [[2020, 3]] }, 'container-title': ['ASPLOS'], abstract: '<jats:p>Hi &amp; bye</jats:p>' } };
    expect(parseCrossref(crossref, '10.1/x')).toEqual({ title: 'A Paper: with colon', authors: ['Ana Lopez', 'Consortium'], year: 2020, venue: 'ASPLOS', arxiv: null, doi: '10.1/x', url: 'https://doi.org/10.1/x', abstract: 'Hi & bye' });
  });

  it('makes citation keys and review notes', () => {
    const meta = { title: 'The Case for Learned Index Structures', authors: ['Tim Kraska'], year: 2018, venue: null, arxiv: null, doi: null, url: null, abstract: null };
    expect(paperKey(meta)).toBe('kraska2018case');
    const note = paperNote({ ...meta, title: 'Title: with "quotes"' }, 'kraska2018case.pdf');
    expect(note).toContain('type: paper\ntitle: \'Title: with "quotes"\'');
    expect(note).toContain('pdf: kraska2018case.pdf');
    expect(note).toMatch(/\nadded: \d{4}-\d{2}-\d{2}\n---\n/);
    expect(note.endsWith('## Highlights\n')).toBe(true);
    expect(isPdf(PDF)).toBe(true);
  });

  it('imports from arXiv with the PDF, once', async () => {
    const fetched: string[] = [];
    const s = await makeTestServer({
      fetch: async (input) => {
        const url = String(input);
        fetched.push(url);
        if (url.startsWith('https://export.arxiv.org/')) return new Response(FEED, { headers: { 'content-type': 'application/atom+xml' } });
        if (url.startsWith('https://arxiv.org/pdf/')) return new Response(PDF, { headers: { 'content-type': 'application/pdf' } });
        return new Response('no', { status: 404 });
      },
    });
    cleanups.push(s.cleanup);
    const res = await s.post('/api/papers/import', { source: 'https://arxiv.org/abs/1706.03762' });
    expect(await res.json()).toEqual({ key: 'vaswani2017attention', path: 'papers/vaswani2017attention.md', pdf: true, existing: false });
    expect(await fs.readFile(path.join(s.dir, 'papers/vaswani2017attention.pdf'))).toEqual(Buffer.from(PDF));
    // Quoted so YAML reads it back as text, not the number 1706.03762.
    expect(await s.read('papers/vaswani2017attention.md')).toContain('arxiv: "1706.03762"');
    const again = await s.post('/api/papers/import', { source: 'arXiv:1706.03762v7' });
    expect(((await again.json()) as { existing: boolean }).existing).toBe(true);
    expect(fetched.filter((u) => u.includes('export.arxiv.org'))).toHaveLength(1);

    const list = (await (await s.get('/api/papers')).json()) as { key: string; pdf: string }[];
    expect(list).toMatchObject([{ key: 'vaswani2017attention', pdf: 'papers/vaswani2017attention.pdf', highlights: 0 }]);
  });

  it('imports an arXiv paper through DataCite when arXiv\'s API can\'t be reached (as from a browser)', async () => {
    const fetched: string[] = [];
    const s = await makeTestServer({
      fetch: async (input) => {
        const url = String(input);
        fetched.push(url);
        if (url.startsWith('https://export.arxiv.org/')) throw new TypeError('Failed to fetch');
        if (url === 'https://api.datacite.org/dois/10.48550/arXiv.1706.03762') {
          return Response.json({
            data: {
              attributes: {
                titles: [{ title: 'Attention Is All You Need' }],
                creators: [{ name: 'Vaswani, Ashish', givenName: 'Ashish', familyName: 'Vaswani' }, { name: 'Shazeer, Noam' }],
                publicationYear: 2017,
                descriptions: [{ description: 'The dominant sequence  transduction models…', descriptionType: 'Abstract' }],
              },
            },
          });
        }
        if (url.startsWith('https://arxiv.org/pdf/')) return new Response(PDF, { headers: { 'content-type': 'application/pdf' } });
        return new Response('no', { status: 404 });
      },
    });
    cleanups.push(s.cleanup);
    const res = await s.post('/api/papers/import', { source: 'arXiv:1706.03762v7' });
    expect(await res.json()).toEqual({ key: 'vaswani2017attention', path: 'papers/vaswani2017attention.md', pdf: true, existing: false });
    const note = await s.read('papers/vaswani2017attention.md');
    expect(note).toContain('title: Attention Is All You Need');
    expect(note).toContain('authors:\n  - Ashish Vaswani\n  - Shazeer, Noam\n');
    expect(note).toContain('## Abstract\n\nThe dominant sequence transduction models…');
    expect(fetched.some((u) => u.startsWith('https://api.datacite.org/'))).toBe(true);
    expect((await s.post('/api/papers/import', { source: '2501.99999' })).status).toBe(404);
  });

  it('reports when arXiv or Crossref cannot be reached', async () => {
    const s = await makeTestServer();
    cleanups.push(s.cleanup);
    expect((await s.post('/api/papers/import', { source: '2501.01234' })).status).toBe(502);
    expect((await s.post('/api/papers/import', { source: 'nonsense' })).status).toBe(400);
  });

  it('adds a paper from an uploaded PDF, and attaches a PDF later', async () => {
    const s = await makeTestServer({ files: { 'papers/lopez2020paper.md': '---\ntype: paper\ntitle: A paper\n---\n# A paper\n' } });
    cleanups.push(s.cleanup);
    const form = new FormData();
    form.append('file', new File([PDF], 'my_great_paper.pdf', { type: 'application/pdf' }));
    const res = await s.app.request(`${ORIGIN}/api/papers/upload`, { method: 'POST', body: form, headers: { origin: ORIGIN } });
    expect(await res.json()).toEqual({ key: 'my-great-paper', path: 'papers/my-great-paper.md', pdf: true });

    const attach = new FormData();
    attach.append('file', new File([PDF], 'x.pdf'));
    attach.append('path', 'papers/lopez2020paper.md');
    const attached = await s.app.request(`${ORIGIN}/api/papers/attach`, { method: 'POST', body: attach, headers: { origin: ORIGIN } });
    expect(await attached.json()).toEqual({ pdf: 'papers/lopez2020paper.pdf' });
    expect(await s.read('papers/lopez2020paper.md')).toBe('---\ntype: paper\ntitle: A paper\npdf: lopez2020paper.pdf\n---\n# A paper\n');
  });
});

describe('web helpers', () => {
  it('decodes HTML entities', () => {
    expect(decodeEntities('A &amp; B &#8211; C &#x27;d&#x27; &nbsp;')).toBe("A & B – C 'd'  ");
  });

  it('reads page titles, preferring og:title, and ignores non-web URLs', async () => {
    const page = (html: string) => async () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    expect(await fetchPageTitle('https://example.com', page('<title> Plain &amp; simple </title>'))).toBe('Plain & simple');
    expect(await fetchPageTitle('https://example.com', page('<meta property="og:title" content="Better"><title>x</title>'))).toBe('Better');
    expect(await fetchPageTitle('file:///etc/passwd', page('<title>no</title>'))).toBeNull();
  });
});
