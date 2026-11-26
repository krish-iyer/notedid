import { syntaxTree } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { rowsToMarkdownTable, tsvToMarkdownTable } from '../../shared/tables.ts';
import { api } from '../api.ts';
import { showToast } from '../toast.ts';
import { dirname, messageOf, relativePath } from '../util.ts';
import { notePathFacet, privateModeFacet } from './context.ts';

const URL_ONLY = /^https?:\/\/\S+$/;

/** A table copied from a web page or document, as a markdown table. */
export function htmlTableToMarkdown(html: string): string | null {
  const table = new DOMParser().parseFromString(html, 'text/html').querySelector('table');
  if (!table) return null;
  const rows = [...table.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('th, td')].map((cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim()));
  const nonEmpty = rows.filter((r) => r.length > 0);
  return nonEmpty.length >= 1 ? rowsToMarkdownTable(nonEmpty) : null;
}

/** Inserts a block (a table) on lines of its own, leaving the cursor on a fresh line below it. */
function insertBlock(view: EditorView, block: string): void {
  const { from, to } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const before = from > line.from ? view.state.lineBreak : '';
  const insert = view.state.toText(`${before}${block.replace(/\n/g, view.state.lineBreak)}${view.state.lineBreak}`);
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.paste', scrollIntoView: true });
}

function insideCodeOrLink(view: EditorView, pos: number): boolean {
  for (let node: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(view.state).resolveInner(pos, -1); node; node = node.parent) {
    if (/Code|URL|Link|WikiLink|Frontmatter/.test(node.name)) return true;
  }
  return false;
}

/** Pasting a URL: insert it, then swap in "[Page title](url)" once the title arrives (if the URL is still there untouched). */
function pasteUrl(view: EditorView, url: string): void {
  const { from } = view.state.selection.main;
  view.dispatch({ changes: { from, insert: url }, selection: { anchor: from + url.length }, userEvent: 'input.paste' });
  void api
    .unfurl(url)
    .then(({ title }) => {
      if (!title || view.state.doc.length === 0) return;
      const text = view.state.doc.toString();
      // Find our pasted URL closest to where it was put, not already inside a link.
      let best = -1;
      for (let at = text.indexOf(url); at >= 0; at = text.indexOf(url, at + 1)) {
        const prev = text[at - 1] ?? '';
        if (prev === '(' || prev === '<' || prev === '[') continue;
        if (best < 0 || Math.abs(at - from) < Math.abs(best - from)) best = at;
      }
      if (best < 0) return;
      const safeTitle = title.replace(/[[\]]/g, '');
      view.dispatch({ changes: { from: best, to: best + url.length, insert: `[${safeTitle}](${url})` }, userEvent: 'input.paste' });
    })
    .catch(() => undefined);
}

function isImage(file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(file.name);
}

/** Uploads files to the notes folder and links them at `pos` (images show inline). */
export async function uploadAndInsert(view: EditorView, files: File[], pos: number): Promise<void> {
  if (view.state.facet(privateModeFacet)) {
    showToast('Files can’t be added to the vault: they would be stored unencrypted.', 'error');
    return;
  }
  const notePath = view.state.facet(notePathFacet) ?? '';
  let at = pos;
  for (const file of files) {
    try {
      const { path } = await api.uploadFile(file);
      const target = relativePath(dirname(notePath), path).replace(/ /g, '%20');
      const name = file.name.replace(/[[\]]/g, '');
      const text = isImage(file) ? `![${name}](${target})` : `[${name}](${target})`;
      const lineStart = at === view.state.doc.lineAt(Math.min(at, view.state.doc.length)).from;
      const insert = `${lineStart ? '' : ' '}${text}`;
      view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length }, userEvent: 'input.paste' });
      at += insert.length;
    } catch (err) {
      showToast(`Could not add ${file.name}: ${messageOf(err)}`, 'error');
    }
  }
}

export const pasteHandling = EditorView.domEventHandlers({
  paste(event, view) {
    const data = event.clipboardData;
    if (!data) return false;
    const files = [...data.files];
    if (files.length > 0) {
      event.preventDefault();
      void uploadAndInsert(view, files, view.state.selection.main.from);
      return true;
    }
    const html = data.getData('text/html');
    const text = data.getData('text/plain');
    if (html && /<table/i.test(html)) {
      const table = htmlTableToMarkdown(html);
      if (table) {
        event.preventDefault();
        insertBlock(view, table);
        return true;
      }
    }
    const tsv = text ? tsvToMarkdownTable(text) : null;
    if (tsv) {
      event.preventDefault();
      insertBlock(view, tsv);
      return true;
    }
    const url = text.trim();
    if (URL_ONLY.test(url)) {
      const selection = view.state.selection.main;
      if (!selection.empty) {
        const label = view.state.sliceDoc(selection.from, selection.to).replace(/[[\]]/g, '');
        event.preventDefault();
        view.dispatch({ changes: { from: selection.from, to: selection.to, insert: `[${label}](${url})` }, userEvent: 'input.paste' });
        return true;
      }
      if (!view.state.facet(privateModeFacet) && !insideCodeOrLink(view, selection.from)) {
        event.preventDefault();
        pasteUrl(view, url);
        return true;
      }
    }
    return false;
  },
  drop(event, view) {
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length === 0) return false;
    event.preventDefault();
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
    void uploadAndInsert(view, files, pos);
    return true;
  },
});
