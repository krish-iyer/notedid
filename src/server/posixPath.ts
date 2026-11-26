/**
 * The few path functions the notes logic needs, for forward-slash paths relative to the notes
 * folder. They behave like Node's `path.posix` for such paths, without needing Node, so the same
 * code runs in a browser.
 */

/** Resolves `.` and `..` and repeated slashes: "a/./b/../c" → "a/c", "" → ".". */
export function normalize(path: string): string {
  const absolute = path.startsWith('/');
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop();
    else if (part === '..' && absolute) continue;
    else out.push(part);
  }
  const joined = out.join('/');
  if (absolute) return `/${joined}`;
  return joined || '.';
}

export function join(...parts: string[]): string {
  return normalize(parts.filter(Boolean).join('/'));
}

/** The folder part: "notes/a.md" → "notes", "a.md" → ".". */
export function dirname(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const at = trimmed.lastIndexOf('/');
  if (at < 0) return '.';
  if (at === 0) return '/';
  return trimmed.slice(0, at);
}

/** The last part, without `ext` if it ends with it: ("files/a.pdf", ".pdf") → "a". */
export function basename(path: string, ext?: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return ext && base !== ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
}

/** The extension with its dot: "a.tar.gz" → ".gz", ".hidden" → "", "a." → ".". */
export function extname(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf('.');
  return dot <= 0 || base === '..' ? '' : base.slice(dot);
}

/** The path from folder `from` to `to`, both relative to the same root: ("notes", "papers/x.md") → "../papers/x.md". */
export function relative(from: string, to: string): string {
  const a = normalize(from).split('/').filter((p) => p !== '.');
  const b = normalize(to).split('/').filter((p) => p !== '.');
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  return [...a.slice(common).map(() => '..'), ...b.slice(common)].join('/');
}
