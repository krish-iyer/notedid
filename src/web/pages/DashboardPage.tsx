import { type DragEvent as ReactDragEvent, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { NoteSummary } from '../../shared/api.ts';
import { addCard, addCluster, type Board, type BoardCard, type BoardCluster, cardLine, cardsOf, moveCard, parseBoard, removeCard, renameCluster, serializeBoard } from '../../shared/board.ts';
import { itemCount, itemWidth, moveTab, removeTab, setItemWidth } from '../../shared/dashboard.ts';
import { fuzzyFilter } from '../../shared/fuzzy.ts';
import { parseWikiTarget } from '../../shared/markdown.ts';
import { tagify } from '../../shared/slug.ts';
import { cardTargetFor, createDashboard } from '../actions.ts';
import { api } from '../api.ts';
import { Icon, type IconName } from '../components/Icon.tsx';
import { Menu } from '../components/Menu.tsx';
import { NoteEditorPane, SaveBadge } from '../components/NoteEditorPane.tsx';
import { askConfirm, askText } from '../dialogs.ts';
import { MarkdownEditor } from '../editor/MarkdownEditor.tsx';
import type { SaveStatus } from '../noteSession.ts';
import { encodeNotePath, Link, noteHref } from '../router.ts';
import { notesStore, refreshNotes, resolveNote, useNote, useNotes } from '../stores.ts';
import { showToast } from '../toast.ts';
import { useNoteSession } from '../useNoteSession.ts';
import { messageOf, timeAgo } from '../util.ts';
import { BoardPage, PAPER_ID } from './BoardPage.tsx';
import { PaperPage } from './PaperPage.tsx';

// Excalidraw is large: it loads with the first whiteboard shown.
const WhiteboardPage = lazy(() => import('./WhiteboardPage.tsx'));

/*
 * A dashboard: named tabs, each holding notes, PDFs (papers) and boards that open right there, so
 * one project's material sits on one screen. It is a markdown file like a board: each ## heading
 * is a tab and each `- [[link]]` an item in it.
 */

function iconFor(kind: string | undefined): IconName {
  if (kind === 'paper') return 'paper';
  if (kind === 'whiteboard') return 'whiteboard';
  if (kind === 'board') return 'board';
  if (kind === 'dashboard') return 'dashboard';
  if (kind === 'journal') return 'today';
  return 'notes';
}

const labelOf = (n: NoteSummary) => (n.kind === 'journal' ? (n.date ?? n.title) : n.title);

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private windows may refuse; it just isn't remembered.
  }
}

