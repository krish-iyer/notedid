import { describe, expect, it } from 'vitest';
import { cellSource, cellText, deleteColumn, deleteRow, insertColumn, insertRow, moveColumn, moveRow, parseTable, setAlign, setCell, sortRows, tableLines } from './tables.ts';

const GROCERIES = ['| Item | Qty | Shop |', '| --- | --: | :---: |', '| Milk | 2 | Co-op |', '| Eggs | 12 | Co-op |', '| Bread | 1 |'];

describe('tables as cells', () => {
  it('reads a table, filling short rows, and writes it back lined up', () => {
    const table = parseTable(GROCERIES);
    expect(table).toEqual({
      indent: '',
      aligns: [null, 'right', 'center'],
      header: ['Item', 'Qty', 'Shop'],
      rows: [
        ['Milk', '2', 'Co-op'],
        ['Eggs', '12', 'Co-op'],
        ['Bread', '1', ''],
      ],
    });
    expect(tableLines(table!)).toEqual(['| Item  | Qty | Shop  |', '| ----- | --: | :---: |', '| Milk  |   2 | Co-op |', '| Eggs  |  12 | Co-op |', '| Bread |   1 |       |']);
    expect(parseTable(['| a |', 'not a delimiter'])).toBeNull();
  });

  it('keeps the indent of a table inside a list', () => {
    const table = parseTable(['  | a | b |', '  | - | - |', '  | 1 | 2 |']);
    expect(tableLines(table!)).toEqual(['  | a   | b   |', '  | --- | --- |', '  | 1   | 2   |']);
  });

  it('edits cells, escaping pipes and joining lines', () => {
    let table = parseTable(GROCERIES)!;
    table = setCell(table, 0, 0, 'Milk | oat');
    table = setCell(table, -1, 2, 'Where\nto buy');
    expect(table.rows[0]?.[0]).toBe('Milk \\| oat');
    expect(table.header[2]).toBe('Where to buy');
    expect(cellText('Milk \\| oat')).toBe('Milk | oat');
    expect(cellSource(' a|b \\| c ')).toBe('a\\|b \\| c');
  });

  it('inserts, deletes and moves rows and columns', () => {
    const table = parseTable(GROCERIES)!;
    expect(insertRow(table, 1).rows.map((r) => r[0])).toEqual(['Milk', '', 'Eggs', 'Bread']);
    expect(deleteRow(table, 0).rows.map((r) => r[0])).toEqual(['Eggs', 'Bread']);
    expect(moveRow(table, 2, -1).rows.map((r) => r[0])).toEqual(['Milk', 'Bread', 'Eggs']);
    expect(moveRow(table, 0, -1)).toBe(table);
    const withColumn = insertColumn(table, 1, 'Note');
    expect(withColumn.header).toEqual(['Item', 'Note', 'Qty', 'Shop']);
    expect(withColumn.aligns).toEqual([null, null, 'right', 'center']);
    expect(withColumn.rows[0]).toEqual(['Milk', '', '2', 'Co-op']);
    expect(deleteColumn(table, 1).header).toEqual(['Item', 'Shop']);
    expect(deleteColumn(parseTable(['| a |', '| - |'])!, 0).header).toEqual(['a']);
    const moved = moveColumn(table, 0, 1);
    expect(moved.header).toEqual(['Qty', 'Item', 'Shop']);
    expect(moved.aligns).toEqual(['right', null, 'center']);
    expect(setAlign(table, 0, 'center').aligns[0]).toBe('center');
  });

  it('sorts by a column: numbers by value, text alphabetically, empty last', () => {
    const table = parseTable(GROCERIES)!;
    expect(sortRows(table, 1, 1).rows.map((r) => r[1])).toEqual(['1', '2', '12']);
    expect(sortRows(table, 1, -1).rows.map((r) => r[1])).toEqual(['12', '2', '1']);
    expect(sortRows(table, 0, 1).rows.map((r) => r[0])).toEqual(['Bread', 'Eggs', 'Milk']);
    expect(sortRows(table, 2, 1).rows.map((r) => r[2])).toEqual(['Co-op', 'Co-op', '']);
    const speed = parseTable(['| x | speed |', '| - | - |', '| a | 2.6× |', '| b | 10× |', '| c | — |'])!;
    expect(sortRows(speed, 1, -1).rows.map((r) => r[0])).toEqual(['b', 'a', 'c']);
  });
});
