import { describe, expect, it } from 'vitest';
import { addMonths, localTimestamp, parseDateWord, relativeDayLabel, weekdayOf } from './dates.ts';
import { fuzzyFilter, fuzzyMatch } from './fuzzy.ts';
import { slugify, tagify, uniqueName } from './slug.ts';
import { displayWidth, emptyTable, formatTable, isDelimiterRow, splitRow, tsvToMarkdownTable } from './tables.ts';

const TODAY = '2026-11-25'; // a Wednesday

describe('date words', () => {
  it('understands common words and weekdays', () => {
    expect(weekdayOf(TODAY)).toBe(3);
    expect(parseDateWord('today', TODAY)).toBe(TODAY);
    expect(parseDateWord('tomorrow', TODAY)).toBe('2026-11-26');
    expect(parseDateWord('fri', TODAY)).toBe('2026-11-27');
    expect(parseDateWord('Friday', TODAY)).toBe('2026-11-27');
    expect(parseDateWord('wed', TODAY)).toBe('2026-12-02'); // the next one, not today
    expect(parseDateWord('+3d', TODAY)).toBe('2026-11-28');
    expect(parseDateWord('+2w', TODAY)).toBe('2026-12-09');
    expect(parseDateWord('+1m', TODAY)).toBe('2026-12-25');
    expect(parseDateWord('2027-01-05', TODAY)).toBe('2027-01-05');
    expect(parseDateWord('someday', TODAY)).toBeNull();
    expect(parseDateWord('f', TODAY)).toBeNull();
  });

  it('adds months without overflowing short months', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
  });

  it('labels nearby days', () => {
    expect(relativeDayLabel('2026-11-26', TODAY)).toBe('tomorrow');
    expect(relativeDayLabel('2026-11-22', TODAY)).toBe('3 days ago');
    expect(relativeDayLabel('2027-01-01', TODAY)).toBe('2027-01-01');
  });

  it('writes local timestamps with the UTC offset', () => {
    expect(localTimestamp(new Date(2026, 10, 25, 14, 32, 5))).toMatch(/^2026-11-25T14:32:05[+-]\d{2}:\d{2}$/);
  });
});

describe('fuzzy matching', () => {
  it('prefers prefix and word-start matches', () => {
    const ranked = fuzzyFilter(['Weekly groceries', 'Groceries', 'Agro research', 'Gross margin'], 'gro', (s) => s).map((r) => r.item);
    expect(ranked[0]).toBe('Groceries');
    expect(ranked).toContain('Weekly groceries');
  });

  it('matches characters in order and reports their positions', () => {
    expect(fuzzyMatch('bnk', 'Bank conflicts')?.indices).toEqual([0, 2, 3]);
    expect(fuzzyMatch('xyz', 'Bank conflicts')).toBeNull();
  });
});

describe('slugs', () => {
  it('makes file-safe names and keeps non-Latin letters', () => {
    expect(slugify('Meeting with Ana (draft)')).toBe('meeting-with-ana-draft');
    expect(slugify("Kernel's HBM/DDR notes")).toBe('kernels-hbm-ddr-notes');
    expect(slugify('ملاحظات الاجتماع')).toBe('ملاحظات-الاجتماع');
    expect(slugify('???')).toBe('untitled');
  });

  it('turns whatever was typed into a tag', () => {
    expect(tagify('#Project X')).toBe('project-x');
    expect(tagify('[[test]]')).toBe('test');
    expect(tagify(' fpga/HBM ')).toBe('fpga/hbm');
  });

  it('finds a free name', () => {
    expect(uniqueName('notes', (n) => ['notes', 'notes-2'].includes(n))).toBe('notes-3');
  });
});

describe('tables', () => {
  it('splits rows, honouring escaped pipes', () => {
    expect(splitRow('| a | b \\| c |  |')).toEqual(['a', 'b \\| c', '']);
    expect(isDelimiterRow('|:---|---:| :-: |')).toBe(true);
    expect(isDelimiterRow('| a | b |')).toBe(false);
  });

  it('aligns a table, keeping column alignment', () => {
    expect(formatTable(['|Name|Qty|', '|:--|--:|', '|milk|2|', '|eggs|12|extra|'])).toEqual([
      '| Name | Qty |       |',
      '| :--- | --: | ----- |',
      '| milk |   2 |       |',
      '| eggs |  12 | extra |',
    ]);
    expect(formatTable(['  |a|b|', '  |-|-|'])).toEqual(['  | a   | b   |', '  | --- | --- |']);
    expect(formatTable(['not', 'a table'])).toEqual(['not', 'a table']);
  });

  it('counts wide characters as two columns', () => {
    expect(displayWidth('日本')).toBe(4);
    expect(displayWidth('ab')).toBe(2);
  });

  it('turns spreadsheet data into a table', () => {
    expect(tsvToMarkdownTable('Item\tQty\nmilk\t2\n')).toBe('| Item | Qty |\n| ---- | --- |\n| milk | 2   |');
    expect(tsvToMarkdownTable('just one line')).toBeNull();
    expect(emptyTable(2, 1).split('\n')).toHaveLength(3);
  });
});
