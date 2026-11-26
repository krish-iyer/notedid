import { frontmatterLines } from './frontmatter.ts';

/**
 * Cards: a heading with `key:: value` lines right under it.
 *
 *     ### A1 · Missing baseline
 *     status:: needs answer
 *     theme:: Evaluation, Clarity
 *     paper:: [§5.2](paper.pdf#page=7)
 *
 *     Everything below, up to the next heading of the same or a higher level, is the card's text.
 *
 * Cards one after another at the same level make a set. The editor shows each card as a card and
 * puts counts and filters above each set. The file stays plain markdown: other apps show a heading
 * and a few lines. Commas separate values (`theme:: Evaluation, Clarity`) unless the value is a
 * sentence.
 */

/** `key:: value`. A space must follow the "::", so `std::vector` stays ordinary text. */
const PROPERTY = /^([\p{L}_][\p{L}\p{N}_-]*)::(?:[ \t]+(.*?))?[ \t]*$/u;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export interface Heading {
  /** 0-based line. */
  line: number;
  level: number;
  title: string;
}

/** The lines outside fenced code blocks (and fence lines themselves), from line `start`. */
function* outsideCode(lines: readonly string[], start = 0): Generator<[number, string]> {
  let fence: string | null = null;
  for (let i = start; i < lines.length; i++) {
    const text = lines[i] ?? '';
    const marker = FENCE.exec(text)?.[1];
    if (fence !== null) {
      const closes = marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length && !text.slice(text.indexOf(marker) + marker.length).trim();
      if (closes) fence = null;
    } else if (marker) {
      fence = marker;
    } else {
      yield [i, text];
    }
  }
}

/** The note's `#` headings, leaving out code blocks and the front matter. */
export function headingsIn(lines: readonly string[]): Heading[] {
  const headings: Heading[] = [];
  const front = frontmatterLines(lines);
  for (const [i, text] of outsideCode(lines, front ? front.close + 1 : 0)) {
    const heading = HEADING.exec(text);
    if (heading) headings.push({ line: i, level: heading[1]?.length ?? 1, title: (heading[2] ?? '').trim() });
  }
  return headings;
}

const TASK_WITH_TEXT = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\][ \t]+\S/;

/** The lines with a task (`- [ ] something`), outside code: the order their checkboxes show in. */
export function taskLinesIn(lines: readonly string[]): number[] {
  const found: number[] = [];
  for (const [i, text] of outsideCode(lines)) if (TASK_WITH_TEXT.test(text)) found.push(i);
  return found;
}

export interface CardProperty {
  /** As written. */
  key: string;
  /** Everything after "key::", trimmed. */
  value: string;
  /** 0-based line. */
  line: number;
}

export interface Card {
  level: number;
  /** The heading's text, without the #s. */
  title: string;
  /** 0-based lines: the heading, the card's last line with text, and its last line before whatever comes next. */
  start: number;
  end: number;
  last: number;
  properties: CardProperty[];
}

export interface CardSet {
  level: number;
  /** The heading of the section the set is in ("Review points"), if there is one. */
  parent: string | null;
  cards: Card[];
}

/** A `key:: value` line's key and value, or null for any other line. */
export function propertyLine(text: string): { key: string; value: string } | null {
  const match = PROPERTY.exec(text);
  return match ? { key: match[1] ?? '', value: (match[2] ?? '').trim() } : null;
}

/**
 * Every card in the note, in sets. A heading is a card when property lines follow it directly.
 * Headings inside a card (a deeper level) are part of its text, even ones with properties.
 * `# Title` headings never are cards: properties under the note's title describe the note.
 */
export function findCards(lines: readonly string[]): CardSet[] {
  const headings = headingsIn(lines);
  const sets: CardSet[] = [];
  let covered = -1;
  headings.forEach((heading, k) => {
    if (heading.line <= covered || heading.level < 2) return;
    const properties: CardProperty[] = [];
    for (let i = heading.line + 1; i < lines.length; i++) {
      const property = propertyLine(lines[i] ?? '');
      if (!property) break;
      properties.push({ ...property, line: i });
    }
    if (properties.length === 0) return;
    let next = lines.length;
    for (let j = k + 1; j < headings.length; j++) {
      const later = headings[j];
      if (later && later.level <= heading.level) {
        next = later.line;
        break;
      }
    }
    let end = next - 1;
    while (end > heading.line && !(lines[end] ?? '').trim()) end--;
    const card: Card = { level: heading.level, title: heading.title, start: heading.line, end, last: next - 1, properties };
    covered = card.last;
    const set = sets.at(-1);
    const previous = set?.cards.at(-1);
    if (set && previous && previous.level === card.level && previous.last + 1 === card.start) {
      set.cards.push(card);
    } else {
      let parent: string | null = null;
      for (let j = k - 1; j >= 0; j--) {
        const above = headings[j];
        if (above && above.level < heading.level) {
          parent = above.title;
          break;
        }
      }
      sets.push({ level: card.level, parent, cards: [card] });
    }
  });
  return sets;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export interface ValuePart {
  text: string;
  /** Where the text is: offsets in the string that was split. */
  from: number;
  to: number;
}

const isShort = (text: string) => text.length <= 32 && text.split(/\s+/).length <= 4;
const LINK = /^(?:\[[^\]]*\]\([^)]*\)|\[\[[^\]]+\]\]|<?https?:\/\/\S+?>?)$/i;

