/**
 * Word-level differences between two texts, for comparing a note with an older version: what was
 * added and what was removed, in reading order. Myers' algorithm on words, spaces and punctuation;
 * very different texts fall back to whole lines.
 */

export interface DiffPart {
  kind: 'same' | 'add' | 'del';
  text: string;
}

type Op = { kind: DiffPart['kind']; token: string };

const WORDS = /\r?\n|[^\S\r\n]+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const LINES = /[^\n]*\n|[^\n]+$/g;

/** The shortest edit script from `a` to `b`, or null if it needs more than `maxEdits` edits. */
function myers(a: string[], b: string[], maxEdits: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d]: the furthest x on each diagonal k (-d-1 … d+1) before step d.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(max, maxEdits); d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0)) ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, d);
    }
  }
  return null;
}

function backtrack(a: string[], b: string[], trace: Int32Array[], edits: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = edits; d >= 0; d--) {
    const before = trace[d] ?? new Int32Array(0);
    const at = (k: number) => before[k + d + 1] ?? 0;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: 'same', token: a[x - 1] ?? '' });
      x--;
      y--;
    }
    if (d === 0) break;
    if (x === prevX) {
      ops.push({ kind: 'add', token: b[y - 1] ?? '' });
      y--;
    } else {
      ops.push({ kind: 'del', token: a[x - 1] ?? '' });
      x--;
    }
  }
  return ops.reverse();
}

function merge(ops: Op[]): DiffPart[] {
  const parts: DiffPart[] = [];
  for (const op of ops) {
    const last = parts[parts.length - 1];
    if (last && last.kind === op.kind) last.text += op.token;
    else parts.push({ kind: op.kind, text: op.token });
  }
  return parts;
}

/**
 * Keeps changes readable: within a change, what was removed comes before what was added, and a
 * space alone between two changes joins them ("the old cat" → "a new dog" is one change, not three).
 */
function tidy(parts: DiffPart[]): DiffPart[] {
  const result: DiffPart[] = [];
  let del = '';
  let add = '';
  const push = (kind: DiffPart['kind'], text: string) => {
    const last = result[result.length - 1];
    if (last && last.kind === kind) last.text += text;
    else if (text) result.push({ kind, text });
  };
  const flush = () => {
    push('del', del);
    push('add', add);
    del = '';
    add = '';
  };
  parts.forEach((part, i) => {
    if (part.kind === 'del') del += part.text;
    else if (part.kind === 'add') add += part.text;
    else if ((del || add) && parts[i + 1] && parts[i + 1]?.kind !== 'same' && /^[^\S\r\n]+$/.test(part.text)) {
      del += part.text;
      add += part.text;
    } else {
      flush();
      push('same', part.text);
    }
  });
  flush();
  return result;
}

function diffTokens(a: string[], b: string[]): DiffPart[] | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const middle = myers(a.slice(start, endA), b.slice(start, endB), 3000);
  if (!middle) return null;
  const ops: Op[] = [...a.slice(0, start).map((token) => ({ kind: 'same' as const, token })), ...middle, ...a.slice(endA).map((token) => ({ kind: 'same' as const, token }))];
  return merge(ops);
}

/** The differences from `before` to `after`. Joining the 'same' and 'add' parts gives `after`. */
export function diffText(before: string, after: string): DiffPart[] {
  if (before === after) return before ? [{ kind: 'same', text: before }] : [];
  const words = diffTokens(before.match(WORDS) ?? [], after.match(WORDS) ?? []);
  if (words) return tidy(words);
  const lines = diffTokens(before.match(LINES) ?? [], after.match(LINES) ?? []);
  if (lines) return tidy(lines);
  return [
    { kind: 'del', text: before },
    { kind: 'add', text: after },
  ].filter((p) => p.text) as DiffPart[];
}

/** How much changed, in words. */
export function diffStats(parts: DiffPart[]): { added: number; removed: number } {
  const count = (kind: DiffPart['kind']) => parts.filter((p) => p.kind === kind).reduce((n, p) => n + (p.text.match(/[\p{L}\p{N}_]+/gu)?.length ?? 0), 0);
  return { added: count('add'), removed: count('del') };
}
