import { parseWikiTarget, safeDecodeURI } from './markdown.ts';
import { tagify } from './slug.ts';

/**
 * A project board is a markdown file: each `## heading` is a cluster and each top-level list
 * item under it is a card. Everything else (front matter, title, notes between items) is kept
 * exactly as written; moving a card only moves its lines.
 */

export type CardKind = 'note' | 'query' | 'link' | 'text';

export interface BoardCard {
  id: string;
  kind: CardKind;
  /** The card's lines, exactly as in the file (bullet line plus indented continuation lines). */
  lines: string[];
  /** First-line content after the bullet. */
  text: string;
  /** note: link target; link: URL. */
  target: string | null;
  label: string | null;
  /** query cards: the search query. */
  query: string | null;
  /** Words in a trailing `{…}` after a link, e.g. `- [[Note]] {full}`: how a dashboard shows it. */
  attrs: string[];
}

export type BoardEntry = { type: 'card'; card: BoardCard } | { type: 'line'; text: string };

export interface BoardCluster {
  id: string;
  title: string;
  headingLine: string;
  entries: BoardEntry[];
}

export interface Board {
  /** Lines before the first cluster heading (front matter, title, intro). */
  head: string[];
  clusters: BoardCluster[];
  title: string;
  /** The board's project tag from front matter (`tag: x`), lowercase, without '#'. */
  tag: string | null;
  lineSeparator: string;
}

const CLUSTER_HEADING = /^##\s+(.*?)\s*#*\s*$/;
const BULLET = /^[-*+]\s+(.*)$/;

export function cardsOf(cluster: BoardCluster): BoardCard[] {
  return cluster.entries.flatMap((e) => (e.type === 'card' ? [e.card] : []));
}

/** A trailing `{full}` (or other words in braces) after a card's link. */
export const CARD_ATTRS = /\s+\{([a-z][\w -]*)\}\s*$/i;

function classify(id: string, lines: string[]): BoardCard {
  const text = (BULLET.exec(lines[0] ?? '')?.[1] ?? '').trim();
  const base = { id, lines, text, target: null, label: null, query: null, attrs: [] as string[] };
  // Attributes count only after a link; on a text card, braces are just text.
  const attrMatch = CARD_ATTRS.exec(text);
  const link = attrMatch ? text.slice(0, attrMatch.index).trim() : text;
  const attrs = attrMatch ? (attrMatch[1] ?? '').trim().toLowerCase().split(/\s+/) : [];
  const query = /^query:\s*(.*)$/i.exec(text);
  if (query) return { ...base, kind: 'query', query: (query[1] ?? '').trim() };
  const wiki = /^\[\[([^\]]+)\]\]$/.exec(link);
  if (wiki) {
    const { target, label } = parseWikiTarget(wiki[1] ?? '');
    return { ...base, kind: 'note', target, label, attrs };
  }
  const mdLink = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(link);
  if (mdLink) {
    const url = mdLink[2] ?? '';
    const external = /^[a-z][a-z0-9+.-]*:/i.test(url);
    return { ...base, kind: external ? 'link' : 'note', target: external ? url : safeDecodeURI(url), label: mdLink[1] || null, attrs };
  }
  if (/^https?:\/\/\S+$/.test(text)) return { ...base, kind: 'link', target: text };
  return { ...base, kind: 'text' };
}

export function parseBoard(content: string): Board {
  const lineSeparator = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const board: Board = { head: [], clusters: [], title: '', tag: null, lineSeparator };

  let inFrontmatter = lines[0]?.trim() === '---';
  let cluster: BoardCluster | null = null;
  let card: BoardCard | null = null;

  lines.forEach((line, i) => {
    if (inFrontmatter) {
      board.head.push(line);
      const tag = /^tag:\s*(.+?)\s*$/i.exec(line);
      if (tag) board.tag = tagify(tag[1] ?? '') || null;
      if (i > 0 && /^(---|\.\.\.)\s*$/.test(line)) inFrontmatter = false;
      return;
    }
    const heading = CLUSTER_HEADING.exec(line);
    if (heading) {
      card = null;
      cluster = { id: `cluster-${board.clusters.length}`, title: heading[1] ?? '', headingLine: line, entries: [] };
      board.clusters.push(cluster);
      return;
    }
    if (!cluster) {
      board.head.push(line);
      const title = /^#\s+(.*?)\s*#*\s*$/.exec(line);
      if (title && !board.title) board.title = title[1] ?? '';
      return;
    }
    if (BULLET.test(line)) {
      card = classify(`${cluster.id}-card-${cluster.entries.length}`, [line]);
      cluster.entries.push({ type: 'card', card });
      return;
    }
    if (card && /^\s+\S/.test(line)) {
      card.lines.push(line);
      return;
    }
    card = null;
    cluster.entries.push({ type: 'line', text: line });
  });
  return board;
}

export function serializeBoard(board: Board): string {
  const lines = [...board.head];
  for (const cluster of board.clusters) {
    lines.push(cluster.headingLine);
    for (const entry of cluster.entries) {
      if (entry.type === 'card') lines.push(...entry.card.lines);
      else lines.push(entry.text);
    }
  }
  return lines.join(board.lineSeparator);
}

function cloneBoard(board: Board): Board {
  return { ...board, head: [...board.head], clusters: board.clusters.map((c) => ({ ...c, entries: [...c.entries] })) };
}

