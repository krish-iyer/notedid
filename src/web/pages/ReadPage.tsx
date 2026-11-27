import { type MouseEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { appendComment, commentsPathFor, type DocComment, newCommentsNote, parseComments } from '../../shared/comments.ts';
import { splitFrontmatter } from '../../shared/markdown.ts';
import { newNoteId, withNoteId } from '../../shared/noteIds.ts';
import { fetchNote, SaveConflict, saveNote } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import { PanelButton, PanelClose, PanelFrame } from '../components/SidePanel.tsx';
import { openLink } from '../editor/links.ts';
import { renderWithCards } from '../editor/cardView.ts';
import { PHONE, useLiveData, useMediaQuery } from '../hooks.ts';
import { encodeNotePath, Link, noteHref } from '../router.ts';
import { useNote } from '../stores.ts';
import { showToast } from '../toast.ts';
import { messageOf } from '../util.ts';


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
  // By their text: both load again whenever any note changes, mostly unchanged.
  const content = doc?.content ?? '';
  const commentsText = commentsDoc?.content ?? '';
  const comments: DocComment[] = useMemo(() => parseComments(commentsText), [commentsText]);
  const article = useRef<HTMLElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const sheet = useMediaQuery(PHONE);
  const [pending, setPending] = useState<{ quote: string; x: number; below: number; above: number } | null>(null);
  const [draft, setDraft] = useState('');
  const [writing, setWriting] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const [panel, setPanel] = useState(false);
  const closePanel = useCallback(() => setPanel(false), []);

  // The note as HTML, cards drawn as cards. Drawn again only when its text changes: drawing it again loads its
  // images and cards again, which moves the page about while they load.
  useLayoutEffect(() => {
    const el = article.current;
    if (!el) return;
    renderWithCards(el, content.slice(splitFrontmatter(content).bodyOffset), { notePath: path, privateMode: false });
  }, [content, path]);

  // Its commented passages, marked (anew when a comment is added).
  useLayoutEffect(() => {
    const el = article.current;
    if (!el) return;
    for (const mark of el.querySelectorAll('mark.comment-mark')) mark.replaceWith(...mark.childNodes);
    el.normalize();
    comments.forEach((c, i) => markQuote(el, c.quote, i));
  }, [content, path, comments]);

  /** The passage selected in the note, and where it is in the note; null if none. */
  const selected = useCallback((): { quote: string; x: number; below: number; above: number } | null => {
    const selection = window.getSelection();
    const el = article.current;
    if (!el || !selection || selection.isCollapsed || selection.rangeCount === 0 || !el.contains(selection.anchorNode)) return null;
    const quote = selection.toString().replace(/\s+/g, ' ').trim();
    if (!quote) return null;
    const box = selection.getRangeAt(0).getBoundingClientRect();
    const host = el.getBoundingClientRect();
    return { quote, x: box.left - host.left, below: box.bottom - host.top + 8, above: box.top - host.top - 8 };
  }, []);

  // The comment button and box go below the selection (a phone shows its own Copy menu above it), or above it when
  // the window has no room below, and never past the note's edges. On a phone they are sheets instead, placed by
  // the CSS: the button at the bottom of the screen, the comment box at the top, where the keyboard can't cover it.
  useLayoutEffect(() => {
    const pop = popover.current;
    const wrap = pop?.parentElement;
    if (!pop || !wrap || !pending) return;
    if (sheet) {
      pop.style.left = '';
      pop.style.top = '';
      return;
    }
    pop.style.left = `${Math.max(0, Math.min(pending.x, wrap.clientWidth - pop.offsetWidth))}px`;
    const top = wrap.getBoundingClientRect().top;
    const fitsBelow = top + pending.below + pop.offsetHeight <= window.innerHeight - 8;
    const fitsAbove = top + pending.above - pop.offsetHeight >= 8;
    pop.style.top = `${!fitsBelow && fitsAbove ? pending.above - pop.offsetHeight : pending.below}px`;
  }, [pending, writing, sheet]);

  const onMouseUp = () => {
    const next = selected();
    if (!next) {
      if (!writing) setPending(null);
      return;
    }
    setPending(next);
    setWriting(false);
    setDraft('');
  };

  // A finger selects with a long press and the handles, and no mouseup comes: follow the selection itself.
  const writingRef = useRef(false);
  writingRef.current = writing;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const next = writingRef.current ? null : selected();
        if (next) setPending((current) => (current?.quote === next.quote ? current : next));
      }, 300);
    };
    document.addEventListener('selectionchange', onChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', onChange);
    };
  }, [selected]);

  const save = async () => {
    if (!pending || !draft.trim()) return;
    try {
      for (let attempt = 0; ; attempt++) {
        const current = await fetchNote(commentsPath);
        const base = current.hash ? current.content : withNoteId(newCommentsNote(title, path), newNoteId());
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
    const tag = anchor.getAttribute('data-tag');
    const href = anchor.getAttribute('href') ?? '';
    if (wiki !== null) {
      event.preventDefault();
      void openLink({ kind: 'wiki', target: wiki, heading: anchor.getAttribute('data-heading') || null }, path);
    } else if (tag) {
      event.preventDefault();
      void openLink({ kind: 'tag', tag }, path);
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
    closePanel();
    article.current?.querySelector(`mark[data-comment="${i}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className="page-grid read-page">
      <div className="note">
        <header className="note-head">
          <div className="title-row">
            <h1>{title}</h1>
            <div className="actions">
              <PanelButton label={`Comments (${comments.length})`} icon="comment" count={comments.length} onClick={() => setPanel(true)} />
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
            <div ref={popover} className={`comment-popover${sheet ? ' sheet' : ''}${writing ? ' writing' : ''}`}>
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
      <PanelFrame open={panel} onClose={closePanel} label="Comments">
        <div className="panel-body">
          <div className="panel-head">
            <h3>Comments ({comments.length})</h3>
            <PanelClose onClose={closePanel} />
          </div>
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
      </PanelFrame>
    </div>
  );
}
