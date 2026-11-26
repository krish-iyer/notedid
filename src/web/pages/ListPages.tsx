import { useEffect, useMemo, useState } from 'react';
import type { NoteKind, TaskItem } from '../../shared/api.ts';
import { fuzzyFilter } from '../../shared/fuzzy.ts';
import { dueState } from '../../shared/tasks.ts';
import { captureToToday, createNote, saveView } from '../actions.ts';
import { api } from '../api.ts';
import { Icon } from '../components/Icon.tsx';
import { TaskRow, taskLabel } from '../components/TaskRow.tsx';
import { Matched, Snippet } from '../components/Text.tsx';
import { useDebounced, useLiveData, useToday } from '../hooks.ts';
import { Link, navigate, noteHref } from '../router.ts';
import { useNotes, useNotesLoaded } from '../stores.ts';
import { timeAgo } from '../util.ts';

const EXAMPLES: [string, string][] = [
  ['tag:fpga', 'notes tagged #fpga (and #fpga/…)'],
  ['is:open', 'open tasks everywhere'],
  ['due:week', 'tasks due in the next 7 days'],
  ['due:overdue', 'tasks past their due date'],
  ['"bank conflict"', 'an exact phrase'],
  ['hbm -draft', 'hbm, but not draft'],
  ['in:papers attention', 'only papers'],
  ['in:journal after:2026-10-01', 'journal days since a date'],
  ['has:pdf', 'notes with PDFs'],
];

