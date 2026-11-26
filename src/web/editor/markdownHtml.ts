import DOMPurify from 'dompurify';
import { Marked, type Tokens, type TokensList } from 'marked';
import { parseWikiTarget, safeDecodeURI } from '../../shared/markdown.ts';
import { fileUrl } from '../api.ts';
import { resolveNote } from '../stores.ts';
import { dirname, escapeHtml, joinPath } from '../util.ts';

/**
 * Markdown as HTML, for cards in the editor and for the reading view: [[links]], #tags and images
 * next to the note, made safe. In the vault, links, tags and images show as their text, so nothing
 * is fetched or opened from there.
 */

export interface HtmlOptions {
  notePath: string | null;
  privateMode: boolean;
}

const TAG_START = /(^|[\s([{,;:!?"'*~>])#[\p{L}\p{N}_]/u;
const TAG = /^#([\p{L}\p{N}_\-/]*[\p{L}\p{N}_])/u;

function create({ notePath, privateMode }: HtmlOptions): Marked {
  const marked = new Marked({ gfm: true, async: false });
  marked.use({
    extensions: [
      {
        name: 'wikilink',
        level: 'inline',
        start: (src: string) => {
          const i = src.indexOf('[[');
          return i < 0 ? undefined : i;
        },
        tokenizer: (src: string) => {
          const match = /^\[\[([^\]\n]+)\]\]/.exec(src);
          return match ? { type: 'wikilink', raw: match[0], inner: match[1] ?? '' } : undefined;
        },
        renderer: (token) => {
          const { target, heading, label } = parseWikiTarget(String(token.inner));
          const text = escapeHtml(label ?? target);
          if (privateMode) return text;
          const missing = !/\.pdf$/i.test(target) && resolveNote(target, notePath ?? undefined) === null;
          return `<a href="#" class="cm-md-wikilink${missing ? ' missing' : ''}" data-target="${escapeHtml(target)}" data-heading="${escapeHtml(heading ?? '')}">${text}</a>`;
        },
      },
      {
        name: 'tag',
        level: 'inline',
        start: (src: string) => {
          const match = TAG_START.exec(src);
          return match ? match.index + (match[1]?.length ?? 0) : undefined;
        },
        tokenizer: (src: string) => {
          const match = TAG.exec(src);
          if (!match || /^[\d/_-]+$/.test(match[1] ?? '')) return undefined;
          return { type: 'tag', raw: match[0], tag: (match[1] ?? '').toLowerCase() };
        },
        renderer: (token) => (privateMode ? escapeHtml(token.raw) : `<a href="#" class="cm-tag" data-tag="${escapeHtml(String(token.tag))}">${escapeHtml(token.raw)}</a>`),
      },
    ],
    renderer: {
      image({ href, title, text }: Tokens.Image) {
        if (privateMode) return escapeHtml(text);
        const file = safeDecodeURI(href.split(/[?#]/)[0] ?? '');
        const src = /^(https?:|data:)/i.test(href) ? href : fileUrl(notePath ? joinPath(dirname(notePath), file) : file);
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ''}>`;
      },
      link(token: Tokens.Link) {
        // In the vault a link is just its text; elsewhere the default.
        return privateMode ? this.parser.parseInline(token.tokens) : false;
      },
    },
  });
  return marked;
}

const instances = new Map<string, Marked>();

function markedFor(options: HtmlOptions): Marked {
  const key = `${options.privateMode}\n${options.notePath ?? ''}`;
  let marked = instances.get(key);
  if (!marked) {
    // One per note (images are found next to it); a long session opens many notes.
    if (instances.size >= 20) instances.clear();
    marked = create(options);
    instances.set(key, marked);
  }
  return marked;
}

const SAFE = { FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'option'] };

/** A whole note's body (the reading view). */
export function documentHtml(source: string, options: HtmlOptions): string {
  return DOMPurify.sanitize(markedFor(options).parse(source) as string, SAFE);
}

/** One line of markdown (a title, a value). */
export function inlineHtml(text: string, options: HtmlOptions): string {
  return DOMPurify.sanitize(markedFor(options).parseInline(text) as string, SAFE);
}

export interface HtmlBlock {
  html: string;
  /** marked's name for it: paragraph, list, blockquote, code, … */
  type: string;
  /** 0-based first and last line of the block in the source. */
  from: number;
  to: number;
}

const newlines = (text: string) => text.match(/\n/g)?.length ?? 0;

/** Markdown as HTML, block by block, with the lines each block came from (to edit the right one). */
export function blocksHtml(source: string, options: HtmlOptions): HtmlBlock[] {
  const marked = markedFor(options);
  const tokens = marked.lexer(source);
  const blocks: HtmlBlock[] = [];
  let offset = 0;
  for (const token of tokens) {
    const found = source.indexOf(token.raw, offset);
    const start = found >= 0 ? found : offset;
    offset = start + token.raw.length;
    if (token.type === 'space' || token.type === 'def') continue;
    const from = newlines(source.slice(0, start));
    const list = Object.assign([token], { links: tokens.links }) as TokensList;
    blocks.push({ html: DOMPurify.sanitize(marked.parser(list) as string, SAFE), type: token.type, from, to: from + newlines(token.raw.trimEnd()) });
  }
  return blocks;
}
