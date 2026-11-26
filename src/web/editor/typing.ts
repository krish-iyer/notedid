import { EditorView } from '@codemirror/view';
import { isISODate, localISODate, parseDateWord } from '../../shared/dates.ts';

/** "due:fri" (or tomorrow, +3d, …) right before `pos`: the word's position and its date. */
function dueWordBefore(view: EditorView, pos: number): { from: number; date: string } | null {
  const line = view.state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  const match = /(?:^|\s)due:(\S+)$/i.exec(before);
  const word = match?.[1];
  if (!word || isISODate(word)) return null;
  const date = parseDateWord(word, localISODate());
  return date ? { from: pos - word.length, date } : null;
}

/**
 * Autoformat while typing:
 *   "due:fri" + space   → "due:2026-11-27 "
 *   "[]" + space        → "- [ ] " (a task)
 */
export const typingShortcuts = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== ' ' || from !== to) return false;
  const due = dueWordBefore(view, from);
  if (due) {
    view.dispatch({ changes: { from: due.from, to: from, insert: `${due.date} ` }, selection: { anchor: due.from + due.date.length + 1 }, userEvent: 'input.type' });
    return true;
  }
  const line = view.state.doc.lineAt(from);
  const checkbox = /^(\s*)(?:([-*+])\s+)?\[\]$/.exec(line.text.slice(0, from - line.from));
  if (checkbox) {
    const insert = `${checkbox[1] ?? ''}${checkbox[2] ?? '-'} [ ] `;
    view.dispatch({ changes: { from: line.from, to: from, insert }, selection: { anchor: line.from + insert.length }, userEvent: 'input.type' });
    return true;
  }
  return false;
});

/** Enter right after "due:fri" also turns it into a date, then lets Enter do its usual job. */
export function convertDueBeforeEnter(view: EditorView): boolean {
  const pos = view.state.selection.main.head;
  const due = dueWordBefore(view, pos);
  if (due) view.dispatch({ changes: { from: due.from, to: pos, insert: due.date }, selection: { anchor: due.from + due.date.length } });
  return false;
}
