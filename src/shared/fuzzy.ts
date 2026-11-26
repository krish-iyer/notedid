export interface FuzzyMatch {
  score: number;
  /** Positions in the text that matched, for highlighting. */
  indices: number[];
}

function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1] ?? '';
  return /[\s\-_/.([]/.test(prev);
}

/**
 * Matches `query` against `text`, case-insensitively: a substring scores best (more so at the
 * start or at a word start), otherwise the query's characters in order. Null if no match.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const t = text.toLowerCase();

  const at = t.indexOf(q);
  if (at >= 0) {
    const indices = Array.from({ length: q.length }, (_, i) => at + i);
    const score = 1000 + (at === 0 ? 300 : 0) + (isWordStart(t, at) ? 150 : 0) - at - (t.length - q.length) * 0.5;
    return { score, indices };
  }

  const indices: number[] = [];
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    // Prefer the next occurrence at a word start, else the next occurrence at all.
    let found = -1;
    for (let i = from; i < t.length; i++) {
      if (t[i] === ch && isWordStart(t, i)) {
        found = i;
        break;
      }
    }
    if (found < 0 || (previous >= 0 && found !== previous + 1 && t.indexOf(ch, from) === previous + 1)) found = t.indexOf(ch, from);
    if (found < 0) return null;
    indices.push(found);
    score += 10 + (found === previous + 1 ? 15 : 0) + (isWordStart(t, found) ? 12 : 0);
    previous = found;
    from = found + 1;
  }
  return { score: score - (t.length - indices.length) * 0.5, indices };
}

/** Ranks items by fuzzy match of `query` against `key(item)`, best first. */
export function fuzzyFilter<T>(items: readonly T[], query: string, key: (item: T) => string, limit = 50): { item: T; match: FuzzyMatch }[] {
  const results: { item: T; match: FuzzyMatch }[] = [];
  for (const item of items) {
    const match = fuzzyMatch(query, key(item));
    if (match) results.push({ item, match });
  }
  results.sort((a, b) => b.match.score - a.match.score);
  return results.slice(0, limit);
}
