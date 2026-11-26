import { syntaxTree } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { isISODate } from '../../shared/dates.ts';
import { parseWikiTarget, safeDecodeURI } from '../../shared/markdown.ts';
import { api, fileUrl } from '../api.ts';
import { encodeNotePath, navigate, noteHref } from '../router.ts';
import { refreshNotes, resolveNote } from '../stores.ts';
import { showToast } from '../toast.ts';
import { dirname, joinPath, messageOf } from '../util.ts';
import { notePathFacet, privateModeFacet } from './context.ts';
import { DATE_IN_TEXT } from './livePreview.ts';

export type LinkTarget =
  | { kind: 'wiki'; target: string; heading: string | null }
  | { kind: 'url'; url: string }
  | { kind: 'file'; href: string }
  | { kind: 'tag'; tag: string }
  | { kind: 'date'; date: string };

/** The link, tag or date at a document position, if any. */
export function linkAt(view: EditorView, pos: number): LinkTarget | null {
  const { state } = view;
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === 'WikiLink') {
      const { target, heading } = parseWikiTarget(state.sliceDoc(node.from + 2, node.to - 2));
      return { kind: 'wiki', target, heading };
    }
    if (node.name === 'Link') {
      const url = node.getChild('URL');
      if (!url) return null;
      const href = state.sliceDoc(url.from, url.to).replace(/^<|>$/g, '');
      return /^[a-z][a-z0-9+.-]*:/i.test(href) ? { kind: 'url', url: href } : { kind: 'file', href };
    }
    if (node.name === 'URL') return { kind: 'url', url: state.sliceDoc(node.from, node.to) };
    if (node.name === 'Tag') return { kind: 'tag', tag: state.sliceDoc(node.from + 1, node.to).toLowerCase() };
  }
  const line = state.doc.lineAt(pos);
  for (const match of line.text.matchAll(DATE_IN_TEXT)) {
    const start = line.from + (match.index ?? 0);
    if (pos >= start && pos <= start + 10 && isISODate(match[1] ?? '')) return { kind: 'date', date: match[1] ?? '' };
  }
  return null;
}

/** Event other screens listen to: "show this place in this PDF". */
export const PDF_LOCATION_EVENT = 'notesapp:pdf-location';

export interface PdfLocation {
  /** The paper's review note. */
  paperPath: string;
  page: number | null;
  highlight: string | null;
}

function openPdf(reference: string, hash: string): void {
  const params = new URLSearchParams(hash);
  const page = Number(params.get('page')) || null;
  const highlight = params.get('hl');
  const paper = resolveNote(reference) ?? resolveNote(reference.split('/').pop() ?? reference);
  if (!paper) {
    window.open(fileUrl(reference), '_blank', 'noopener');
    return;
  }
  const paperUrl = `/paper/${encodeNotePath(paper.path)}`;
  if (location.pathname === paperUrl) {
    window.dispatchEvent(new CustomEvent<PdfLocation>(PDF_LOCATION_EVENT, { detail: { paperPath: paper.path, page, highlight } }));
    return;
  }
  const query = new URLSearchParams();
  if (page) query.set('page', String(page));
  if (highlight) query.set('hl', highlight);
  navigate(`${paperUrl}${query.size ? `?${query}` : ''}`);
}

/**
 * Opens a link: notes and papers in the app, web pages in a new tab. A link to a missing note
 * creates it, except in private mode (the vault), where nothing may leave the browser unencrypted.
 */
export async function openLink(target: LinkTarget, fromPath: string | null, options: { privateMode?: boolean } = {}): Promise<void> {
  switch (target.kind) {
    case 'url':
      window.open(target.url, '_blank', 'noopener,noreferrer');
      return;
    case 'tag':
      if (options.privateMode) {
        showToast('Tags in the vault stay in the vault: search for them in the vault’s own search box.');
        return;
      }
      navigate(`/search?q=${encodeURIComponent(`tag:${target.tag}`)}`);
      return;
    case 'date':
      navigate(`/day/${target.date}`);
      return;
    case 'file': {
      const [file = '', hash = ''] = target.href.split('#');
      const path = fromPath ? joinPath(dirname(fromPath), safeDecodeURI(file)) : safeDecodeURI(file);
      if (/\.pdf$/i.test(path)) return openPdf(path, hash);
      if (/\.md$/i.test(path)) {
        const note = resolveNote(path);
        navigate(noteHref(note?.path ?? path, note?.kind, hash ? safeDecodeURI(hash) : null));
        return;
      }
      window.open(fileUrl(path), '_blank', 'noopener');
      return;
    }
    case 'wiki': {
      if (/\.pdf$/i.test(target.target)) return openPdf(target.target, target.heading ?? '');
      const note = resolveNote(target.target, fromPath ?? undefined);
      if (note) {
        navigate(noteHref(note.path, note.kind, target.heading));
        return;
      }
      if (options.privateMode) {
        showToast(`There’s no note called “${target.target}”. (From the vault, links don’t create notes, so the name stays private.)`);
        return;
      }
      try {
        const { path } = await api.createNote(target.target);
        await refreshNotes();
        navigate(noteHref(path));
      } catch (err) {
        showToast(`Could not create “${target.target}”: ${messageOf(err)}`, 'error');
      }
    }
  }
}

const LINKISH = '.cm-wikilink, .cm-link-text, .cm-link-raw, .cm-url, .cm-tag, .cm-date';

/**
 * Clicking a link opens it. On the line being edited, plain clicks place the cursor as usual
 * and Ctrl/Cmd-click opens the link.
 */
export const linkClicks = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || !(event.target instanceof Element) || !event.target.closest(LINKISH)) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;
    const target = linkAt(view, pos);
    if (!target) return false;
    const lineNumber = view.state.doc.lineAt(pos).number;
    const editingLine =
      view.hasFocus &&
      view.state.selection.ranges.some((r) => view.state.doc.lineAt(r.from).number <= lineNumber && view.state.doc.lineAt(r.to).number >= lineNumber);
    if (editingLine && !(event.ctrlKey || event.metaKey)) return false;
    event.preventDefault();
    void openLink(target, view.state.facet(notePathFacet), { privateMode: view.state.facet(privateModeFacet) });
    return true;
  },
});
