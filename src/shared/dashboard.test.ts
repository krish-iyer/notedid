import { describe, expect, it } from 'vitest';
import { addCard, addCluster, cardLine, parseBoard, serializeBoard } from './board.ts';
import { itemCount, itemWidth, moveTab, newDashboardContent, removeTab, setItemWidth } from './dashboard.ts';

const DASH = ['---', 'type: dashboard', '---', '# Research', '', '## Reading', '- [[Attention Is All You Need]]', '- [[Proj board]]', '', '## Writing', '- [[Draft]]', ''].join('\n');

describe('dashboards', () => {
  it('start with one empty tab', () => {
    const dash = parseBoard(newDashboardContent('Research'));
    expect(dash.title).toBe('Research');
    expect(dash.clusters.map((c) => c.title)).toEqual(['Overview']);
    expect(newDashboardContent('Research').endsWith('\n')).toBe(true);
  });

  it('add tabs and items like a board', () => {
    let dash = parseBoard(newDashboardContent('Research'));
    dash = addCluster(dash, 'Papers');
    dash = addCard(dash, dash.clusters[1]?.id ?? '', cardLine('note', 'Attention Is All You Need'));
    expect(serializeBoard(dash)).toBe('---\ntype: dashboard\n---\n# Research\n\n## Overview\n\n## Papers\n- [[Attention Is All You Need]]\n');
    expect(dash.clusters.map(itemCount)).toEqual([0, 1]);
  });

  it('move tabs left and right, keeping blank lines between them', () => {
    const dash = parseBoard(DASH);
    const writing = dash.clusters[1]?.id ?? '';
    const moved = serializeBoard(moveTab(dash, writing, -1));
    expect(moved).toBe(['---', 'type: dashboard', '---', '# Research', '', '## Writing', '- [[Draft]]', '', '## Reading', '- [[Attention Is All You Need]]', '- [[Proj board]]', ''].join('\n'));
    expect(moveTab(dash, writing, 1)).toBe(dash);
    expect(moveTab(dash, dash.clusters[0]?.id ?? '', -1)).toBe(dash);
  });

  it('remove a tab with its items', () => {
    const dash = parseBoard(DASH);
    expect(serializeBoard(removeTab(dash, dash.clusters[0]?.id ?? ''))).toBe(['---', 'type: dashboard', '---', '# Research', '', '## Writing', '- [[Draft]]', ''].join('\n'));
    expect(serializeBoard(removeTab(dash, dash.clusters[1]?.id ?? ''))).toBe(['---', 'type: dashboard', '---', '# Research', '', '## Reading', '- [[Attention Is All You Need]]', '- [[Proj board]]', ''].join('\n'));
    expect(removeTab(dash, 'nope')).toBe(dash);
  });
});

describe('item widths', () => {
  const DOC = ['# D', '', '## Tab', '- [[Meeting notes]]', '  - a sub-point stays with it', '* [[Reconfig study]] {half}', '- just text {not a width}', ''].join('\n');

  it('reads {full} and {half} after a link, and keeps the link target', async () => {
    const { cardsOf } = await import('./board.ts');
    const cards = cardsOf(parseBoard(DOC).clusters[0] as never);
    expect(cards.map((c) => [c.kind, c.target, c.attrs])).toEqual([
      ['note', 'Meeting notes', []],
      ['note', 'Reconfig study', ['half']],
      ['text', null, []],
    ]);
    expect(cards.map(itemWidth)).toEqual([null, 'half', null]);
  });

  it('sets, changes and clears the width, keeping the bullet and lines below', async () => {
    const { cardsOf } = await import('./board.ts');
    const dash = parseBoard(DOC);
    const [note, paper, text] = cardsOf(dash.clusters[0] as never);
    const full = serializeBoard(setItemWidth(dash, note?.id ?? '', 'full'));
    expect(full).toContain('- [[Meeting notes]] {full}\n  - a sub-point stays with it\n');
    expect(serializeBoard(setItemWidth(dash, paper?.id ?? '', 'full'))).toContain('* [[Reconfig study]] {full}\n');
    expect(serializeBoard(setItemWidth(dash, paper?.id ?? '', null))).toContain('* [[Reconfig study]]\n- just text');
    expect(setItemWidth(dash, text?.id ?? '', 'full')).toBe(dash);
  });
});
