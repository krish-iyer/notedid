/**
 * Highlights and comments in a paper's review note. Each one is a block like:
 *
 *   > the quoted passage
 *   > — [p. 4](paper.pdf#page=4&hl=abcd1234)
 *
 *   The comment, over as many lines as you like.
 *
 * A resolved comment has " · resolved" after its page link. It stays in the note.
 *
 * The note is the source of truth for the text; the PDF positions live in <key>.highlights.json.
 */

export interface HighlightBlock {
  id: string;
  page: number | null;
  quote: string;
  comment: string;
  resolved: boolean;
  /** 0-based line of the first quote line. */
  quoteStart: number;
  /** 0-based line of the "> — [p. N](…hl=id)" line. */
  attribution: number;
  /** 0-based line where the block ends (exclusive): the next quote, heading, rule or the end. */
  end: number;
}

const ATTRIBUTION = /^(>\s*—?\s*\[p\.\s*(\d+)\]\([^)]*?[#&?]hl=([0-9a-z]+)[^)]*\))\s*(?:[·-]?\s*(resolved))?\s*$/i;
const BLOCK_END = /^(>|#{1,6}\s|---\s*$)/;

function linesOf(content: string): { lines: string[]; newline: string } {
  return { lines: content.split(/\r?\n/), newline: content.includes('\r\n') ? '\r\n' : '\n' };
}

export function parseHighlightBlocks(content: string): HighlightBlock[] {
  const { lines } = linesOf(content);
  const blocks: HighlightBlock[] = [];
  lines.forEach((line, i) => {
    const match = ATTRIBUTION.exec(line);
    if (!match) return;
    let start = i;
    while (start > 0 && /^>/.test(lines[start - 1] ?? '') && !ATTRIBUTION.test(lines[start - 1] ?? '')) start--;
    let end = i + 1;
    while (end < lines.length && !BLOCK_END.test(lines[end] ?? '')) end++;
    blocks.push({
      id: (match[3] ?? '').toLowerCase(),
      page: Number(match[2]) || null,
      quote: lines
        .slice(start, i)
        .map((l) => l.replace(/^>\s?/, ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
      comment: lines.slice(i + 1, end).join('\n').trim(),
      resolved: Boolean(match[4]),
      quoteStart: start,
      attribution: i,
      end,
    });
  });
  return blocks;
}

/** The text for a new highlight block (with its comment, if any). */
export function highlightBlock(quote: string, page: number, link: string, comment?: string | null): string {
  const quoted = `> ${quote.replace(/\s+/g, ' ').trim()}\n> — [p. ${page}](${link})`;
  return comment?.trim() ? `${quoted}\n\n${comment.trim()}` : quoted;
}

/** Replaces the comment under highlight `id`. Returns null if there is no such highlight. */
export function setHighlightComment(content: string, id: string, comment: string): string | null {
  const block = parseHighlightBlocks(content).find((b) => b.id === id);
  if (!block) return null;
  const { lines, newline } = linesOf(content);
  const atEnd = block.end >= lines.length;
  const text = comment.trim();
  const replacement = text ? ['', ...text.split(/\r?\n/), ''] : [''];
  // At the end of the note, keep the final line break (the last "line" is the empty string after it).
  lines.splice(block.attribution + 1, block.end - (block.attribution + 1), ...(atEnd && !text ? [''] : replacement));
  return lines.join(newline);
}

/** Marks highlight `id` resolved, or open again. Returns null if there is no such highlight. */
export function setHighlightResolved(content: string, id: string, resolved: boolean): string | null {
  const block = parseHighlightBlocks(content).find((b) => b.id === id);
  if (!block) return null;
  const { lines, newline } = linesOf(content);
  const link = ATTRIBUTION.exec(lines[block.attribution] ?? '')?.[1] ?? '';
  lines[block.attribution] = resolved ? `${link} · resolved` : link;
  return lines.join(newline);
}

/** Removes highlight `id`'s quote and comment from the note. Returns null if there is no such highlight. */
export function removeHighlightBlock(content: string, id: string): string | null {
  const block = parseHighlightBlocks(content).find((b) => b.id === id);
  if (!block) return null;
  const { lines, newline } = linesOf(content);
  const atEnd = block.end >= lines.length;
  lines.splice(block.quoteStart, block.end - block.quoteStart, ...(atEnd ? [''] : []));
  if (atEnd) {
    // End the note with a single line break.
    while (lines.length > 1 && lines[lines.length - 1] === '' && lines[lines.length - 2]?.trim() === '') lines.pop();
  } else if (block.quoteStart > 0 && lines[block.quoteStart - 1]?.trim() === '' && lines[block.quoteStart]?.trim() === '') {
    // Don't leave two blank lines where the block was.
    lines.splice(block.quoteStart, 1);
  }
  return lines.join(newline);
}
