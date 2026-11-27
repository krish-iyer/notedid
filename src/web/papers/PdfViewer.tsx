// pdf.js's "legacy" build: the same viewer, plus fallbacks for browsers a little behind the newest
// (Firefox ESR, iPhones not on the latest iOS), which the regular build no longer runs in.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { type CSSProperties, forwardRef, type MouseEvent, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Highlight } from '../../shared/api.ts';
import { Icon } from '../components/Icon.tsx';
import { PHONE, useMediaQuery } from '../hooks.ts';
import { messageOf } from '../util.ts';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type Rect = Highlight['rects'][number];

export interface PdfSelection {
  page: number;
  rects: Rect[];
  text: string;
}

/** A comment stored inside the PDF file itself (made in Acrobat, Zotero, Preview, …). */
export interface PdfAnnotation {
  id: string;
  page: number;
  /** PDF annotation type: Text (sticky note), Highlight, FreeText, … */
  kind: string;
  author: string;
  text: string;
  date: string | null;
  rect: Rect;
}

/** Selected text, and where it is in the scrolling PDF: its left edge, and the tops for a menu below and above it. */
interface Offer {
  selection: PdfSelection;
  x: number;
  below: number;
  above: number;
}

export interface PdfViewerHandle {
  scrollTo(page: number | null, highlight?: string | null): void;
  showRect(page: number, rect: Rect): void;
}

interface PdfViewerProps {
  url: string;
  highlights: Highlight[];
  /** Highlight id → its comment, for the comment markers. */
  comments: Map<string, string>;
  /** Highlights whose comment is resolved: drawn faintly. */
  resolved: Set<string>;
  onHighlight: (selection: PdfSelection, comment: string | null) => void;
  onHighlightClick: (highlight: Highlight) => void;
  onAnnotations?: (annotations: PdfAnnotation[]) => void;
  initialPage?: number | null;
  initialHighlight?: string | null;
}

interface RawAnnotation {
  id: string;
  subtype: string;
  rect: number[];
  contents?: string;
  contentsObj?: { str?: string };
  title?: string;
  titleObj?: { str?: string };
  modificationDate?: string | null;
}

const NOT_COMMENTS = new Set(['Popup', 'Link', 'Widget']);
const round = (n: number) => Math.round(n * 10_000) / 10_000;

/** Joins the many small boxes of a text selection into one box per line. */
function mergeRects(rects: Rect[]): Rect[] {
  const merged: Rect[] = [];
  for (const r of [...rects].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.y - r.y) < last.h * 0.5 && r.x <= last.x + last.w + 0.01) {
      const right = Math.max(last.x + last.w, r.x + r.w);
      const bottom = Math.max(last.y + last.h, r.y + r.h);
      last.x = Math.min(last.x, r.x);
      last.y = Math.min(last.y, r.y);
      last.w = right - last.x;
      last.h = bottom - last.y;
    } else {
      merged.push({ ...r });
    }
  }
  return merged.map((r) => ({ x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) }));
}

