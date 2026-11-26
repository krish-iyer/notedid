import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { noteIdOf } from '../shared/noteIds.ts';
import { makeTestServer } from './testkit.ts';

const GENERATED = /^[a-z][0-9a-z]{11}$/;

describe('note ids', () => {
  it('gives ids to notes without one and new ids to copies, changing nothing else', async () => {
    const s = await makeTestServer({
      git: true,
      files: {
        'notes/old.md': '# Old\n\nText\n',
        'notes/crlf.md': '---\r\ntype: note\r\n---\r\nBody\r\n',
        'notes/original.md': '---\nid: k7q9m2vbfz4r\n---\n# Original\n',
        'notes/copy.md': '---\nid: k7q9m2vbfz4r\n---\n# Copy\n',
        'notes/own.md': '---\nid: my-own-id\n---\n# Own\n',
        'trash/notes/gone.md': '# Gone\n',
      },
    });
    try {
      // The copy is the newer file, so the original keeps the id.
      const earlier = new Date(Date.now() - 60_000);
      await fs.utimes(path.join(s.dir, 'notes/original.md'), earlier, earlier);

      expect(await (await s.get('/api/ids')).json()).toEqual({ notes: 5, missing: 2, copies: 1 });
      expect(await (await s.post('/api/ids', {})).json()).toEqual({ added: 2, renewed: 1 });

      expect(await s.read('notes/old.md')).toMatch(/^---\nid: [a-z][0-9a-z]{11}\n---\n# Old\n\nText\n$/);
      expect(await s.read('notes/crlf.md')).toMatch(/^---\r\nid: [a-z][0-9a-z]{11}\r\ntype: note\r\n---\r\nBody\r\n$/);
      expect(await s.read('notes/original.md')).toBe('---\nid: k7q9m2vbfz4r\n---\n# Original\n');
      const copy = await s.read('notes/copy.md');
      expect(copy).toMatch(/^---\nid: [a-z][0-9a-z]{11}\n---\n# Copy\n$/);
      expect(noteIdOf(copy)).not.toBe('k7q9m2vbfz4r');
      expect(await s.read('notes/own.md')).toBe('---\nid: my-own-id\n---\n# Own\n');
      expect(await s.read('trash/notes/gone.md')).toBe('# Gone\n');

      // Every note now has its own id, the index knows them, and asking again changes nothing.
      const ids = s.index.list().map((n) => n.id ?? '');
      expect(new Set(ids).size).toBe(5);
      expect(ids.filter((id) => GENERATED.test(id))).toHaveLength(4);
      expect(await (await s.get('/api/ids')).json()).toEqual({ notes: 5, missing: 0, copies: 0 });
      expect(await (await s.post('/api/ids', {})).json()).toEqual({ added: 0, renewed: 0 });

      // The git backup keeps it as one step of its own, and the notes' versions leave it out.
      const { stdout } = await promisify(execFile)('git', ['log', '-1', '--format=%s'], { cwd: s.dir });
      expect(stdout.trim()).toBe('Give 3 notes ids');
      await s.versions.flush();
      await expect(fs.stat(path.join(s.dir, '.notedid/history'))).rejects.toThrow();
    } finally {
      await s.cleanup();
    }
  });

  it('keeps a note exactly as the editor saves it: the server never adds an id on its own', async () => {
    const s = await makeTestServer();
    try {
      await s.put('/api/note', { path: 'journal/2026-11-26.md', content: 'typed\n', baseHash: null });
      expect(await s.read('journal/2026-11-26.md')).toBe('typed\n');
    } finally {
      await s.cleanup();
    }
  });
});
