import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Range, RangeSet, RangeValue, StateEffect, StateField, type Text } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { notePathFacet, privateModeFacet } from './context.ts';

/**
 * Folding quotes: a block of "> " lines can fold to one line that shows a quote is there, its
 * first words and its length. Click it to open it again. Only the view changes; the file doesn't.
 * Folds are remembered per note in this browser (never for vault notes: their text stays encrypted).
 */

const QUOTE_LINE = /^ {0,3}>/;

interface QuoteBlock {
  from: number;
  to: number;
  /** The quote as plain text (no "> ", links reduced to their text), for the folded line and for remembering it. */
  text: string;
}

function plain(lines: string[]): string {
  return lines
    .map((l) => l.replace(/^ {0,3}> ?/, ''))
    .join(' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whether `pos` is inside a code block or the front matter (where markdown is just text). */
export function isInCode(state: EditorState, pos: number): boolean {
  let node = syntaxTree(state).resolveInner(pos, 1);
  for (;;) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'Frontmatter') return true;
    const parent = node.parent;
    if (!parent) return false;
    node = parent;
  }
}

/** Every quote block: a run of lines starting with ">", outside code. */
function quotesIn(state: EditorState): QuoteBlock[] {
  const doc: Text = state.doc;
  const blocks: QuoteBlock[] = [];
  for (let n = 1; n <= doc.lines; n++) {
    const first = doc.line(n);
    if (!QUOTE_LINE.test(first.text) || isInCode(state, first.from)) continue;
    const lines = [first.text];
    let last = first;
    while (last.number < doc.lines) {
      const next = doc.line(last.number + 1);
      if (!QUOTE_LINE.test(next.text)) break;
      lines.push(next.text);
      last = next;
    }
    blocks.push({ from: first.from, to: last.to, text: plain(lines) });
    n = last.number;
  }
  return blocks;
}

const fingerprint = (q: QuoteBlock) => q.text.slice(0, 160);

class FoldMark extends RangeValue {}
const foldMark = new FoldMark();

const foldQuote = StateEffect.define<number>({ map: (pos, changes) => changes.mapPos(pos) });
const unfoldQuote = StateEffect.define<number>({ map: (pos, changes) => changes.mapPos(pos) });
const foldAll = StateEffect.define<boolean>();

function storageKey(state: EditorState): string | null {
  const path = state.facet(notePathFacet);
  return path && !state.facet(privateModeFacet) ? `notesapp-folded-quotes:${path}` : null;
}

function remembered(state: EditorState): Set<string> {
  const key = storageKey(state);
  if (!key) return new Set();
  try {
    const list: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return new Set(Array.isArray(list) ? list.map(String) : []);
  } catch {
    return new Set();
  }
}

function remember(state: EditorState, folded: QuoteBlock[]): void {
  const key = storageKey(state);
  if (!key) return;
  try {
    if (folded.length) localStorage.setItem(key, JSON.stringify(folded.map(fingerprint)));
    else localStorage.removeItem(key);
  } catch {
    // Not remembered in a private window.
  }
}

/** A quote folded to one line: ❝, its first words and its length. Cards fold their quotes the same way. */
export function foldedQuoteElement(text: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'cm-quote-folded';
  box.title = 'Folded quote: click to open it';
  const mark = document.createElement('span');
  mark.className = 'cm-quote-folded-mark';
  mark.textContent = '❝';
  const words = document.createElement('span');
  words.className = 'cm-quote-folded-text';
  words.textContent = text || 'Quote';
  const size = document.createElement('span');
  size.className = 'cm-quote-folded-size';
  const count = text ? text.split(' ').length : 0;
  size.textContent = `${count} word${count === 1 ? '' : 's'}`;
  box.append(mark, words, size);
  return box;
}

class FoldedQuote extends WidgetType {
  readonly text: string;

  constructor(text: string) {
    super();
    this.text = text;
  }

  override eq(other: FoldedQuote): boolean {
    return other.text === this.text;
  }

  toDOM(view: EditorView): HTMLElement {
    // The widget's root has no margins (the editor can't measure them): spacing is its padding.
    const root = document.createElement('div');
    root.className = 'cm-quote-folded-outer';
    const box = foldedQuoteElement(this.text);
    root.append(box);
    box.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const at = view.posAtDOM(root);
      view.dispatch({ effects: unfoldQuote.of(at) });
    });
    return root;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

