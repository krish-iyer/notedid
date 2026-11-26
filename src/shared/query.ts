import { addDays, isISODate, parseDateWord, type ISODate } from './dates.ts';

/**
 * The search language: words, "phrases" and -exclusions, combined with filters:
 *   tag:x  is:task|open|done  due:today|overdue|week|none|any|<date|>date|date
 *   in:journal|notes|papers|boards|<folder>  after:<date>  before:<date>  has:link|pdf|task|tag
 * Dates accept words such as "tomorrow" or "fri" as well as YYYY-MM-DD.
 */
export interface SearchTerm {
  text: string;
  phrase: boolean;
  negated: boolean;
}

export type DueFilter =
  | { kind: 'overdue' | 'none' | 'any' }
  | { kind: 'on' | 'before' | 'after'; date: ISODate }
  | { kind: 'between'; from: ISODate; to: ISODate };

export interface ParsedQuery {
  terms: SearchTerm[];
  tags: string[];
  notTags: string[];
  is: string[];
  in: string[];
  has: string[];
  due: DueFilter | null;
  after: ISODate | null;
  before: ISODate | null;
  errors: string[];
}

const IS_VALUES = new Set(['task', 'open', 'done', 'journal', 'note', 'paper', 'board', 'pinned']);
const HAS_VALUES = new Set(['link', 'pdf', 'task', 'tag']);

/** Splits a query into tokens, keeping "quoted phrases" and key:"quoted values" together. */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const pattern = /(-?[\w-]+:"[^"]*"?|-?"[^"]*"?|\S+)/g;
  for (const match of input.matchAll(pattern)) tokens.push(match[0]);
  return tokens;
}

function unquote(value: string): { text: string; quoted: boolean } {
  if (value.startsWith('"')) return { text: value.replace(/^"|"$/g, ''), quoted: true };
  return { text: value, quoted: false };
}

function dateValue(value: string, today: ISODate): ISODate | null {
  return isISODate(value) ? value : parseDateWord(value, today);
}

export function parseQuery(input: string, today: ISODate): ParsedQuery {
  const query: ParsedQuery = { terms: [], tags: [], notTags: [], is: [], in: [], has: [], due: null, after: null, before: null, errors: [] };

  for (const token of tokenize(input)) {
    const negated = token.startsWith('-') && token.length > 1;
    const body = negated ? token.slice(1) : token;
    const filter = /^([a-z]+):(.+)$/i.exec(body);
    const key = filter?.[1]?.toLowerCase();
    const rawValue = filter?.[2];

    if (key && rawValue !== undefined && ['tag', 'is', 'in', 'has', 'due', 'after', 'before'].includes(key)) {
      const value = unquote(rawValue).text.trim();
      const lower = value.toLowerCase();
      switch (key) {
        case 'tag':
          (negated ? query.notTags : query.tags).push(lower.replace(/^#/, ''));
          break;
        case 'is':
          if (IS_VALUES.has(lower)) query.is.push(lower);
          else query.errors.push(`Unknown is:${value} (try is:task, is:open, is:done)`);
          break;
        case 'in':
          query.in.push(lower.replace(/\/+$/, ''));
          break;
        case 'has':
          if (HAS_VALUES.has(lower)) query.has.push(lower);
          else query.errors.push(`Unknown has:${value} (try has:link, has:pdf, has:task)`);
          break;
        case 'after':
        case 'before': {
          const date = dateValue(lower, today);
          if (date) query[key] = date;
          else query.errors.push(`Not a date: ${key}:${value}`);
          break;
        }
        case 'due':
          query.due = parseDue(lower, today);
          if (!query.due) query.errors.push(`Not understood: due:${value} (try due:today, due:overdue, due:week, due:<2026-12-01)`);
          break;
      }
      continue;
    }

    if (body.startsWith('#') && body.length > 1 && !/^#\d+$/.test(body)) {
      (negated ? query.notTags : query.tags).push(body.slice(1).toLowerCase());
      continue;
    }

    const { text, quoted } = unquote(body);
    if (text.trim()) query.terms.push({ text: text.trim(), phrase: quoted, negated });
  }
  return query;
}

function parseDue(value: string, today: ISODate): DueFilter | null {
  if (value === 'overdue' || value === 'none' || value === 'any') return { kind: value };
  if (value === 'today') return { kind: 'on', date: today };
  if (value === 'week') return { kind: 'between', from: today, to: addDays(today, 7) };
  const comparison = /^([<>])(.+)$/.exec(value);
  if (comparison) {
    const date = dateValue(comparison[2] ?? '', today);
    return date ? { kind: comparison[1] === '<' ? 'before' : 'after', date } : null;
  }
  const date = dateValue(value, today);
  return date ? { kind: 'on', date } : null;
}

/** Task queries list tasks instead of notes. */
export function isTaskQuery(query: ParsedQuery): boolean {
  return query.is.some((v) => v === 'task' || v === 'open' || v === 'done') || query.due !== null;
}

export function dueMatches(filter: DueFilter, due: string | null, today: ISODate): boolean {
  switch (filter.kind) {
    case 'none':
      return due === null;
    case 'any':
      return due !== null;
    case 'overdue':
      return due !== null && due < today;
    case 'on':
      return due === filter.date;
    case 'before':
      return due !== null && due < filter.date;
    case 'after':
      return due !== null && due > filter.date;
    case 'between':
      return due !== null && due >= filter.from && due <= filter.to;
  }
}
