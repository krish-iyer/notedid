import { addCard, type Board, cardsOf } from './board.ts';
import { removeTab } from './dashboard.ts';

/**
 * Collections in the paper library (like Zotero's): named groups you make and put papers in. They
 * live in one markdown file in the board format: each `## heading` is a collection and each
 * `- [[Paper]]` under it a paper in it. A paper can be in several collections.
 */

export const COLLECTIONS_PATH = 'papers/collections.md';

export function newCollectionsContent(): string {
  return ['---', 'type: collections', '---', '# Paper collections', '', 'Each heading is a collection in the paper library, and each item a paper in it. A paper can be in several.', ''].join('\n');
}

export interface PaperCollection {
  id: string;
  title: string;
  /** Paths of the papers in it (links that no longer lead to a note are left out). */
  paths: Set<string>;
}

/** The collections, with links resolved to note paths by `resolve`. */
export function collectionsOf(board: Board, resolve: (target: string) => string | null): PaperCollection[] {
  return board.clusters.map((c) => ({
    id: c.id,
    title: c.title,
    paths: new Set(cardsOf(c).flatMap((card) => (card.kind === 'note' && card.target ? [resolve(card.target)].filter((p): p is string => p !== null) : []))),
  }));
}

/** Adds papers to a collection (`line` is the list item for each), skipping ones already in it. */
export function addToCollection(board: Board, collectionId: string, papers: { path: string; line: string }[], resolve: (target: string) => string | null): Board {
  const cluster = board.clusters.find((c) => c.id === collectionId);
  if (!cluster) return board;
  const inside = collectionsOf(board, resolve).find((c) => c.id === collectionId)?.paths ?? new Set<string>();
  let next = board;
  for (const paper of papers) {
    if (inside.has(paper.path)) continue;
    inside.add(paper.path);
    next = addCard(next, collectionId, paper.line);
  }
  return next;
}

/** Takes papers out of a collection (they stay in the library). */
export function removeFromCollection(board: Board, collectionId: string, paths: ReadonlySet<string>, resolve: (target: string) => string | null): Board {
  const cluster = board.clusters.find((c) => c.id === collectionId);
  if (!cluster) return board;
  const leaving = new Set(cardsOf(cluster).flatMap((card) => (card.kind === 'note' && card.target && paths.has(resolve(card.target) ?? '') ? [card.id] : [])));
  if (leaving.size === 0) return board;
  return {
    ...board,
    clusters: board.clusters.map((c) => (c.id === collectionId ? { ...c, entries: c.entries.filter((e) => !(e.type === 'card' && leaving.has(e.card.id))) } : c)),
  };
}

/** Deletes a collection. The papers in it stay in the library. */
export function deleteCollection(board: Board, collectionId: string): Board {
  return removeTab(board, collectionId);
}
