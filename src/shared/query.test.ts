import { describe, expect, it } from 'vitest';
import { dueMatches, isTaskQuery, parseQuery } from './query.ts';

const TODAY = '2026-11-25'; // a Wednesday

describe('parseQuery', () => {
  it('reads words, phrases and exclusions', () => {
    const q = parseQuery('hbm "bank conflict" -draft', TODAY);
    expect(q.terms).toEqual([
      { text: 'hbm', phrase: false, negated: false },
      { text: 'bank conflict', phrase: true, negated: false },
      { text: 'draft', phrase: false, negated: true },
    ]);
  });

  it('reads filters', () => {
    const q = parseQuery('tag:fpga #ideas -tag:old is:open in:papers has:pdf after:2026-10-01 before:yesterday', TODAY);
    expect(q.tags).toEqual(['fpga', 'ideas']);
    expect(q.notTags).toEqual(['old']);
    expect(q.is).toEqual(['open']);
    expect(q.in).toEqual(['papers']);
    expect(q.has).toEqual(['pdf']);
    expect(q.after).toBe('2026-10-01');
    expect(q.before).toBe('2026-11-24');
    expect(q.errors).toEqual([]);
    expect(isTaskQuery(q)).toBe(true);
  });

  it('reads due filters, including date words', () => {
    expect(parseQuery('due:today', TODAY).due).toEqual({ kind: 'on', date: TODAY });
    expect(parseQuery('due:fri', TODAY).due).toEqual({ kind: 'on', date: '2026-11-27' });
    expect(parseQuery('due:<2026-12-01', TODAY).due).toEqual({ kind: 'before', date: '2026-12-01' });
    expect(parseQuery('due:week', TODAY).due).toEqual({ kind: 'between', from: TODAY, to: '2026-12-02' });
    expect(parseQuery('due:overdue', TODAY).due).toEqual({ kind: 'overdue' });
  });

  it('reports filters it does not understand', () => {
    expect(parseQuery('is:banana due:someday', TODAY).errors).toHaveLength(2);
  });

  it('treats an unknown key:value as plain words', () => {
    expect(parseQuery('http://x.org note:thing', TODAY).terms.map((t) => t.text)).toEqual(['http://x.org', 'note:thing']);
  });
});

describe('dueMatches', () => {
  it('compares due dates', () => {
    expect(dueMatches({ kind: 'overdue' }, '2026-11-20', TODAY)).toBe(true);
    expect(dueMatches({ kind: 'overdue' }, null, TODAY)).toBe(false);
    expect(dueMatches({ kind: 'none' }, null, TODAY)).toBe(true);
    expect(dueMatches({ kind: 'between', from: TODAY, to: '2026-12-02' }, '2026-11-30', TODAY)).toBe(true);
    expect(dueMatches({ kind: 'after', date: '2026-11-30' }, '2026-11-30', TODAY)).toBe(false);
  });
});
