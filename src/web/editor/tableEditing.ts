import { redo, undo } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Range, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { parseWikiTarget } from '../../shared/markdown.ts';
import {
  type Align,
  cellText,
  deleteColumn,
  deleteRow,
  emptyTable,
  insertColumn,
  insertRow,
  isDelimiterRow,
  isTableRow,
  moveColumn,
  moveRow,
  parseTable,
  setAlign,
  setCell,
  sortRows,
  splitRow,
  type TableModel,
  tableLines,
} from '../../shared/tables.ts';
import { navigate, noteHref } from '../router.ts';
import { resolveNote } from '../stores.ts';
import { notePathFacet, privateModeFacet } from './context.ts';
import { escapeHtml } from '../util.ts';
import { isInCode } from './quotes.ts';
import { type MenuEntry, menuElement } from './widgetMenu.ts';

/**
 * Tables in the editor show as tables: click a cell to edit it, Tab and Enter move between cells,
 * and a menu on each cell inserts, deletes, moves, aligns and sorts. Every change is written back
 * to the markdown at once (lined up), so the file stays an ordinary markdown table. With the cursor
 * inside a table's markdown ("Edit as markdown"), the text shows instead.
 */

interface TableBlock {
  from: number;
  to: number;
  text: string;
}

/** Tables in the note: a header row, a delimiter row with as many cells, and the rows after. */
function tablesIn(state: EditorState): TableBlock[] {
  const doc = state.doc;
  const tables: TableBlock[] = [];
  for (let n = 1; n < doc.lines; n++) {
    const head = doc.line(n);
    if (!isTableRow(head.text)) continue;
    const delimiter = doc.line(n + 1).text;
    if (!isDelimiterRow(delimiter) || splitRow(delimiter).length !== splitRow(head.text).length || isInCode(state, head.from)) continue;
    let last = n + 1;
    while (last < doc.lines && isTableRow(doc.line(last + 1).text)) last++;
    const to = doc.line(last).to;
    tables.push({ from: head.from, to, text: doc.sliceString(head.from, to) });
    n = last;
  }
  return tables;
}

/** The table starting at `from` as it is in the document now. */
function tableAt(state: EditorState, from: number): TableBlock | null {
  return tablesIn(state).find((t) => t.from === from) ?? null;
}

// ---------------------------------------------------------------------------
// Showing a cell: inline markdown (bold, code, links, [[note links]]) as HTML.
// ---------------------------------------------------------------------------

const inline = new Marked({ gfm: true });

function renderCell(source: string, privateMode: boolean): string {
  const text = cellText(source).replace(/\[\[([^\]]+)\]\]/g, (_, inner: string) => {
    const { target, label } = parseWikiTarget(inner);
    const shown = escapeHtml(label ?? target);
    return privateMode ? shown : `<a class="cm-md-wikilink" data-target="${escapeHtml(target)}" title="Ctrl+click to open">${shown}</a>`;
  });
  const html = inline.parseInline(text) as string;
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: ['a', 'strong', 'em', 'b', 'i', 'code', 'del', 's', 'span'], ALLOWED_ATTR: ['href', 'class', 'data-target', 'title'] });
}

// ---------------------------------------------------------------------------
// The table on screen.
// ---------------------------------------------------------------------------

/** A cell to focus once the table has been redrawn (after adding a row, sorting, …). */
const pendingFocus = new WeakMap<EditorView, { from: number; row: number; column: number; selectAll: boolean }>();
const hosts = new WeakMap<HTMLElement, TableHost>();

class TableHost {
  readonly dom: HTMLElement;
  model: TableModel;
  readonly view: EditorView;
  readonly #scroll: HTMLElement;
  readonly #menuButton: HTMLButtonElement;
  #menu: HTMLElement | null = null;
  /** Rows and columns on screen now. */
  #shown = { rows: 0, columns: 0 };
  /** True while the rows are being redrawn (the focused cell goes away; that is not leaving it). */
  #redrawing = false;
  #editing: HTMLElement | null = null;

  constructor(view: EditorView, model: TableModel) {
    this.view = view;
    this.model = model;
    this.dom = document.createElement('div');
    this.dom.className = 'cm-md-table';
    this.#scroll = document.createElement('div');
    this.#scroll.className = 'cm-md-table-scroll';
    this.dom.append(this.#scroll);

    const bar = document.createElement('div');
    bar.className = 'cm-md-table-bar';
    bar.append(
      this.#barButton('+ Row', 'Add a row at the end', () => this.#change(insertRow(this.model, this.model.rows.length), this.model.rows.length, 0)),
      this.#barButton('+ Column', 'Add a column at the end', () => {
        const at = this.model.header.length;
        this.#change(insertColumn(this.model, at, `Column ${at + 1}`), -1, at, true);
      }),
      this.#barButton('Edit as markdown', 'Edit the table as text', () => this.#editAsText()),
    );
    this.dom.append(bar);

