/** Where you are with a paper. Stored as `status:` in the review note's front matter. */
export type PaperStatus = 'to-read' | 'reading' | 'read';

export const PAPER_STATUSES: readonly { value: PaperStatus; label: string }[] = [
  { value: 'to-read', label: 'To read' },
  { value: 'reading', label: 'Reading' },
  { value: 'read', label: 'Read' },
];

/** A missing or unknown status counts as "to read". */
export function paperStatusOf(value: unknown): PaperStatus {
  const v = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  if (v === 'reading') return 'reading';
  if (v === 'read' || v === 'done' || v === 'finished') return 'read';
  return 'to-read';
}
