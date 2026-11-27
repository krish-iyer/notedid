import { describe, expect, it } from 'vitest';
import { analyzeBody, excerptOf, lineIndex, linkKey, parseWikiTarget, splitFrontmatter } from './markdown.ts';

describe('splitFrontmatter', () => {
  it('splits a closed YAML block', () => {
    const content = '---\ntitle: Hello\ntags: [a, b]\n---\n# Body\n';
    const { raw, bodyOffset } = splitFrontmatter(content);
    expect(raw).toBe('title: Hello\ntags: [a, b]');
    expect(content.slice(bodyOffset)).toBe('# Body\n');
  });

  it('handles CRLF and empty blocks', () => {
    expect(splitFrontmatter('---\r\na: 1\r\n---\r\nbody').bodyOffset).toBe(16);
    expect(splitFrontmatter('---\n---\nbody')).toEqual({ raw: '', bodyOffset: 8 });
  });

  it('ignores an unclosed fence or a rule later in the note', () => {
    expect(splitFrontmatter('---\nnot closed\n')).toEqual({ raw: null, bodyOffset: 0 });
    expect(splitFrontmatter('text\n---\na: 1\n---\n')).toEqual({ raw: null, bodyOffset: 0 });
  });
});

describe('parseWikiTarget', () => {
  it('splits target, heading and label', () => {
    expect(parseWikiTarget('Groceries')).toEqual({ target: 'Groceries', heading: null, label: null });
    expect(parseWikiTarget('Paper notes#Method|the method')).toEqual({ target: 'Paper notes', heading: 'Method', label: 'the method' });
    expect(parseWikiTarget('smith2024.pdf#page=4|p. 4')).toEqual({ target: 'smith2024.pdf', heading: 'page=4', label: 'p. 4' });
  });
});

describe('analyzeBody', () => {
  const note = [
    '# Project X',
    '',
    'See [[Related work]] and [[Paper notes#Method|the method]] for #fpga and #ideas/later.',
    'Not tags: #123, a#b, `#code`, https://example.com/#frag',
    '- [ ] email committee due:2026-11-28 #admin',
    '- [x] book room done:2026-11-24',
    '  - [ ] nested task',
    '',
    '```',
    '[[not a link]] #nottag 2026-01-01',
    '```',
    '',
    'Mentioned 2026-11-25 and [a doc](../notes/a%20doc.md#part) and <https://example.org>.',
    '',
    'Setext',
    'title',
    '------------',
  ].join('\n');
  const result = analyzeBody(note);

  it('finds wiki links with headings and labels', () => {
    const wiki = result.links.filter((l) => l.kind === 'wiki');
    expect(wiki.map((l) => [l.target, l.heading, l.label, l.line])).toEqual([
      ['Related work', null, null, 3],
      ['Paper notes', 'Method', 'the method', 3],
    ]);
  });

  it('finds tags but not issue numbers, mid-word hashes, code or URL fragments', () => {
    expect(result.tags).toEqual(['fpga', 'ideas/later', 'admin']);
  });

  it('finds tasks with their exact line, state and dates', () => {
    expect(result.tasks).toEqual([
      { line: 5, text: 'email committee due:2026-11-28 #admin', raw: '- [ ] email committee due:2026-11-28 #admin', done: false, due: '2026-11-28', doneDate: null },
      { line: 6, text: 'book room done:2026-11-24', raw: '- [x] book room done:2026-11-24', done: true, due: null, doneDate: '2026-11-24' },
      { line: 7, text: 'nested task', raw: '  - [ ] nested task', done: false, due: null, doneDate: null },
    ]);
  });

  it('finds markdown links, URLs and dates outside code', () => {
    const others = result.links.filter((l) => l.kind !== 'wiki').map((l) => [l.kind, l.target, l.heading]);
    expect(others).toContainEqual(['md', '../notes/a doc.md', 'part']);
    expect(others).toContainEqual(['url', 'https://example.org', null]);
    expect(others).toContainEqual(['url', 'https://example.com/#frag', null]);
    expect(others).toContainEqual(['date', '2026-11-25', null]);
    expect(others).toContainEqual(['date', '2026-11-28', null]);
    expect(others).not.toContainEqual(['date', '2026-01-01', null]);
  });

  it('finds headings and the first level-1 heading', () => {
    expect(result.firstH1).toBe('Project X');
    expect(result.headings).toEqual([
      { level: 1, text: 'Project X', line: 1 },
      { level: 2, text: 'Setext title', line: 15 },
    ]);
  });

  it('reports positions within the whole note when given an offset', () => {
    const content = '---\na: 1\n---\nsee [[Target]]\n';
    const offset = splitFrontmatter(content).bodyOffset;
    const links = analyzeBody(content.slice(offset), offset, lineIndex(content)).links;
    expect(links[0]).toMatchObject({ target: 'Target', line: 4, from: 17, to: 27 });
    expect(content.slice(17, 27)).toBe('[[Target]]');
  });

  it('finds the link in a picture of a whiteboard, ![[Board#Frame]], just as in [[Board#Frame]]', () => {
    const text = 'Here: ![[Plan#Architecture]]\n\n![[Plan]] and ![photo](a.png) and \\![[Escaped]] and `![[code]]`\n';
    const wiki = analyzeBody(text).links.filter((l) => l.kind === 'wiki');
    expect(wiki.map((l) => [l.target, l.heading, text.slice(l.from, l.to)])).toEqual([
      ['Plan', 'Architecture', '[[Plan#Architecture]]'],
      ['Plan', null, '[[Plan]]'],
      ['Escaped', null, '[[Escaped]]'],
    ]);
    expect(analyzeBody(text).links.some((l) => l.kind === 'md' && l.target === 'a.png')).toBe(true);
    // A lone "!" or "![" is still text, and ![…](…) still an image.
    expect(analyzeBody('Wow! ![[]] ![[x').links).toEqual([]);
  });
});

describe('linkKey', () => {
  it('matches names regardless of case, spacing and .md', () => {
    expect(linkKey('  My  Note.md ')).toBe('my note');
    expect(linkKey('My Note')).toBe(linkKey('my note'));
  });
});

describe('excerptOf', () => {
  it('drops the title heading and markup', () => {
    expect(excerptOf('# Title\n\nSome **bold** text with [[Link|a link]] and [x](y).\n- [ ] a task', 'Title')).toBe(
      'Some bold text with a link and x. a task',
    );
  });

  it('cuts long text at a word', () => {
    const text = 'word '.repeat(100);
    const excerpt = excerptOf(text, null, 50);
    expect(excerpt.length).toBeLessThanOrEqual(51);
    expect(excerpt.endsWith('…')).toBe(true);
  });
});