export function DashboardsPage() {
  const notes = useNotes();
  const dashboards = notes.filter((n) => n.kind === 'dashboard').sort((a, b) => b.mtime - a.mtime);
  return (
    <div className="page narrow">
      <header className="page-head with-action">
        <h1>Dashboards</h1>
        <button type="button" className="primary" onClick={() => void createDashboard()}>
          <Icon name="plus" size={16} /> New dashboard
        </button>
      </header>
      <p className="muted">
        A dashboard puts the notes, PDFs and boards you work on together in named tabs, each opened right there. It is a markdown file: each ## heading is a tab and each list item links to a note, paper
        or board. Items are links, never copies.
      </p>
      {dashboards.length === 0 && <p className="muted">No dashboards yet.</p>}
      <ul className="note-list">
        {dashboards.map((d) => (
          <li key={d.path}>
            <div className="note-row-head">
              <Icon name="dashboard" size={15} />
              <Link to={noteHref(d.path, 'dashboard')} className="result-title">
                {d.title}
              </Link>
              <span className="muted small">{timeAgo(d.mtime)}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

type AddKind = 'note' | 'pdf' | 'board' | 'whiteboard';

const ADD_KINDS: { kind: AddKind; label: string; icon: IconName }[] = [
  { kind: 'note', label: 'Note', icon: 'notes' },
  { kind: 'pdf', label: 'PDF', icon: 'paper' },
  { kind: 'board', label: 'Board', icon: 'board' },
  { kind: 'whiteboard', label: 'Whiteboard', icon: 'whiteboard' },
];

function matchesKind(n: NoteSummary, kind: AddKind): boolean {
  if (kind === 'pdf') return n.kind === 'paper';
  if (kind === 'board') return n.kind === 'board';
  if (kind === 'whiteboard') return n.kind === 'whiteboard';
  return n.kind === 'note' || n.kind === 'journal';
}

type Option = { type: 'note'; note: NoteSummary } | { type: 'create'; label: string };

/** Finds a note, paper or board to add, or makes a new one (a note, an imported paper, an uploaded PDF, a board). */
function AddItem({ kind, exclude, onAdd, onClose }: { kind: AddKind; exclude: Set<string>; onAdd: (notePath: string, title: string) => void; onClose: () => void }) {
  const notes = useNotes();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const q = query.trim();

  const candidates = useMemo(() => notes.filter((n) => matchesKind(n, kind) && !exclude.has(n.path)), [notes, kind, exclude]);
  const results = useMemo(
    () => (q ? fuzzyFilter(candidates, q, labelOf, 8).map((r) => r.item) : [...candidates].sort((a, b) => b.mtime - a.mtime).slice(0, 8)),
    [candidates, q],
  );
  const exact = results.some((n) => labelOf(n).toLowerCase() === q.toLowerCase());
  const createLabel = !q || exact ? null : kind === 'pdf' ? (PAPER_ID.test(q) ? `Import ${q}` : null) : kind === 'board' ? `Create board “${q}”` : kind === 'whiteboard' ? `Create whiteboard “${q}”` : `Create note “${q}”`;
  const options: Option[] = [...results.map((note): Option => ({ type: 'note', note })), ...(createLabel ? [{ type: 'create', label: createLabel } as const] : [])];

  useEffect(() => setActive(0), [q]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (err) {
      showToast(messageOf(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  /** Adds a note that was just made, once the notes list knows it. */
  const addNew = async (notePath: string) => {
    await refreshNotes();
    const made = (notesStore.get() ?? []).find((n) => n.path === notePath);
    onAdd(notePath, made ? labelOf(made) : notePath.replace(/\.md$/, ''));
  };

  const create = () =>
    run(async () => {
      if (kind === 'pdf') {
        const result = await api.importPaper(q);
        if (result.existing) showToast('That paper was already in Papers');
        else if (!result.pdf) showToast('Imported the details. Add the PDF on the paper’s page.');
        return addNew(result.path);
      }
      if (kind === 'board') return addNew((await api.createBoard(q, tagify(q))).path);
      if (kind === 'whiteboard') return addNew((await api.createWhiteboard(q)).path);
      return addNew((await api.createNote(q)).path);
    });

  const upload = (files: File[]) =>
    run(async () => {
      for (const file of files.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf')) await addNew((await api.uploadPaper(file)).path);
    });

  const choose = (option: Option | undefined) => {
    if (!option || busy) return;
    if (option.type === 'note') onAdd(option.note.path, labelOf(option.note));
    else void create();
  };

  const placeholder =
    kind === 'pdf' ? 'Find a paper, or paste an arXiv link or DOI' : kind === 'board' ? 'Find a board, or name a new one' : kind === 'whiteboard' ? 'Find a whiteboard, or name a new one' : 'Find a note, or type a new title';
  return (
    <div className="dash-add">
      <div className="dash-add-row">
        <Icon name={ADD_KINDS.find((k) => k.kind === kind)?.icon ?? 'notes'} size={16} />
        <input
          autoFocus
          className="text-input"
          value={query}
          disabled={busy}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, options.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              choose(options[active]);
            }
          }}
        />
        {kind === 'pdf' && (
          <>
            <button type="button" disabled={busy} onClick={() => fileInput.current?.click()}>
              <Icon name="upload" size={15} /> Upload PDF
            </button>
            <input ref={fileInput} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => void upload([...(e.target.files ?? [])])} />
          </>
        )}
        <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={15} />
        </button>
      </div>
      {busy && <p className="muted small">Working…</p>}
      {options.length > 0 ? (
        <ul className="dash-add-results" role="listbox" aria-label="Matches">
          {options.map((option, i) => (
            <li key={option.type === 'note' ? option.note.path : 'create'}>
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                className={i === active ? 'popover-item active' : 'popover-item'}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(option)}
              >
                {option.type === 'note' ? (
                  <>
                    <Icon name={iconFor(option.note.kind)} size={14} /> <span className="dash-add-title">{labelOf(option.note)}</span>
                    <span className="muted small">{timeAgo(option.note.mtime)}</span>
                  </>
                ) : (
                  <>
                    <Icon name="plus" size={14} /> {option.label}
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small dash-add-hint">
          {kind === 'pdf'
            ? 'No papers match. Paste an arXiv link or DOI to import one, or upload a PDF.'
            : kind === 'board'
              ? 'No boards yet. Type a name to create one.'
              : 'No notes match. Type a title to create one.'}
        </p>
      )}
    </div>
  );
}

/** Dragging an item by its handle: which item, and where it would land. */
interface ItemDrag {
  /** The item being dragged, or null when nothing is. */
  dragging: string | null;
  /** This item shows a drop line before or after it. */
  drop: 'before' | 'after' | null;
  onStart: () => void;
  onEnd: () => void;
  onOver: (before: boolean) => void;
  onDrop: (before: boolean) => void;
}

const DRAG_TYPE = 'application/x-notesapp-dashboard-item';

/** One item in a tab: the note, paper or board itself, opened right here. */
function Panel(props: {
  card: BoardCard;
  index: number;
  count: number;
  tab: BoardCluster;
  tabs: BoardCluster[];
  dashPath: string;
  drag: ItemDrag;
  onApply: (change: (d: Board) => Board) => void;
}) {
  const { card, index, count, tab, tabs, dashPath, drag, onApply } = props;
  useNotes(); // re-resolve when notes are renamed or added
  const target = card.kind === 'note' && card.target ? resolveNote(card.target, dashPath) : null;
  const [status, setStatus] = useState<SaveStatus | null>(null);
  // Keyed by the link, not the whole line, so changing the width doesn't forget it.
  const collapsedKey = `notesapp-dash-collapsed:${dashPath}:${card.target ?? card.text}`;
  const [collapsed, setCollapsed] = useState(() => readStored(collapsedKey) === '1');
  const kind = target?.kind ?? (card.kind === 'note' ? 'missing' : card.kind);
  // Notes start half width, papers, boards and whiteboards full width; {full} or {half} after the link changes that.
  const fullByDefault = kind === 'paper' || kind === 'board' || kind === 'whiteboard';
  const chosen = itemWidth(card);
  const wide = chosen ? chosen === 'full' : fullByDefault;
  const toggleWidth = () => onApply((d) => setItemWidth(d, card.id, wide === fullByDefault ? (wide ? 'half' : 'full') : null));
  const title = target ? labelOf(target) : (card.label ?? card.target ?? card.text);

  const toggle = () => {
    store(collapsedKey, collapsed ? null : '1');
    setCollapsed(!collapsed);
  };

  const remove = () => {
    onApply((d) => removeCard(d, card.id));
    showToast(`Removed “${title}” from ${tab.title}`, 'info', {
      label: 'Undo',
      run: () => onApply((d) => addCard(d, tab.id, card.lines[0] ?? cardLine('note', title), index)),
    });
  };

  const body = () => {
    if (card.kind !== 'note') {
      return (
        <p className="dash-text">
          {card.kind === 'link' && card.target ? (
            <a href={card.target} target="_blank" rel="noopener noreferrer">
              {card.label ?? card.target}
            </a>
          ) : (
            card.text
          )}
        </p>
      );
    }
    if (!target) return <p className="muted dash-text">There’s no note called “{card.target}”. It may have been renamed or deleted.</p>;
    if (target.kind === 'paper') return <PaperPage path={target.path} page={null} highlight={null} embedded />;
    if (target.kind === 'board') return <BoardPage path={target.path} embedded />;
    if (target.kind === 'whiteboard') {
      // [[Whiteboard#Frame]]: the whiteboard, on that frame.
      const inner = /\[\[([^\]]+)\]\]/.exec(card.text)?.[1];
      return (
        <Suspense fallback={<p className="muted dash-text">Opening the whiteboard…</p>}>
          <WhiteboardPage path={target.path} frame={inner ? parseWikiTarget(inner).heading : null} embedded />
        </Suspense>
      );
    }
    if (target.kind === 'dashboard') {
      return (
        <p className="dash-text">
          <Link to={noteHref(target.path, 'dashboard')}>Open the dashboard “{title}”</Link>
        </p>
      );
    }
    return <NoteEditorPane path={target.path} label={title} onStatus={setStatus} placeholder="Write here…" />;
  };

  /** Where a drop lands: side by side items split left and right, full-width ones top and bottom. */
  const isBefore = (event: ReactDragEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return wide ? event.clientY < box.top + box.height / 2 : event.clientX < box.left + box.width / 2;
  };
  const ours = (event: ReactDragEvent) => drag.dragging !== null && event.dataTransfer.types.includes(DRAG_TYPE);

  return (
    <section
      className={`dash-panel kind-${kind}${wide ? ' wide' : ''}${collapsed ? ' collapsed' : ''}${drag.dragging === card.id ? ' dragging' : ''}${drag.drop ? ` drop-${drag.drop}` : ''}`}
      aria-label={title}
      // Capture phase: a note's editor or a board inside must not take the drop.
      onDragOverCapture={(e) => {
        if (!ours(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        if (drag.dragging !== card.id) drag.onOver(isBefore(e));
      }}
      onDropCapture={(e) => {
        if (!ours(e)) return;
        e.preventDefault();
        e.stopPropagation();
        if (drag.dragging !== card.id) drag.onDrop(isBefore(e));
        else drag.onEnd();
      }}
    >
      <header className="dash-panel-head">
        <span
          className="dash-grip"
          draggable
          title="Drag to move (drop on another item, or on a tab)"
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG_TYPE, card.id);
            e.dataTransfer.effectAllowed = 'move';
            const head = e.currentTarget.parentElement;
            if (head) e.dataTransfer.setDragImage(head, 24, 16);
            drag.onStart();
          }}
          onDragEnd={drag.onEnd}
        >
          <Icon name="grip" size={16} />
        </span>
        <button type="button" className="icon-button" aria-label={collapsed ? `Show ${title}` : `Fold ${title}`} aria-expanded={!collapsed} onClick={toggle}>
          <span className="chevron" aria-hidden="true">
            {collapsed ? '▸' : '▾'}
          </span>
        </button>
        <Icon name={iconFor(target?.kind)} size={15} />
        {target ? (
          <Link to={noteHref(target.path, target.kind)} className="dash-panel-title" title="Open on its own page">
            {title}
          </Link>
        ) : (
          <span className="dash-panel-title">{title}</span>
        )}
        {status && <SaveBadge status={status} />}
        <span className="spacer" />
        <button type="button" className="icon-button" title={wide ? 'Half width' : 'Full width'} aria-label={wide ? `Make ${title} half width` : `Make ${title} full width`} onClick={toggleWidth}>
          <Icon name={wide ? 'narrow' : 'widen'} size={15} />
        </button>
        <Menu
          label={`Options for ${title}`}
          items={[
            { label: 'Move up', disabled: index === 0, run: () => onApply((d) => moveCard(d, card.id, tab.id, index - 1)) },
            { label: 'Move down', disabled: index >= count - 1, run: () => onApply((d) => moveCard(d, card.id, tab.id, index + 2)) },
            { label: wide ? 'Half width' : 'Full width', run: toggleWidth },
            ...tabs.filter((t) => t.id !== tab.id).map((t) => ({ label: `Move to “${t.title}”`, run: () => onApply((d) => moveCard(d, card.id, t.id, Number.MAX_SAFE_INTEGER)) })),
            { label: 'Remove from this tab', danger: true, run: remove },
          ]}
        />
      </header>
      {!collapsed && <div className="dash-panel-body">{body()}</div>}
    </section>
  );
}

/** A dashboard: tabs you name, each with the notes, PDFs and boards you put in it. */
export function DashboardPage({ path }: { path: string }) {
  const note = useNote(path);
  const { state, edit, flush } = useNoteSession(path);
  const [text, setText] = useState<string | null>(null);
  const [textVersion, setTextVersion] = useState(0);
  const [mode, setMode] = useState<'tabs' | 'text'>('tabs');
  const [adding, setAdding] = useState<AddKind | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ cardId: string; before: boolean } | null>(null);
  const [dropTab, setDropTab] = useState<string | null>(null);
  const tabKey = `notesapp-dash-tab:${path}`;
  const [activeTitle, setActiveTitle] = useState<string | null>(() => readStored(tabKey));

  // The first load, and changes made elsewhere.
  useEffect(() => {
    if (state.editor) {
      setText(state.editor.content);
      setTextVersion((v) => v + 1);
    }
  }, [state.editor]);

  const dash = useMemo(() => (text === null ? null : parseBoard(text)), [text]);
  const latest = useRef(dash);
  latest.current = dash;

  const apply = (next: Board) => {
    const serialized = serializeBoard(next);
    setText(serialized);
    edit(serialized);
    void flush();
  };
  /** Applies a change to the dashboard as it is now (also after an await, or from an Undo). */
  const applyLatest = (change: (current: Board) => Board) => {
    if (latest.current) apply(change(latest.current));
  };

  const select = (title: string | null) => {
    setActiveTitle(title);
    store(tabKey, title);
    setAdding(null);
  };

  if (state.status === 'error' && !state.editor) return <p className="error page">Couldn’t open this dashboard: {state.error}</p>;
  if (!dash) return <p className="muted page">Loading…</p>;

  const active = dash.clusters.find((c) => c.title === activeTitle) ?? dash.clusters[0] ?? null;
  const cards = active ? cardsOf(active) : [];
  const inTab = new Set(cards.flatMap((c) => (c.kind === 'note' && c.target ? [resolveNote(c.target, path)?.path ?? ''] : [])));
  const seen = new Map<string, number>();
  const keyOf = (card: BoardCard) => {
    const id = `${card.kind}:${card.target ?? card.text}`;
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return `${id}#${n}`;
  };

  const endDrag = () => {
    setDragging(null);
    setDropAt(null);
    setDropTab(null);
  };
  const dragFor = (card: BoardCard, index: number): ItemDrag => ({
    dragging,
    drop: dropAt?.cardId === card.id ? (dropAt.before ? 'before' : 'after') : null,
    onStart: () => setDragging(card.id),
    onEnd: endDrag,
    onOver: (before) => (dropAt?.cardId !== card.id || dropAt.before !== before) && setDropAt({ cardId: card.id, before }),
    onDrop: (before) => {
      const moving = dragging;
      const tabId = active?.id;
      if (moving && tabId) applyLatest((d) => moveCard(d, moving, tabId, index + (before ? 0 : 1)));
      endDrag();
    },
  });
  const dropOnTab = (tab: BoardCluster) => {
    const moving = dragging;
    if (moving && tab !== active) {
      applyLatest((d) => moveCard(d, moving, tab.id, Number.MAX_SAFE_INTEGER));
      showToast(`Moved to “${tab.title}”`);
    }
    endDrag();
  };

  const addTab = async () => {
    const title = await askText({ title: 'New tab', placeholder: 'Name, e.g. Reading', confirmLabel: 'Add tab' });
    if (!title) return;
    if (dash.clusters.some((c) => c.title === title)) return showToast(`There is already a tab called “${title}”`, 'error');
    applyLatest((d) => addCluster(d, title));
    select(title);
  };

  const renameTab = async (tab: BoardCluster) => {
    const title = await askText({ title: 'Rename tab', initial: tab.title, confirmLabel: 'Rename' });
    if (!title || title === tab.title) return;
    if (dash.clusters.some((c) => c.title === title)) return showToast(`There is already a tab called “${title}”`, 'error');
    applyLatest((d) => renameCluster(d, tab.id, title));
    select(title);
  };

  const deleteTab = async (tab: BoardCluster) => {
    const n = itemCount(tab);
    if (n > 0) {
      const ok = await askConfirm({
        title: `Delete the tab “${tab.title}”?`,
        message: `Its ${n} item${n === 1 ? '' : 's'} leave the dashboard. The notes, papers and boards themselves stay.`,
        confirmLabel: 'Delete tab',
        danger: true,
      });
      if (!ok) return;
    }
    const at = dash.clusters.findIndex((c) => c.id === tab.id);
    applyLatest((d) => removeTab(d, tab.id));
    select(dash.clusters[at - 1]?.title ?? dash.clusters[at + 1]?.title ?? null);
  };

  const addItem = (notePath: string, title: string) => {
    const tabTitle = active?.title;
    applyLatest((d) => {
      const tab = d.clusters.find((c) => c.title === tabTitle);
      return tab ? addCard(d, tab.id, cardLine('note', cardTargetFor(notePath, title))) : d;
    });
    setAdding(null);
  };

  return (
    <div className="dash-page">
      <header className="dash-head">
        <div className="title-row">
          <h1>{dash.title || note?.title || 'Dashboard'}</h1>
          <div className="actions">
            <SaveBadge status={state.status} />
            <div className="segmented" role="group" aria-label="View">
              <button type="button" className={mode === 'tabs' ? 'active' : ''} aria-pressed={mode === 'tabs'} onClick={() => setMode('tabs')}>
                Tabs
              </button>
              <button type="button" className={mode === 'text' ? 'active' : ''} aria-pressed={mode === 'text'} onClick={() => setMode('text')}>
                Text
              </button>
            </div>
            <Link to={`/note/${encodeNotePath(path)}`} className="icon-button" title="Open as a note (links, history)">
              <Icon name="notes" />
            </Link>
          </div>
        </div>
        {state.conflict && (
          <div className="banner" role="alert">
            <p>This dashboard was changed somewhere else. Reload it to see those changes (yours since then will be lost).</p>
          </div>
        )}
      </header>

      {mode === 'text' ? (
        <div className="board-text">
          <MarkdownEditor
            content={text ?? ''}
            version={textVersion}
            onChange={(t) => {
              setText(t);
              edit(t);
            }}
            label="Dashboard as text"
            notePath={path}
            registryKey={`dashboard:${path}`}
          />
        </div>
      ) : (
        <>
          <div className="dash-tabs" role="tablist" aria-label="Tabs">
            {dash.clusters.map((tab, i) => (
              <div
                key={tab.id}
                className={`dash-tab${tab === active ? ' active' : ''}${dropTab === tab.id ? ' drop-target' : ''}`}
                onDragOver={(e) => {
                  if (!dragging || tab === active) return;
                  e.preventDefault();
                  setDropTab(tab.id);
                }}
                onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropTab(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  dropOnTab(tab);
                }}
              >
                <button type="button" role="tab" aria-selected={tab === active} title="Double-click to rename" onClick={() => select(tab.title)} onDoubleClick={() => void renameTab(tab)}>
                  {tab.title}
                  <span className="count">{itemCount(tab)}</span>
                </button>
                {tab === active && (
                  <Menu
                    label={`Tab “${tab.title}”`}
                    items={[
                      { label: 'Rename', run: () => void renameTab(tab) },
                      { label: 'Move left', disabled: i === 0, run: () => applyLatest((d) => moveTab(d, tab.id, -1)) },
                      { label: 'Move right', disabled: i === dash.clusters.length - 1, run: () => applyLatest((d) => moveTab(d, tab.id, 1)) },
                      { label: 'Delete tab', danger: true, run: () => void deleteTab(tab) },
                    ]}
                  />
                )}
              </div>
            ))}
            <button type="button" className="dash-tab-add" onClick={() => void addTab()}>
              <Icon name="plus" size={14} /> New tab
            </button>
          </div>

          {active ? (
            <section className="dash-tabpanel" role="tabpanel" aria-label={active.title}>
              <div className="dash-toolbar">
                {ADD_KINDS.map((k) => (
                  <button key={k.kind} type="button" className={adding === k.kind ? 'pressed' : ''} aria-pressed={adding === k.kind} onClick={() => setAdding(adding === k.kind ? null : k.kind)}>
                    <Icon name={k.icon} size={15} /> Add {k.label}
                  </button>
                ))}
              </div>
              {adding && <AddItem key={`${adding}:${active.title}`} kind={adding} exclude={inTab} onAdd={addItem} onClose={() => setAdding(null)} />}
              {cards.length === 0 && !adding && <p className="dash-empty">This tab is empty. Add notes, PDFs and boards to keep them here, side by side.</p>}
              <div className="dash-grid">
                {cards.map((card, i) => (
                  <Panel key={keyOf(card)} card={card} index={i} count={cards.length} tab={active} tabs={dash.clusters} dashPath={path} drag={dragFor(card, i)} onApply={applyLatest} />
                ))}
              </div>
            </section>
          ) : (
            <p className="dash-empty">No tabs yet. Add one to start.</p>
          )}
        </>
      )}
    </div>
  );
}