/** Splits at commas outside links, brackets and `code`. */
function splitAtCommas(value: string): ValuePart[] {
  const parts: ValuePart[] = [];
  let depth = 0;
  let code = false;
  let start = 0;
  const push = (end: number) => {
    const raw = value.slice(start, end);
    const text = raw.trim();
    const from = start + raw.length - raw.trimStart().length;
    if (text) parts.push({ text, from, to: from + text.length });
  };
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '`') code = !code;
    else if (code) continue;
    else if (ch === '[' || ch === '(') depth++;
    else if ((ch === ']' || ch === ')') && depth > 0) depth--;
    else if (ch === ',' && depth === 0) {
      push(i);
      start = i + 1;
    }
  }
  push(value.length);
  return parts;
}

/**
 * A property's values. Commas separate them when every part is a link or a few words
 * (`Evaluation, Clarity`); a sentence with a comma in it stays one value.
 */
export function valueParts(value: string): ValuePart[] {
  const parts = splitAtCommas(value);
  if (parts.length > 1 && parts.every((p) => LINK.test(p.text) || isShort(p.text))) return parts;
  const text = value.trim();
  const from = value.length - value.trimStart().length;
  return text ? [{ text, from, to: from + text.length }] : [];
}

export function propertyValues(value: string): string[] {
  return valueParts(value).map((p) => p.text);
}

export type ValueKind = 'link' | 'word' | 'text';

/** How a value shows: as a link, as a coloured word you can filter by, or as plain text (a sentence). */
export function valueKind(value: string): ValueKind {
  if (LINK.test(value)) return 'link';
  return isShort(value) ? 'word' : 'text';
}

