import { type CSSProperties, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Highlight } from '../../shared/api.ts';
import { frontmatterField, setFrontmatterField } from '../../shared/frontmatter.ts';
import { type HighlightBlock, highlightBlock, parseHighlightBlocks, removeHighlightBlock, setHighlightComment, setHighlightResolved } from '../../shared/highlights.ts';
import { PAPER_STATUSES, type PaperStatus, paperStatusOf } from '../../shared/papers.ts';
import { ApiError, api, fileUrl } from '../api.ts';
import { AddToBoard } from '../components/AddToBoard.tsx';
import { Icon } from '../components/Icon.tsx';
import { NoteEditorPane, SaveBadge } from '../components/NoteEditorPane.tsx';
import { HistoryTab } from '../components/SidePanel.tsx';
import { askConfirm } from '../dialogs.ts';
import { PDF_LOCATION_EVENT, type PdfLocation } from '../editor/links.ts';
import { appendToEditor, editorFor, transformEditorText } from '../editor/registry.ts';
import type { SaveStatus } from '../noteSession.ts';
import { type PdfAnnotation, PdfViewer, type PdfSelection, type PdfViewerHandle } from '../papers/PdfViewer.tsx';
import { encodeNotePath, Link } from '../router.ts';
import { refreshNotes, useNote, useNotesLoaded } from '../stores.ts';
import { showToast } from '../toast.ts';
import { dirname, messageOf, randomId } from '../util.ts';

function stemOf(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/i, '');
}

function shorten(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

const KIND_LABELS: Record<string, string> = { Text: 'Note', FreeText: 'Text box', Highlight: 'Highlight', Underline: 'Underline', StrikeOut: 'Strikeout', Squiggly: 'Squiggle' };

function CommentCard(props: {
  block: HighlightBlock;
  active: boolean;
  onJump: () => void;
  onSave: (text: string) => void;
  onResolve: (resolved: boolean) => void;
  onRemove: () => void;
}) {
  const { block, active, onJump, onSave, onResolve, onRemove } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(block.comment);

  useEffect(() => {
    if (!editing) setDraft(block.comment);
  }, [block.comment, editing]);

  const save = () => {
    onSave(draft);
    setEditing(false);
  };

  return (
    <li id={`comment-${block.id}`} className={`pdf-comment${active ? ' active' : ''}${block.resolved ? ' resolved' : ''}`}>
      <div className="pdf-comment-head">
        <button type="button" className="pdf-comment-quote" onClick={onJump} title="Show it in the PDF">
          <span className="pdf-comment-page">p. {block.page ?? '?'}</span> “{shorten(block.quote, 160)}”
        </button>
        {!editing && (
          <div className="pdf-comment-tools">
            {block.resolved ? (
              <button type="button" className="icon-button" title="Reopen" aria-label="Reopen this comment" onClick={() => onResolve(false)}>
                <Icon name="reopen" size={15} />
              </button>
            ) : (
              <>
                <button type="button" className="icon-button resolve" title="Resolve" aria-label="Resolve this comment" onClick={() => onResolve(true)}>
                  <Icon name="check" size={16} />
                </button>
                <button type="button" className="icon-button" title={block.comment ? 'Edit' : 'Add a comment'} aria-label={block.comment ? 'Edit this comment' : 'Add a comment'} onClick={() => setEditing(true)}>
                  <Icon name="edit" size={15} />
                </button>
              </>
            )}
            <button type="button" className="icon-button" title="Delete" aria-label="Delete this comment and its highlight" onClick={onRemove}>
              <Icon name="trash" size={15} />
            </button>
          </div>
        )}
      </div>
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <textarea
            autoFocus
            rows={3}
            value={draft}
            aria-label="Comment"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') save();
              if (e.key === 'Escape') setEditing(false);
            }}
          />
          <div className="dialog-actions">
            <button type="button" className="small" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="submit" className="primary small">
              Save
            </button>
          </div>
        </form>
      ) : block.comment ? (
        <p className="pdf-comment-text" onDoubleClick={() => !block.resolved && setEditing(true)}>
          {block.comment}
        </p>
      ) : (
        !block.resolved && (
          <button type="button" className="link-button small" onClick={() => setEditing(true)}>
            Add a comment
          </button>
        )
      )}
    </li>
  );
}

const SIDE_WIDTH_KEY = 'notesapp-paper-side-width';

function savedSideWidth(): number | null {
  try {
    const value = Number(localStorage.getItem(SIDE_WIDTH_KEY));
    return value >= 240 ? value : null;
  } catch {
    return null;
  }
}

