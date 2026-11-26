import { describe, expect, it } from 'vitest';
import { addCard, addCluster, cardsOf, moveCard, newBoardContent, parseBoard, removeCard, renameCluster, serializeBoard } from './board.ts';

const BOARD = [
  '---',
  'type: board',
  'tag: projectx',
  '---',
  '# Project X',
  '',
  'Everything for project X.',
  '',
  '## Reading',
  '- [[papers/smith2024]]',
  '- [[Related work|related]]',
  '  with a continuation line',
  '',
  '## Open tasks',
  '- query: is:task is:open tag:projectx',
  '',
  '## Ideas',
  '- Ask about the cluster quota',
  '- https://example.com/idea',
  '- [Spec](../notes/spec.md)',
  '',
].join('\n');

describe('parseBoard', () => {
  const board = parseBoard(BOARD);

  it('reads the title, tag and clusters', () => {
    expect(board.title).toBe('Project X');
    expect(board.tag).toBe('projectx');
    expect(board.clusters.map((c) => c.title)).toEqual(['Reading', 'Open tasks', 'Ideas']);
  });

  it('classifies cards', () => {
    const cards = board.clusters.flatMap(cardsOf).map((c) => [c.kind, c.target ?? c.query ?? c.text, c.label]);
    expect(cards).toEqual([
      ['note', 'papers/smith2024', null],
      ['note', 'Related work', 'related'],
      ['query', 'is:task is:open tag:projectx', null],
      ['text', 'Ask about the cluster quota', null],
      ['link', 'https://example.com/idea', null],
      ['note', '../notes/spec.md', 'Spec'],
    ]);
  });

  it('round-trips the file exactly', () => {
    expect(serializeBoard(board)).toBe(BOARD);
    const crlf = BOARD.replace(/\n/g, '\r\n');
    expect(serializeBoard(parseBoard(crlf))).toBe(crlf);
  });
});

describe('board edits', () => {
  it('moves a card, with its continuation lines, to another cluster', () => {
    const board = parseBoard(BOARD);
    const related = cardsOf(board.clusters[0]!)[1]!;
    const moved = serializeBoard(moveCard(board, related.id, board.clusters[2]!.id, 1));
    expect(moved).toContain('## Ideas\n- Ask about the cluster quota\n- [[Related work|related]]\n  with a continuation line\n- https://example.com/idea');
    expect(moved).toContain('## Reading\n- [[papers/smith2024]]\n\n## Open tasks');
  });

  it('reorders cards within a cluster', () => {
    const board = parseBoard(BOARD);
    const [first] = cardsOf(board.clusters[0]!);
    const reordered = moveCard(board, first!.id, board.clusters[0]!.id, 2);
    expect(cardsOf(reordered.clusters[0]!).map((c) => c.target)).toEqual(['Related work', 'papers/smith2024']);
  });

  it('adds and removes cards and clusters', () => {
    let board = parseBoard(BOARD);
    board = addCard(board, board.clusters[1]!.id, '- [[New note]]');
    board = addCluster(board, 'Later');
    board = addCard(board, board.clusters[3]!.id, '- a thought');
    board = removeCard(board, cardsOf(board.clusters[0]!)[0]!.id);
    board = renameCluster(board, board.clusters[1]!.id, 'Tasks');
    const text = serializeBoard(board);
    expect(text).toContain('## Tasks\n- query: is:task is:open tag:projectx\n- [[New note]]\n');
    expect(text.endsWith('## Later\n- a thought\n')).toBe(true);
    expect(text).not.toContain('smith2024');
  });

  it('creates a new board with three clusters', () => {
    const board = parseBoard(newBoardContent('Thesis', 'thesis'));
    expect(board.tag).toBe('thesis');
    expect(board.clusters.map((c) => c.title)).toEqual(['To do', 'Doing', 'Done']);
    const withCard = serializeBoard(addCard(board, board.clusters[0]!.id, '- [[Chapter 1]]'));
    expect(withCard).toContain('## To do\n- [[Chapter 1]]\n\n## Doing');
  });
});