/** A value as compared: case and spacing don't matter. */
export function valueId(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** A property line's key and values, with where each value is on the line. */
export function propertyParts(line: string): { key: string; parts: ValuePart[] } | null {
  const match = PROPERTY.exec(line);
  if (!match) return null;
  const key = match[1] ?? '';
  const valueFrom = key.length + 2;
  const parts = valueParts(line.slice(valueFrom)).map((p) => ({ text: p.text, from: p.from + valueFrom, to: p.to + valueFrom }));
  return { key, parts };
}

/**
 * The property line with value number `index` changed to `next`, or removed when `next` is null
 * or empty. An index past the end adds a value. Everything else on the line stays as written.
 */
export function setPropertyValue(line: string, index: number, next: string | null): string | null {
  const property = propertyParts(line);
  if (!property) return null;
  const text = (next ?? '').replace(/\s+/g, ' ').trim();
  const { key, parts } = property;
  const part = parts[index];
  if (!part) {
    if (!text) return line;
    return parts.length ? `${line.trimEnd()}, ${text}` : `${key}:: ${text}`;
  }
  if (text) return line.slice(0, part.from) + text + line.slice(part.to);
  if (parts.length === 1) return `${key}:: `;
  const before = parts[index - 1];
  if (before) return line.slice(0, before.to) + line.slice(part.to);
  const after = parts[index + 1];
  return after ? line.slice(0, part.from) + line.slice(after.from) : `${key}:: `;
}

/** A new card: its heading and property lines (`key:: ` for an empty value, ready to type in). */
export function newCardLines(level: number, title: string, properties: readonly (readonly [string, string])[]): string[] {
  return [`${'#'.repeat(Math.min(6, Math.max(2, level)))} ${title}`, ...properties.map(([key, value]) => `${key}:: ${value}`)];
}

// ---------------------------------------------------------------------------
// Counts and filters
// ---------------------------------------------------------------------------

export interface FacetValue {
  /** As first written. */
  value: string;
  id: string;
  /** Cards with this value. */
  count: number;
}

export interface Facet {
  /** As first written. */
  key: string;
  /** Lower case. */
  id: string;
  values: FacetValue[];
}

/**
 * The properties a set can be filtered by, with how many cards have each value. Only properties
 * whose values are words (not sentences or links), with at most 12 different values, at least one
 * of them shared by two cards (unless the set is small).
 */
export function cardFacets(cards: readonly Pick<Card, 'properties'>[]): Facet[] {
  const facets = new Map<string, Facet & { usable: boolean }>();
  for (const card of cards) {
    const counted = new Set<string>();
    for (const property of card.properties) {
      const id = property.key.toLowerCase();
      let facet = facets.get(id);
      if (!facet) {
        facet = { key: property.key, id, values: [], usable: true };
        facets.set(id, facet);
      }
      for (const value of propertyValues(property.value)) {
        if (valueKind(value) !== 'word') {
          facet.usable = false;
          continue;
        }
        const valueKey = valueId(value);
        if (counted.has(`${id}\n${valueKey}`)) continue;
        counted.add(`${id}\n${valueKey}`);
        const known = facet.values.find((v) => v.id === valueKey);
        if (known) known.count++;
        else facet.values.push({ value, id: valueKey, count: 1 });
      }
    }
  }
  return [...facets.values()]
    .filter((f) => f.usable && f.values.length > 0 && f.values.length <= 12 && (cards.length <= 4 || f.values.some((v) => v.count > 1)))
    .map(({ key, id, values }) => ({ key, id, values }));
}

/** The values of property `id` (lower case) on a card, as ids. */
export function cardValueIds(card: Pick<Card, 'properties'>, id: string): string[] {
  return card.properties.filter((p) => p.key.toLowerCase() === id).flatMap((p) => propertyValues(p.value).map(valueId));
}

export interface CardFilter {
  /** Property id → the value ids wanted. A card needs one of them, for every property listed. */
  values: Readonly<Record<string, readonly string[]>>;
  /** Words that must all be somewhere in the card. */
  search: string;
}

export const NO_FILTER: CardFilter = { values: {}, search: '' };

export function isFiltering(filter: CardFilter): boolean {
  return filter.search.trim() !== '' || Object.values(filter.values).some((v) => v.length > 0);
}

/** Whether a card passes the filter; `text` is the card's markdown, for the search words. */
export function cardMatches(card: Pick<Card, 'properties'>, text: string, filter: CardFilter): boolean {
  for (const [id, wanted] of Object.entries(filter.values)) {
    if (wanted.length === 0) continue;
    const has = new Set(cardValueIds(card, id));
    if (!wanted.some((w) => has.has(w))) return false;
  }
  const haystack = text.toLowerCase();
  return filter.search
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/** The property that sums a set up in colour: `status` (or state, stage, progress), when the cards have one. */
export function statusFacet(facets: readonly Facet[]): Facet | null {
  for (const id of ['status', 'state', 'stage', 'progress']) {
    const facet = facets.find((f) => f.id === id);
    if (facet) return facet;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

export type Tone = 'done' | 'active' | 'open' | 'problem' | 'c0' | 'c1' | 'c2' | 'c3' | 'c4' | 'c5';

const TONE_WORDS: Record<'done' | 'active' | 'open' | 'problem', string[]> = {
  done: ['done', 'resolved', 'fixed', 'answered', 'addressed', 'accepted', 'accept', 'agreed', 'agree', 'complete', 'completed', 'closed', 'yes', 'read', 'merged', 'ok', 'finished', 'approved', 'passed', 'pass', 'strong accept'],
  active: ['in progress', 'doing', 'planned', 'plan', 'reading', 'started', 'wip', 'draft', 'drafted', 'writing', 'ongoing', 'partial', 'partly', 'partially addressed', 'review', 'in review'],
  open: ['needs answer', 'todo', 'to do', 'open', 'pending', 'to read', 'waiting', 'question', 'maybe', 'minor', 'unclear', 'new', 'weak accept', 'borderline', 'later', 'someday'],
  problem: ['disagree', 'blocked', 'rejected', 'reject', 'wontfix', 'wont fix', "won't fix", 'no', 'major', 'critical', 'bug', 'urgent', 'failed', 'fail', 'strong reject', 'weak reject', 'overdue'],
};

const KNOWN_TONES = new Map<string, Tone>(Object.entries(TONE_WORDS).flatMap(([tone, words]) => words.map((w): [string, Tone] => [w, tone as Tone])));

/**
 * A colour for a value: green for done, blue for in progress, amber for open, red for problems.
 * Any other value gets one of six colours picked from its text, so it is the same everywhere.
 */
export function toneOf(value: string): Tone {
  const word = value.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const known = KNOWN_TONES.get(word);
  if (known) return known;
  if (/^needs? /.test(word)) return 'open';
  let hash = 7;
  for (const ch of word) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return `c${hash % 6}` as Tone;
}
