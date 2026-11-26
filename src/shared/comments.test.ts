import { describe, expect, it } from 'vitest';
import { appendComment, commentsPathFor, newCommentsNote, parseComments } from './comments.ts';

describe('document comments', () => {
  it('builds a comments note and reads comments back', () => {
    let note = newCommentsNote('Design doc', 'notes/design-doc.md');
    expect(commentsPathFor('notes/design-doc.md')).toBe('notes/design-doc.comments.md');
    expect(parseComments(note)).toEqual([]);
    note = appendComment(note, 'the cache  is\nwrite-back', 'Is it, though?');
    note = appendComment(note, 'second passage', 'Line one\nline two');
    expect(note).toContain('Comments on [[Design doc]].');
    expect(note).toContain('\n---\n');
    expect(parseComments(note)).toEqual([
      { quote: 'the cache is write-back', text: 'Is it, though?' },
      { quote: 'second passage', text: 'Line one\nline two' },
    ]);
  });
});
