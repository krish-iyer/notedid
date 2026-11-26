/** GFM pipe tables: recognising, aligning, and building them from pasted spreadsheet data. */

export type Align = 'left' | 'center' | 'right' | null;

const DELIMITER_CELL = /^\s*:?-+:?\s*$/;

/** Splits a table row into cell texts, honouring escaped pipes (\|). */
export function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && text[i + 1] === '|') {
      current += '\\|';
      i++;
    } else if (ch === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

export function isTableRow(line: string): boolean {
  return /(^|[^\\])\|/.test(line) && line.trim().length > 1;
}

export function isDelimiterRow(line: string): boolean {
  if (!line.includes('-')) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => DELIMITER_CELL.test(cell));
}

function alignOf(cell: string): Align {
  const c = cell.trim();
  const left = c.startsWith(':');
  const right = c.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

/** Characters that take two columns in a monospace font (CJK and similar). */
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;

export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += WIDE.test(ch) ? 2 : 1;
  return width;
}

function pad(text: string, width: number, align: Align): string {
  const space = Math.max(0, width - displayWidth(text));
  if (align === 'right') return ' '.repeat(space) + text;
  if (align === 'center') return ' '.repeat(Math.floor(space / 2)) + text + ' '.repeat(Math.ceil(space / 2));
  return text + ' '.repeat(space);
}

/**
 * Re-aligns a table (header, delimiter row, body rows) so its pipes line up. Rows are padded to
 * the same number of cells. Returns the lines unchanged if they don't form a table.
 */
export function formatTable(lines: string[]): string[] {
  if (lines.length < 2 || !isDelimiterRow(lines[1] ?? '')) return lines;
  const indent = /^\s*/.exec(lines[0] ?? '')?.[0] ?? '';
  const aligns = splitRow(lines[1] ?? '').map(alignOf);
  const rows = lines.filter((_, i) => i !== 1).map(splitRow);
  const columns = Math.max(aligns.length, ...rows.map((r) => r.length));
  const widths = Array.from({ length: columns }, (_, c) => Math.max(3, ...rows.map((r) => displayWidth(r[c] ?? ''))));
  const render = (cells: string[]) =>
    `${indent}| ${widths.map((w, c) => pad(cells[c] ?? '', w, aligns[c] ?? null)).join(' | ')} |`;
  const delimiter = `${indent}| ${widths
    .map((w, c) => {
      const align = aligns[c] ?? null;
      const dashes = '-'.repeat(Math.max(1, w - (align === 'center' ? 2 : align ? 1 : 0)));
      if (align === 'center') return `:${dashes}:`;
      if (align === 'right') return `${dashes}:`;
      if (align === 'left') return `:${dashes}`;
      return dashes;
    })
    .join(' | ')} |`;
  const [header, ...body] = rows;
  return [render(header ?? []), delimiter, ...body.map(render)];
}

function escapeCell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

/** A markdown table from rows of cells; the first row is the header. */
export function rowsToMarkdownTable(rows: string[][]): string {
  const columns = Math.max(...rows.map((r) => r.length));
  const normalized = rows.map((r) => Array.from({ length: columns }, (_, c) => escapeCell(r[c] ?? '')));
  const [header, ...body] = normalized;
  const lines = [`| ${(header ?? []).join(' | ')} |`, `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`, ...body.map((r) => `| ${r.join(' | ')} |`)];
  return formatTable(lines).join('\n');
}

/** Tab-separated text (as spreadsheets put on the clipboard) as a markdown table, or null if it isn't tabular. */
export function tsvToMarkdownTable(text: string): string | null {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  if (lines.length < 2 || !lines.every((l) => l.includes('\t'))) return null;
  return rowsToMarkdownTable(lines.map((l) => l.split('\t')));
}

/** The empty table inserted by the "/table" command. */
export function emptyTable(columns = 3, rows = 2): string {
  const header = Array.from({ length: columns }, (_, i) => `Column ${i + 1}`);
  const body = Array.from({ length: rows }, () => Array.from({ length: columns }, () => ''));
  return rowsToMarkdownTable([header, ...body]);
}

// ---------------------------------------------------------------------------
// Tables as rows of cells, for editing them as a table rather than as text.
// ---------------------------------------------------------------------------

export interface TableModel {
  /** Leading spaces of the table's lines (a table inside a list), kept as written. */
  indent: string;
  aligns: Align[];
  header: string[];
  rows: string[][];
}

