/**
 * Small, exact edits to a note's YAML front matter (the `---` block at the top). Only the line for
 * the field changes; everything else keeps its bytes: line endings, quoting, comments, key order.
 */

const OPEN = /^\uFEFF?---[ \t]*$/;
const CLOSE = /^(---|\.\.\.)[ \t]*$/;

/** 0-based lines of the front matter's opening and closing markers, or null if there is none. */
export function frontmatterLines(lines: readonly string[]): { open: number; close: number } | null {
  if (!OPEN.test(lines[0] ?? '')) return null;
  for (let i = 1; i < lines.length; i++) if (CLOSE.test(lines[i] ?? '')) return { open: 0, close: i };
  return null;
}

export function isFrontmatterOpen(line: string): boolean {
  return OPEN.test(line);
}

export function isFrontmatterClose(line: string): boolean {
  return CLOSE.test(line);
}

function keyLine(key: string): RegExp {
  return new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*:(.*)$`);
}

/** A line that continues the value above it: indented, or a `- item` of a list. */
const CONTINUATION = /^([ \t]|-([ \t]|$))/;

function unquote(value: string): string {
  const v = value.trim();
  if (/^".*"$/.test(v)) {
    try {
      return String(JSON.parse(v));
    } catch {
      return v.slice(1, -1);
    }
  }
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  return v.replace(/\s+#.*$/, '');
}

/** Plain words stay plain; anything YAML could read differently is double-quoted. */
function yamlScalar(value: string): string {
  const plain = /^[\p{L}\p{N}_][\p{L}\p{N}_ .-]*$/u.test(value) && !/\s$/.test(value);
  const special = /^(true|false|yes|no|on|off|null|~|[-+]?[\d.]+(e[-+]?\d+)?)$/i.test(value);
  return plain && !special ? value : JSON.stringify(value);
}

/** A top-level scalar field, e.g. `status`. Null if the note has no such field. */
export function frontmatterField(content: string, key: string): string | null {
  const lines = content.split(/\r?\n/);
  const fm = frontmatterLines(lines);
  if (!fm) return null;
  const pattern = keyLine(key);
  for (let i = fm.open + 1; i < fm.close; i++) {
    const match = pattern.exec(lines[i] ?? '');
    if (match) return unquote(match[1] ?? '') || null;
  }
  return null;
}

/**
 * Sets a top-level field to a plain value or a list, or removes it when `value` is null (or an
 * empty list). A note without front matter gets a block at the top.
 */
export function setFrontmatterField(content: string, key: string, value: string | number | readonly string[] | null): string {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const empty = value === null || (Array.isArray(value) && value.length === 0);
  const line = empty ? null : typeof value === 'number' ? `${key}: ${value}` : typeof value === 'string' ? `${key}: ${yamlScalar(value)}` : [`${key}:`, ...(value as readonly string[]).map((v) => `  - ${yamlScalar(v)}`)].join(newline);
  const fm = frontmatterLines(lines);
  if (!fm) {
    if (line === null) return content;
    const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
    return `${bom}---${newline}${line}${newline}---${newline}${content.slice(bom.length)}`;
  }
  const pattern = keyLine(key);
  for (let i = fm.open + 1; i < fm.close; i++) {
    if (!pattern.test(lines[i] ?? '')) continue;
    let end = i + 1;
    while (end < fm.close && CONTINUATION.test(lines[end] ?? '')) end++;
    lines.splice(i, end - i, ...(line === null ? [] : [line]));
    return lines.join(newline);
  }
  if (line === null) return content;
  lines.splice(fm.close, 0, line);
  return lines.join(newline);
}
