import { syntaxTree } from '@codemirror/language';
import type { Range } from '@codemirror/state';
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { isISODate } from '../../shared/dates.ts';
import { parseWikiTarget, safeDecodeURI } from '../../shared/markdown.ts';
import { fileUrl } from '../api.ts';
import { resolveNote } from '../stores.ts';
import { dirname, joinPath } from '../util.ts';
import { whiteboardPicture } from '../whiteboardPicture.ts';
import { notePathFacet, privateModeFacet } from './context.ts';
import { refreshDecorations } from './registry.ts';

/**
 * Live preview: on lines without the cursor, markdown markup (#, **, [[ ]], link URLs, list
 * bullets) is hidden and the text is styled instead. The file itself is never changed.
 */

const hide = Decoration.replace({});

class BulletWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-bullet';
    span.textContent = '•';
    return span;
  }
}

class RuleWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-rule';
    return span;
  }
}

class ImageWidget extends WidgetType {
  readonly src: string;
  readonly alt: string;

  constructor(src: string, alt: string) {
    super();
    this.src = src;
    this.alt = alt;
  }

  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  toDOM(): HTMLElement {
    const img = document.createElement('img');
    img.src = this.src;
    img.alt = this.alt;
    img.className = 'cm-image';
    img.loading = 'lazy';
    return img;
  }
}

/** ![[Whiteboard]] or ![[Whiteboard#Frame]]: a picture of it (src/web/whiteboardPicture.ts). */
class WhiteboardWidget extends WidgetType {
  readonly path: string;
  readonly frame: string | null;

  constructor(path: string, frame: string | null) {
    super();
    this.path = path;
    this.frame = frame;
  }

  override eq(other: WhiteboardWidget): boolean {
    return other.path === this.path && other.frame === this.frame;
  }

  toDOM(): HTMLElement {
    return whiteboardPicture(this.path, this.frame);
  }
}

export const DATE_IN_TEXT = /(?<![\w/-])(\d{4}-\d{2}-\d{2})(?![\w/-])/g;

