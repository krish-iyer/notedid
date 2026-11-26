import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { NoteSummary } from '../../shared/api.ts';
import { fuzzyFilter, type FuzzyMatch } from '../../shared/fuzzy.ts';
import { captureToToday, createBoard, createDashboard, createNote, exportNotes, giveNotesIds, importNotes } from '../actions.ts';
import { syncNow } from '../sync.ts';
import { navigate, noteHref } from '../router.ts';
import { useNotes } from '../stores.ts';
import { setTheme } from '../theme.ts';
import { Icon, type IconName } from './Icon.tsx';
import { Matched } from './Text.tsx';

type Item =
  | { kind: 'note'; note: NoteSummary; match: FuzzyMatch | null }
  | { kind: 'action'; id: string; icon: IconName; label: string; hint?: string; run: () => void };

const PAGES: { label: string; to: string; icon: IconName }[] = [
  { label: 'Today', to: '/', icon: 'today' },
  { label: 'Tasks', to: '/tasks', icon: 'tasks' },
  { label: 'Search', to: '/search', icon: 'search' },
  { label: 'All notes', to: '/notes', icon: 'notes' },
  { label: 'Papers', to: '/papers', icon: 'paper' },
  { label: 'Boards', to: '/boards', icon: 'board' },
  { label: 'Dashboards', to: '/dashboards', icon: 'dashboard' },
  { label: 'Vault', to: '/vault', icon: 'vault' },
];

function noteLabel(note: NoteSummary): string {
  return note.kind === 'journal' && note.date ? note.date : note.title;
}

/** Export and import: the whole notes folder as a zip. */
const ARCHIVE: Item[] = [
  { kind: 'action', id: 'export', icon: 'upload', label: 'Export all notes (.zip)', run: () => void exportNotes() },
  { kind: 'action', id: 'import-folder', icon: 'folder', label: 'Import notes from a folder…', run: () => void importNotes('folder') },
  { kind: 'action', id: 'import-zip', icon: 'folder', label: 'Import notes from a .zip…', run: () => void importNotes('zip') },
];

/** Syncing with Dropbox. */
const SYNC: Item[] = [
  { kind: 'action', id: 'sync-now', icon: 'sync', label: 'Sync now', run: () => void syncNow() },
  { kind: 'action', id: 'sync-settings', icon: 'sync', label: 'Sync with Dropbox…', run: () => navigate('/sync') },
];

