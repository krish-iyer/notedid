import { StateEffect, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { type CompareBase, setCompare } from './compare.ts';

/**
 * Replaces an editor's text with `next` as one small change, so the cursor and scroll position
 * survive. Works in document positions, where every line break counts as one, whatever the
 * note's line endings are.
 */
export function replaceEditorText(view: EditorView, next: string, options: { remote?: boolean } = {}): void {
  const current = view.state.doc.toString();
  const target = next.replace(/\r\n?/g, '\n');
  if (current === target) return;
  let start = 0;
  while (start < current.length && start < target.length && current[start] === target[start]) start++;
  let endCurrent = current.length;
  let endTarget = target.length;
  while (endCurrent > start && endTarget > start && current[endCurrent - 1] === target[endTarget - 1]) {
    endCurrent--;
    endTarget--;
  }
  view.dispatch({
    changes: { from: start, to: endCurrent, insert: view.state.toText(target.slice(start, endTarget).replace(/\n/g, view.state.lineBreak)) },
    ...(options.remote ? { annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)] } : {}),
  });
}

/** Shows the changes since `base` in an open note (null stops). Returns false if the note isn't open. */
export function compareEditor(key: string, base: CompareBase | null): boolean {
  const view = editors.get(key);
  if (!view) return false;
  view.dispatch({ effects: setCompare.of(base) });
  return true;
}

/**
 * Changes an open note's text with `change` (null leaves it). Returns false if the note isn't open.
 * A `remote` change can't be undone in the editor.
 */
export function transformEditorText(key: string, change: (text: string) => string | null, options: { remote?: boolean } = {}): boolean {
  const view = editors.get(key);
  if (!view) return false;
  const text = view.state.sliceDoc();
  const next = change(text);
  if (next !== null && next !== text) replaceEditorText(view, next, options);
  return true;
}

/** Open editors by note path, so other parts of the app can add text to or scroll an open note. */
const editors = new Map<string, EditorView>();

/** Dispatched to make editors redraw their decorations (e.g. after the notes list changes). */
export const refreshDecorations = StateEffect.define<null>();

export function registerEditor(key: string, view: EditorView): () => void {
  editors.set(key, view);
  return () => {
    if (editors.get(key) === view) editors.delete(key);
  };
}

export function editorFor(key: string): EditorView | undefined {
  return editors.get(key);
}

export function refreshAllEditors(): void {
  for (const view of editors.values()) view.dispatch({ effects: refreshDecorations.of(null) });
}

/**
 * Appends a block at the end of an open note and puts the cursor after it. Returns false if the
 * note isn't open in an editor.
 */
export function appendToEditor(key: string, block: string, options: { focus?: boolean; blankLineAfter?: boolean } = {}): boolean {
  const view = editors.get(key);
  if (!view) return false;
  const doc = view.state.doc;
  const newline = view.state.lineBreak;
  const text = doc.toString();
  const prefix = text.length === 0 || text.endsWith('\n') ? '' : newline;
  const insert = view.state.toText(`${prefix}${block.replace(/\n/g, newline)}${newline}${options.blankLineAfter ? newline : ''}`);
  view.dispatch({
    changes: { from: doc.length, insert },
    selection: { anchor: doc.length + insert.length },
    scrollIntoView: true,
    userEvent: 'input.append',
  });
  if (options.focus) view.focus();
  return true;
}

/** Scrolls an open note to a 1-based line and selects it. With `focus: false`, a phone's keyboard doesn't open. */
export function scrollEditorTo(key: string, line: number, options: { focus?: boolean } = {}): boolean {
  const view = editors.get(key);
  if (!view || line < 1 || line > view.state.doc.lines) return false;
  const target = view.state.doc.line(line);
  view.dispatch({ selection: { anchor: target.from, head: target.to }, effects: EditorView.scrollIntoView(target.from, { y: 'center' }) });
  if (options.focus ?? true) view.focus();
  return true;
}
