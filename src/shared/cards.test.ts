import { describe, expect, it } from 'vitest';
import {
  cardFacets,
  cardMatches,
  findCards,
  headingsIn,
  newCardLines,
  propertyLine,
  propertyParts,
  setPropertyValue,
  statusFacet,
  taskLinesIn,
  toneOf,
  valueKind,
  valueParts,
} from './cards.ts';

const NOTE = [
  '---', // 0
  'type: note',
  'status:: not a card',
  '---',
  '# Review', // 4
  'status:: draft',
  '',
  '## Review points', // 7
  '',
  '### A1 · Missing baseline', // 9
  'reviewer:: A',
  'status:: needs answer',
  'theme:: Evaluation, Clarity',
  '',
  '**They said.** Compare with a baseline.',
  '',
  '#### Detail', // 16
  'more',
  '',
  '### A2 · Cloud', // 19
  'status:: done',
  '',
  '```',
  '### not a heading',
  'status:: inside code',
  '```', // 25
  '',
  '### Plain heading', // 27
  'no properties',
  '',
  '### B1 · Other', // 30
  'status:: open',
  '## Next section', // 32
];

describe('finding cards', () => {
  it('finds headings with properties right under them, in sets of neighbours', () => {
    const sets = findCards(NOTE);
    expect(sets.map((s) => ({ level: s.level, parent: s.parent, cards: s.cards.map((c) => [c.title, c.start, c.end, c.last]) }))).toEqual([
      {
        level: 3,
        parent: 'Review points',
        cards: [
          ['A1 · Missing baseline', 9, 17, 18],
          ['A2 · Cloud', 19, 25, 26],
        ],
      },
      { level: 3, parent: 'Review points', cards: [['B1 · Other', 30, 31, 31]] },
    ]);
    expect(sets[0]?.cards[0]?.properties).toEqual([
      { key: 'reviewer', value: 'A', line: 10 },
      { key: 'status', value: 'needs answer', line: 11 },
      { key: 'theme', value: 'Evaluation, Clarity', line: 12 },
    ]);
  });

  it('leaves out the front matter, code, the note title and deeper headings inside a card', () => {
    expect(headingsIn(NOTE).map((h) => h.line)).toEqual([4, 7, 9, 16, 19, 27, 30, 32]);
    expect(findCards(['# Title', 'status:: draft', '', 'Text'])).toEqual([]);
    const nested = findCards(['## Reviewer A', 'verdict:: weak accept', '### A1', 'status:: open', '## Reviewer B', 'verdict:: accept']);
    expect(nested.map((s) => s.cards.map((c) => c.title))).toEqual([['Reviewer A', 'Reviewer B']]);
  });

  it('needs a space after "::", so C++ stays text', () => {
    expect(propertyLine('std::vector<int> grows')).toBeNull();
    expect(propertyLine('status:: done ')).toEqual({ key: 'status', value: 'done' });
    expect(propertyLine('status::')).toEqual({ key: 'status', value: '' });
    expect(propertyLine('Due-date:: 2026-12-01')).toEqual({ key: 'Due-date', value: '2026-12-01' });
    expect(propertyLine('- status:: done')).toBeNull();
    expect(findCards(['## C++', 'std::vector is a container'])).toEqual([]);
  });

  it('reads headings as markdown does', () => {
    const titles = headingsIn(['### Title ###', '### C# notes', '####### seven', '#tag', '  ## indented', '~~~', '# in code', '~~~']).map((h) => h.title);
    expect(titles).toEqual(['Title', 'C# notes', 'indented']);
    expect(headingsIn(['````md', '```', '# still code', '```', '````', '## after']).map((h) => h.title)).toEqual(['after']);
  });

  it('finds the tasks whose checkboxes show, in order', () => {
    expect(taskLinesIn(['- [ ] one', '- [ ]', '  - [x] two', '```', '- [ ] code', '```', '1. [ ] three', '> - [ ] quoted', '- not a task'])).toEqual([0, 2, 6]);
  });
});