function sideHiddenKey(embedded: boolean): string {
  return embedded ? 'notesapp-paper-side-hidden:embedded' : 'notesapp-paper-side-hidden';
}

function savedSideHidden(embedded: boolean): boolean {
  try {
    return localStorage.getItem(sideHiddenKey(embedded)) === '1';
  } catch {
    return false;
  }
}

function saveSideWidth(value: number | null): void {
  try {
    if (value === null) localStorage.removeItem(SIDE_WIDTH_KEY);
    else localStorage.setItem(SIDE_WIDTH_KEY, String(value));
  } catch {
    // Private windows may refuse; the width just isn't remembered.
  }
}

/** A paper: the PDF on one side; its comments and review note on the other. */
export function PaperPage({ path, page, highlight, embedded = false }: { path: string; page: number | null; highlight: string | null; embedded?: boolean }) {
  const note = useNote(path);
  const loaded = useNotesLoaded();
  const [status, setStatus] = useState<SaveStatus>('loading');
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [content, setContent] = useState('');
  const [tab, setTab] = useState<'comments' | 'notes' | 'history'>('comments');
  const [showResolved, setShowResolved] = useState(false);
  const [sideWidth, setSideWidth] = useState<number | null>(savedSideWidth);
  const [sideHidden, setSideHidden] = useState(() => savedSideHidden(embedded));
  // A narrow paper (half a dashboard, a small window) folds the side pane into the strip by itself.
  const [narrow, setNarrow] = useState(false);
  const [openWhileNarrow, setOpenWhileNarrow] = useState(false);
  const hidden = sideHidden || (narrow && !openWhileNarrow);
  const split = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const current = useRef<Highlight[]>([]);
  const hash = useRef<string | null>(null);
  const viewer = useRef<PdfViewerHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const dir = dirname(path);
  const pdfName = typeof note?.meta.pdf === 'string' ? note.meta.pdf : null;
  const pdfPath = pdfName ? `${dir}/${pdfName}` : null;
  const highlightsPath = `${dir}/${stemOf(path)}.highlights.json`;

  const blocks = useMemo(() => parseHighlightBlocks(content), [content]);
  // Resolved comments keep their highlight (drawn faintly) but lose their marker in the PDF.
  const comments = useMemo(() => new Map(blocks.filter((b) => b.comment && !b.resolved).map((b) => [b.id, b.comment])), [blocks]);
  const resolvedIds = useMemo(() => new Set(blocks.filter((b) => b.resolved).map((b) => b.id)), [blocks]);
  const sortedBlocks = useMemo(() => {
    const where = new Map(highlights.map((h) => [h.id, h.page * 10 + (h.rects[0]?.y ?? 0)]));
    return [...blocks].sort((a, b) => (where.get(a.id) ?? (a.page ?? 0) * 10) - (where.get(b.id) ?? (b.page ?? 0) * 10));
  }, [blocks, highlights]);
  const orphans = highlights.filter((h) => !blocks.some((b) => b.id === h.id));

  /** Reads the review note's text straight from its editor, so new comments show at once. */
  const syncContent = () => {
    const view = editorFor(path);
    if (view) setContent(view.state.sliceDoc());
  };

  const loadHighlights = useCallback(async () => {
    const doc = await api.data<Highlight[]>(highlightsPath);
    hash.current = doc.hash;
    current.current = Array.isArray(doc.data) ? doc.data : [];
    setHighlights(current.current);
  }, [highlightsPath]);

  useEffect(() => {
    void loadHighlights().catch(() => undefined);
  }, [loadHighlights]);

  useEffect(() => {
    if (active) document.getElementById(`comment-${active}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [active, tab]);

  /** Changes the highlight positions and saves them, reloading and retrying if they changed elsewhere. */
  const updateHighlights = async (change: (list: Highlight[]) => Highlight[]): Promise<boolean> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const next = change(current.current);
      current.current = next;
      setHighlights(next);
      try {
        hash.current = (await api.saveData(highlightsPath, next, hash.current)).hash;
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          await loadHighlights();
          continue;
        }
        showToast(`Could not save the highlight: ${messageOf(err)}`, 'error');
        return false;
      }
    }
    return false;
  };

  const addHighlight = async (selection: PdfSelection, comment: string | null) => {
    const created: Highlight = { id: randomId(4), page: selection.page, rects: selection.rects, text: selection.text, createdAt: new Date().toISOString() };
    if (!(await updateHighlights((list) => [...list, created]))) return;
    const link = `${encodeURI(pdfName ?? '')}#page=${created.page}&hl=${created.id}`;
    const added = appendToEditor(path, highlightBlock(created.text, created.page, link, comment), { focus: tab === 'notes' && !comment, blankLineAfter: true });
    if (!added) showToast('Highlight saved, but the review note isn’t open: reload the page to see it.', 'error');
    syncContent();
    setActive(created.id);
  };

  const saveComment = (id: string, text: string) => {
    if (!transformEditorText(path, (t) => setHighlightComment(t, id, text))) return showToast('The review note isn’t open; reload the page.', 'error');
    syncContent();
  };

  const resolveComment = (id: string, resolved: boolean) => {
    if (!transformEditorText(path, (t) => setHighlightResolved(t, id, resolved))) return showToast('The review note isn’t open; reload the page.', 'error');
    syncContent();
    if (resolved && active === id) setActive(null);
    if (resolved) showToast('Comment resolved', 'info', { label: 'Undo', run: () => resolveComment(id, false) });
  };

  const setReadingStatus = (value: PaperStatus) => {
    if (!transformEditorText(path, (t) => setFrontmatterField(t, 'status', value))) return showToast('The review note is still loading; try again in a moment.', 'error');
    syncContent();
  };

  /** Dragging the line between the PDF and the side pane resizes them. Double-click resets. */
  const clampSide = (width: number) => {
    const total = split.current?.clientWidth ?? window.innerWidth;
    return Math.round(Math.min(Math.max(width, 280), Math.max(280, total - 320)));
  };
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = handle.parentElement?.getBoundingClientRect().width ?? 400;
    let last = startWidth;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-columns');
    const move = (e: PointerEvent) => {
      last = clampSide(startWidth - (e.clientX - startX));
      setSideWidth(last);
    };
    const end = (e: PointerEvent) => {
      if (e.type === 'pointerup') move(e);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      document.body.classList.remove('resizing-columns');
      saveSideWidth(last);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };
  const nudgeSide = (delta: number) => {
    const next = clampSide((sideWidth ?? split.current?.querySelector('.paper-side')?.getBoundingClientRect().width ?? 400) + delta);
    setSideWidth(next);
    saveSideWidth(next);
  };

  const removeHighlight = async (id: string) => {
    const ok = await askConfirm({ title: 'Delete this comment?', message: 'Its highlight, quote and comment leave the review note. (The PDF itself is never changed.)', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    transformEditorText(path, (t) => removeHighlightBlock(t, id));
    syncContent();
    await updateHighlights((list) => list.filter((h) => h.id !== id));
  };

  /** Hides or shows the comments and review notes pane (the review note stays open, so highlights still save). */
  const setSideHiddenSaved = (hidden: boolean) => {
    setSideHidden(hidden);
    try {
      if (hidden) localStorage.setItem(sideHiddenKey(embedded), '1');
      else localStorage.removeItem(sideHiddenKey(embedded));
    } catch {
      // Not remembered in a private window.
    }
  };
  const showSide = (which: 'comments' | 'notes' | 'history') => {
    setTab(which);
    setSideHiddenSaved(false);
    if (narrow) setOpenWhileNarrow(true);
  };
  const hideSide = () => {
    // Narrow: just fold it again. Wide: remember that you prefer it hidden.
    if (narrow && !sideHidden) setOpenWhileNarrow(false);
    else setSideHiddenSaved(true);
  };

  useEffect(() => {
    const el = split.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const isNarrow = el.clientWidth > 0 && el.clientWidth < 760;
      setNarrow(isNarrow);
      if (!isNarrow) setOpenWhileNarrow(false);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [loaded, note === undefined]);

  const showHighlight = (h: Highlight) => {
    showSide('comments');
    setActive(h.id);
    if (resolvedIds.has(h.id)) setShowResolved(true);
  };

  // Links like [p. 4](paper.pdf#page=4&hl=…) clicked in the note scroll the PDF.
  useEffect(() => {
    const onLocation = (event: Event) => {
      const detail = (event as CustomEvent<PdfLocation>).detail;
      if (detail.paperPath !== path) return;
      viewer.current?.scrollTo(detail.page, detail.highlight);
      if (detail.highlight) setActive(detail.highlight);
    };
    window.addEventListener(PDF_LOCATION_EVENT, onLocation);
    return () => window.removeEventListener(PDF_LOCATION_EVENT, onLocation);
  }, [path]);

  const attach = async (file: File | undefined) => {
    if (!file) return;
    try {
      await api.attachPdf(path, file);
      await refreshNotes();
    } catch (err) {
      showToast(`Could not add the PDF: ${messageOf(err)}`, 'error');
    }
  };

  if (loaded && !note) {
    return (
      <div className="page narrow">
        <h1>Paper not found</h1>
        <p>
          There’s no paper at {path}. <Link to="/papers">See all papers</Link>.
        </p>
      </div>
    );
  }

  const title = note?.title ?? stemOf(path);
  const authors = Array.isArray(note?.meta.authors) ? (note.meta.authors as unknown[]).map(String) : [];
  const url = typeof note?.meta.url === 'string' ? note.meta.url : null;
  const details = [authors.length > 4 ? `${authors.slice(0, 4).join(', ')} et al.` : authors.join(', '), note?.meta.year, note?.meta.venue].filter(Boolean).join(' · ');
  const openBlocks = sortedBlocks.filter((b) => !b.resolved);
  const resolvedBlocks = sortedBlocks.filter((b) => b.resolved);
  const commentCount = openBlocks.length + annotations.length;
  const readingStatus = paperStatusOf(content ? frontmatterField(content, 'status') : note?.meta.status);
  const card = (b: HighlightBlock) => (
    <CommentCard
      key={b.id}
      block={b}
      active={active === b.id}
      onJump={() => {
        setActive(b.id);
        viewer.current?.scrollTo(b.page, b.id);
      }}
      onSave={(text) => saveComment(b.id, text)}
      onResolve={(resolved) => resolveComment(b.id, resolved)}
      onRemove={() => void removeHighlight(b.id)}
    />
  );

  return (
    <div className={embedded ? 'paper-page embedded' : 'paper-page'}>
      {/* In a dashboard panel, the panel shows the title. */}
      <header className="paper-head" hidden={embedded}>
        <div className="title-row">
          <h1>{title}</h1>
          <div className="actions">
            <SaveBadge status={status} />
            <AddToBoard path={path} title={title} />
            {url && (
              <a className="icon-button" href={url} target="_blank" rel="noopener noreferrer" title="Open the paper’s page">
                <Icon name="external" />
              </a>
            )}
            <Link to={`/note/${encodeNotePath(path)}`} className="icon-button" title="Open the review note on its own">
              <Icon name="notes" />
            </Link>
          </div>
        </div>
        <div className="paper-sub">
          <p className="muted small">{details}</p>
          <div className="segmented small" role="group" aria-label="Reading status">
            {PAPER_STATUSES.map((s) => (
              <button key={s.value} type="button" className={readingStatus === s.value ? 'active' : ''} aria-pressed={readingStatus === s.value} onClick={() => setReadingStatus(s.value)}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </header>
      <div
        ref={split}
        className={`paper-split${sideWidth && !hidden ? ' sized' : ''}${hidden ? ' side-hidden' : ''}`}
        style={sideWidth ? ({ '--side-width': `${sideWidth}px` } as CSSProperties) : undefined}
      >
        <section className="paper-pdf" aria-label="PDF">
          {pdfPath ? (
            <PdfViewer
              ref={viewer}
              url={fileUrl(pdfPath)}
              highlights={highlights}
              comments={comments}
              resolved={resolvedIds}
              onHighlight={(s, c) => void addHighlight(s, c)}
              onHighlightClick={showHighlight}
              onAnnotations={setAnnotations}
              initialPage={page}
              initialHighlight={highlight}
            />
          ) : (
            <div
              className="dropzone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void attach(e.dataTransfer.files[0]);
              }}
            >
              <p>No PDF for this paper yet.</p>
              <button type="button" className="primary" onClick={() => fileInput.current?.click()}>
                <Icon name="upload" size={16} /> Add the PDF
              </button>
              <p className="muted small">or drop it here</p>
              <input ref={fileInput} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => void attach(e.target.files?.[0])} />
            </div>
          )}
        </section>
        {hidden && (
          <nav className="paper-side-strip" aria-label="Comments and review notes (hidden)">
            <button type="button" className="icon-button" title="Show the comments" aria-label="Show the comments" onClick={() => showSide('comments')}>
              <Icon name="comment" size={17} />
              {commentCount > 0 && <span className="strip-count">{commentCount}</span>}
            </button>
            <button type="button" className="icon-button" title="Show the review notes" aria-label="Show the review notes" onClick={() => showSide('notes')}>
              <Icon name="notes" size={17} />
            </button>
            <button type="button" className="icon-button" title="Show the history" aria-label="Show the history" onClick={() => showSide('history')}>
              <Icon name="history" size={17} />
            </button>
          </nav>
        )}
        <section className="paper-side" aria-label="Comments and review notes" hidden={hidden}>
          <div
            className="pane-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the PDF and the side pane"
            title="Drag to resize · double-click to reset"
            tabIndex={0}
            onPointerDown={startResize}
            onDoubleClick={() => {
              setSideWidth(null);
              saveSideWidth(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') nudgeSide(32);
              if (e.key === 'ArrowRight') nudgeSide(-32);
            }}
          />
          <div className="tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'comments'} className={tab === 'comments' ? 'tab active' : 'tab'} title="Comments" onClick={() => setTab('comments')}>
              <Icon name="comment" size={15} /> <span className="tab-label">Comments</span>
              {commentCount > 0 && <span className="tab-count">({commentCount})</span>}
            </button>
            <button type="button" role="tab" aria-selected={tab === 'notes'} className={tab === 'notes' ? 'tab active' : 'tab'} title="Review notes" onClick={() => setTab('notes')}>
              <Icon name="notes" size={15} /> <span className="tab-label">Review notes</span>
            </button>
            <button type="button" role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'tab active' : 'tab'} title="History" onClick={() => setTab('history')}>
              <Icon name="history" size={15} /> <span className="tab-label">History</span>
            </button>
            <button type="button" className="icon-button side-hide" title="Hide comments and notes (more room for the PDF)" aria-label="Hide the comments and notes" onClick={hideSide}>
              <Icon name="sideClose" size={16} />
            </button>
          </div>
          <div className="paper-side-body comments-pane" hidden={tab !== 'comments'}>
            {blocks.length === 0 && annotations.length === 0 && (
              <p className="muted small">
                Select text in the PDF, then choose <strong>Comment</strong> (or <strong>Highlight</strong>). Comments are saved in the review note, so search finds them.
              </p>
            )}
            {blocks.length > 0 && openBlocks.length === 0 && <p className="muted small">No open comments.</p>}
            {openBlocks.length > 0 && <ol className="pdf-comments">{openBlocks.map(card)}</ol>}
            {resolvedBlocks.length > 0 && (
              <>
                <button type="button" className="link-button small resolved-toggle" aria-expanded={showResolved} onClick={() => setShowResolved(!showResolved)}>
                  {showResolved ? '▾' : '▸'} Resolved ({resolvedBlocks.length})
                </button>
                {showResolved && <ol className="pdf-comments">{resolvedBlocks.map(card)}</ol>}
              </>
            )}
            {orphans.length > 0 && (
              <>
                <h3>Highlights no longer in the notes</h3>
                <ul className="pdf-comments">
                  {orphans.map((h) => (
                    <li key={h.id} className="pdf-comment">
                      <button type="button" className="pdf-comment-quote" onClick={() => viewer.current?.scrollTo(h.page, h.id)}>
                        <span className="pdf-comment-page">p. {h.page}</span> “{shorten(h.text, 120)}”
                      </button>
                      <div className="pdf-comment-actions">
                        <button type="button" className="link-button small subtle" onClick={() => void updateHighlights((list) => list.filter((x) => x.id !== h.id))}>
                          Remove highlight
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {annotations.length > 0 && (
              <>
                <h3>In the PDF file ({annotations.length})</h3>
                <p className="muted small">Comments saved inside this PDF by another app (Acrobat, Zotero, Preview…). They stay in the file and are read-only here.</p>
                <ul className="pdf-comments">
                  {annotations.map((a) => (
                    <li key={a.id} className="pdf-comment from-file">
                      <button type="button" className="pdf-comment-quote" onClick={() => viewer.current?.showRect(a.page, a.rect)} title="Show it in the PDF">
                        <span className="pdf-comment-page">p. {a.page}</span> {a.author || KIND_LABELS[a.kind] || a.kind}
                        {a.date ? ` · ${a.date}` : ''}
                      </button>
                      <p className="pdf-comment-text">{a.text}</p>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
          <div className="paper-side-body" hidden={tab !== 'notes'}>
            <NoteEditorPane path={path} label="Review notes" onStatus={setStatus} onContent={setContent} placeholder="Your summary, notes and questions…" />
          </div>
          {tab === 'history' && (
            <div className="paper-side-body">
              <p className="muted small">Versions of the review note and its comments. Every change is kept in the notes folder’s git history.</p>
              <HistoryTab path={path} current={content || undefined} onShowChanges={() => setTab('notes')} />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
