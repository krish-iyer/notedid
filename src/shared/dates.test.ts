import { describe, expect, it } from 'vitest';
import { addDays, formatDayTitle, isISODate, journalPath, localISODate } from './dates.ts';

describe('dates', () => {
  it('accepts only real YYYY-MM-DD days', () => {
    expect(isISODate('2026-11-25')).toBe(true);
    expect(isISODate('2028-02-29')).toBe(true);
    for (const bad of ['2026-02-29', '2026-13-01', '2026-11-31', '26-11-25', '2026-11-25T00:00', '', '2026/11/25']) {
      expect(isISODate(bad), bad).toBe(false);
    }
  });

  it('uses the local calendar day', () => {
    expect(localISODate(new Date(2026, 10, 25, 23, 59))).toBe('2026-11-25');
    expect(localISODate(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01');
  });

  it('adds days across month and year ends', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('maps a day to its journal note and refuses anything else', () => {
    expect(journalPath('2026-11-25')).toBe('journal/2026-11-25.md');
    expect(() => journalPath('../etc')).toThrow(RangeError);
  });

  it('formats a readable title', () => {
    expect(formatDayTitle('2026-11-25', 'en-GB')).toMatch(/Wed.*25.*Nov.*2026/);
  });
});