/** Ctrl+K: jump to any note, or turn what you typed into a note, a capture or a search. */
export function Switcher({ onClose }: { onClose: () => void }) {
  const notes = useNotes();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  const items = useMemo<Item[]>(() => {
    const q = query.trim();
    if (!q) {
      return [
        ...notes.slice(0, 8).map((note): Item => ({ kind: 'note', note, match: null })),
        ...PAGES.map((p): Item => ({ kind: 'action', id: p.to, icon: p.icon, label: p.label, run: () => navigate(p.to) })),
        { kind: 'action', id: 'new-board', icon: 'board', label: 'New project board', run: () => void createBoard() },
        { kind: 'action', id: 'new-dashboard', icon: 'dashboard', label: 'New dashboard', run: () => void createDashboard() },
        { kind: 'action', id: 'theme-light', icon: 'sun', label: 'Theme: light', run: () => setTheme('light') },
        { kind: 'action', id: 'theme-dark', icon: 'moon', label: 'Theme: dark', run: () => setTheme('dark') },
        { kind: 'action', id: 'theme-auto', icon: 'auto', label: 'Theme: follow the system', run: () => setTheme('auto') },
        { kind: 'action', id: 'note-ids', icon: 'check', label: 'Give every note an ID', run: () => void giveNotesIds() },
        ...ARCHIVE,
        ...SYNC,
      ];
    }
    const found = fuzzyFilter(notes, q, noteLabel, 30).map(({ item, match }): Item => ({ kind: 'note', note: item, match }));
    // Commands that match what was typed: the theme, giving notes ids.
    const commands: Item[] = /^(theme|dark|light)/i.test(q)
      ? [
          { kind: 'action', id: 'theme-light', icon: 'sun', label: 'Theme: light', run: () => setTheme('light') },
          { kind: 'action', id: 'theme-dark', icon: 'moon', label: 'Theme: dark', run: () => setTheme('dark') },
          { kind: 'action', id: 'theme-auto', icon: 'auto', label: 'Theme: follow the system', run: () => setTheme('auto') },
        ]
      : [];
    if (/^(export|import|backup|zip)/i.test(q)) commands.push(...ARCHIVE);
    if (/^(sync|dropbox)/i.test(q)) commands.push(...SYNC);
    if (/^(give|ids?\b|note ids?)/i.test(q)) commands.push({ kind: 'action', id: 'note-ids', icon: 'check', label: 'Give every note an ID', run: () => void giveNotesIds() });
    const exact = notes.some((n) => n.title.toLowerCase() === q.toLowerCase());
    const actions: Item[] = [
      ...(exact ? [] : [{ kind: 'action' as const, id: 'create', icon: 'plus' as const, label: `Create note “${q}”`, hint: 'Shift Enter', run: () => void createNote(q) }]),
      { kind: 'action', id: 'capture', icon: 'today', label: `Add “${q}” to today`, hint: 'Alt Enter', run: () => void captureToToday(q) },
      { kind: 'action', id: 'search', icon: 'search', label: `Search for “${q}”`, run: () => navigate(`/search?q=${encodeURIComponent(q)}`) },
    ];
    return [...commands, ...found, ...actions];
  }, [query, notes]);

  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const run = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    if (item.kind === 'note') navigate(noteHref(item.note.path, item.note.kind));
    else item.run();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const q = query.trim();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected((s) => Math.min(s + 1, items.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (q && event.shiftKey) run(items.find((i) => i.kind === 'action' && i.id === 'create'));
      else if (q && event.altKey) run(items.find((i) => i.kind === 'action' && i.id === 'capture'));
      else run(items[selected]);
    } else if (event.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div className="overlay switcher-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="switcher" role="dialog" aria-modal="true" aria-label="Find or create">
        <input
          className="switcher-input"
          autoFocus
          value={query}
          placeholder="Find a note, or type to create one…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded="true"
          aria-controls="switcher-list"
          aria-activedescendant={`switcher-item-${selected}`}
        />
        <ul id="switcher-list" ref={list} className="switcher-list" role="listbox">
          {items.map((item, i) => (
            <li
              key={item.kind === 'note' ? item.note.path : item.id}
              id={`switcher-item-${i}`}
              role="option"
              aria-selected={i === selected}
              className={i === selected ? 'switcher-item selected' : 'switcher-item'}
              onMouseMove={() => setSelected(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                run(item);
              }}
            >
              {item.kind === 'note' ? (
                <>
                  <Icon name={item.note.kind === 'journal' ? 'today' : item.note.kind === 'paper' ? 'paper' : item.note.kind === 'board' ? 'board' : item.note.kind === 'dashboard' ? 'dashboard' : 'notes'} size={16} />
                  <span className="switcher-title">{item.match ? <Matched text={noteLabel(item.note)} indices={item.match.indices} /> : noteLabel(item.note)}</span>
                  <span className="switcher-hint">{item.note.path.split('/')[0]}</span>
                </>
              ) : (
                <>
                  <Icon name={item.icon} size={16} />
                  <span className="switcher-title">{item.label}</span>
                  {item.hint && <kbd>{item.hint}</kbd>}
                </>
              )}
            </li>
          ))}
        </ul>
        <div className="switcher-footer">
          <span><kbd>↑↓</kbd> move</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>Shift Enter</kbd> new note</span>
          <span><kbd>Alt Enter</kbd> add to today</span>
        </div>
      </div>
    </div>
  );
}
