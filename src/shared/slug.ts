/** A file-name-safe slug of a title: "Meeting with Ana (draft)" → "meeting-with-ana-draft". Keeps non-Latin letters. */
export function slugify(title: string, maxLength = 80): string {
  const slug = title
    .normalize('NFC')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/, '');
  return slug || 'untitled';
}

/** A tag from whatever was typed: "#Project X", "[[project x]]" → "project-x". Keeps / for nested tags. */
export function tagify(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/\[\[|\]\]|["'#]/g, '')
    .trim()
    .replace(/[^\p{L}\p{N}_/-]+/gu, '-')
    .replace(/^[-/]+|[-/]+$/g, '');
}

/** `base`, or `base-2`, `base-3`, … whichever `exists` says is free. */
export function uniqueName(base: string, exists: (candidate: string) => boolean): string {
  if (!exists(base)) return base;
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base}-${n}`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`No free name for ${base}`);
}
