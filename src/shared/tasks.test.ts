import { describe, expect, it } from 'vitest';
import { dueState, parseTaskMeta, toggleTaskLine } from './tasks.ts';

describe('toggleTaskLine', () => {
  it('ticks a task and records the day', () => {
    expect(toggleTaskLine('- [ ] buy milk', '2026-11-25')).toBe('- [x] buy milk done:2026-11-25');
    expect(toggleTaskLine('  * [ ] nested due:2026-11-28', '2026-11-25')).toBe('  * [x] nested due:2026-11-28 done:2026-11-25');
    expect(toggleTaskLine('1. [ ] numbered  ', '2026-11-25')).toBe('1. [x] numbered done:2026-11-25');
  });

  it('unticks a task and removes the done date', () => {
    expect(toggleTaskLine('- [x] buy milk done:2026-11-25', '2026-11-26')).toBe('- [ ] buy milk');
    expect(toggleTaskLine('- [X] shout due:2026-11-28', '2026-11-26')).toBe('- [ ] shout due:2026-11-28');
  });

  it('ignores lines that are not tasks', () => {
    expect(toggleTaskLine('- buy milk', '2026-11-25')).toBeNull();
    expect(toggleTaskLine('[ ] not a list item', '2026-11-25')).toBeNull();
  });
});

describe('task metadata', () => {
  it('reads due and done dates', () => {
    expect(parseTaskMeta('a due:2026-11-28 done:2026-11-25')).toEqual({ due: '2026-11-28', done: '2026-11-25' });
    expect(parseTaskMeta('overdue:2026-11-28')).toEqual({ due: null, done: null });
  });

  it('classifies due dates', () => {
    expect(dueState('2026-11-24', '2026-11-25')).toBe('overdue');
    expect(dueState('2026-11-25', '2026-11-25')).toBe('today');
    expect(dueState('2026-12-01', '2026-11-25')).toBe('upcoming');
    expect(dueState(null, '2026-11-25')).toBe('none');
  });
});
