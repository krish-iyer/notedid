import { frontmatterField, frontmatterLines } from './frontmatter.ts';

/**
 * Every note carries a permanent random id in its front matter: `id: k7q9m2vbfz4r`. Paths and titles
 * change; the id doesn't, so it identifies a note through renames, moves and syncing between
 * devices, whatever the note is called or wherever it is.
 *
 * An id is twelve characters: a letter, then letters and digits without i, l, o and u (easy to
 * read aloud and never taken by YAML for a number, a date or yes/no). New notes get one when they
 * are made; older notes get one when you ask (Ctrl+K, "Give every note an ID"), never behind your back.
 */

const FIRST = 'abcdefghjkmnpqrstvwxyz';
const REST = '0123456789abcdefghjkmnpqrstvwxyz';

/** A new random id. */
export function newNoteId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(12));
  let id = '';
  bytes.forEach((byte, i) => {
    id += i === 0 ? FIRST[byte % FIRST.length] : REST[byte % REST.length];
  });
  return id;
}

/** Whether `value` looks like an id this app makes. Ids people wrote themselves are kept as they are. */
export function isGeneratedNoteId(value: string): boolean {
  return /^[a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z]{11}$/.test(value);
}

/** The note's id (front matter `id`), or null if it has none. */
export function noteIdOf(content: string): string | null {
  return frontmatterField(content, 'id');
}

/**
 * The note with an id: `id: <id>` as the first line of its front matter, or in a new front matter
 * block at the top. A note that has an id already is returned as it is. Line endings and a byte
 * order mark are kept.
 */
export function withNoteId(content: string, id: string): string {
  if (noteIdOf(content) !== null) return content;
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  if (frontmatterLines(lines)) {
    lines.splice(1, 0, `id: ${id}`);
    return lines.join(newline);
  }
  const bom = content.startsWith('﻿') ? '﻿' : '';
  return `${bom}---${newline}id: ${id}${newline}---${newline}${content.slice(bom.length)}`;
}
