import DOMPurify from 'dompurify';
import { Marked, type Tokens } from 'marked';
import { type MouseEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { appendComment, commentsPathFor, type DocComment, newCommentsNote, parseComments } from '../../shared/comments.ts';
import { parseWikiTarget, safeDecodeURI, splitFrontmatter } from '../../shared/markdown.ts';
import { fetchNote, fileUrl, SaveConflict, saveNote } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import { openLink } from '../editor/links.ts';
import { useLiveData } from '../hooks.ts';
import { encodeNotePath, Link, noteHref } from '../router.ts';
import { useNote } from '../stores.ts';
import { showToast } from '../toast.ts';
import { dirname, joinPath, messageOf } from '../util.ts';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/** Markdown → safe HTML, with [[links]] and images from the notes folder. */
function renderMarkdown(content: string, notePath: string): string {
  const markdown = new Marked({ gfm: true, async: false });
  markdown.use({
    extensions: [
      {
        name: 'wikilink',
        level: 'inline',
        start: (src: string) => {
          const i = src.indexOf('[[');
          return i < 0 ? undefined : i;
        },
        tokenizer: (src: string) => {
          const match = /^\[\[([^\]\n]+)\]\]/.exec(src);
          return match ? { type: 'wikilink', raw: match[0], inner: match[1] ?? '' } : undefined;
        },
        renderer: (token) => {
          const { target, heading, label } = parseWikiTarget(String(token.inner));
          return `<a href="#" class="wikilink" data-target="${escapeHtml(target)}" data-heading="${escapeHtml(heading ?? '')}">${escapeHtml(label ?? target)}</a>`;
        },
      },
    ],
    renderer: {
      image({ href, title, text }: Tokens.Image) {
        const src = /^(https?:|data:)/i.test(href) ? href : fileUrl(joinPath(dirname(notePath), safeDecodeURI(href)));
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ''}>`;
      },
    },
  });
  const { bodyOffset } = splitFrontmatter(content);
  return DOMPurify.sanitize(markdown.parse(content.slice(bodyOffset)) as string);
}

/** Wraps the first occurrence of `quote` (ignoring spacing and case) in <mark>s. */
function markQuote(root: HTMLElement, quote: string, index: number): void {
  const wanted = quote.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!wanted) return;
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  // A flattened, space-collapsed copy of the text, remembering where each character came from.
  let flat = '';
  const origin: { node: Text; offset: number }[] = [];
  let lastSpace = true;
  for (const node of nodes) {
    const text = node.data;
    for (let i = 0; i < text.length; i++) {
      const isSpace = /\s/.test(text[i] ?? '');
      if (isSpace && lastSpace) continue;
      flat += isSpace ? ' ' : (text[i] ?? '').toLowerCase();
      origin.push({ node, offset: i });
      lastSpace = isSpace;
    }
  }
  const at = flat.indexOf(wanted);
  if (at < 0) return;
  const start = origin[at];
  const end = origin[at + wanted.length - 1];
  if (!start || !end) return;
  // Wrap each text node's part of the match.
  const touched = nodes.slice(nodes.indexOf(start.node), nodes.indexOf(end.node) + 1);
  for (const node of touched) {
    const from = node === start.node ? start.offset : 0;
    const to = node === end.node ? end.offset + 1 : node.data.length;
    if (to <= from || !node.data.slice(from, to).trim()) continue;
    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    const mark = document.createElement('mark');
    mark.className = 'comment-mark';
    mark.dataset.comment = String(index);
    range.surroundContents(mark);
  }
}

/** Reading view for a markdown note: select a passage to comment on it. */
export function ReadPage({ path }: { path: string }) {
  const note = useNote(path);
  const title = note?.title ?? path;
  const commentsPath = commentsPathFor(path);
  const { data: doc, error } = useLiveData(() => fetchNote(path), [path]);
  const { data: commentsDoc, reload } = useLiveData(() => fetchNote(commentsPath), [commentsPath]);
  const comments: DocComment[] = useMemo(() => parseComments(commentsDoc?.content ?? ''), [commentsDoc]);
  const html = useMemo(() => (doc ? renderMarkdown(doc.content, path) : ''), [doc, path]);
  const article = useRef<HTMLElement>(null);
  const [pending, setPending] = useState<{ quote: string; x: number; y: number } | null>(null);
  const [draft, setDraft] = useState('');
  const [writing, setWriting] = useState(false);
  const [active, setActive] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = article.current;
    if (!el) return;
    el.innerHTML = html;
    comments.forEach((c, i) => markQuote(el, c.quote, i));
  }, [html, comments]);

  const onMouseUp = () => {
    const selection = window.getSelection();
    const el = article.current;
    if (!el || !selection || selection.isCollapsed || !el.contains(selection.anchorNode)) {
      if (!writing) setPending(null);
      return;
    }
    const quote = selection.toString().replace(/\s+/g, ' ').trim();
    if (!quote) return;
    const box = selection.getRangeAt(0).getBoundingClientRect();
    const host = el.getBoundingClientRect();
    setPending({ quote, x: box.left - host.left, y: box.bottom - host.top + 8 });
    setWriting(false);
    setDraft('');
  };

  const save = async () => {
    if (!pending || !draft.trim()) return;
    try {
      for (let attempt = 0; ; attempt++) {
        const current = await fetchNote(commentsPath);
        const base = current.hash ? current.content : newCommentsNote(title, path);
        try {
          await saveNote({ path: commentsPath, content: appendComment(base, pending.quote, draft), baseHash: current.hash });
          break;
        } catch (err) {
          if (!(err instanceof SaveConflict) || attempt >= 2) throw err;
        }
      }
      setPending(null);
      setDraft('');
      setWriting(false);
      window.getSelection()?.removeAllRanges();
      reload();
    } catch (err) {
      showToast(`Could not save the comment: ${messageOf(err)}`, 'error');
    }
  };

  const onClick = (event: MouseEvent) => {
    const target = event.target as Element;
    const mark = target.closest<HTMLElement>('mark.comment-mark');
    if (mark) setActive(Number(mark.dataset.comment));
    const anchor = target.closest('a');
    if (!anchor) return;
    const wiki = anchor.getAttribute('data-target');
    const href = anchor.getAttribute('href') ?? '';
    if (wiki !== null) {
      event.preventDefault();
      void openLink({ kind: 'wiki', target: wiki, heading: anchor.getAttribute('data-heading') || null }, path);
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      event.preventDefault();
      window.open(href, '_blank', 'noopener,noreferrer');
    } else if (href && !href.startsWith('#')) {
      event.preventDefault();
      void openLink({ kind: 'file', href }, path);
    }
  };

  const focusComment = (i: number) => {
    setActive(i);
    article.current?.querySelector(`mark[data-comment="${i}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className="page-grid read-page">
      <div className="note">
        <header className="note-head">
          <div className="title-row">
            <h1>{title}</h1>
            <div className="actions">
              <Link to={noteHref(path, note?.kind === 'paper' || note?.kind === 'board' ? undefined : note?.kind)} className="button">
                <Icon name="edit" size={16} /> Edit
              </Link>
            </div>
          </div>
          <p className="muted small">Reading view. Select a passage to comment on it.</p>
        </header>
        {error && <p className="error">{error}</p>}
        <div className="read-wrap">
          <article ref={article} className="rendered" onMouseUp={onMouseUp} onClick={onClick} />
          {pending && (
            <div className="comment-popover" style={{ left: Math.max(0, pending.x), top: pending.y }}>
              {!writing ? (
                <button type="button" className="primary" onMouseDown={(e) => e.preventDefault()} onClick={() => setWriting(true)}>
                  <Icon name="comment" size={16} /> Comment
                </button>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void save();
                  }}
                >
                  <blockquote>{pending.quote.length > 120 ? `${pending.quote.slice(0, 120)}…` : pending.quote}</blockquote>
                  <textarea autoFocus value={draft} rows={4} placeholder="Your comment" aria-label="Comment" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && void save()} />
                  <div className="dialog-actions">
                    <button type="button" onClick={() => setPending(null)}>
                      Cancel
                    </button>
                    <button type="submit" className="primary" disabled={!draft.trim()}>
                      Save
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
        </div>
      </div>
      <aside className="side-panel" aria-label="Comments">
        <div className="panel-body">
          <h3>Comments ({comments.length})</h3>
          {comments.length === 0 && <p className="muted small">Select text in the document to add the first comment.</p>}
          <ol className="comment-list">
            {comments.map((c, i) => (
              <li key={`${i}-${c.quote}`} className={active === i ? 'active' : ''}>
                <button type="button" className="link-button comment-quote" onClick={() => focusComment(i)}>
                  “{c.quote.length > 90 ? `${c.quote.slice(0, 90)}…` : c.quote}”
                </button>
                <p>{c.text}</p>
              </li>
            ))}
          </ol>
          {commentsDoc?.hash && (
            <Link to={`/note/${encodeNotePath(commentsPath)}`} className="link-button small">
              Edit the comments as text
            </Link>
          )}
        </div>
      </aside>
    </div>
  );
}
