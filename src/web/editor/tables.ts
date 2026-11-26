import type { EditorState } from '@codemirror/state';
import type { EditorView, KeyBinding } from '@codemirror/view';
import { formatTable, isDelimiterRow, isTableRow, splitRow } from '../../shared/tables.ts';

/** Tab / Shift-Tab move between table cells and Enter adds a row. Each keeps the table aligned. */

interface TableAt {
  first: number;
  last: number;
}

function tableAt(state: EditorState, pos: number): TableAt | null {
  const line = state.doc.lineAt(pos);
  if (!isTableRow(line.text)) return null;
  let first = line.number;
  let last = line.number;
  while (first > 1 && isTableRow(state.doc.line(first - 1).text)) first--;
  while (last < state.doc.lines && isTableRow(state.doc.line(last + 1).text)) last++;
  if (last <= first || !isDelimiterRow(state.doc.line(first + 1).text)) return null;
  return { first, last };
}

/** Index of the cell containing `offset` in a row. */
function cellIndexAt(text: string, offset: number): number {
  let index = text.trimStart().startsWith('|') ? -1 : 0;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '|' && text[i - 1] !== '\\') index++;
  return Math.max(0, index);
}

/** Start and end of a cell's text within a formatted row (for selecting it). */
function cellSpan(row: string, index: number): { from: number; to: number } {
  let seen = -1;
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '|' && row[i - 1] !== '\\') {
      seen++;
      if (seen === index) {
        const start = i + 2;
        const next = row.indexOf('|', i + 1);
        const content = row.slice(start, next < 0 ? row.length : next).trimEnd();
        return { from: Math.min(start, row.length), to: Math.min(start + content.length, row.length) };
      }
    }
  }
  return { from: row.length, to: row.length };
}

function replaceTable(view: EditorView, table: TableAt, lines: string[], row: number, col: number): void {
  const { state } = view;
  const from = state.doc.line(table.first).from;
  const to = state.doc.line(table.last).to;
  // In document positions every line break counts as one, whatever the note's line endings.
  const offset = lines.slice(0, row).reduce((sum, l) => sum + l.length + 1, 0);
  const span = cellSpan(lines[row] ?? '', col);
  view.dispatch({
    changes: { from, to, insert: state.toText(lines.join(state.lineBreak)) },
    selection: { anchor: from + offset + span.from, head: from + offset + span.to },
    scrollIntoView: true,
    userEvent: 'input.table',
  });
}

function moveCell(view: EditorView, step: 1 | -1): boolean {
  const { state } = view;
  const pos = state.selection.main.head;
  const table = tableAt(state, pos);
  if (!table) return false;
  const original = Array.from({ length: table.last - table.first + 1 }, (_, i) => state.doc.line(table.first + i).text);
  let lines = formatTable(original);
  const columns = splitRow(lines[0] ?? '').length;
  const line = state.doc.lineAt(pos);
  let row = line.number - table.first;
  let col = cellIndexAt(line.text, pos - line.from) + step;
  if (row === 1) row = step > 0 ? 2 : 0; // never stop in the |---| row
  if (col >= columns) {
    col = 0;
    row = row === 0 ? 2 : row + 1;
  } else if (col < 0) {
    if (row === 0) return true;
    col = columns - 1;
    row = row === 2 ? 0 : row - 1;
  }
  if (row >= lines.length) lines = formatTable([...lines, `|${' |'.repeat(columns)}`]);
  replaceTable(view, table, lines, row, col);
  return true;
}

function newRow(view: EditorView): boolean {
  const { state } = view;
  const pos = state.selection.main.head;
  const table = tableAt(state, pos);
  if (!table) return false;
  const line = state.doc.lineAt(pos);
  const original = Array.from({ length: table.last - table.first + 1 }, (_, i) => state.doc.line(table.first + i).text);
  const row = line.number - table.first;
  const columns = splitRow(original[0] ?? '').length;
  // Enter on an empty last row leaves the table.
  if (row === original.length - 1 && row >= 2 && splitRow(line.text).every((c) => c === '')) {
    const formatted = formatTable(original.slice(0, -1));
    const from = state.doc.line(table.first).from;
    const insert = state.toText(`${formatted.join(state.lineBreak)}${state.lineBreak}`);
    view.dispatch({ changes: { from, to: line.to, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.table' });
    return true;
  }
  const at = Math.max(row, 1) + 1;
  const lines = formatTable([...original.slice(0, at), `|${' |'.repeat(columns)}`, ...original.slice(at)]);
  replaceTable(view, table, lines, at, 0);
  return true;
}

export const tableKeymap: KeyBinding[] = [
  { key: 'Tab', run: (view) => moveCell(view, 1) },
  { key: 'Shift-Tab', run: (view) => moveCell(view, -1) },
  { key: 'Enter', run: newRow },
];