/** Inserts a card entry before the `index`-th card of a cluster (or after its last card). */
function insertCard(cluster: BoardCluster, card: BoardCard, index: number): void {
  const cardPositions = cluster.entries.flatMap((e, i) => (e.type === 'card' ? [i] : []));
  let at: number;
  if (index < cardPositions.length) at = cardPositions[index] ?? 0;
  else if (cardPositions.length > 0) at = (cardPositions[cardPositions.length - 1] ?? 0) + 1;
  else {
    // An empty cluster: right after the heading, skipping a single blank line if there is one.
    at = cluster.entries[0]?.type === 'line' && cluster.entries[0].text.trim() === '' && cluster.entries.length > 1 ? 1 : 0;
  }
  cluster.entries.splice(at, 0, { type: 'card', card });
}

export function moveCard(board: Board, cardId: string, toClusterId: string, toIndex: number): Board {
  const next = cloneBoard(board);
  let moving: BoardCard | null = null;
  let fromCluster: BoardCluster | null = null;
  let fromIndex = -1;
  for (const cluster of next.clusters) {
    const at = cluster.entries.findIndex((e) => e.type === 'card' && e.card.id === cardId);
    if (at >= 0) {
      const entry = cluster.entries[at];
      if (entry?.type === 'card') moving = entry.card;
      fromIndex = cardsOf(cluster).findIndex((c) => c.id === cardId);
      fromCluster = cluster;
      cluster.entries.splice(at, 1);
      break;
    }
  }
  const target = next.clusters.find((c) => c.id === toClusterId);
  if (!moving || !target) return board;
  // Moving down within the same cluster: the card's old slot is gone, so the index shifts by one.
  const index = fromCluster === target && fromIndex < toIndex ? toIndex - 1 : toIndex;
  insertCard(target, moving, index);
  return next;
}

export function addCard(board: Board, clusterId: string, line: string, index = Number.MAX_SAFE_INTEGER): Board {
  const next = cloneBoard(board);
  const cluster = next.clusters.find((c) => c.id === clusterId);
  if (!cluster) return board;
  insertCard(cluster, classify(`${cluster.id}-card-new-${cluster.entries.length}`, [line]), index);
  return next;
}

export function removeCard(board: Board, cardId: string): Board {
  const next = cloneBoard(board);
  for (const cluster of next.clusters) {
    cluster.entries = cluster.entries.filter((e) => !(e.type === 'card' && e.card.id === cardId));
  }
  return next;
}

/** Replaces a card's lines (e.g. after editing a text card). */
export function replaceCard(board: Board, cardId: string, line: string): Board {
  return replaceCardLines(board, cardId, [line]);
}

/** Replaces a card's lines, keeping any it had below its first (pass them in `lines`). */
export function replaceCardLines(board: Board, cardId: string, lines: string[]): Board {
  const next = cloneBoard(board);
  for (const cluster of next.clusters) {
    const at = cluster.entries.findIndex((e) => e.type === 'card' && e.card.id === cardId);
    if (at >= 0) cluster.entries[at] = { type: 'card', card: classify(cardId, lines) };
  }
  return next;
}

export function addCluster(board: Board, title: string): Board {
  const next = cloneBoard(board);
  const last = next.clusters[next.clusters.length - 1];
  // Keep a blank line before the new heading.
  if (last) {
    const tail = last.entries[last.entries.length - 1];
    if (!(tail?.type === 'line' && tail.text.trim() === '')) last.entries.push({ type: 'line', text: '' });
  } else if ((next.head[next.head.length - 1] ?? '').trim() !== '') {
    next.head.push('');
  }
  // The trailing blank line keeps the file ending with a newline.
  next.clusters.push({ id: `cluster-${next.clusters.length}`, title, headingLine: `## ${title}`, entries: [{ type: 'line', text: '' }] });
  return next;
}

export function renameCluster(board: Board, clusterId: string, title: string): Board {
  const next = cloneBoard(board);
  const cluster = next.clusters.find((c) => c.id === clusterId);
  if (!cluster) return board;
  cluster.title = title;
  cluster.headingLine = `## ${title}`;
  return next;
}

/** Removes a cluster heading; its cards and lines join the previous cluster (or the head). */
export function removeCluster(board: Board, clusterId: string): Board {
  const next = cloneBoard(board);
  const index = next.clusters.findIndex((c) => c.id === clusterId);
  const cluster = next.clusters[index];
  if (!cluster || cardsOf(cluster).length > 0) return board;
  next.clusters.splice(index, 1);
  return next;
}

/** The line for a new card. */
export function cardLine(kind: CardKind, value: string): string {
  switch (kind) {
    case 'note':
      return `- [[${value}]]`;
    case 'query':
      return `- query: ${value}`;
    case 'link':
      return `- ${value}`;
    case 'text':
      return `- ${value.replace(/\r?\n/g, ' ')}`;
  }
}

/** A new, empty board note. */
export function newBoardContent(title: string, tag: string | null): string {
  const frontmatter = ['---', 'type: board', ...(tag ? [`tag: ${tag}`] : []), '---'];
  return [...frontmatter, `# ${title}`, '', '## To do', '', '## Doing', '', '## Done', ''].join('\n');
}
