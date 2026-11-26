import { type Board, type BoardCard, type BoardCluster, CARD_ATTRS, cardsOf, replaceCardLines } from './board.ts';

/**
 * A dashboard is a markdown file like a board: each `## heading` is a tab and each list item under
 * it (`- [[Note]]`, `- [[Paper]]`, `- [[Board]]`) is something opened in that tab. The parsing and
 * card moves are the board's (see board.ts); these are the tab-level changes boards don't have.
 */

/** A new dashboard note with one empty tab. */
export function newDashboardContent(title: string): string {
  return ['---', 'type: dashboard', '---', `# ${title}`, '', '## Overview', ''].join('\n');
}

function isBlank(entry: BoardCluster['entries'][number] | undefined): boolean {
  return entry?.type === 'line' && entry.text.trim() === '';
}

/** Every tab ends with a blank line, so headings never run into the list above them and the file ends with a newline. */
function tidyTabs(clusters: BoardCluster[]): BoardCluster[] {
  return clusters.map((c) => (isBlank(c.entries[c.entries.length - 1]) ? c : { ...c, entries: [...c.entries, { type: 'line', text: '' }] }));
}

/** Removes a tab and the items in it. The items are links: the notes, papers and boards stay. */
export function removeTab(board: Board, tabId: string): Board {
  const clusters = board.clusters.filter((c) => c.id !== tabId);
  if (clusters.length === board.clusters.length) return board;
  return { ...board, clusters: tidyTabs(clusters) };
}

/** Moves a tab one place left (-1) or right (+1). */
export function moveTab(board: Board, tabId: string, delta: -1 | 1): Board {
  const from = board.clusters.findIndex((c) => c.id === tabId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= board.clusters.length) return board;
  const clusters = [...board.clusters];
  const [tab] = clusters.splice(from, 1);
  if (tab) clusters.splice(to, 0, tab);
  return { ...board, clusters: tidyTabs(clusters) };
}

export type ItemWidth = 'full' | 'half';

/** The width written after an item's link (`{full}` or `{half}`), or null if it has none. */
export function itemWidth(card: BoardCard): ItemWidth | null {
  if (card.attrs.includes('full')) return 'full';
  if (card.attrs.includes('half')) return 'half';
  return null;
}

/** Writes an item's width after its link (`- [[Note]] {full}`), or removes it with null. */
export function setItemWidth(board: Board, cardId: string, width: ItemWidth | null): Board {
  const card = board.clusters.flatMap(cardsOf).find((c) => c.id === cardId);
  if (!card || card.kind !== 'note') return board;
  const first = card.lines[0] ?? '';
  const bare = card.attrs.length > 0 ? first.replace(CARD_ATTRS, '') : first.trimEnd();
  return replaceCardLines(board, cardId, [width ? `${bare} {${width}}` : bare, ...card.lines.slice(1)]);
}

/** How many items a tab holds. */
export function itemCount(tab: BoardCluster): number {
  return cardsOf(tab).length;
}
