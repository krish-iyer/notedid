import { Fragment } from 'react';
import { splitHighlights } from '../util.ts';

/** Text with search hits (marked \u0001…\u0002) highlighted. */
export function Snippet({ text }: { text: string }) {
  return (
    <>
      {splitHighlights(text).map((part, i) => (part.hit ? <mark key={i}>{part.text}</mark> : <Fragment key={i}>{part.text}</Fragment>))}
    </>
  );
}

/** Text with the characters at `indices` highlighted (fuzzy matches). */
export function Matched({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return <>{text}</>;
  const set = new Set(indices);
  const parts: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    const last = parts[parts.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else parts.push({ text: text[i] ?? '', hit });
  }
  return (
    <>
      {parts.map((p, i) => (p.hit ? <b key={i}>{p.text}</b> : <Fragment key={i}>{p.text}</Fragment>))}
    </>
  );
}
