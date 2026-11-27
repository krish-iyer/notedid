import type { SyntaxNode } from '@lezer/common';
import { tags } from '@lezer/highlight';
import { GFM, type MarkdownConfig, parser as commonmarkParser } from '@lezer/markdown';
import { isISODate } from './dates.ts';
import { parseTaskMeta } from './tasks.ts';

// ---------------------------------------------------------------------------
// Parser extensions, shared by the editor and the indexer so both agree on
// what is a link, a tag or a task, down to the character.
// ---------------------------------------------------------------------------

const OPEN_BRACKET = 91; // [
const CLOSE_BRACKET = 93; // ]
const HASH = 35; // #
const NEWLINE = 10;
const SLASH = 47;
const DASH = 45;

/** [[Target]], [[Target|label]], [[Target#Heading]], [[file.pdf#page=4|p. 4]] */
export const WikiLinkExtension: MarkdownConfig = {
  defineNodes: [
    { name: 'WikiLink', style: tags.link },
    { name: 'WikiLinkMark', style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: 'WikiLink',
      before: 'Link',
      parse(cx, next, pos) {
        if (next !== OPEN_BRACKET || cx.char(pos + 1) !== OPEN_BRACKET) return -1;
        const end = cx.offset + cx.text.length;
        for (let i = pos + 2; i < end; i++) {
          const ch = cx.char(i);
          if (ch === NEWLINE || ch === OPEN_BRACKET) return -1;
          if (ch === CLOSE_BRACKET) {
            if (cx.char(i + 1) !== CLOSE_BRACKET || i === pos + 2) return -1;
            return cx.addElement(
              cx.elt('WikiLink', pos, i + 2, [cx.elt('WikiLinkMark', pos, pos + 2), cx.elt('WikiLinkMark', i, i + 2)]),
            );
          }
        }
        return -1;
      },
    },
  ],
};

