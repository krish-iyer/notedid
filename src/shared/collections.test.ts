import { describe, expect, it } from 'vitest';
import { addCluster, cardLine, parseBoard, serializeBoard } from './board.ts';
import { addToCollection, collectionsOf, deleteCollection, newCollectionsContent, removeFromCollection } from './collections.ts';

const PATHS: Record<string, string> = { 'Attention Is All You Need': 'papers/vaswani2017attention.md', 'Reconfig study': 'papers/reconfig-study.md', 'papers/second-study': 'papers/second-study.md' };
const resolve = (target: string) => PATHS[target] ?? null;
const paper = (target: string) => ({ path: PATHS[target] ?? '', line: cardLine('note', target) });

describe('paper collections', () => {
  it('start empty, and gain collections and papers', () => {
    let board = parseBoard(newCollectionsContent());
    expect(collectionsOf(board, resolve)).toEqual([]);
    board = addCluster(board, 'Thesis');
    const thesis = board.clusters[0]?.id ?? '';
    board = addToCollection(board, thesis, [paper('Attention Is All You Need'), paper('Reconfig study'), paper('Attention Is All You Need')], resolve);
    expect(serializeBoard(board)).toBe(`${newCollectionsContent()}\n## Thesis\n- [[Attention Is All You Need]]\n- [[Reconfig study]]\n`);
    expect([...(collectionsOf(board, resolve)[0]?.paths ?? [])]).toEqual(['papers/vaswani2017attention.md', 'papers/reconfig-study.md']);
  });

  it('a paper can be in several collections; removing takes it out of one only', () => {
    const board = parseBoard('# C\n\n## Thesis\n- [[Reconfig study]]\n- [[papers/second-study]]\n\n## Reading group\n- [[Reconfig study]]\n- [[Gone paper]]\n');
    const [thesis, group] = collectionsOf(board, resolve);
    expect(group?.paths).toEqual(new Set(['papers/reconfig-study.md']));
    const out = removeFromCollection(board, thesis?.id ?? '', new Set(['papers/reconfig-study.md']), resolve);
    expect(serializeBoard(out)).toBe('# C\n\n## Thesis\n- [[papers/second-study]]\n\n## Reading group\n- [[Reconfig study]]\n- [[Gone paper]]\n');
    expect(removeFromCollection(board, thesis?.id ?? '', new Set(['papers/nothing.md']), resolve)).toBe(board);
  });

  it('moving is removing from one and adding to another', () => {
    const board = parseBoard('# C\n\n## Thesis\n- [[Reconfig study]]\n\n## Later\n');
    const [thesis, later] = collectionsOf(board, resolve);
    const moved = addToCollection(removeFromCollection(board, thesis?.id ?? '', new Set(['papers/reconfig-study.md']), resolve), later?.id ?? '', [paper('Reconfig study')], resolve);
    expect(serializeBoard(moved)).toBe('# C\n\n## Thesis\n\n## Later\n- [[Reconfig study]]\n');
  });

  it('deleting a collection keeps the others', () => {
    const board = parseBoard('# C\n\n## Thesis\n- [[Reconfig study]]\n\n## Later\n- [[papers/second-study]]\n');
    expect(serializeBoard(deleteCollection(board, board.clusters[0]?.id ?? ''))).toBe('# C\n\n## Later\n- [[papers/second-study]]\n');
  });
});
