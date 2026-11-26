/** Formats a capture as a list item: "- 14:32 text", or "- [ ] text" when it starts with "[] " or "todo ". */
export function formatCapture(text: string, time: string | null): string {
  const lines = text.replace(/\r\n?/g, '\n').trim().split('\n');
  const first = lines[0] ?? '';
  const task = /^(?:\[\s?\]|todo:?)\s+(.+)$/i.exec(first);
  const head = task ? `- [ ] ${task[1]}` : `- ${time ? `${time} ` : ''}${first}`;
  return [head, ...lines.slice(1).map((l) => (l.trim() ? `  ${l}` : ''))].join('\n');
}

/** Appends a block at the end of a note, adding a line break first if the note doesn't end with one. */
export function appendBlock(content: string, block: string): string {
  if (!content) return `${block}\n`;
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const text = block.replace(/\n/g, newline);
  return content.endsWith('\n') ? `${content}${text}${newline}` : `${content}${newline}${text}${newline}`;
}
