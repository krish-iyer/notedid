import { type DragEvent, Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { NoteSummary } from '../../shared/api.ts';
import {
  addCard,
  addCluster,
  type Board,
  type BoardCard,
  type BoardCluster,
  cardLine,
  cardsOf,
  moveCard,
  parseBoard,
  removeCard,
  removeCluster,
  renameCluster,
  replaceCard,
  serializeBoard,
} from '../../shared/board.ts';
import { cardTargetFor, createBoard } from '../actions.ts';
import { api } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import { SaveBadge } from '../components/NoteEditorPane.tsx';
import { TaskRow } from '../components/TaskRow.tsx';
import { askText } from '../dialogs.ts';
import { MarkdownEditor } from '../editor/MarkdownEditor.tsx';
import { useLiveData, useToday } from '../hooks.ts';
import { encodeNotePath, Link, navigate, noteHref } from '../router.ts';
import { notesStore, refreshNotes, resolveNote, useNote, useNotes } from '../stores.ts';
import { showToast } from '../toast.ts';
import { useNoteSession } from '../useNoteSession.ts';
import { messageOf, timeAgo } from '../util.ts';

export function BoardsPage() {
  const notes = useNotes();
  const boards = notes.filter((n) => n.kind === 'board');
  return (
    <div className="page narrow">
      <header className="page-head with-action">
        <h1>Project boards</h1>
        <button type="button" className="primary" onClick={() => void createBoard()}>
          <Icon name="plus" size={16} /> New board
        </button>
      </header>
      <p className="muted">
        A board gathers one project’s notes, tasks, papers and links into clusters. It is an ordinary markdown file: each ## heading is a cluster and each list item a card. Cards point to notes; they
        are never copies.
      </p>
      {boards.length === 0 && <p className="muted">No boards yet.</p>}
      <ul className="note-list">
        {boards.map((b) => (
          <li key={b.path}>
            <div className="note-row-head">
              <Link to={noteHref(b.path, 'board')} className="result-title">
                {b.title}
              </Link>
              {typeof b.meta.tag === 'string' && <span className="tag-chip">#{b.meta.tag}</span>}
              <span className="muted small">{timeAgo(b.mtime)}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export const PAPER_ID = /arxiv\.org\/(abs|pdf)\/|^(arxiv:\s*)?\d{4}\.\d{4,5}(v\d+)?$|^(https?:\/\/(dx\.)?doi\.org\/)?10\.\d{4,9}\//i;

function findNote(notes: NoteSummary[], text: string): NoteSummary | undefined {
  const wanted = text.toLowerCase();
  return notes.find((n) => n.title.toLowerCase() === wanted || (n.kind === 'journal' && n.date === text));
}

function QueryCard({ query }: { query: string }) {
  const today = useToday();
  const { data, error } = useLiveData(() => api.search(query, today), [query, today]);
  return (
    <div className="card-body">
      <div className="card-title">
        <Icon name="search" size={14} />
        <Link to={`/search?q=${encodeURIComponent(query)}`}>{query}</Link>
      </div>
      {error && <p className="error small">{error}</p>}
      {data?.mode === 'tasks' && (
        <ul className="task-list compact">
          {data.tasks.slice(0, 8).map((t) => (
            <TaskRow key={`${t.path}:${t.line}:${t.raw}`} task={t} today={today} />
          ))}
          {data.tasks.length === 0 && <li className="muted small">Nothing right now.</li>}
        </ul>
      )}
      {data?.mode === 'notes' && (
        <ul className="mini-list">
          {data.notes.slice(0, 8).map((n) => (
            <li key={n.path}>
              <Link to={noteHref(n.path, n.kind)}>{n.title}</Link>
            </li>
          ))}
          {data.notes.length === 0 && <li className="muted small">Nothing matches.</li>}
        </ul>
      )}
    </div>
  );
}

function NoteCard({ card, boardPath }: { card: BoardCard; boardPath: string }) {
  const note = resolveNote(card.target ?? '', boardPath);
  if (!note) {
    const create = async () => {
      try {
        const { path } = await api.createNote(card.target ?? 'Untitled');
        await refreshNotes();
        navigate(noteHref(path));
      } catch (err) {
        showToast(`Could not create it: ${messageOf(err)}`, 'error');
      }
    };
    return (
      <div className="card-body missing">
        <div className="card-title">{card.label ?? card.target}</div>
        <button type="button" className="link-button small" onClick={() => void create()}>
          Create this note
        </button>
      </div>
    );
  }
  return (
    <div className="card-body">
      <div className="card-title">
        <Icon name={note.kind === 'paper' ? 'paper' : note.kind === 'journal' ? 'today' : note.kind === 'board' ? 'board' : note.kind === 'dashboard' ? 'dashboard' : 'notes'} size={14} />
        <Link to={noteHref(note.path, note.kind)}>{card.label ?? note.title}</Link>
        {note.openTasks > 0 && <span className="badge" title="Open tasks">{note.openTasks}</span>}
      </div>
      {note.excerpt && <p className="card-excerpt">{note.excerpt}</p>}
    </div>
  );
}

function TextCard({ card, onChange }: { card: BoardCard; onChange: (text: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(card.text);
  if (editing) {
    return (
      <form
        className="card-body"
        onSubmit={(e) => {
          e.preventDefault();
          setEditing(false);
          if (value.trim() && value !== card.text) onChange(value.trim());
        }}
      >
        <textarea autoFocus value={value} rows={3} aria-label="Card text" onChange={(e) => setValue(e.target.value)} onBlur={(e) => e.currentTarget.form?.requestSubmit()} onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), e.currentTarget.form?.requestSubmit())} />
      </form>
    );
  }
  return (
    <div className="card-body sticky" onDoubleClick={() => setEditing(true)} title="Double-click to edit">
      {card.text}
    </div>
  );
}

function CardView(props: {
  card: BoardCard;
  board: Board;
  boardPath: string;
  cluster: BoardCluster;
  onApply: (next: Board) => void;
  onDragStart: (event: DragEvent, card: BoardCard) => void;
  onDragEnd: () => void;
}) {
  const { card, board, boardPath, cluster, onApply, onDragStart, onDragEnd } = props;
  return (
    <li className={`card card-${card.kind}`} data-card={card.id} draggable onDragStart={(e) => onDragStart(e, card)} onDragEnd={onDragEnd}>
      {card.kind === 'note' && <NoteCard card={card} boardPath={boardPath} />}
      {card.kind === 'query' && <QueryCard query={card.query ?? ''} />}
      {card.kind === 'link' && (
        <div className="card-body">
          <div className="card-title">
            <Icon name="external" size={14} />
            <a href={card.target ?? '#'} target="_blank" rel="noopener noreferrer">
              {card.label ?? (card.target ? new URL(card.target).hostname + new URL(card.target).pathname.replace(/\/$/, '') : '')}
            </a>
          </div>
        </div>
      )}
      {card.kind === 'text' && <TextCard card={card} onChange={(text) => onApply(replaceCard(board, card.id, cardLine('text', text)))} />}
      <div className="card-tools">
        <select
          value=""
          aria-label="Move to cluster"
          onChange={(e) => {
            const to = board.clusters.find((c) => c.id === e.target.value);
            if (to) onApply(moveCard(board, card.id, to.id, cardsOf(to).length + (to.id === cluster.id ? 1 : 0)));
          }}
        >
          <option value="">Move to…</option>
          {board.clusters
            .filter((c) => c.id !== cluster.id)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
        </select>
        <button type="button" className="icon-button" aria-label="Remove card (the note itself stays)" title="Remove card (the note itself stays)" onClick={() => onApply(removeCard(board, card.id))}>
          <Icon name="close" size={14} />
        </button>
      </div>
    </li>
  );
}

/**
 * The "+ Add card" box. A note or paper title adds that note; an arXiv link or DOI imports the
 * paper; a web link or `query:` adds those; anything else asks: create a note, or a text card?
 */
function AddCard({ onAdd }: { onAdd: (line: string) => void }) {
  const notes = useNotes();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState<string | null>(null);

  const reset = () => {
    setValue('');
    setUnknown(null);
  };

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
      reset();
    } catch (err) {
      showToast(messageOf(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    const v = value.trim();
    if (!v) return;
    if (/^query:/i.test(v) || /^\[\[[^\]]+\]\]$/.test(v)) {
      onAdd(`- ${v}`);
      return reset();
    }
    if (PAPER_ID.test(v)) {
      return void run(async () => {
        const result = await api.importPaper(v);
        await refreshNotes();
        const paper = (notesStore.get() ?? []).find((n) => n.path === result.path);
        onAdd(cardLine('note', cardTargetFor(result.path, paper?.title ?? result.path)));
        showToast(result.existing ? 'That paper was already in Papers; it’s on the board now' : 'Imported the paper and added it to the board');
      });
    }
    if (/^https?:\/\/\S+$/.test(v)) {
      onAdd(`- ${v}`);
      return reset();
    }
    const note = findNote(notes, v);
    if (note) {
      onAdd(cardLine('note', cardTargetFor(note.path, note.kind === 'journal' ? (note.date ?? note.title) : note.title)));
      return reset();
    }
    setUnknown(v);
  };

  if (!open) {
    return (
      <button type="button" className="add-card" onClick={() => setOpen(true)}>
        + Add card
      </button>
    );
  }
  return (
    <div className="add-card-box">
      <form
        className="add-card-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          className="text-input"
          list="board-note-titles"
          autoFocus
          value={value}
          disabled={busy}
          placeholder="Note or paper title, arXiv link, DOI…"
          aria-label="New card"
          onChange={(e) => {
            setValue(e.target.value);
            setUnknown(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setOpen(false);
              reset();
            }
          }}
        />
        <button type="submit" className="primary small" disabled={busy || !value.trim()}>
          {busy ? '…' : 'Add'}
        </button>
      </form>
      {unknown ? (
        <div className="add-card-choice">
          <span className="muted small">No note called “{unknown}” yet.</span>
          <button
            type="button"
            className="primary small"
            onClick={() =>
              void run(async () => {
                const { path } = await api.createNote(unknown);
                await refreshNotes();
                onAdd(cardLine('note', cardTargetFor(path, unknown)));
              })
            }
          >
            Create note
          </button>
          <button
            type="button"
            className="small"
            onClick={() => {
              onAdd(cardLine('text', unknown));
              reset();
            }}
          >
            Add as text
          </button>
        </div>
      ) : (
        <p className="hint">
          A note or paper title, an arXiv link or DOI (imports the paper), a web link, <code>query: is:open</code>, or new text.
        </p>
      )}
    </div>
  );
}

type Drag = { kind: 'card'; cardId: string } | { kind: 'note'; title: string };

/** A project board: clusters of cards that point to notes, papers, live queries, links and text. */
export function BoardPage({ path, embedded = false }: { path: string; embedded?: boolean }) {
  const note = useNote(path);
  const notes = useNotes();
  const { state, edit, flush } = useNoteSession(path);
  const [text, setText] = useState<string | null>(null);
  const [textVersion, setTextVersion] = useState(0);
  const [mode, setMode] = useState<'board' | 'text'>('board');
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dropAt, setDropAt] = useState<{ cluster: string; index: number } | null>(null);

  // The first load, and changes made elsewhere.
  useEffect(() => {
    if (state.editor) {
      setText(state.editor.content);
      setTextVersion((v) => v + 1);
    }
  }, [state.editor]);

  const board = useMemo(() => (text === null ? null : parseBoard(text)), [text]);
  const latest = useRef(board);
  latest.current = board;

  const apply = (next: Board) => {
    const serialized = serializeBoard(next);
    setText(serialized);
    edit(serialized);
    void flush();
  };

  /** For changes made after an await (importing a paper, creating a note): apply them to the board as it is by then. */
  const applyLatest = (change: (current: Board) => Board) => {
    if (latest.current) apply(change(latest.current));
  };

  const onBoard = useMemo(() => {
    const paths = new Set<string>();
    for (const cluster of board?.clusters ?? []) for (const card of cardsOf(cluster)) if (card.kind === 'note' && card.target) paths.add(resolveNote(card.target, path)?.path ?? '');
    return paths;
  }, [board, notes, path]);

  if (state.status === 'error' && !state.editor) return <p className="error page">Couldn’t open this board: {state.error}</p>;
  if (!board) return <p className="muted page">Loading…</p>;

  const tag = board.tag;
  const tray = tag ? notes.filter((n) => n.path !== path && n.kind !== 'board' && n.tags.some((t) => t === tag || t.startsWith(`${tag}/`)) && !onBoard.has(n.path)) : [];

  const indexAt = (list: HTMLElement, clientY: number) => {
    const cards = [...list.querySelectorAll<HTMLElement>('[data-card]')];
    const index = cards.findIndex((el) => {
      const box = el.getBoundingClientRect();
      return clientY < box.top + box.height / 2;
    });
    return index < 0 ? cards.length : index;
  };

  const onDragOver = (event: DragEvent, cluster: BoardCluster) => {
    if (!drag) return;
    event.preventDefault();
    const list = (event.currentTarget as HTMLElement).querySelector<HTMLElement>('.cards');
    if (list) setDropAt({ cluster: cluster.id, index: indexAt(list, event.clientY) });
  };

  const onDrop = (event: DragEvent, cluster: BoardCluster) => {
    event.preventDefault();
    const index = dropAt?.cluster === cluster.id ? dropAt.index : cardsOf(cluster).length;
    if (drag?.kind === 'card') apply(moveCard(board, drag.cardId, cluster.id, index));
    if (drag?.kind === 'note') apply(addCard(board, cluster.id, cardLine('note', drag.title), index));
    setDrag(null);
    setDropAt(null);
  };

  const addClusterPrompt = async () => {
    const title = await askText({ title: 'New cluster', placeholder: 'Name', confirmLabel: 'Add' });
    if (title) apply(addCluster(board, title));
  };

  const renameClusterPrompt = async (cluster: BoardCluster) => {
    const title = await askText({ title: 'Rename cluster', initial: cluster.title, confirmLabel: 'Rename' });
    if (title && title !== cluster.title) apply(renameCluster(board, cluster.id, title));
  };

  return (
    <div className={embedded ? 'board-page embedded' : 'board-page'}>
      <header className="board-head">
        {/* In a dashboard panel, the panel shows the title. */}
        <div className="title-row" hidden={embedded}>
          <h1>{board.title || note?.title || 'Board'}</h1>
          <div className="actions">
            <SaveBadge status={state.status} />
            {tag && (
              <Link to={`/search?q=${encodeURIComponent(`tag:${tag}`)}`} className="tag-chip">
                #{tag}
              </Link>
            )}
            <div className="segmented" role="group" aria-label="View">
              <button type="button" className={mode === 'board' ? 'active' : ''} aria-pressed={mode === 'board'} onClick={() => setMode('board')}>
                Board
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
            <p>This board was changed somewhere else. Reload it to see those changes (yours since then will be lost).</p>
          </div>
        )}
      </header>

      <datalist id="board-note-titles">
        {notes.slice(0, 500).map((n) => (
          <option key={n.path} value={n.title} />
        ))}
      </datalist>

      {mode === 'text' ? (
        <div className="board-text">
          <MarkdownEditor
            content={text ?? ''}
            version={textVersion}
            onChange={(t) => {
              setText(t);
              edit(t);
            }}
            label="Board as text"
            notePath={path}
            registryKey={`board:${path}`}
          />
        </div>
      ) : (
        <div className="board">
          {board.clusters.map((cluster) => {
            const cards = cardsOf(cluster);
            return (
              <section
                key={cluster.id}
                className={dropAt?.cluster === cluster.id ? 'cluster drag-over' : 'cluster'}
                onDragOver={(e) => onDragOver(e, cluster)}
                onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropAt(null)}
                onDrop={(e) => onDrop(e, cluster)}
                aria-label={cluster.title}
              >
                <header className="cluster-head">
                  <h2 onDoubleClick={() => void renameClusterPrompt(cluster)} title="Double-click to rename">
                    {cluster.title}
                  </h2>
                  <span className="muted small">{cards.length}</span>
                  {cards.length === 0 && (
                    <button type="button" className="icon-button" aria-label={`Remove cluster ${cluster.title}`} onClick={() => apply(removeCluster(board, cluster.id))}>
                      <Icon name="close" size={14} />
                    </button>
                  )}
                </header>
                <ul className="cards">
                  {cards.map((card, i) => (
                    <Fragment key={card.id}>
                      {dropAt?.cluster === cluster.id && dropAt.index === i && <li className="drop-line" aria-hidden="true" />}
                      <CardView
                        card={card}
                        board={board}
                        boardPath={path}
                        cluster={cluster}
                        onApply={apply}
                        onDragStart={(e, c) => {
                          e.dataTransfer.setData('text/plain', c.text);
                          e.dataTransfer.effectAllowed = 'move';
                          setDrag({ kind: 'card', cardId: c.id });
                        }}
                        onDragEnd={() => {
                          setDrag(null);
                          setDropAt(null);
                        }}
                      />
                    </Fragment>
                  ))}
                  {dropAt?.cluster === cluster.id && dropAt.index === cards.length && <li className="drop-line" aria-hidden="true" />}
                </ul>
                <AddCard onAdd={(line) => applyLatest((latest) => addCard(latest, cluster.id, line))} />
              </section>
            );
          })}
          <button type="button" className="add-cluster" onClick={() => void addClusterPrompt()}>
            + Add cluster
          </button>
        </div>
      )}

      {mode === 'board' && tag && (
        <aside className="tray" aria-label="Tray">
          <h2>
            Tray <span className="muted small">notes tagged #{tag} that aren’t on the board</span>
          </h2>
          {tray.length === 0 ? (
            <p className="muted small">Empty. Tag a note #{tag} (from anywhere, even a quick capture) and it shows up here.</p>
          ) : (
            <ul className="tray-items">
              {tray.map((n) => (
                <li
                  key={n.path}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', n.title);
                    setDrag({ kind: 'note', title: n.title });
                  }}
                  onDragEnd={() => {
                    setDrag(null);
                    setDropAt(null);
                  }}
                >
                  <Link to={noteHref(n.path, n.kind)}>{n.kind === 'journal' ? n.date : n.title}</Link>
                  {board.clusters[0] && (
                    <button type="button" className="link-button small" onClick={() => apply(addCard(board, board.clusters[0]?.id ?? '', cardLine('note', n.kind === 'journal' ? (n.date ?? n.title) : n.title)))}>
                      add to {board.clusters[0].title}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </aside>
      )}
    </div>
  );
}
