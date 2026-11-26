import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { basename, dirname, extname, join, normalize, relative } from './posixPath.ts';

const paths = ['', '.', 'a.md', 'notes/a.md', 'notes//a.md', 'notes/./a.md', 'notes/../a.md', '../a.md', '../../x/y.md', 'a/b/c/', 'files/2026/x.tar.gz', '.hidden', 'notes/.hidden', 'a.', 'a/b/../../..', '/abs/x.md', 'journal/2026-11-26.md'];

describe('posixPath matches Node for paths in the notes folder', () => {
  it.each(paths)('%j', (p) => {
    expect(normalize(p)).toBe(path.posix.normalize(p).replace(/\/$/, '') || '.');
    if (p) {
      expect(dirname(p)).toBe(path.posix.dirname(p));
      expect(basename(p)).toBe(path.posix.basename(p));
      expect(extname(p)).toBe(path.posix.extname(p));
    }
  });

  it('joins and relates folders', () => {
    const cases: [string, string][] = [
      ['notes', 'a.md'],
      ['.', 'x.md'],
      ['journal', '../notes/a.md'],
      ['papers', '../../outside.md'],
      ['a/b', './c/../d.md'],
    ];
    for (const [dir, rel] of cases) expect(join(dir, rel)).toBe(path.posix.join(dir, rel));
    const pairs: [string, string][] = [
      ['notes', 'papers/x.md'],
      ['notes', 'notes/a.md'],
      ['.', 'a.md'],
      ['journal', 'files/2026/x.png'],
      ['a/b/c', 'a/d'],
      ['notes', 'notes'],
    ];
    for (const [from, to] of pairs) expect(relative(from, to)).toBe(path.posix.relative(from, to));
    expect(basename('files/a.pdf', '.pdf')).toBe(path.posix.basename('files/a.pdf', '.pdf'));
  });
});
