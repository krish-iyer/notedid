import { useMemo, useState } from 'react';
import { createBoard, createNote, removeView } from '../actions.ts';
import { Link, noteHref, type Route, useRoute } from '../router.ts';
import { useNotes, useSettings, useTags } from '../stores.ts';
import { setTheme, useTheme } from '../theme.ts';
import { Icon, type IconName } from './Icon.tsx';

function isCurrent(route: Route, name: Route['name'] | Route['name'][]): boolean {
  return Array.isArray(name) ? name.includes(route.name) : route.name === name;
}

function NavItem({ to, icon, label, active, badge, onNavigate }: { to: string; icon: IconName; label: string; active: boolean; badge?: number; onNavigate: () => void }) {
  return (
    <Link to={to} className={active ? 'nav-item active' : 'nav-item'} aria-current={active ? 'page' : undefined} onNavigate={onNavigate}>
      <Icon name={icon} />
      <span className="nav-label">{label}</span>
      {badge ? <span className="badge">{badge}</span> : null}
    </Link>
  );
}

export function Sidebar({ open, onClose, onOpenSwitcher }: { open: boolean; onClose: () => void; onOpenSwitcher: () => void }) {
  const route = useRoute();
  const notes = useNotes();
  const settings = useSettings();
  const tags = useTags();
  const [showAllTags, setShowAllTags] = useState(false);
  const theme = useTheme();

  const openTasks = useMemo(() => notes.reduce((sum, n) => sum + n.openTasks, 0), [notes]);
  const pinned = useMemo(() => (settings?.pinned ?? []).map((p) => notes.find((n) => n.path === p)).filter((n) => n !== undefined), [settings, notes]);
  // Not journal days (Today has them), nor the paper library's collections file.
  const recent = useMemo(() => notes.filter((n) => n.kind !== 'journal' && n.meta.type !== 'collections').slice(0, 6), [notes]);
  const currentPath = 'path' in route ? route.path : null;
  const close = onClose;

  return (
    <>
      {open && <div className="sidebar-scrim" onClick={onClose} aria-hidden="true" />}
      <nav className={open ? 'sidebar open' : 'sidebar'} aria-label="Main">
        <div className="sidebar-top">
          <span className="brand">Notes</span>
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
        </div>

        {pinned.length > 0 && (
          <div className="nav-section">
            <h2>Pinned</h2>
            {pinned.map((n) => (
              <Link key={n.path} to={noteHref(n.path, n.kind)} className={currentPath === n.path ? 'nav-sub active' : 'nav-sub'} onNavigate={close}>
                <Icon name="pin" size={14} /> {n.kind === 'journal' ? n.date : n.title}
              </Link>
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

        {recent.length > 0 && (
          <div className="nav-section">
            <h2>Recent</h2>
            {recent.map((n) => (
              <Link key={n.path} to={noteHref(n.path, n.kind)} className={currentPath === n.path ? 'nav-sub active' : 'nav-sub'} onNavigate={close}>
                {n.title}
              </Link>
            ))}
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
