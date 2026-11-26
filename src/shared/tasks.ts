import type { ISODate } from './dates.ts';

/** A list item with a checkbox: indent, bullet, then [ ] or [x]. */
export const TASK_LINE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\](?=\s|$)/;

const DUE = /(?:^|\s)due:(\d{4}-\d{2}-\d{2})(?=\s|$)/;
const DONE = /(?:^|\s)done:(\d{4}-\d{2}-\d{2})(?=\s|$)/;

export function parseTaskMeta(text: string): { due: string | null; done: string | null } {
  return { due: DUE.exec(text)?.[1] ?? null, done: DONE.exec(text)?.[1] ?? null };
}

/**
 * Ticks or unticks the task on `line`. Ticking adds `done:<today>`; unticking removes it.
 * Returns null when the line isn't a task. Only this line changes.
 */
export function toggleTaskLine(line: string, today: ISODate): string | null {
  const match = TASK_LINE.exec(line);
  if (!match) return null;
  const prefix = match[1] ?? '';
  const wasDone = match[2] !== ' ';
  const rest = line.slice(prefix.length + 3);
  if (wasDone) return `${prefix}[ ]${rest.replace(/[ \t]+done:\d{4}-\d{2}-\d{2}(?=\s|$)/, '')}`;
  const withoutOldDone = rest.replace(/[ \t]+done:\d{4}-\d{2}-\d{2}(?=\s|$)/, '').replace(/[ \t]+$/, '');
  return `${prefix}[x]${withoutOldDone} done:${today}`;
}

export type DueState = 'overdue' | 'today' | 'upcoming' | 'none';

export function dueState(due: string | null, today: ISODate): DueState {
  if (!due) return 'none';
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  return 'upcoming';
}
