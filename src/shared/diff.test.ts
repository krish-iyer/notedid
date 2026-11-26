import { describe, expect, it } from 'vitest';
import { type DiffPart, diffStats, diffText } from './diff.ts';

const join = (parts: DiffPart[], keep: DiffPart['kind']) =>
  parts
    .filter((p) => p.kind === 'same' || p.kind === keep)
    .map((p) => p.text)
    .join('');

describe('word differences', () => {
  it('marks added and removed words', () => {
    expect(diffText('The quick fox jumps.', 'The quick brown fox leaps.')).toEqual([
      { kind: 'same', text: 'The quick ' },
      { kind: 'add', text: 'brown ' },
      { kind: 'same', text: 'fox ' },
      { kind: 'del', text: 'jumps' },
      { kind: 'add', text: 'leaps' },
      { kind: 'same', text: '.' },
    ]);
  });

  it('joins neighbouring changed words into one change', () => {
    expect(diffText('see the old cat here', 'see a new dog here')).toEqual([
      { kind: 'same', text: 'see ' },
      { kind: 'del', text: 'the old cat' },
      { kind: 'add', text: 'a new dog' },
      { kind: 'same', text: ' here' },
    ]);
  });

  it('always rebuilds both texts', () => {
    const cases: [string, string][] = [
      ['', 'new note\n'],
      ['old note\n', ''],
      ['same', 'same'],
      ['# Title\r\n\r\n- [ ] task one\r\n- [x] task two\r\n', '# Title\r\n\r\n- [x] task one\r\n- [x] task two\r\n- [ ] three\r\n'],
      ['Line one\nline two\nline three\n', 'line two\nLine one\nline three and more\n'],
      ['naïve café — “quotes”', 'naive café – “quotes!”'],
    ];
    for (const [before, after] of cases) {
      const parts = diffText(before, after);
      expect(join(parts, 'add')).toBe(after);
      expect(join(parts, 'del')).toBe(before);
    }
  });

  it('copes with long, very different texts', () => {
    const before = Array.from({ length: 4000 }, (_, i) => `word${i}`).join(' ');
    const after = Array.from({ length: 4000 }, (_, i) => `other${i}`).join(' ');
    const parts = diffText(before, after);
    expect(join(parts, 'add')).toBe(after);
    expect(join(parts, 'del')).toBe(before);
  });

  it('counts changed words', () => {
    expect(diffStats(diffText('a b c', 'a x y c'))).toEqual({ added: 2, removed: 1 });
  });
});
