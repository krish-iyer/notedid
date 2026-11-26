import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { isGeneratedNoteId, newNoteId, noteIdOf, withNoteId } from './noteIds.ts';

describe('note ids', () => {
  it('makes twelve-character ids that start with a letter, all different', () => {
    const ids = Array.from({ length: 2000 }, newNoteId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(isGeneratedNoteId(id)).toBe(true);
      expect(id).toMatch(/^[a-z][0-9a-z]{11}$/);
      expect(id).not.toMatch(/[ilou]/);
      // YAML reads it back as the same string, never a number or a boolean.
      expect(parseYaml(`id: ${id}`)).toEqual({ id });
    }
  });

  it('reads the id from the front matter', () => {
    expect(noteIdOf('---\nid: k7q9m2vbfz4r\ntype: paper\n---\n# A\n')).toBe('k7q9m2vbfz4r');
    expect(noteIdOf('---\nid: "my-own-id"\n---\n')).toBe('my-own-id');
    expect(noteIdOf('# No front matter\nid: not this\n')).toBeNull();
    expect(noteIdOf('---\nid:\n---\n')).toBeNull();
  });

  it('adds the id as the first line of the front matter, or a block at the top', () => {
    expect(withNoteId('# Title\n\nText\n', 'k7q9m2vbfz4r')).toBe('---\nid: k7q9m2vbfz4r\n---\n# Title\n\nText\n');
    expect(withNoteId('', 'k7q9m2vbfz4r')).toBe('---\nid: k7q9m2vbfz4r\n---\n');
    expect(withNoteId('---\ntype: board\n---\n# B\n', 'k7q9m2vbfz4r')).toBe('---\nid: k7q9m2vbfz4r\ntype: board\n---\n# B\n');
  });

  it('keeps line endings and a byte order mark, and leaves a note with an id alone', () => {
    expect(withNoteId('﻿---\r\ntype: paper\r\n---\r\nBody\r\n', 'k7q9m2vbfz4r')).toBe('﻿---\r\nid: k7q9m2vbfz4r\r\ntype: paper\r\n---\r\nBody\r\n');
    expect(withNoteId('﻿Body\r\n', 'k7q9m2vbfz4r')).toBe('﻿---\r\nid: k7q9m2vbfz4r\r\n---\r\nBody\r\n');
    const has = '---\nid: abcdefghjkmn\n---\nText\n';
    expect(withNoteId(has, 'k7q9m2vbfz4r')).toBe(has);
  });

  it('tells its own ids from ids people wrote', () => {
    expect(isGeneratedNoteId('k7q9m2vbfz4r')).toBe(true);
    expect(isGeneratedNoteId('1k7q9m2vbfz4')).toBe(false);
    expect(isGeneratedNoteId('my-own-id')).toBe(false);
  });
});