describe('values', () => {
  it('splits at commas, except in links and sentences', () => {
    expect(valueParts('Evaluation, Clarity')).toEqual([
      { text: 'Evaluation', from: 0, to: 10 },
      { text: 'Clarity', from: 12, to: 19 },
    ]);
    expect(valueParts('Agree, but the second experiment already answers this').map((p) => p.text)).toEqual(['Agree, but the second experiment already answers this']);
    expect(valueParts('[§3.1](paper.pdf#page=3), [§6](paper.pdf#page=7)').map((p) => p.text)).toEqual(['[§3.1](paper.pdf#page=3)', '[§6](paper.pdf#page=7)']);
    expect(valueParts('[[Smith, 2024]]').map((p) => p.text)).toEqual(['[[Smith, 2024]]']);
    expect(valueParts('Smith (2024, 2025)').map((p) => p.text)).toEqual(['Smith (2024, 2025)']);
    expect(valueParts('`a,b`, c').map((p) => p.text)).toEqual(['`a,b`', 'c']);
    expect(valueParts('  ')).toEqual([]);
  });

  it('tells links, words and sentences apart', () => {
    expect(valueKind('[§3.1](paper.pdf#page=3)')).toBe('link');
    expect(valueKind('[[Some note]]')).toBe('link');
    expect(valueKind('https://example.com/a')).toBe('link');
    expect(valueKind('needs answer')).toBe('word');
    expect(valueKind('this is a whole sentence about it')).toBe('text');
  });

  it('finds each value on its line', () => {
    expect(propertyParts('theme::  A,B')).toEqual({ key: 'theme', parts: [{ text: 'A', from: 9, to: 10 }, { text: 'B', from: 11, to: 12 }] });
  });

  it('changes, adds and removes one value, keeping the rest of the line', () => {
    expect(setPropertyValue('status:: needs answer', 0, 'done')).toBe('status:: done');
    expect(setPropertyValue('theme:: Evaluation,  Clarity', 1, 'Novelty')).toBe('theme:: Evaluation,  Novelty');
    expect(setPropertyValue('theme:: A, B', 0, null)).toBe('theme:: B');
    expect(setPropertyValue('theme:: A, B', 1, null)).toBe('theme:: A');
    expect(setPropertyValue('theme:: A, B, C', 1, '')).toBe('theme:: A, C');
    expect(setPropertyValue('status:: done', 0, null)).toBe('status:: ');
    expect(setPropertyValue('theme:: A, B', 2, 'C')).toBe('theme:: A, B, C');
    expect(setPropertyValue('status::', 0, '  in   progress ')).toBe('status:: in progress');
    expect(setPropertyValue('status:: ', 3, '')).toBe('status:: ');
    expect(setPropertyValue('not a property', 0, 'x')).toBeNull();
  });

  it('writes a new card with empty values ready to type in', () => {
    expect(newCardLines(3, 'New card', [['status', ''], ['theme', 'Scope']])).toEqual(['### New card', 'status:: ', 'theme:: Scope']);
    expect(newCardLines(1, 'T', [])).toEqual(['## T']);
  });
});

const p = (key: string, value: string) => ({ key, value, line: 0 });

describe('counts and filters', () => {
  const cards = [
    { properties: [p('status', 'needs answer'), p('reviewer', 'A'), p('paper', '[§1](x.pdf#page=1)')] },
    { properties: [p('Status', 'Done'), p('reviewer', 'A')] },
    { properties: [p('status', 'done'), p('reviewer', 'B'), p('note', 'A long sentence that is not a word at all')] },
  ];

  it('counts the values of properties made of words', () => {
    expect(cardFacets(cards)).toEqual([
      {
        key: 'status',
        id: 'status',
        values: [
          { value: 'needs answer', id: 'needs answer', count: 1 },
          { value: 'Done', id: 'done', count: 2 },
        ],
      },
      {
        key: 'reviewer',
        id: 'reviewer',
        values: [
          { value: 'A', id: 'a', count: 2 },
          { value: 'B', id: 'b', count: 1 },
        ],
      },
    ]);
    expect(statusFacet(cardFacets(cards))?.id).toBe('status');
    expect(statusFacet(cardFacets([{ properties: [p('theme', 'x')] }]))).toBeNull();
  });

  it('leaves out properties where every card has its own value', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ properties: [p('id', `P${i}`), p('status', i % 2 ? 'done' : 'open')] }));
    expect(cardFacets(many).map((f) => f.id)).toEqual(['status']);
    expect(cardFacets([{ properties: [p('theme', 'A, B')] }, { properties: [p('theme', 'b')] }])[0]?.values).toEqual([
      { value: 'A', id: 'a', count: 1 },
      { value: 'B', id: 'b', count: 2 },
    ]);
  });

  it('filters by values (any of them, for every property) and by words', () => {
    const shown = (values: Record<string, string[]>, search = '') => cards.map((c, i) => (cardMatches(c, `card ${i} ${c.properties.map((x) => x.value).join(' ')}`, { values, search }) ? i : -1)).filter((i) => i >= 0);
    expect(shown({})).toEqual([0, 1, 2]);
    expect(shown({ status: ['done'] })).toEqual([1, 2]);
    expect(shown({ status: ['done', 'needs answer'], reviewer: ['a'] })).toEqual([0, 1]);
    expect(shown({}, 'SENTENCE long')).toEqual([2]);
    expect(shown({ status: [] }, '  ')).toEqual([0, 1, 2]);
  });
});

describe('colours', () => {
  it('knows the usual words and gives the same colour to the same value', () => {
    expect(toneOf('Done')).toBe('done');
    expect(toneOf('needs answer')).toBe('open');
    expect(toneOf('needs more experiments')).toBe('open');
    expect(toneOf('In-Progress')).toBe('active');
    expect(toneOf('to_do')).toBe('open');
    expect(toneOf('disagree')).toBe('problem');
    expect(toneOf('Clarity')).toMatch(/^c[0-5]$/);
    expect(toneOf('Clarity')).toBe(toneOf(' clarity '));
  });
});