function imageSource(src: string, notePath: string | null): string {
  if (/^(https?:|data:)/i.test(src)) return src;
  const file = safeDecodeURI(src.split(/[?#]/)[0] ?? '');
  return fileUrl(notePath ? joinPath(dirname(notePath), file) : file);
}

/** Lines touched by a selection, while the editor has focus: their markup stays visible. */
function activeLines(view: EditorView): Set<number> {
  const lines = new Set<number>();
  if (!view.hasFocus) return lines;
  for (const range of view.state.selection.ranges) {
    const first = view.state.doc.lineAt(range.from).number;
    const last = view.state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) lines.add(n);
  }
  return lines;
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const active = activeLines(view);
  const notePath = state.facet(notePathFacet);
  const privateMode = state.facet(privateModeFacet);
  const ranges: Range<Decoration>[] = [];

  const isActive = (from: number, to: number) => {
    if (active.size === 0) return false;
    const last = doc.lineAt(to).number;
    for (let n = doc.lineAt(from).number; n <= last; n++) if (active.has(n)) return true;
    return false;
  };
  const lineClass = (from: number, to: number, className: string) => {
    const decoration = Decoration.line({ class: className });
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos);
      ranges.push(decoration.range(line.from));
      pos = line.to + 1;
    }
  };
  const hideMarkAndSpace = (from: number, to: number) => {
    ranges.push(hide.range(from, doc.sliceString(to, to + 1) === ' ' ? to + 1 : to));
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        switch (node.name) {
          case 'FencedCode':
            lineClass(node.from, node.to, 'cm-codeblock-line');
            return false;
          case 'Frontmatter':
            lineClass(node.from, node.to, 'cm-frontmatter-line');
            return false;
          case 'Table':
            lineClass(node.from, node.to, 'cm-table-line');
            return false;
          case 'Blockquote':
            lineClass(node.from, node.to, 'cm-quote-line');
            return undefined;
          case 'HorizontalRule':
            if (!isActive(node.from, node.to)) ranges.push(Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to));
            return false;
          case 'HeaderMark': {
            const parent = node.node.parent?.name ?? '';
            if (isActive(node.from, node.to)) return undefined;
            if (parent.startsWith('ATXHeading')) hideMarkAndSpace(node.from, node.to);
            else if (parent.startsWith('SetextHeading')) ranges.push(hide.range(node.from, node.to));
            return undefined;
          }
          case 'EmphasisMark':
          case 'StrikethroughMark':
            if (!isActive(node.from, node.to)) ranges.push(hide.range(node.from, node.to));
            return undefined;
          case 'CodeMark':
            if (node.node.parent?.name === 'InlineCode' && !isActive(node.from, node.to)) ranges.push(hide.range(node.from, node.to));
            return undefined;
          case 'QuoteMark':
            if (!isActive(node.from, node.to)) hideMarkAndSpace(node.from, node.to);
            return undefined;
          case 'ListMark': {
            const item = node.node.parent;
            if (item?.parent?.name !== 'BulletList' || isActive(node.from, node.to)) return undefined;
            if (item.getChild('Task')) hideMarkAndSpace(node.from, node.to);
            else ranges.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
            return undefined;
          }
          case 'Link': {
            const marks = node.node.getChildren('LinkMark');
            const url = node.node.getChild('URL');
            const open = marks[0];
            const close = marks[1];
            if (!url || !open || !close) return undefined;
            if (isActive(node.from, node.to)) {
              ranges.push(Decoration.mark({ class: 'cm-link-raw' }).range(node.from, node.to));
            } else if (close.from > open.to) {
              ranges.push(hide.range(open.from, open.to));
              ranges.push(Decoration.mark({ class: 'cm-link-text' }).range(open.to, close.from));
              ranges.push(hide.range(close.from, node.to));
            }
            return undefined;
          }
          case 'Image': {
            const url = node.node.getChild('URL');
            const marks = node.node.getChildren('LinkMark');
            if (url && !isActive(node.from, node.to)) {
              const alt = marks.length >= 2 ? doc.sliceString(marks[0]?.to ?? node.from, marks[1]?.from ?? node.from) : '';
              ranges.push(Decoration.replace({ widget: new ImageWidget(imageSource(doc.sliceString(url.from, url.to), notePath), alt) }).range(node.from, node.to));
            }
            return false;
          }
          case 'WikiEmbed': {
            // A whiteboard's picture; anything else shows as its "!" and the link.
            const link = node.node.getChild('WikiLink');
            if (!link || privateMode || isActive(node.from, node.to)) return undefined;
            const { target, heading } = parseWikiTarget(doc.sliceString(link.from + 2, link.to - 2));
            const board = resolveNote(target, notePath ?? undefined);
            if (board?.kind !== 'whiteboard') return undefined;
            ranges.push(Decoration.replace({ widget: new WhiteboardWidget(board.path, heading) }).range(node.from, node.to));
            return false;
          }
          case 'WikiLink': {
            const inner = doc.sliceString(node.from + 2, node.to - 2);
            const { target } = parseWikiTarget(inner);
            const missing = !/\.pdf$/i.test(target) && resolveNote(target, notePath ?? undefined) === null;
            const className = missing ? 'cm-wikilink cm-wikilink-missing' : 'cm-wikilink';
            if (isActive(node.from, node.to)) {
              ranges.push(Decoration.mark({ class: className }).range(node.from, node.to));
            } else {
              const bar = inner.indexOf('|');
              const textFrom = bar >= 0 ? node.from + 3 + bar : node.from + 2;
              ranges.push(hide.range(node.from, textFrom));
              if (node.to - 2 > textFrom) ranges.push(Decoration.mark({ class: className }).range(textFrom, node.to - 2));
              ranges.push(hide.range(node.to - 2, node.to));
            }
            return false;
          }
          case 'Tag':
            ranges.push(Decoration.mark({ class: 'cm-tag' }).range(node.from, node.to));
            return false;
          case 'URL':
            if (node.node.parent?.name !== 'Link' && node.node.parent?.name !== 'Image') ranges.push(Decoration.mark({ class: 'cm-url' }).range(node.from, node.to));
            return undefined;
          default:
            return undefined;
        }
      },
    });

    // Dates link to that day's journal note.
    const text = doc.sliceString(from, to);
    for (const match of text.matchAll(DATE_IN_TEXT)) {
      const start = from + (match.index ?? 0);
      if (!isISODate(match[1] ?? '')) continue;
      const inside = syntaxTree(state).resolveInner(start, 1).name;
      if (/Code|URL|Frontmatter|WikiLink|LinkMark/.test(inside)) continue;
      ranges.push(Decoration.mark({ class: 'cm-date' }).range(start, start + 10));
    }
  }
  return Decoration.set(ranges, true);
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = build(view);
    }

    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.focusChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state) ||
        update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshDecorations)))
      ) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