    this.#menuButton = document.createElement('button');
    this.#menuButton.type = 'button';
    this.#menuButton.className = 'cm-md-cell-menu-button';
    this.#menuButton.textContent = '⋯';
    this.#menuButton.title = 'Rows, columns, alignment and sorting';
    this.#menuButton.setAttribute('aria-label', 'Table options for this cell');
    this.#menuButton.hidden = true;
    // Keep the cell focused while using its menu.
    this.#menuButton.addEventListener('mousedown', (e) => e.preventDefault());
    this.#menuButton.addEventListener('click', () => (this.#menu ? this.#closeMenu() : this.#openMenu()));
    this.dom.append(this.#menuButton);

    this.#render();
    this.dom.addEventListener('focusin', (e) => this.#onFocusIn(e));
    this.dom.addEventListener('focusout', (e) => this.#onFocusOut(e));
    this.dom.addEventListener('input', (e) => this.#onInput(e));
    this.dom.addEventListener('keydown', (e) => this.#onKeyDown(e));
    this.dom.addEventListener('paste', (e) => this.#onPaste(e));
    this.dom.addEventListener('mousedown', (e) => this.#onMouseDown(e));
    // Right-click on a cell: the same menu as its ⋯ button.
    this.dom.addEventListener('contextmenu', (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>('.cm-md-cell');
      if (!cell) return;
      e.preventDefault();
      if (cell !== this.#editing) this.focusCell(Number(cell.dataset.row), Number(cell.dataset.column));
      this.#closeMenu();
      this.#openMenu();
    });
    hosts.set(this.dom, this);
    queueMicrotask(() => this.#applyPendingFocus());
  }

  get #privateMode(): boolean {
    return this.view.state.facet(privateModeFacet);
  }

  #barButton(label: string, title: string, run: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.title = title;
    button.addEventListener('mousedown', (e) => e.preventDefault());
    button.addEventListener('click', run);
    return button;
  }

  // ----- drawing

  #render(): void {
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    this.model.header.forEach((_, c) => head.append(this.#cell('th', -1, c)));
    const body = table.createTBody();
    this.model.rows.forEach((row, r) => {
      const tr = body.insertRow();
      row.forEach((_, c) => tr.append(this.#cell('td', r, c)));
    });
    this.#scroll.replaceChildren(table);
    this.#shown = { rows: this.model.rows.length, columns: this.model.header.length };
  }

  #cell(tag: 'th' | 'td', row: number, column: number): HTMLElement {
    const box = document.createElement(tag);
    const cell = document.createElement('div');
    cell.className = 'cm-md-cell';
    cell.contentEditable = 'plaintext-only';
    if (cell.contentEditable !== 'plaintext-only') cell.contentEditable = 'true';
    cell.spellcheck = true;
    cell.dataset.row = String(row);
    cell.dataset.column = String(column);
    cell.setAttribute('role', 'textbox');
    cell.setAttribute('aria-label', row < 0 ? `Column ${column + 1} heading` : `Row ${row + 1}, column ${column + 1}`);
    box.append(cell);
    this.#paint(cell, box);
    return box;
  }

  #source(row: number, column: number): string {
    return (row < 0 ? this.model.header[column] : this.model.rows[row]?.[column]) ?? '';
  }

  /** Shows a cell's content: raw text while it is being edited, rendered otherwise. */
  #paint(cell: HTMLElement, box: HTMLElement | null = cell.parentElement): void {
    const row = Number(cell.dataset.row);
    const column = Number(cell.dataset.column);
    const source = this.#source(row, column);
    const align: Align = this.model.aligns[column] ?? null;
    if (box) box.style.textAlign = align ?? 'left';
    if (cell === this.#editing) {
      // Leave the text being typed alone unless the table changed under it (undo, sort…).
      if ((cell.textContent ?? '').trim() !== cellText(source).trim()) cell.textContent = cellText(source);
    } else if (cell.dataset.source !== source || !cell.dataset.painted) {
      cell.innerHTML = renderCell(source, this.#privateMode);
      cell.dataset.source = source;
      cell.dataset.painted = '1';
    }
  }

  #cells(): HTMLElement[] {
    return [...this.dom.querySelectorAll<HTMLElement>('.cm-md-cell')];
  }

  cellAt(row: number, column: number): HTMLElement | null {
    return this.dom.querySelector<HTMLElement>(`.cm-md-cell[data-row="${row}"][data-column="${column}"]`);
  }

  /** The document changed (an edit here, undo, a new row, a change elsewhere): show it in place. */
  update(model: TableModel): void {
    this.model = model;
    if (model.rows.length !== this.#shown.rows || model.header.length !== this.#shown.columns) {
      this.#redrawing = true;
      this.#editing = null;
      this.#render();
      this.#redrawing = false;
    } else {
      for (const cell of this.#cells()) this.#paint(cell);
    }
    // Right after the editor finishes this update: put the cursor in the cell it belongs in.
    queueMicrotask(() => this.#applyPendingFocus());
  }

  // ----- writing back

  #where(cell: HTMLElement): { row: number; column: number } {
    return { row: Number(cell.dataset.row), column: Number(cell.dataset.column) };
  }

  #start(): number | null {
    if (!this.dom.isConnected) return null;
    try {
      return this.view.posAtDOM(this.dom);
    } catch {
      return null;
    }
  }

  /** Writes the table into the document (lined up). */
  #commit(): void {
    const from = this.#start();
    if (from === null) return;
    const block = tableAt(this.view.state, from);
    if (!block) return;
    const text = tableLines(this.model).join('\n');
    if (text === block.text) return;
    const { state } = this.view;
    this.view.dispatch({ changes: { from: block.from, to: block.to, insert: state.toText(text.replace(/\n/g, state.lineBreak)) }, userEvent: 'input.table' });
  }

  /** A change to the table's shape or order: written at once, then `row`/`column` gets the cursor. */
  #change(next: TableModel, row: number, column: number, selectAll = false): void {
    this.#closeMenu();
    const from = this.#start();
    if (from === null) return;
    this.model = next;
    pendingFocus.set(this.view, { from, row, column, selectAll });
    this.#commit();
  }

  #applyPendingFocus(): void {
    const want = pendingFocus.get(this.view);
    if (!want || want.from !== this.#start()) return;
    pendingFocus.delete(this.view);
    this.focusCell(want.row, want.column, want.selectAll);
  }

  focusCell(row: number, column: number, selectAll = false): void {
    const cell = this.cellAt(row, column);
    if (!cell) return;
    cell.focus();
    const range = document.createRange();
    range.selectNodeContents(cell);
    if (!selectAll) range.collapse(false);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  // ----- events

  #onFocusIn(event: FocusEvent): void {
    const cell = (event.target as HTMLElement).closest<HTMLElement>('.cm-md-cell');
    if (!cell) return;
    this.#editing = cell;
    cell.textContent = cellText(this.#source(Number(cell.dataset.row), Number(cell.dataset.column)));
    delete cell.dataset.painted;
    this.#placeMenuButton(cell);
  }

  #onFocusOut(event: FocusEvent): void {
    const cell = (event.target as HTMLElement).closest<HTMLElement>('.cm-md-cell');
    if (this.#redrawing || !cell || cell !== this.#editing) return;
    const next = event.relatedTarget as Node | null;
    this.#editing = null;
    this.#commit();
    this.#paint(cell);
    if (!next || !this.dom.contains(next)) {
      this.#menuButton.hidden = true;
      this.#closeMenu();
    }
  }

  #onInput(event: Event): void {
    const cell = (event.target as HTMLElement).closest<HTMLElement>('.cm-md-cell');
    if (!cell) return;
    const { row, column } = this.#where(cell);
    this.model = setCell(this.model, row, column, cell.textContent ?? '');
    // Straight into the document, so nothing typed is lost if the note closes right after.
    this.#commit();
  }

  #onPaste(event: ClipboardEvent): void {
    const cell = (event.target as HTMLElement).closest<HTMLElement>('.cm-md-cell');
    if (!cell) return;
    event.preventDefault();
    const text = (event.clipboardData?.getData('text/plain') ?? '').replace(/\s*\r?\n\s*/g, ' ');
    document.execCommand('insertText', false, text);
  }

  #onMouseDown(event: MouseEvent): void {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('.cm-md-cell a');
    if (!link || !(event.ctrlKey || event.metaKey) || this.#privateMode) return;
    event.preventDefault();
    const target = link.dataset.target;
    if (target) {
      const note = resolveNote(target, this.view.state.facet(notePathFacet) ?? undefined);
      if (note) navigate(noteHref(note.path, note.kind));
    } else if (link.href && /^https?:/i.test(link.href)) {
      window.open(link.href, '_blank', 'noopener');
    }
  }

  #onKeyDown(event: KeyboardEvent): void {
    const cell = (event.target as HTMLElement).closest<HTMLElement>('.cm-md-cell');
    if (!cell) {
      if (event.key === 'Escape') this.#closeMenu();
      return;
    }
    const { row, column } = this.#where(cell);
    const rows = this.model.rows.length;
    const columns = this.model.header.length;
    const mod = event.ctrlKey || event.metaKey;
    const go = (r: number, c: number) => {
      event.preventDefault();
      this.#commit();
      this.focusCell(r, c);
    };

    if (mod && (event.key === 'z' || event.key === 'Z' || event.key === 'y')) {
      event.preventDefault();
      this.#commit();
      if (event.key === 'y' || event.shiftKey) redo(this.view);
      else undo(this.view);
      return;
    }
    switch (event.key) {
      case 'Tab': {
        const order = (row + 1) * columns + column + (event.shiftKey ? -1 : 1);
        if (order < 0) return void event.preventDefault();
        if (order >= (rows + 1) * columns) {
          event.preventDefault();
          return this.#change(insertRow(this.model, rows), rows, 0);
        }
        return go(Math.floor(order / columns) - 1, order % columns);
      }
      case 'Enter':
        event.preventDefault();
        if (event.shiftKey || mod) return;
        if (row + 1 < rows) return go(row + 1, column);
        return this.#change(insertRow(this.model, rows), rows, column);
      case 'ArrowUp':
        if (row < 0) return void this.#leave(event, 'above');
        return go(row - 1, column);
      case 'ArrowDown':
        if (row + 1 >= rows) return void this.#leave(event, 'below');
        return go(row + 1, column);
      case 'Escape':
        if (this.#menu) return this.#closeMenu();
        return void this.#leave(event, 'below');
      default:
    }
  }

  /** Back to the text, on the line above or below the table. */
  #leave(event: KeyboardEvent, where: 'above' | 'below'): void {
    event.preventDefault();
    this.#commit();
    const from = this.#start();
    if (from === null) return;
    const block = tableAt(this.view.state, from);
    if (!block) return;
    const { doc } = this.view.state;
    this.view.focus();
    if (where === 'above') {
      if (block.from > 0) this.view.dispatch({ selection: { anchor: block.from - 1 }, scrollIntoView: true });
      else this.view.dispatch({ changes: { from: 0, insert: this.view.state.lineBreak }, selection: { anchor: 0 } });
    } else if (block.to < doc.length) {
      this.view.dispatch({ selection: { anchor: block.to + 1 }, scrollIntoView: true });
    } else {
      this.view.dispatch({ changes: { from: block.to, insert: this.view.state.lineBreak }, selection: { anchor: block.to + 1 } });
    }
  }

  #editAsText(): void {
    this.#commit();
    const from = this.#start();
    if (from === null) return;
    this.view.focus();
    this.view.dispatch({ selection: { anchor: from }, scrollIntoView: true });
  }

  // ----- the cell menu

  #placeMenuButton(cell: HTMLElement): void {
    const box = cell.getBoundingClientRect();
    const root = this.dom.getBoundingClientRect();
    this.#menuButton.hidden = false;
    this.#menuButton.style.left = `${Math.min(box.right - root.left - 26, root.width - 26)}px`;
    this.#menuButton.style.top = `${box.top - root.top + 3}px`;
  }

