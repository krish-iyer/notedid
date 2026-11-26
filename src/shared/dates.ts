/** A calendar day written as YYYY-MM-DD, in the user's local time zone. */
export type ISODate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

interface DayParts {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
}

function parseDay(value: string): DayParts | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  const valid = probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
  return valid ? { year, month, day } : null;
}

function requireDay(value: string): DayParts {
  const parts = parseDay(value);
  if (!parts) throw new RangeError(`Not a YYYY-MM-DD date: ${value}`);
  return parts;
}

export function isISODate(value: string): boolean {
  return parseDay(value) !== null;
}

/** The calendar day of `at` (default: now) in the device's time zone. */
export function localISODate(at: Date = new Date()): ISODate {
  return [
    String(at.getFullYear()).padStart(4, '0'),
    String(at.getMonth() + 1).padStart(2, '0'),
    String(at.getDate()).padStart(2, '0'),
  ].join('-');
}

/** "14:32" in the device's time zone. */
export function localTime(at: Date = new Date()): string {
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** An ISO timestamp with the device's UTC offset, e.g. "2026-11-25T14:32:00+03:00". */
export function localTimestamp(at: Date = new Date()): string {
  const offset = -at.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${localISODate(at)}T${localTime(at)}:${String(at.getSeconds()).padStart(2, '0')}${sign}${hh}:${mm}`;
}

export function addDays(date: ISODate, days: number): ISODate {
  const { year, month, day } = requireDay(date);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Adds calendar months, keeping the day where possible (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(date: ISODate, months: number): ISODate {
  const { year, month, day } = requireDay(date);
  const first = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(day, lastDay));
  return first.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(date: ISODate): number {
  const { year, month, day } = requireDay(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

const WEEKDAYS: Record<string, number> = {
  su: 0, sun: 0, sunday: 0,
  mo: 1, mon: 1, monday: 1,
  tu: 2, tue: 2, tues: 2, tuesday: 2,
  we: 3, wed: 3, wednesday: 3,
  th: 4, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fr: 5, fri: 5, friday: 5,
  sa: 6, sat: 6, saturday: 6,
};

/**
 * Turns a date word into a date: today, tomorrow, yesterday, a weekday name ("fri", "friday":
 * the next one after today), +3d / +2w / +1m, or a YYYY-MM-DD date. Null if not understood.
 */
export function parseDateWord(word: string, today: ISODate): ISODate | null {
  const w = word.trim().toLowerCase();
  if (isISODate(w)) return w;
  if (w === 'today' || w === 'tod') return today;
  if (w === 'tomorrow' || w === 'tom' || w === 'tmr') return addDays(today, 1);
  if (w === 'yesterday') return addDays(today, -1);
  const relative = /^\+(\d{1,3})([dwm])$/.exec(w);
  if (relative) {
    const n = Number(relative[1]);
    if (relative[2] === 'm') return addMonths(today, n);
    return addDays(today, relative[2] === 'w' ? n * 7 : n);
  }
  const weekday = WEEKDAYS[w];
  if (weekday !== undefined) return addDays(today, (weekday - weekdayOf(today) + 7) % 7 || 7);
  return null;
}

/** Where the journal note for a day lives, relative to the notes folder. */
export function journalPath(date: ISODate): string {
  requireDay(date);
  return `journal/${date}.md`;
}

/** The day of a journal note path, or null for other notes. */
export function journalDateOf(path: string): ISODate | null {
  const match = /^journal\/(\d{4}-\d{2}-\d{2})\.md$/.exec(path);
  return match && isISODate(match[1] ?? '') ? (match[1] ?? null) : null;
}

/** A readable title for a day, e.g. "Wed 25 Nov 2026" (wording depends on the locale). */
export function formatDayTitle(date: ISODate, locale?: string): string {
  const { year, month, day } = requireDay(date);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** A short relative label: "today", "tomorrow", "yesterday", "in 3 days", "2 days ago", or the date. */
export function relativeDayLabel(date: ISODate, today: ISODate): string {
  const diff = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  if (diff > 1 && diff < 7) return `in ${diff} days`;
  if (diff < -1 && diff > -7) return `${-diff} days ago`;
  return date;
}
