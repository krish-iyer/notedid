import { splitFrontmatter } from './markdown.ts';

/**
 * Comments on a markdown document live in a separate note next to it ("doc.comments.md").
 * Each comment is a quote of the passage it is about, then the comment; comments are
 * separated by "---" lines. It stays readable (and editable) as an ordinary note.
 */
export interface DocComment {
  quote: string;
  text: string;
}

export function commentsPathFor(docPath: string): string {
  return docPath.replace(/\.md$/i, '.comments.md');
}

export function parseComments(content: string): DocComment[] {
  const { bodyOffset } = splitFrontmatter(content);
  const body = content.slice(bodyOffset).replace(/\r\n?/g, '\n');
  const comments: DocComment[] = [];
  for (const block of body.split(/\n---[ \t]*\n/)) {
    const lines = block.split('\n');
    const quote = lines.filter((l) => /^>\s?/.test(l)).map((l) => l.replace(/^>\s?/, ''));
    if (quote.length === 0) continue;
    // The comment is what follows the quote; anything above it (like the note's intro) isn't part of it.
    const lastQuoteLine = lines.reduce((last, l, i) => (/^>\s?/.test(l) ? i : last), -1);
    const text = lines.slice(lastQuoteLine + 1).join('\n').trim();
    comments.push({ quote: quote.join(' ').replace(/\s+/g, ' ').trim(), text });
  }
  return comments;
}

export function newCommentsNote(docTitle: string, docPath: string): string {
  const safeTitle = docTitle.replace(/[[\]|#]/g, '');
  return `---\ntype: comments\ntitle: ${JSON.stringify(`Comments on ${safeTitle}`)}\nabout: ${JSON.stringify(docPath)}\n---\nComments on [[${safeTitle}]].\n`;
}

export function appendComment(content: string, quote: string, text: string): string {
  const block = `> ${quote.replace(/\s+/g, ' ').trim()}\n\n${text.trim()}\n`;
  return `${content.replace(/\s+$/, '')}\n\n---\n\n${block}`;
}