  #openMenu(): void {
    const cell = this.#editing;
    if (!cell) return;
    const { row, column } = this.#where(cell);
    const m = this.model;
    const header = row < 0;
    const entries: (MenuEntry | 'line')[] = [
      ...(header ? [] : [{ label: 'Insert row above', run: () => this.#change(insertRow(this.model, row), row, column) }]),
      { label: 'Insert row below', run: () => this.#change(insertRow(this.model, row + 1), row + 1, column) },
      ...(header
        ? []
        : [
            { label: 'Move row up', disabled: row === 0, run: () => this.#change(moveRow(this.model, row, -1), row - 1, column) },
            { label: 'Move row down', disabled: row >= m.rows.length - 1, run: () => this.#change(moveRow(this.model, row, 1), row + 1, column) },
            { label: 'Delete row', danger: true, run: () => this.#change(deleteRow(this.model, row), Math.min(row, m.rows.length - 2), column) },
          ]),
      'line',
      { label: 'Insert column left', run: () => this.#change(insertColumn(this.model, column), -1, column, true) },
      { label: 'Insert column right', run: () => this.#change(insertColumn(this.model, column + 1), -1, column + 1, true) },
      { label: 'Move column left', disabled: column === 0, run: () => this.#change(moveColumn(this.model, column, -1), row, column - 1) },
      { label: 'Move column right', disabled: column >= m.header.length - 1, run: () => this.#change(moveColumn(this.model, column, 1), row, column + 1) },
      { label: 'Delete column', danger: true, disabled: m.header.length <= 1, run: () => this.#change(deleteColumn(this.model, column), row, Math.max(0, column - 1)) },
      'line',
      { label: 'Align left', run: () => this.#change(setAlign(this.model, column, 'left'), row, column) },
      { label: 'Align centre', run: () => this.#change(setAlign(this.model, column, 'center'), row, column) },
      { label: 'Align right', run: () => this.#change(setAlign(this.model, column, 'right'), row, column) },
      'line',
      { label: 'Sort A → Z (1 → 9)', disabled: m.rows.length < 2, run: () => this.#change(sortRows(this.model, column, 1), -1, column) },
      { label: 'Sort Z → A (9 → 1)', disabled: m.rows.length < 2, run: () => this.#change(sortRows(this.model, column, -1), -1, column) },
    ];
    const menu = menuElement(entries);
    const root = this.dom.getBoundingClientRect();
    const left = Number.parseFloat(this.#menuButton.style.left) || 0;
    menu.style.left = `${Math.max(0, Math.min(left - 190, root.width - 220))}px`;
    menu.style.top = `${(Number.parseFloat(this.#menuButton.style.top) || 0) + 26}px`;
    this.dom.append(menu);
    this.#menu = menu;
  }

  #closeMenu(): void {
    this.#menu?.remove();
    this.#menu = null;
  }
}

class TableWidget extends WidgetType {
  readonly text: string;
  readonly model: TableModel;

  constructor(text: string, model: TableModel) {
    super();
    this.text = text;
    this.model = model;
  }

  override eq(other: TableWidget): boolean {
    return other.text === this.text;
  }

  toDOM(view: EditorView): HTMLElement {
    return new TableHost(view, this.model).dom;
  }

  override updateDOM(dom: HTMLElement): boolean {
    const host = hosts.get(dom);
    if (!host) return false;
    host.update(this.model);
    return true;
  }

  override ignoreEvent(): boolean {
    return true;
  }

  override get estimatedHeight(): number {
    return 34 * (this.model.rows.length + 1) + 36;
  }
}

// ---------------------------------------------------------------------------
// Which tables show as tables: all of them, except one whose markdown has the cursor.
// ---------------------------------------------------------------------------

const focusChanged = StateEffect.define<boolean>();

function build(state: EditorState, focused: boolean): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const table of tablesIn(state)) {
    if (focused && state.selection.ranges.some((r) => r.from <= table.to && r.to >= table.from)) continue;
    const model = parseTable(table.text.split('\n'));
    if (model) ranges.push(Decoration.replace({ widget: new TableWidget(table.text, model), block: true }).range(table.from, table.to));
  }
  return Decoration.set(ranges, true);
}

const tableField = StateField.define<{ focused: boolean; decorations: DecorationSet }>({
  create: (state) => ({ focused: false, decorations: build(state, false) }),
  update(value, tr) {
    let focused = value.focused;
    for (const effect of tr.effects) if (effect.is(focusChanged)) focused = effect.value;
    const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    if (!tr.docChanged && !tr.selection && focused === value.focused && !treeChanged) return value;
    return { focused, decorations: build(tr.state, focused) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

export const tableEditing = [tableField, EditorView.focusChangeEffect.of((_state, focusing) => focusChanged.of(focusing))];

/** "/table": a new table, with its first heading selected to type over. */
export function insertTable(view: EditorView, from: number, to: number): void {
  const line = view.state.doc.lineAt(from);
  const breakBefore = from > line.from;
  const text = emptyTable().replace(/\n/g, view.state.lineBreak);
  const insert = view.state.toText(`${breakBefore ? view.state.lineBreak : ''}${text}${view.state.lineBreak}`);
  const start = from + (breakBefore ? 1 : 0);
  pendingFocus.set(view, { from: start, row: -1, column: 0, selectAll: true });
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.complete' });
}
