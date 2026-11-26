import { describe, expect, it } from 'vitest';
import { highlightBlock, parseHighlightBlocks, removeHighlightBlock, setHighlightComment, setHighlightResolved } from './highlights.ts';

const NOTE = [
  '# A paper',
  '',
  '## Highlights',
  '> first passage that',
  '> spans two lines',
  '> — [p. 1](paper.pdf#page=1&hl=aaaa1111)',
  '',
  'My comment',
  'continues here.',
  '',
  '> second passage',
  '> — [p. 3](paper.pdf#page=3&hl=bbbb2222)',
  '',
].join('\n');

describe('highlight blocks in a review note', () => {
  it('reads quotes, pages and comments', () => {
    expect(parseHighlightBlocks(NOTE).map(({ id, page, quote, comment }) => ({ id, page, quote, comment }))).toEqual([
      { id: 'aaaa1111', page: 1, quote: 'first passage that spans two lines', comment: 'My comment\ncontinues here.' },
      { id: 'bbbb2222', page: 3, quote: 'second passage', comment: '' },
    ]);
  });

  it('resolves a comment and opens it again, keeping its text', () => {
    const resolved = setHighlightResolved(NOTE, 'aaaa1111', true) ?? '';
    expect(resolved).toBe(NOTE.replace('hl=aaaa1111)', 'hl=aaaa1111) · resolved'));
    const block = parseHighlightBlocks(resolved)[0];
    expect(block?.resolved).toBe(true);
    expect(block?.comment).toBe('My comment\ncontinues here.');
    expect(parseHighlightBlocks(resolved)[1]?.resolved).toBe(false);
    expect(setHighlightResolved(resolved, 'aaaa1111', true)).toBe(resolved);
    expect(setHighlightResolved(resolved, 'aaaa1111', false)).toBe(NOTE);
    expect(setHighlightComment(resolved, 'aaaa1111', 'Changed')).toContain('hl=aaaa1111) · resolved\n\nChanged\n');
    expect(removeHighlightBlock(resolved, 'aaaa1111')).toBe(removeHighlightBlock(NOTE, 'aaaa1111'));
    expect(setHighlightResolved(NOTE.replace(/\n/g, '\r\n'), 'bbbb2222', true)).toBe(NOTE.replace('hl=bbbb2222)', 'hl=bbbb2222) · resolved').replace(/\n/g, '\r\n'));
    expect(setHighlightResolved(NOTE, 'nope', true)).toBeNull();
  });

  it('writes a comment, changes it and clears it', () => {
    const added = setHighlightComment(NOTE, 'bbbb2222', 'Is this measured?') ?? '';
    expect(added.endsWith('> — [p. 3](paper.pdf#page=3&hl=bbbb2222)\n\nIs this measured?\n')).toBe(true);
    expect(parseHighlightBlocks(added)[1]?.comment).toBe('Is this measured?');
    const changed = setHighlightComment(added, 'aaaa1111', 'Shorter') ?? '';
    expect(changed).toContain('hl=aaaa1111)\n\nShorter\n\n> second passage');
    const cleared = setHighlightComment(changed, 'bbbb2222', '') ?? '';
    expect(cleared.endsWith('hl=bbbb2222)\n')).toBe(true);
    expect(setHighlightComment(NOTE, 'nope', 'x')).toBeNull();
  });

  it('removes a block without leaving gaps', () => {
    expect(removeHighlightBlock(NOTE, 'aaaa1111')).toBe('# A paper\n\n## Highlights\n> second passage\n> — [p. 3](paper.pdf#page=3&hl=bbbb2222)\n');
    expect(removeHighlightBlock(NOTE, 'bbbb2222')).toBe(
      '# A paper\n\n## Highlights\n> first passage that\n> spans two lines\n> — [p. 1](paper.pdf#page=1&hl=aaaa1111)\n\nMy comment\ncontinues here.\n',
    );
  });

  it('keeps CRLF line endings', () => {
    const crlf = NOTE.replace(/\n/g, '\r\n');
    const out = setHighlightComment(crlf, 'bbbb2222', 'x') ?? '';
    expect(/(^|[^\r])\n/.test(out)).toBe(false);
    expect(parseHighlightBlocks(out)[1]?.comment).toBe('x');
  });

  it('formats new blocks', () => {
    expect(highlightBlock('a  b\nc', 2, 'p.pdf#page=2&hl=x1')).toBe('> a b c\n> — [p. 2](p.pdf#page=2&hl=x1)');
    expect(highlightBlock('q', 2, 'l', ' why? ')).toBe('> q\n> — [p. 2](l)\n\nwhy?');
  });
});