/** Selected PDF text as one line: words hyphenated across a line break are joined again. */
export function cleanSelectedText(text: string): string {
  return text
    .replace(/(\p{L})-\s*\n\s*(?=\p{Ll})/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function pdfDate(value: string | null | undefined): string | null {
  const match = /^D?:?(\d{4})(\d{2})?(\d{2})?/.exec(value ?? '');
  return match ? [match[1], match[2] ?? '01', match[3] ?? '01'].join('-') : null;
}

interface PageProps {
  doc: PDFDocumentProxy;
  number: number;
  scale: number;
  size: { w: number; h: number };
  highlights: Highlight[];
  comments: Map<string, string>;
  resolved: Set<string>;
  flash: string | null;
  flashRect: Rect | null;
  onMarker: (highlight: Highlight) => void;
}

/** One page: drawn on a canvas once it scrolls near view, with a selectable text layer over it. */
function PdfPage({ doc, number, scale, size, highlights, comments, resolved, flash, flashRect, onMarker }: PageProps) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { rootMargin: '1500px 0px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    let layer: pdfjs.TextLayer | null = null;
    void (async () => {
      const page = await doc.getPage(number);
      const c = canvas.current;
      const t = text.current;
      if (cancelled || !c || !t) return;
      const viewport = page.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      c.width = Math.floor(viewport.width * ratio);
      c.height = Math.floor(viewport.height * ratio);
      c.style.width = `${viewport.width}px`;
      c.style.height = `${viewport.height}px`;
      task = page.render({ canvas: c, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      try {
        await task.promise;
      } catch {
        return; // cancelled by a newer render
      }
      if (cancelled) return;
      t.replaceChildren();
      layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: t, viewport });
      await layer.render().catch(() => undefined);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
      layer?.cancel();
    };
  }, [near, scale, doc, number]);

  const box = (r: Rect): CSSProperties => ({ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });

  return (
    <div ref={root} className="pdf-page" data-page={number} style={{ width: size.w * scale, height: size.h * scale, '--scale-factor': scale } as CSSProperties}>
      <canvas ref={canvas} />
      <div className="pdf-highlights" aria-hidden="true">
        {highlights.flatMap((h) =>
          h.rects.map((r, i) => <div key={`${h.id}-${i}`} className={`pdf-hl${comments.has(h.id) ? ' commented' : ''}${resolved.has(h.id) ? ' resolved' : ''}${flash === h.id ? ' flash' : ''}`} style={box(r)} />),
        )}
        {flashRect && <div className="pdf-flash-box" style={box(flashRect)} />}
      </div>
      <div ref={text} className="textLayer" />
      {highlights
        .filter((h) => comments.has(h.id))
        .map((h) => (
          <button
            key={h.id}
            type="button"
            className="pdf-comment-marker"
            style={{ top: `${(h.rects[0]?.y ?? 0) * 100}%` }}
            title={comments.get(h.id)}
            aria-label="Show this comment"
            onClick={(e) => {
              e.stopPropagation();
              onMarker(h);
            }}
          >
            <Icon name="comment" size={14} />
          </button>
        ))}
      <span className="pdf-page-number">{number}</span>
    </div>
  );
}

/** A PDF, page by page. Select text to highlight or comment; click a highlight to find it in the comments. */
export const PdfViewer = forwardRef<PdfViewerHandle, PdfViewerProps>(function PdfViewer(props, ref) {
  const { url, highlights, comments, resolved, onHighlight, onHighlightClick, onAnnotations, initialPage, initialHighlight } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const widthRef = useRef(0);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState<Offer | null>(null);
  const popover = useRef<HTMLDivElement>(null);
  const sheet = useMediaQuery(PHONE);
  const [writing, setWriting] = useState(false);
  const writingRef = useRef(false);
  writingRef.current = writing;
  const [draft, setDraft] = useState('');
  const [flash, setFlash] = useState<string | null>(null);
  const [flashRect, setFlashRect] = useState<{ page: number; rect: Rect } | null>(null);
  const startedAt = useRef(false);
  const annotationsCallback = useRef(onAnnotations);
  annotationsCallback.current = onAnnotations;

  useEffect(() => {
    let cancelled = false;
    const task = pdfjs.getDocument({ url });
    task.promise
      .then(async (pdf) => {
        const pageSizes: { w: number; h: number }[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const viewport = (await pdf.getPage(i)).getViewport({ scale: 1 });
          pageSizes.push({ w: viewport.width, h: viewport.height });
        }
        if (cancelled) return;
        setSizes(pageSizes);
        setDoc(pdf);
      })
      .catch((err: unknown) => !cancelled && setError(messageOf(err)));
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [url]);

  // Comments stored inside the PDF file.
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    void (async () => {
      const found: PdfAnnotation[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const pdfPage = await doc.getPage(i);
        const viewport = pdfPage.getViewport({ scale: 1 });
        for (const a of (await pdfPage.getAnnotations()) as RawAnnotation[]) {
          const text = (a.contentsObj?.str ?? a.contents ?? '').trim();
          if (!text || NOT_COMMENTS.has(a.subtype) || a.rect.length < 4) continue;
          const [x1 = 0, y1 = 0] = viewport.convertToViewportPoint(a.rect[0] ?? 0, a.rect[1] ?? 0) as number[];
          const [x2 = 0, y2 = 0] = viewport.convertToViewportPoint(a.rect[2] ?? 0, a.rect[3] ?? 0) as number[];
          found.push({
            id: `${i}-${a.id}`,
            page: i,
            kind: a.subtype,
            author: (a.titleObj?.str ?? a.title ?? '').trim(),
            text,
            date: pdfDate(a.modificationDate),
            rect: {
              x: round(Math.min(x1, x2) / viewport.width),
              y: round(Math.min(y1, y2) / viewport.height),
              w: round(Math.abs(x2 - x1) / viewport.width),
              h: round(Math.abs(y2 - y1) / viewport.height),
            },
          });
        }
      }
      if (!cancelled) annotationsCallback.current?.(found);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [doc]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      if (el.clientWidth && !widthRef.current) setWidth((widthRef.current = el.clientWidth));
      else timer = setTimeout(() => setWidth((widthRef.current = el.clientWidth)), 150);
    });
    observer.observe(el);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  const widest = Math.max(1, ...sizes.map((s) => s.w));
  const scale = zoom === 'fit' ? Math.max(0.3, (width - 32) / widest) : zoom;
  const byPage = useMemo(() => {
    const map = new Map<number, Highlight[]>();
    for (const h of highlights) map.set(h.page, [...(map.get(h.page) ?? []), h]);
    return map;
  }, [highlights]);

  const scrollToSpot = useCallback((pageNumber: number, y: number | null) => {
    const el = scroller.current;
    const pageEl = el?.querySelector<HTMLElement>(`.pdf-page[data-page="${pageNumber}"]`);
    if (!el || !pageEl) return;
    el.scrollTo({ top: pageEl.offsetTop + (y === null ? -12 : y * pageEl.offsetHeight - 80), behavior: 'smooth' });
  }, []);

  const scrollTo = useCallback(
    (pageNumber: number | null, highlightId?: string | null) => {
      const highlight = highlightId ? highlights.find((h) => h.id === highlightId) : undefined;
      scrollToSpot(highlight?.page ?? pageNumber ?? 1, highlight?.rects[0]?.y ?? null);
      if (highlight) {
        setFlash(highlight.id);
        setTimeout(() => setFlash((f) => (f === highlight.id ? null : f)), 2200);
      }
    },
    [highlights, scrollToSpot],
  );

  const showRect = useCallback(
    (pageNumber: number, rect: Rect) => {
      scrollToSpot(pageNumber, rect.y);
      setFlashRect({ page: pageNumber, rect });
      setTimeout(() => setFlashRect(null), 2200);
    },
    [scrollToSpot],
  );

  useImperativeHandle(ref, () => ({ scrollTo, showRect }), [scrollTo, showRect]);

  useEffect(() => {
    if (!doc || !width || startedAt.current) return;
    startedAt.current = true;
    if (initialPage || initialHighlight) requestAnimationFrame(() => scrollTo(initialPage ?? null, initialHighlight));
  }, [doc, width, initialPage, initialHighlight, scrollTo]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const middle = el.scrollTop + el.clientHeight / 3;
    let current = 1;
    for (const pageEl of el.querySelectorAll<HTMLElement>('.pdf-page')) {
      if (pageEl.offsetTop <= middle) current = Number(pageEl.dataset.page);
      else break;
    }
    setPage(current);
  };

  /** The text selected in the PDF, to highlight or comment on, and where it is; null if none. */
  const selected = useCallback((): Offer | null => {
    const el = scroller.current;
    const selection = window.getSelection();
    if (!el || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    const pageEl = start?.closest<HTMLElement>('.pdf-page');
    if (!pageEl || !el.contains(pageEl)) return null;
    const box = pageEl.getBoundingClientRect();
    const rects = mergeRects(
      [...range.getClientRects()]
        .filter((r) => r.width > 1 && r.height > 1 && r.top >= box.top - 2 && r.bottom <= box.bottom + 2)
        .map((r) => ({ x: (r.left - box.left) / box.width, y: (r.top - box.top) / box.height, w: r.width / box.width, h: r.height / box.height })),
    );
    const text = cleanSelectedText(selection.toString());
    if (!text || rects.length === 0) return null;
    const bounds = range.getBoundingClientRect();
    const host = el.getBoundingClientRect();
    const top = bounds.top - host.top + el.scrollTop;
    return { selection: { page: Number(pageEl.dataset.page), rects, text }, x: bounds.left - host.left + el.scrollLeft, below: top + bounds.height + 6, above: top - 6 };
  }, []);

  const offer = useCallback((next: Offer) => {
    setWriting(false);
    setDraft('');
    setPending((current) => (current && current.selection.text === next.selection.text && current.selection.page === next.selection.page ? current : next));
  }, []);

  const onMouseUp = (event: MouseEvent) => {
    if ((event.target as Element).closest('.pdf-popover')) return;
    const next = selected();
    if (next) offer(next);
    else if (!writing) setPending(null);
  };

  // A finger selects with a long press and the handles, and no mouseup comes: follow the selection itself.
  // An emptied selection changes nothing here (tapping the menu empties it); a tap elsewhere closes the menu.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (writingRef.current) return;
        const next = selected();
        if (next) offer(next);
      }, 300);
    };
    document.addEventListener('selectionchange', onChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', onChange);
    };
  }, [selected, offer]);

  // The menu and the comment box go below the selection (a phone shows its own Copy menu above it), or above it
  // when there's no room below, and never past the PDF's edges. On a phone they are sheets instead, placed by the
  // CSS: the buttons at the bottom of the screen, the comment box at the top, where the keyboard can't cover it.
  useLayoutEffect(() => {
    const pop = popover.current;
    const el = scroller.current;
    if (!pop || !el || !pending) return;
    if (sheet) {
      pop.style.left = '';
      pop.style.top = '';
      return;
    }
    const margin = 8;
    const left = Math.min(pending.x, el.scrollLeft + el.clientWidth - pop.offsetWidth - margin);
    pop.style.left = `${Math.max(el.scrollLeft + margin, left)}px`;
    const fitsBelow = pending.below + pop.offsetHeight <= el.scrollTop + el.clientHeight - margin;
    pop.style.top = `${fitsBelow ? pending.below : Math.max(el.scrollTop + margin, pending.above - pop.offsetHeight)}px`;
  }, [pending, writing, sheet]);

  /** A click (not a selection) on a highlight shows its comment. */
  const onClick = (event: MouseEvent) => {
    if ((event.target as Element).closest('.pdf-popover') || !window.getSelection()?.isCollapsed) return;
    const pageEl = (event.target as Element).closest<HTMLElement>('.pdf-page');
    if (!pageEl) return;
    const box = pageEl.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    const hit = (byPage.get(Number(pageEl.dataset.page)) ?? []).find((h) => h.rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h));
    if (hit) onHighlightClick(hit);
  };

  const finish = (comment: string | null) => {
    if (!pending) return;
    onHighlight(pending.selection, comment);
    window.getSelection()?.removeAllRanges();
    setPending(null);
    setWriting(false);
    setDraft('');
  };

  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar">
        <button type="button" className="icon-button" aria-label="Previous page" disabled={page <= 1} onClick={() => scrollTo(page - 1)}>
          <Icon name="left" />
        </button>
        <span className="muted small">{doc ? `${page} / ${doc.numPages}` : '…'}</span>
        <button type="button" className="icon-button" aria-label="Next page" disabled={!doc || page >= doc.numPages} onClick={() => scrollTo(page + 1)}>
          <Icon name="right" />
        </button>
        <span className="spacer" />
        <button type="button" className="icon-button" aria-label="Zoom out" onClick={() => setZoom(Math.max(0.4, round(scale - 0.15)))}>
          −
        </button>
        <button type="button" className={zoom === 'fit' ? 'button small active' : 'button small'} onClick={() => setZoom('fit')}>
          Fit width
        </button>
        <button type="button" className="icon-button" aria-label="Zoom in" onClick={() => setZoom(Math.min(4, round(scale + 0.15)))}>
          +
        </button>
        <a className="icon-button" href={url} target="_blank" rel="noopener" title="Open the PDF in a new tab">
          <Icon name="external" />
        </a>
      </div>
      <div ref={scroller} className="pdf-scroll" onScroll={onScroll} onMouseUp={onMouseUp} onClick={onClick}>
        {error && <p className="error">Couldn’t open this PDF: {error}</p>}
        {!doc && !error && <p className="muted">Opening the PDF…</p>}
        {doc && (
          <div className="pdf-pages">
            {sizes.map((size, i) => (
              <PdfPage
                key={i + 1}
                doc={doc}
                number={i + 1}
                scale={scale}
                size={size}
                highlights={byPage.get(i + 1) ?? []}
                comments={comments}
                resolved={resolved}
                flash={flash}
                flashRect={flashRect?.page === i + 1 ? flashRect.rect : null}
                onMarker={onHighlightClick}
              />
            ))}
          </div>
        )}
        {pending && (
          <div ref={popover} className={`pdf-popover${sheet ? ' sheet' : ''}${writing ? ' writing' : ''}`}>
            {!writing ? (
              <div className="pdf-popover-actions">
                <button type="button" className="primary" onMouseDown={(e) => e.preventDefault()} onClick={() => finish(null)}>
                  <Icon name="highlight" size={16} /> Highlight
                </button>
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setWriting(true)}>
                  <Icon name="comment" size={16} /> Comment
                </button>
              </div>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (draft.trim()) finish(draft);
                }}
              >
                <blockquote>{pending.selection.text.length > 140 ? `${pending.selection.text.slice(0, 140)}…` : pending.selection.text}</blockquote>
                <textarea
                  autoFocus
                  rows={4}
                  value={draft}
                  placeholder="Your comment (Ctrl+Enter saves)"
                  aria-label="Comment"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && draft.trim()) finish(draft);
                    if (e.key === 'Escape') setPending(null);
                  }}
                />
                <div className="dialog-actions">
                  <button type="button" onClick={() => setPending(null)}>
                    Cancel
                  </button>
                  <button type="submit" className="primary" disabled={!draft.trim()}>
                    Save comment
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
