/** Small browser-side helpers. */

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** Joins and normalises a relative path ("../notes/a.md" from "journal") → "notes/a.md". */
export function joinPath(dir: string, rel: string): string {
  const parts: string[] = [];
  for (const segment of `${dir}/${rel}`.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

/** The relative path from folder `fromDir` to `to`: ("journal", "files/2026/a.png") → "../files/2026/a.png". */
export function relativePath(fromDir: string, to: string): string {
  const from = fromDir ? fromDir.split('/') : [];
  const target = to.split('/');
  let common = 0;
  while (common < from.length && common < target.length - 1 && from[common] === target[common]) common++;
  return [...from.slice(common).map(() => '..'), ...target.slice(common)].join('/');
}

/** Text made safe inside HTML: as element text or in a quoted attribute. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

export function randomId(bytes = 8): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "12 Nov". */
export function timeAgo(ms: number, now = Date.now()): string {
  const seconds = Math.round((now - ms) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 2 * 86_400) return 'yesterday';
  const date = new Date(ms);
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: date.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' });
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Splits text with \u0001…\u0002 markers into plain and highlighted parts. */
export function splitHighlights(text: string): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = [];
  const pattern = /\u0001([\s\S]*?)\u0002/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if ((match.index ?? 0) > last) parts.push({ text: text.slice(last, match.index), hit: false });
    parts.push({ text: match[1] ?? '', hit: true });
    last = (match.index ?? 0) + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false });
  return parts;
}
