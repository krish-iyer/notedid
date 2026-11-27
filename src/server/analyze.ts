import { parse as parseYaml } from 'yaml';
import type { NoteKind } from '../shared/api.ts';
import { journalDateOf } from '../shared/dates.ts';
import { analyzeBody, type BodyAnalysis, excerptOf, lineIndex, splitFrontmatter } from '../shared/markdown.ts';
import { noteIdOf } from '../shared/noteIds.ts';

export interface NoteAnalysis extends BodyAnalysis {
  /** Its permanent id (front matter `id`), or null. */
  id: string | null;
  title: string;
  kind: NoteKind;
  /** Journal notes: their day. */
  date: string | null;
  frontmatter: Record<string, unknown>;
  /** Tags from front matter only (the note-level tags). */
  metaTags: string[];
  excerpt: string;
  /** Alternative names from front matter `aliases`. */
  aliases: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A front matter value as a list of strings: `[a, b]`, `a, b` or `a`. */
export function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' || typeof v === 'number').map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean);
  return [];
}

export function readFrontmatter(content: string): { data: Record<string, unknown>; bodyOffset: number } {
  const { raw, bodyOffset } = splitFrontmatter(content);
  if (!raw) return { data: {}, bodyOffset };
  try {
    const parsed: unknown = parseYaml(raw);
    return { data: isPlainObject(parsed) ? parsed : {}, bodyOffset };
  } catch {
    return { data: {}, bodyOffset };
  }
}

export function stemOf(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.(md|excalidraw)$/i, '');
}

export function analyzeNote(path: string, content: string): NoteAnalysis {
  const { data: frontmatter, bodyOffset } = readFrontmatter(content);
  const body = content.slice(bodyOffset);
  const analysis = analyzeBody(body, bodyOffset, lineIndex(content));
  const date = journalDateOf(path);
  const fmTitle = typeof frontmatter.title === 'string' && frontmatter.title.trim() ? frontmatter.title.trim() : null;
  const title = fmTitle ?? analysis.firstH1 ?? stemOf(path);
  const type = typeof frontmatter.type === 'string' ? frontmatter.type.toLowerCase() : '';
  const kind: NoteKind = date ? 'journal' : type === 'paper' || type === 'board' || type === 'dashboard' || type === 'comments' || type === 'whiteboard' ? type : 'note';
  const metaTags = [...stringList(frontmatter.tags), ...stringList(frontmatter.tag)].map((t) => t.replace(/^#/, '').toLowerCase());
  const tags = [...new Set([...analysis.tags, ...metaTags])];
  return {
    ...analysis,
    // A whiteboard's text has no tasks: ticking one would mean editing the drawing by its lines.
    tasks: kind === 'whiteboard' ? [] : analysis.tasks,
    tags,
    metaTags: [...new Set(metaTags)],
    id: noteIdOf(content),
    title,
    kind,
    date,
    frontmatter,
    excerpt: excerptOf(body, analysis.firstH1),
    aliases: stringList(frontmatter.aliases),
  };
}
