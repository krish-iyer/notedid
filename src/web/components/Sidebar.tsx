import { useMemo, useState } from 'react';
import type { NoteSummary } from '../../shared/api.ts';
import { formatDayTitle, journalPath } from '../../shared/dates.ts';
import { createBoard, createNote, removeView } from '../actions.ts';
import { forgetVisit, useRecentVisits } from '../recent.ts';
import { Link, noteHref, type Route, useRoute } from '../router.ts';
import { useNotes, useSettings, useTags } from '../stores.ts';
import { useSyncStatus } from '../sync.ts';
import { setTheme, useTheme } from '../theme.ts';
import { Icon, type IconName } from './Icon.tsx';

function isCurrent(route: Route, name: Route['name'] | Route['name'][]): boolean {
  return Array.isArray(name) ? name.includes(route.name) : route.name === name;
}

function NavItem({ to, icon, label, active, badge, warn, onNavigate }: { to: string; icon: IconName; label: string; active: boolean; badge?: number; warn?: string; onNavigate: () => void }) {
  return (
    <Link to={to} className={active ? 'nav-item active' : 'nav-item'} aria-current={active ? 'page' : undefined} onNavigate={onNavigate}>
      <Icon name={icon} />
      <span className="nav-label">{label}</span>
      {badge ? <span className="badge">{badge}</span> : null}
      {warn ? (
        <span className="badge warn" title={warn}>
          !
        </span>
      ) : null}
    </Link>
  );
}

const KIND_ICONS: Partial<Record<NoteSummary['kind'], IconName>> = { journal: 'today', paper: 'paper', board: 'board', dashboard: 'dashboard' };

/** A note's name in the sidebar: its title, or its day for a journal page. */
function noteName(n: NoteSummary): string {
  return n.kind === 'journal' && n.date ? formatDayTitle(n.date) : n.title;
}

/** What the sync item says needs a look, if anything. */
function syncWarning(status: ReturnType<typeof useSyncStatus>): string | undefined {
  if (!status?.connected) return undefined;
  if (status.confirmDeletes !== null) return 'Sync waits for you: files were deleted here';
  if (status.lastError) return `Sync failed: ${status.lastError}`;
  return undefined;
}

