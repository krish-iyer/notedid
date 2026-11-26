import { matchTokens } from './diff.ts';

/**
 * Combines two edits of the same text, line by line (a three-way merge, like diff3): changes made
 * in different places are both taken, and a change made on both sides is taken once. Lines added at
 * the same place on both sides are all kept, `ours` first, as two devices adding to the end of a
 * note is common. Where both changed the same lines differently the merge isn't clean, and the
 * text has `ours` there.
 */

export interface MergeResult {
  text: string;
  clean: boolean;
}

const LINES = /[^\n]*\n|[^\n]+$/g;

export function merge3(base: string, ours: string, theirs: string): MergeResult {
  if (ours === theirs || theirs === base) return { text: ours, clean: true };
  if (ours === base) return { text: theirs, clean: true };
  // Compare whole lines: a last line without a line break is the same line as one with it.
  const lines = (text: string) => (text.endsWith('\n') || text === '' ? text : `${text}\n`).match(LINES) ?? [];
  const b = lines(base);
  const o = lines(ours);
  const t = lines(theirs);
  const toOurs = matchTokens(b, o);
  const toTheirs = matchTokens(b, t);
  if (!toOurs || !toTheirs) return { text: ours, clean: false };

  const out: string[] = [];
  let clean = true;
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < b.length || j < o.length || k < t.length) {
    if (i < b.length && toOurs[i] === j && toTheirs[i] === k) {
      out.push(b[i] ?? '');
      i++;
      j++;
      k++;
      continue;
    }
    // The changed stretch ends at the next base line both sides kept.
    let next = i;
    while (next < b.length && ((toOurs[next] ?? -1) < j || (toTheirs[next] ?? -1) < k)) next++;
    const jEnd = next < b.length ? (toOurs[next] ?? o.length) : o.length;
    const kEnd = next < b.length ? (toTheirs[next] ?? t.length) : t.length;
    const was = b.slice(i, next).join('');
    const mine = o.slice(j, jEnd).join('');
    const other = t.slice(k, kEnd).join('');
    if (mine === was) out.push(other);
    else if (other === was || mine === other) out.push(mine);
    else if (was === '') out.push(mine, other);
    else {
      out.push(mine);
      clean = false;
    }
    i = next;
    j = jEnd;
    k = kEnd;
  }
  let text = out.join('');
  // A line break at the very end only if one of the two had it.
  if (text.endsWith('\n') && !ours.endsWith('\n') && !theirs.endsWith('\n')) text = text.slice(0, -1);
  return { text, clean };
}