export function SearchPage({ initialQuery }: { initialQuery: string }) {
  const today = useToday();
  const [query, setQuery] = useState(initialQuery);
  const debounced = useDebounced(query, 200);
  const [showHelp, setShowHelp] = useState(false);
  const { data, error } = useLiveData(() => (debounced.trim() ? api.search(debounced, today) : Promise.resolve(null)), [debounced, today]);

  useEffect(() => {
    const target = debounced.trim() ? `/search?q=${encodeURIComponent(debounced)}` : '/search';
    if (location.pathname + location.search !== target) navigate(target, { replace: true });
  }, [debounced]);

  return (
    <div className="page narrow">
      <header className="page-head">
        <h1>Search</h1>
      </header>
      <div className="search-bar">
        <Icon name="search" />
        <input className="text-input" autoFocus value={query} placeholder="Words, “phrases”, tag:x, is:open, due:week…" aria-label="Search" onChange={(e) => setQuery(e.target.value)} />
        {debounced.trim() && (
          <button type="button" onClick={() => void saveView(debounced.trim())}>
            Save as view
          </button>
        )}
        <button type="button" className="link-button" onClick={() => setShowHelp(!showHelp)} aria-expanded={showHelp}>
          {showHelp ? 'Hide tips' : 'Tips'}
        </button>
      </div>
      {showHelp && (
        <ul className="search-help">
          {EXAMPLES.map(([example, meaning]) => (
            <li key={example}>
              <button type="button" className="link-button" onClick={() => setQuery(example)}>
                <code>{example}</code>
              </button>{' '}
              {meaning}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
      {data?.errors.map((e) => (
        <p key={e} className="warning">
          {e}
        </p>
      ))}
      {data && data.mode === 'notes' && (
        <>
          <p className="muted small">{data.notes.length === 0 ? 'Nothing found.' : `${data.notes.length} note${data.notes.length === 1 ? '' : 's'}`}</p>
          <ul className="result-list">
            {data.notes.map((hit) => (
              <li key={hit.path}>
                <Link to={noteHref(hit.path, hit.kind)} className="result-title">
                  {hit.kind === 'journal' ? hit.path.slice(8, 18) : hit.title}
                </Link>
                <span className="result-path">{hit.path}</span>
                <p className="result-snippet">
                  <Snippet text={hit.snippet} />
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
      {data && data.mode === 'tasks' && (
        <>
          <p className="muted small">{data.tasks.length === 0 ? 'No tasks match.' : `${data.tasks.length} task${data.tasks.length === 1 ? '' : 's'}`}</p>
          <ul className="task-list">
            {data.tasks.map((t) => (
              <TaskRow key={`${t.path}:${t.line}:${t.raw}`} task={t} today={today} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function groupTasks(tasks: TaskItem[], today: string) {
  const groups = { overdue: [] as TaskItem[], today: [] as TaskItem[], upcoming: [] as TaskItem[], none: [] as TaskItem[], done: [] as TaskItem[] };
  for (const t of tasks) {
    if (t.done) groups.done.push(t);
    else groups[dueState(t.due, today)].push(t);
  }
  groups.done.sort((a, b) => (b.doneDate ?? '').localeCompare(a.doneDate ?? ''));
  return groups;
}

export function TasksPage() {
  const today = useToday();
  const { data, error } = useLiveData(() => api.tasks(today), [today]);
  const [filter, setFilter] = useState('');
  const [newTask, setNewTask] = useState('');
  const [showDone, setShowDone] = useState(false);

  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (data ?? []).filter((t) => !f || t.text.toLowerCase().includes(f) || t.title.toLowerCase().includes(f));
  }, [data, filter]);
  const groups = groupTasks(visible, today);
  const sections: [keyof typeof groups, string][] = [
    ['overdue', 'Overdue'],
    ['today', 'Today'],
    ['upcoming', 'Upcoming'],
    ['none', 'No date'],
  ];

  return (
    <div className="page narrow">
      <header className="page-head">
        <h1>Tasks</h1>
        <p className="muted">Every “- [ ]” line in your notes. Ticking one here ticks it in its note.</p>
      </header>
      <form
        className="add-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newTask.trim()) return;
          void captureToToday(`[] ${newTask.trim()}`);
          setNewTask('');
        }}
      >
        <input className="text-input" value={newTask} placeholder="Add a task to today… (due:fri works)" aria-label="New task" onChange={(e) => setNewTask(e.target.value)} />
        <button type="submit" className="primary" disabled={!newTask.trim()}>
          Add
        </button>
      </form>
      <input className="text-input filter" value={filter} placeholder="Filter tasks" aria-label="Filter tasks" onChange={(e) => setFilter(e.target.value)} />
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && visible.length === 0 && <p className="muted">No tasks{filter ? ' match' : ' yet. Type “[] something” in any note'}.</p>}
      {data && visible.length > 0 && visible.every((t) => t.done) && <p className="muted">Nothing open{filter ? ' that matches' : ''}. 🎉</p>}
      {sections.map(([key, label]) =>
        groups[key].length ? (
          <section key={key} className={`task-group group-${key}`}>
            <h2>
              {label} <span className="muted">({groups[key].length})</span>
            </h2>
            <ul className="task-list">
              {groups[key].map((t) => (
                <TaskRow key={`${t.path}:${t.line}:${t.raw}`} task={t} today={today} />
              ))}
            </ul>
          </section>
        ) : null,
      )}
      {groups.done.length > 0 && (
        <section className="task-group">
          <h2>
            <button type="button" className="link-button" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
              Done in the last two weeks ({groups.done.length}) {showDone ? '▾' : '▸'}
            </button>
          </h2>
          {showDone && (
            <ul className="task-list">
              {groups.done.map((t) => (
                <TaskRow key={`${t.path}:${t.line}:${t.raw}`} task={t} today={today} />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

const KINDS: [NoteKind | 'all', string][] = [
  ['all', 'All'],
  ['note', 'Notes'],
  ['journal', 'Journal'],
  ['paper', 'Papers'],
  ['board', 'Boards'],
  ['dashboard', 'Dashboards'],
];

export function NotesPage() {
  const notes = useNotes();
  const loaded = useNotesLoaded();
  const [kind, setKind] = useState<NoteKind | 'all'>('all');
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<'modified' | 'title'>('modified');

  const rows = useMemo(() => {
    const ofKind = notes.filter((n) => kind === 'all' || n.kind === kind);
    if (filter.trim()) return fuzzyFilter(ofKind, filter, (n) => n.title, 500);
    const sorted = [...ofKind].sort((a, b) => (sort === 'title' ? a.title.localeCompare(b.title) : b.mtime - a.mtime));
    return sorted.map((item) => ({ item, match: null }));
  }, [notes, kind, filter, sort]);

  return (
    <div className="page narrow">
      <header className="page-head with-action">
        <h1>All notes</h1>
        <button type="button" className="primary" onClick={() => void createNote()}>
          <Icon name="plus" size={16} /> New note
        </button>
      </header>
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Kind">
          {KINDS.map(([k, label]) => (
            <button key={k} type="button" aria-pressed={kind === k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>
              {label}
            </button>
          ))}
        </div>
        <input className="text-input filter" value={filter} placeholder="Filter by title" aria-label="Filter by title" onChange={(e) => setFilter(e.target.value)} />
        <select value={sort} onChange={(e) => setSort(e.target.value as 'modified' | 'title')} aria-label="Sort">
          <option value="modified">Recently changed</option>
          <option value="title">Title</option>
        </select>
      </div>
      {!loaded && <p className="muted">Loading…</p>}
      {loaded && rows.length === 0 && <p className="muted">No notes{filter ? ' match' : ' yet'}.</p>}
      <ul className="note-list">
        {rows.map(({ item, match }) => (
          <li key={item.path}>
            <div className="note-row-head">
              <Link to={noteHref(item.path, item.kind)} className="result-title">
                {match ? <Matched text={item.title} indices={match.indices} /> : item.title}
              </Link>
              <span className="muted small">{timeAgo(item.mtime)}</span>
              {item.openTasks > 0 && <span className="badge" title="Open tasks">{item.openTasks}</span>}
            </div>
            {item.excerpt && <p className="result-snippet">{taskLabel(item.excerpt)}</p>}
            {item.tags.length > 0 && (
              <div className="tag-row">
                {item.tags.map((t) => (
                  <Link key={t} to={`/search?q=${encodeURIComponent(`tag:${t}`)}`} className="tag-chip">
                    #{t}
                  </Link>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="page narrow">
      <h1>Not found</h1>
      <p>
        There’s nothing at this address. <Link to="/">Go to today</Link>.
      </p>
    </div>
  );
}