export function Sidebar({ open, onClose, onOpenSwitcher }: { open: boolean; onClose: () => void; onOpenSwitcher: () => void }) {
  const route = useRoute();
  const notes = useNotes();
  const settings = useSettings();
  const tags = useTags();
  const [showAllTags, setShowAllTags] = useState(false);
  const theme = useTheme();
  const sync = useSyncStatus();

  const openTasks = useMemo(() => notes.reduce((sum, n) => sum + n.openTasks, 0), [notes]);
  const pinned = useMemo(() => (settings?.pinned ?? []).map((p) => notes.find((n) => n.path === p)).filter((n) => n !== undefined), [settings, notes]);
  const currentPath = 'path' in route ? route.path : route.name === 'day' ? journalPath(route.date) : null;
  // The notes you went to, the latest first: not the one open now, nor ones gone since, nor the
  // files that go with another note (a document's comments, the paper library's collections).
  const visits = useRecentVisits();
  const recent = useMemo(() => {
    const byPath = new Map(notes.map((n) => [n.path, n]));
    return visits
      .map((path) => byPath.get(path))
      .filter((n): n is NoteSummary => n !== undefined && n.path !== currentPath && n.kind !== 'comments' && n.meta.type !== 'collections')
      .slice(0, 6);
  }, [notes, visits, currentPath]);
  const close = onClose;

  return (
    <>
      {open && <div className="sidebar-scrim" onClick={onClose} aria-hidden="true" />}
      <nav className={open ? 'sidebar open' : 'sidebar'} aria-label="Main">
        <div className="sidebar-top">
          <span className="brand">notedid</span>
          <button type="button" className="icon-button sidebar-close" aria-label="Close menu" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <button type="button" className="quick-find" onClick={onOpenSwitcher}>
          <Icon name="search" size={16} />
          <span>Find or create…</span>
          <kbd>Ctrl K</kbd>
        </button>
        <button type="button" className="new-note" onClick={() => void createNote()}>
          <Icon name="plus" size={16} /> New note
        </button>

        <div className="nav-group">
          <NavItem to="/" icon="today" label="Today" active={isCurrent(route, ['today', 'day'])} onNavigate={close} />
          <NavItem to="/tasks" icon="tasks" label="Tasks" active={isCurrent(route, 'tasks')} badge={openTasks} onNavigate={close} />
          <NavItem to="/search" icon="search" label="Search" active={isCurrent(route, 'search')} onNavigate={close} />
          <NavItem to="/notes" icon="notes" label="All notes" active={isCurrent(route, ['notes', 'note', 'read'])} onNavigate={close} />
          <NavItem to="/papers" icon="paper" label="Papers" active={isCurrent(route, ['papers', 'paper'])} onNavigate={close} />
          <NavItem to="/boards" icon="board" label="Boards" active={isCurrent(route, ['boards', 'board'])} onNavigate={close} />
          <NavItem to="/dashboards" icon="dashboard" label="Dashboards" active={isCurrent(route, ['dashboards', 'dashboard'])} onNavigate={close} />
          <NavItem to="/vault" icon="vault" label="Vault" active={isCurrent(route, 'vault')} onNavigate={close} />
          <NavItem to="/sync" icon="sync" label={sync?.connected ? 'Sync' : 'Sync…'} active={isCurrent(route, 'sync')} warn={syncWarning(sync)} onNavigate={close} />
        </div>

        {pinned.length > 0 && (
          <div className="nav-section">
            <h2>Pinned</h2>
            {pinned.map((n) => (
              <Link key={n.path} to={noteHref(n.path, n.kind)} className={currentPath === n.path ? 'nav-sub active' : 'nav-sub'} title={noteName(n)} onNavigate={close}>
                <Icon name="pin" size={14} /> <span className="nav-text">{noteName(n)}</span>
              </Link>
            ))}
          </div>
        )}

        {recent.length > 0 && (
          <div className="nav-section">
            <h2>Recent</h2>
            {recent.map((n) => (
              <div key={n.path} className="nav-sub-row recent-row">
                <Link to={noteHref(n.path, n.kind)} className="nav-sub" title={noteName(n)} onNavigate={close}>
                  <Icon name={KIND_ICONS[n.kind] ?? 'notes'} size={14} /> <span className="nav-text">{noteName(n)}</span>
                </Link>
                <button type="button" className="icon-button remove" title="Remove from Recent" aria-label={`Remove ${noteName(n)} from Recent`} onClick={() => forgetVisit(n.path)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {settings && settings.views.length > 0 && (
          <div className="nav-section">
            <h2>Views</h2>
            {settings.views.map((v) => (
              <div key={v.name} className="nav-sub-row">
                <Link to={`/search?q=${encodeURIComponent(v.query)}`} className={route.name === 'search' && route.q === v.query ? 'nav-sub active' : 'nav-sub'} title={v.query} onNavigate={close}>
                  <Icon name="view" size={14} /> {v.name}
                </Link>
                <button type="button" className="icon-button remove" aria-label={`Remove view ${v.name}`} onClick={() => void removeView(v.name)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {tags.length > 0 && (
          <div className="nav-section">
            <h2>Tags</h2>
            <div className="tag-cloud">
              {(showAllTags ? tags : tags.slice(0, 12)).map((t) => (
                <Link key={t.tag} to={`/search?q=${encodeURIComponent(`tag:${t.tag}`)}`} className="tag-chip" onNavigate={close}>
                  #{t.tag} <span className="count">{t.count}</span>
                </Link>
              ))}
              {tags.length > 12 && (
                <button type="button" className="link-button small" onClick={() => setShowAllTags(!showAllTags)}>
                  {showAllTags ? 'fewer' : `all ${tags.length}`}
                </button>
              )}
            </div>
          </div>
        )}

        <div className="nav-section">
          <button type="button" className="link-button small" onClick={() => void createBoard()}>
            + New project board
          </button>
        </div>

        <div className="theme-switch" role="group" aria-label="Theme">
          {(
            [
              ['auto', 'auto', 'Follow the system'],
              ['light', 'sun', 'Light'],
              ['dark', 'moon', 'Dark'],
            ] as const
          ).map(([choice, icon, label]) => (
            <button key={choice} type="button" className={theme === choice ? 'active' : ''} aria-pressed={theme === choice} title={label} onClick={() => setTheme(choice)}>
              <Icon name={icon} size={15} /> {choice === 'auto' ? 'Auto' : label}
            </button>
          ))}
        </div>
      </nav>
    </>
  );
}
