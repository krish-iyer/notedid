import { useState } from 'react';
import { addDays, formatDayTitle, journalPath } from '../../shared/dates.ts';
import { addExampleNotes, deleteNote, renameNote, togglePin } from '../actions.ts';
import { api } from '../api.ts';
import { AddToBoard } from '../components/AddToBoard.tsx';
import { Icon } from '../components/Icon.tsx';
import { NoteEditorPane, SaveBadge } from '../components/NoteEditorPane.tsx';
import { SidePanel } from '../components/SidePanel.tsx';
import { TaskRow } from '../components/TaskRow.tsx';
import { useLiveData, useToday } from '../hooks.ts';
import type { SaveStatus } from '../noteSession.ts';
import { encodeNotePath, Link, navigate, noteHref } from '../router.ts';
import { useNote, useNotes, useNotesLoaded, useSettings } from '../stores.ts';

function titleFromPath(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/i, '').replace(/-/g, ' ');
}

function PinButton({ path }: { path: string }) {
  const settings = useSettings();
  const pinned = settings?.pinned.includes(path) ?? false;
  return (
    <button type="button" className={pinned ? 'icon-button pressed' : 'icon-button'} aria-pressed={pinned} title={pinned ? 'Unpin from the sidebar' : 'Pin to the sidebar'} onClick={() => void togglePin(path)}>
      <Icon name="pin" />
    </button>
  );
}

/** Any note: title, actions, the editor, and links/outline/history beside it. */
export function NotePage({ path, anchor }: { path: string; anchor: string | null }) {
  const note = useNote(path);
  const [content, setContent] = useState('');
  const [status, setStatus] = useState<SaveStatus>('loading');
  const title = note?.title ?? titleFromPath(path);

  return (
    <div className="page-grid">
      <article className="note">
        <header className="note-head">
          <div className="title-row">
            <h1>{title}</h1>
            <div className="actions">
              {note?.kind === 'paper' && (
                <Link to={noteHref(path, 'paper')} className="button">
                  <Icon name="paper" size={16} /> Open with PDF
                </Link>
              )}
              {note?.kind === 'dashboard' && (
                <Link to={noteHref(path, 'dashboard')} className="button">
                  <Icon name="dashboard" size={16} /> Open as dashboard
                </Link>
              )}
              {note?.kind === 'board' && (
                <Link to={noteHref(path, 'board')} className="button">
                  <Icon name="board" size={16} /> Open as board
                </Link>
              )}
              <PinButton path={path} />
              {note?.kind !== 'board' && note?.kind !== 'dashboard' && <AddToBoard path={path} title={title} />}
              <Link to={`/read/${encodeNotePath(path)}`} className="icon-button" title="Read and comment">
                <Icon name="read" />
              </Link>
              <button type="button" className="icon-button" title="Rename" onClick={() => void renameNote(path, title)}>
                <Icon name="edit" />
              </button>
              <button type="button" className="icon-button" title="Delete" onClick={() => void deleteNote(path, title)}>
                <Icon name="trash" />
              </button>
            </div>
          </div>
          <p className="meta">
            <span className="path">{path}</span>
            <SaveBadge status={status} />
            {note?.tags.map((t) => (
              <Link key={t} to={`/search?q=${encodeURIComponent(`tag:${t}`)}`} className="tag-chip">
                #{t}
              </Link>
            ))}
          </p>
        </header>
        <NoteEditorPane path={path} label={`Note: ${title}`} anchor={anchor} onContent={setContent} onStatus={setStatus} />
      </article>
      <SidePanel path={path} title={title} content={content} />
    </div>
  );
}

/** Open tasks due today or earlier, on today's journal page. */
/** In an app with no notes yet: the example notes, one for each thing the app does. */
function NewHere() {
  const loaded = useNotesLoaded();
  const notes = useNotes();
  if (!loaded || notes.length > 0) return null;
  return (
    <section className="new-here" aria-label="New here">
      <p>
        New here? The example notes show what notedid does, one thing each: tasks, tables, cards, a board, a dashboard, a paper with its PDF, and more. They're ordinary notes, and
        Ctrl+K → <i>Remove example notes</i> takes them away again.
      </p>
      <button type="button" className="primary" onClick={() => void addExampleNotes()}>
        Add example notes
      </button>
    </section>
  );
}

function DueToday({ today }: { today: string }) {
  const { data } = useLiveData(() => api.tasks(today), [today]);
  const due = (data ?? []).filter((t) => !t.done && t.due !== null && t.due <= today);
  if (due.length === 0) return null;
  return (
    <section className="due-box" aria-label="Due today">
      <h2>
        Due today{due.some((t) => (t.due ?? '') < today) ? ' and overdue' : ''} <span className="muted">({due.length})</span>
      </h2>
      <ul className="task-list">
        {due.map((t) => (
          <TaskRow key={`${t.path}:${t.line}:${t.raw}`} task={t} today={today} />
        ))}
      </ul>
    </section>
  );
}

/** A day in the journal. Today's page is where captures land. */
export function JournalPage({ date, anchor }: { date: string; anchor?: string | null }) {
  const today = useToday();
  const path = journalPath(date);
  const [content, setContent] = useState('');
  const [status, setStatus] = useState<SaveStatus>('loading');
  const title = formatDayTitle(date);
  const isToday = date === today;

  return (
    <div className="page-grid">
      <article className="note">
        <header className="note-head">
          <div className="title-row">
            <h1>{isToday ? `Today · ${title}` : title}</h1>
            <nav className="actions" aria-label="Journal day">
              <Link to={`/day/${addDays(date, -1)}`} className="icon-button" title="Previous day">
                <Icon name="left" />
              </Link>
              <button type="button" className="button" disabled={isToday} onClick={() => navigate('/')}>
                Today
              </button>
              <Link to={`/day/${addDays(date, 1)}`} className="icon-button" title="Next day">
                <Icon name="right" />
              </Link>
              <input type="date" className="date-input" value={date} aria-label="Go to day" onChange={(e) => e.target.value && navigate(`/day/${e.target.value}`)} />
              <PinButton path={path} />
              <AddToBoard path={path} title={date} />
            </nav>
          </div>
          <p className="meta">
            <span className="path">{path}</span>
            <SaveBadge status={status} />
          </p>
        </header>
        {isToday && <NewHere />}
        {isToday && <DueToday today={today} />}
        <NoteEditorPane
          path={path}
          label={`Journal for ${title}`}
          anchor={anchor ?? null}
          autoFocus={isToday && !anchor}
          placeholder="Type anything. [] or todo makes a task, [[ links a note, / for more."
          onContent={setContent}
          onStatus={setStatus}
        />
      </article>
      <SidePanel path={path} title={date} content={content} />
    </div>
  );
}