const TAG_CHAR = /[\p{L}\p{N}_\-/]/u;
const BEFORE_TAG = /[\s([{,;:!?"'*~>]/u;

/** #tag and #nested/tag, but not #123, a#b or &#39;. */
export const TagExtension: MarkdownConfig = {
  defineNodes: [{ name: 'Tag', style: tags.labelName }],
  parseInline: [
    {
      name: 'Tag',
      parse(cx, next, pos) {
        if (next !== HASH) return -1;
        if (pos > cx.offset && !BEFORE_TAG.test(String.fromCharCode(cx.char(pos - 1)))) return -1;
        const limit = cx.offset + cx.text.length;
        let end = pos + 1;
        while (end < limit && TAG_CHAR.test(String.fromCharCode(cx.char(end)))) end++;
        while (end > pos + 1 && (cx.char(end - 1) === SLASH || cx.char(end - 1) === DASH)) end--;
        if (end === pos + 1 || /^[\d/_-]+$/.test(cx.slice(pos + 1, end))) return -1;
        return cx.addElement(cx.elt('Tag', pos, end));
      },
    },
  ],
};

const OPENING_FENCE = /^---\s*$/;
const CLOSING_FENCE = /^(---|\.\.\.)\s*$/;

/**
 * YAML front matter at the very start of a note. Editor only (styling): the indexer splits
 * front matter off with a strict pattern instead, because a block parser can't look ahead to
 * check that the closing fence exists.
 */
export const FrontmatterExtension: MarkdownConfig = {
  defineNodes: [{ name: 'Frontmatter', block: true, style: tags.meta }],
  parseBlock: [
    {
      name: 'Frontmatter',
      before: 'HorizontalRule',
      parse(cx, line) {
        if (cx.lineStart !== 0 || !OPENING_FENCE.test(line.text)) return false;
        let end = line.text.length;
        while (cx.nextLine()) {
          end = cx.lineStart + line.text.length;
          if (CLOSING_FENCE.test(line.text)) {
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt('Frontmatter', 0, end));
        return true;
      },
    },
  ],
};

/** Extensions for the editor (CodeMirror's markdown language already includes GFM). */
export const editorMarkdownExtensions = [FrontmatterExtension, WikiLinkExtension, TagExtension];

/** Parser for a note body (front matter already removed). */
export const bodyParser = commonmarkParser.configure([GFM, WikiLinkExtension, TagExtension]);

// ---------------------------------------------------------------------------
// Front matter
// ---------------------------------------------------------------------------

const FRONTMATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/** Splits off a closed YAML front matter block. `raw` is the YAML text, `bodyOffset` where the body starts. */
export function splitFrontmatter(content: string): { raw: string | null; bodyOffset: number } {
  const match = FRONTMATTER.exec(content);
  if (!match) return { raw: null, bodyOffset: 0 };
  return { raw: match[1] ?? '', bodyOffset: match[0].length };
}

// ---------------------------------------------------------------------------
// Note analysis: everything the index needs, with 1-based line numbers.
// ---------------------------------------------------------------------------

export type LinkKind = 'wiki' | 'md' | 'url' | 'date';

export interface LinkRef {
  kind: LinkKind;
  /** Note title, path or URL as written (no |label, no #heading). For dates: the date. */
  target: string;
  heading: string | null;
  label: string | null;
  line: number;
  from: number;
  to: number;
}

export interface TaskRef {
  line: number;
  /** Task text after the checkbox. */
  text: string;
  /** The whole line, exactly as in the file. */
  raw: string;
  done: boolean;
  due: string | null;
  doneDate: string | null;
}

export interface HeadingRef {
  level: number;
  text: string;
  line: number;
}

export interface BodyAnalysis {
  links: LinkRef[];
  /** Lowercase, without '#'. */
  tags: string[];
  tasks: TaskRef[];
  headings: HeadingRef[];
  /** Text of the first level-1 heading, if any. */
  firstH1: string | null;
}

/** 1-based line numbers for offsets in `text`. */
export function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === NEWLINE) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Splits the inside of [[...]] into target, heading and label. */
export function parseWikiTarget(inner: string): { target: string; heading: string | null; label: string | null } {
  const bar = inner.indexOf('|');
  const ref = bar >= 0 ? inner.slice(0, bar) : inner;
  const label = bar >= 0 ? inner.slice(bar + 1).trim() || null : null;
  const hash = ref.indexOf('#');
  return {
    target: (hash >= 0 ? ref.slice(0, hash) : ref).trim(),
    heading: hash >= 0 ? ref.slice(hash + 1).trim() || null : null,
    label,
  };
}

const SKIP_INSIDE = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'CommentBlock', 'Comment', 'HTMLTag']);
const ISO_DATE_IN_TEXT = /(?<![\w/-])(\d{4}-\d{2}-\d{2})(?![\w/-])/g;

/**
 * Finds links, tags, tasks and headings in `text`. `offset` is added to positions and `lineOf`
 * maps document offsets to line numbers, so a body can be analysed in place within a note.
 */
export function analyzeBody(text: string, offset = 0, lineOf: (pos: number) => number = lineIndex(text)): BodyAnalysis {
  const tree = bodyParser.parse(text);
  const result: BodyAnalysis = { links: [], tags: [], tasks: [], headings: [], firstH1: null };
  const tagSet = new Set<string>();
  const excluded: [number, number][] = []; // ranges where a date is not a mention (code, links)
  const slice = (from: number, to: number) => text.slice(from, to);

  const walk = (node: SyntaxNode): void => {
    const name = node.name;
    if (SKIP_INSIDE.has(name)) {
      excluded.push([node.from, node.to]);
      return;
    }
    if (/^(ATX|Setext)Heading\d$/.test(name)) {
      const level = Number(name.slice(-1));
      const raw = slice(node.from, node.to);
      const headingText = (
        name.startsWith('ATX')
          ? raw.replace(/^#+\s*/, '').replace(/\s+#+\s*$/, '')
          : raw.split(/\r?\n/).slice(0, -1).join(' ') // setext: every line above the underline
      ).trim();
      result.headings.push({ level, text: headingText, line: lineOf(node.from + offset) });
      if (level === 1 && result.firstH1 === null && headingText) result.firstH1 = headingText;
    } else if (name === 'WikiLink') {
      excluded.push([node.from, node.to]);
      const { target, heading, label } = parseWikiTarget(slice(node.from + 2, node.to - 2));
      if (target) {
        result.links.push({ kind: 'wiki', target, heading, label, line: lineOf(node.from + offset), from: node.from + offset, to: node.to + offset });
      }
      return;
    } else if (name === 'Tag') {
      const tag = slice(node.from + 1, node.to).toLowerCase();
      if (!tagSet.has(tag)) {
        tagSet.add(tag);
        result.tags.push(tag);
      }
      return;
    } else if (name === 'Link' || name === 'Image') {
      excluded.push([node.from, node.to]);
      const url = node.getChild('URL');
      if (url) {
        const href = slice(url.from, url.to).replace(/^<|>$/g, '');
        const textEnd = node.getChildren('LinkMark')[1]?.from ?? node.to;
        const label = slice(node.from + (name === 'Image' ? 2 : 1), textEnd) || null;
        const kind: LinkKind = /^[a-z][a-z0-9+.-]*:/i.test(href) ? 'url' : 'md';
        const target = kind === 'md' ? safeDecodeURI(href.split('#')[0] ?? '') : href;
        const heading = kind === 'md' && href.includes('#') ? href.slice(href.indexOf('#') + 1) : null;
        if (target) result.links.push({ kind, target, heading, label, line: lineOf(node.from + offset), from: node.from + offset, to: node.to + offset });
      }
    } else if (name === 'URL' && node.parent?.name !== 'Link' && node.parent?.name !== 'Image') {
      excluded.push([node.from, node.to]);
      result.links.push({ kind: 'url', target: slice(node.from, node.to), heading: null, label: null, line: lineOf(node.from + offset), from: node.from + offset, to: node.to + offset });
      return;
    } else if (name === 'Task') {
      const marker = node.getChild('TaskMarker');
      if (marker) {
        const lineStart = text.lastIndexOf('\n', marker.from - 1) + 1;
        let lineEnd = text.indexOf('\n', marker.from);
        if (lineEnd < 0) lineEnd = text.length;
        const raw = text.slice(lineStart, lineEnd).replace(/\r$/, '');
        const taskText = text.slice(marker.to, lineEnd).replace(/\r$/, '').trim();
        const meta = parseTaskMeta(taskText);
        result.tasks.push({
          line: lineOf(marker.from + offset),
          text: taskText,
          raw,
          done: /\[[xX]\]/.test(slice(marker.from, marker.to)),
          due: meta.due,
          doneDate: meta.done,
        });
      }
    }
    for (let child = node.firstChild; child; child = child.nextSibling) walk(child);
  };
  walk(tree.topNode);

  // Plain dates mentioned anywhere outside code and links link to that day's journal note.
  for (const match of text.matchAll(ISO_DATE_IN_TEXT)) {
    const date = match[1] ?? '';
    const from = match.index ?? 0;
    if (!isISODate(date) || excluded.some(([a, b]) => from >= a && from < b)) continue;
    result.links.push({ kind: 'date', target: date, heading: null, label: null, line: lineOf(from + offset), from: from + offset, to: from + offset + date.length });
  }
  return result;
}

/** decodeURI that returns the input unchanged when it isn't valid percent-encoding. */
export function safeDecodeURI(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

/** Lowercase lookup key for link targets and note names: "My Note.md" and "my note" match. */
export function linkKey(value: string): string {
  return value
    .normalize('NFC')
    .trim()
    .replace(/\.(md|excalidraw)$/i, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const MARKUP_FOR_EXCERPT: [RegExp, string][] = [
  [/!\[[^\]]*\]\([^)]*\)/g, ''],
  [/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2'],
  [/\[([^\]]*)\]\([^)]*\)/g, '$1'],
  [/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, ''],
  [/[*_~`]+/g, ''],
  [/^\s*\|?[-:| ]+\|?\s*$/gm, ''],
  // Table rows: "| a | b |" → "a · b"
  [/^\s*\|(.*)\|\s*$/gm, '$1'],
  [/\s*(?<!\\)\|\s*/g, ' · '],
];

/** A short plain-text preview of a note body, without its title heading. */
export function excerptOf(body: string, title: string | null, maxLength = 180): string {
  let text = body;
  if (title) text = text.replace(/^\s*#\s+.*(\r?\n|$)/, '');
  for (const [pattern, replacement] of MARKUP_FOR_EXCERPT) text = text.replace(pattern, replacement);
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), maxLength - 20))}…`;
}