/** A table's lines as cells, as written (escaped pipes stay escaped). Null if they aren't a table. */
export function parseTable(lines: readonly string[]): TableModel | null {
  if (lines.length < 2 || !isTableRow(lines[0] ?? '') || !isDelimiterRow(lines[1] ?? '')) return null;
  const indent = /^\s*/.exec(lines[0] ?? '')?.[0] ?? '';
  const header = splitRow(lines[0] ?? '');
  const aligns = splitRow(lines[1] ?? '').map(alignOf);
  const rows = lines.slice(2).map(splitRow);
  const width = Math.max(header.length, aligns.length, ...rows.map((r) => r.length));
  const fill = <T>(cells: T[], empty: T) => Array.from({ length: width }, (_, i) => cells[i] ?? empty);
  return { indent, aligns: fill(aligns, null), header: fill(header, ''), rows: rows.map((r) => fill(r, '')) };
}

/** The table's lines, lined up. */
export function tableLines(table: TableModel): string[] {
  const row = (cells: readonly string[]) => `${table.indent}| ${cells.join(' | ')} |`;
  const delimiter = table.aligns.map((a) => (a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---'));
  return formatTable([row(table.header), row(delimiter), ...table.rows.map(row)]);
}

/** A cell's text for showing and editing: "\|" becomes "|". */
export function cellText(source: string): string {
  return source.replace(/\\\|/g, '|');
}

/** Text typed into a cell, as markdown: one line, "|" escaped. */
export function cellSource(text: string): string {
  return text
    .replace(/\r?\n/g, ' ')
    .replace(/\\\|/g, '|')
    .replace(/\|/g, '\\|')
    .trim();
}

const blankRow = (table: TableModel) => table.header.map(() => '');
const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));

/** Changes one cell; row -1 is the header. */
export function setCell(table: TableModel, row: number, column: number, text: string): TableModel {
  const source = cellSource(text);
  if (row < 0) return { ...table, header: table.header.map((c, i) => (i === column ? source : c)) };
  return { ...table, rows: table.rows.map((r, i) => (i === row ? r.map((c, j) => (j === column ? source : c)) : r)) };
}

/** Inserts an empty row so it becomes row `at` (0 = first row under the header). */
export function insertRow(table: TableModel, at: number): TableModel {
  const rows = [...table.rows];
  rows.splice(clamp(at, rows.length), 0, blankRow(table));
  return { ...table, rows };
}

export function deleteRow(table: TableModel, row: number): TableModel {
  return { ...table, rows: table.rows.filter((_, i) => i !== row) };
}

export function moveRow(table: TableModel, row: number, by: -1 | 1): TableModel {
  const to = row + by;
  if (row < 0 || to < 0 || to >= table.rows.length) return table;
  const rows = [...table.rows];
  const [moving] = rows.splice(row, 1);
  if (moving) rows.splice(to, 0, moving);
  return { ...table, rows };
}

/** Inserts an empty column so it becomes column `at`. */
export function insertColumn(table: TableModel, at: number, title = ''): TableModel {
  const put = <T>(cells: T[], value: T) => {
    const next = [...cells];
    next.splice(clamp(at, cells.length), 0, value);
    return next;
  };
  return { ...table, header: put(table.header, title), aligns: put(table.aligns, null), rows: table.rows.map((r) => put(r, '')) };
}

/** Deletes a column (a table keeps at least one). */
export function deleteColumn(table: TableModel, column: number): TableModel {
  if (table.header.length <= 1) return table;
  const drop = <T>(cells: T[]) => cells.filter((_, i) => i !== column);
  return { ...table, header: drop(table.header), aligns: drop(table.aligns), rows: table.rows.map(drop) };
}

export function moveColumn(table: TableModel, column: number, by: -1 | 1): TableModel {
  const to = column + by;
  if (to < 0 || to >= table.header.length) return table;
  const swap = <T>(cells: T[]) => {
    const next = [...cells];
    const a = next[column] as T;
    next[column] = next[to] as T;
    next[to] = a;
    return next;
  };
  return { ...table, header: swap(table.header), aligns: swap(table.aligns), rows: table.rows.map(swap) };
}

export function setAlign(table: TableModel, column: number, align: Align): TableModel {
  return { ...table, aligns: table.aligns.map((a, i) => (i === column ? align : a)) };
}

/** Sorts the rows by a column: numbers by value, text alphabetically, empty cells last. */
export function sortRows(table: TableModel, column: number, direction: 1 | -1): TableModel {
  const key = (row: string[]) => cellText(row[column] ?? '').replace(/[*_`~]/g, '').trim();
  const rows = [...table.rows].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (!x || !y) return x ? -1 : y ? 1 : 0;
    const nx = Number(x.replace(/[,\s%×x$€£]/g, ''));
    const ny = Number(y.replace(/[,\s%×x$€£]/g, ''));
    const byNumber = Number.isFinite(nx) && Number.isFinite(ny) && x !== '' && y !== '' ? nx - ny : null;
    return direction * (byNumber ?? x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' }));
  });
  return { ...table, rows };
}