class FoldButton extends WidgetType {
  override eq(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cm-quote-fold';
    button.title = 'Fold this quote';
    button.setAttribute('aria-label', 'Fold this quote');
    button.textContent = '▴';
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      view.dispatch({ effects: foldQuote.of(view.posAtDOM(button)) });
    });
    return button;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

interface QuoteState {
  folds: RangeSet<FoldMark>;
  decorations: DecorationSet;
  atomic: RangeSet<FoldMark>;
}

function build(state: EditorState, folds: RangeSet<FoldMark>): QuoteState {
  const quotes = quotesIn(state);
  const starts = new Set<number>();
  for (const cursor = folds.iter(); cursor.value; cursor.next()) starts.add(state.doc.lineAt(cursor.from).from);
  const decorations: Range<Decoration>[] = [];
  const kept: Range<FoldMark>[] = [];
  const atomic: Range<FoldMark>[] = [];
  const folded: QuoteBlock[] = [];
  for (const q of quotes) {
    if (starts.has(q.from)) {
      decorations.push(Decoration.replace({ widget: new FoldedQuote(q.text), block: true }).range(q.from, q.to));
      kept.push(foldMark.range(q.from));
      atomic.push(foldMark.range(q.from, q.to));
      folded.push(q);
    } else {
      decorations.push(Decoration.widget({ widget: new FoldButton(), side: -1 }).range(q.from));
    }
  }
  return { folds: RangeSet.of(kept), decorations: Decoration.set(decorations, true), atomic: RangeSet.of(atomic) };
}

const quoteField = StateField.define<QuoteState>({
  create(state) {
    const wanted = remembered(state);
    const folds = wanted.size ? RangeSet.of(quotesIn(state).flatMap((q) => (wanted.has(fingerprint(q)) ? [foldMark.range(q.from)] : []))) : RangeSet.empty;
    return build(state, folds);
  },
  update(value, tr) {
    let folds = tr.docChanged ? value.folds.map(tr.changes) : value.folds;
    let changed = tr.docChanged;
    let folding = false;
    for (const effect of tr.effects) {
      if (effect.is(foldQuote) || effect.is(unfoldQuote)) {
        const quote = quotesIn(tr.state).find((q) => q.from <= effect.value && effect.value <= q.to);
        if (!quote) continue;
        folds = folds.update({ filter: (from) => from !== quote.from, filterFrom: quote.from, filterTo: quote.from });
        if (effect.is(foldQuote)) folds = folds.update({ add: [foldMark.range(quote.from)] });
        changed = folding = true;
      } else if (effect.is(foldAll)) {
        // Folding all leaves the quote you're typing in open.
        const head = tr.state.selection.main.head;
        folds = effect.value ? RangeSet.of(quotesIn(tr.state).flatMap((q) => (head >= q.from && head <= q.to ? [] : [foldMark.range(q.from)]))) : RangeSet.empty;
        changed = folding = true;
      }
    }
    if (!changed) return value;
    const next = build(tr.state, folds);
    if (folding) {
      const folded: QuoteBlock[] = [];
      const starts = new Set<number>();
      for (const cursor = next.folds.iter(); cursor.value; cursor.next()) starts.add(cursor.from);
      for (const q of quotesIn(tr.state)) if (starts.has(q.from)) folded.push(q);
      remember(tr.state, folded);
    }
    return next;
  },
  provide: (field) => [EditorView.decorations.from(field, (v) => v.decorations), EditorView.atomicRanges.of((view) => view.state.field(field).atomic)],
});

/** After folding the quote the cursor was in, put the cursor just after it. */
const keepCursorOut = EditorView.updateListener.of((update) => {
  if (!update.transactions.some((tr) => tr.effects.some((e) => e.is(foldQuote) || e.is(foldAll)))) return;
  const head = update.state.selection.main.head;
  for (const cursor = update.state.field(quoteField).atomic.iter(); cursor.value; cursor.next()) {
    if (head > cursor.from && head <= cursor.to) {
      const after = Math.min(cursor.to + 1, update.state.doc.length);
      queueMicrotask(() => update.view.dispatch({ selection: { anchor: after } }));
      return;
    }
  }
});

export const quoteFolding = [quoteField, keepCursorOut];

/** For the slash commands: fold every quote in the note, or open them all. */
export function setAllQuotesFolded(view: EditorView, folded: boolean): void {
  view.dispatch({ effects: foldAll.of(folded) });
}
