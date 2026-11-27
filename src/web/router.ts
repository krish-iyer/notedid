import { createElement, type MouseEvent, type ReactNode, useMemo, useSyncExternalStore } from 'react';
import { isISODate, journalDateOf } from '../shared/dates.ts';
import { isWhiteboardPath } from '../shared/whiteboards.ts';

/** Every screen of the app. URLs never contain ".md": /note/notes/groceries is notes/groceries.md. */
export type Route =
  | { name: 'today' }
  | { name: 'day'; date: string; anchor: string | null }
  | { name: 'note'; path: string; anchor: string | null }
  | { name: 'search'; q: string }
  | { name: 'tasks' }
  | { name: 'notes' }
  | { name: 'papers' }
  | { name: 'paper'; path: string; page: number | null; hl: string | null }
  | { name: 'read'; path: string }
  | { name: 'boards' }
  | { name: 'board'; path: string }
  | { name: 'dashboards' }
  | { name: 'dashboard'; path: string }
  | { name: 'vault' }
  | { name: 'sync' }
  | { name: 'whiteboards' }
  | { name: 'whiteboard'; path: string; frame: string | null }
  | { name: 'notfound' };

/**
 * Where the app is served from: '/' usually, or a folder such as '/notedid/' when it is hosted on
 * GitHub Pages (set when building). App paths ('/note/…', '/api/…') are written without it.
 */
export const BASE = import.meta.env.BASE_URL;

/** An app path as the URL path to use: under BASE. */
export function appUrl(path: string): string {
  return BASE === '/' ? path : `${BASE}${path.replace(/^\//, '')}`;
}

/** The app path of a URL path (BASE taken off). */
function appPath(pathname: string): string {
  if (BASE === '/') return pathname;
  if (pathname.startsWith(BASE)) return `/${pathname.slice(BASE.length)}`;
  // The folder itself, without its last slash.
  return `${pathname}/` === BASE ? '/' : pathname;
}

/** The app path of the page shown, with its query. */
export function currentHref(): string {
  return appPath(location.pathname) + location.search;
}

export function encodeNotePath(path: string): string {
  return path
    .replace(/\.(md|excalidraw)$/i, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

function decodeNotePath(rest: string, extension = '.md'): string | null {
  try {
    const path = rest.split('/').map(decodeURIComponent).join('/');
    return path ? `${path}${extension}` : null;
  } catch {
    return null;
  }
}

export function parseRoute(url: URL): Route {
  const p = appPath(url.pathname).replace(/\/+$/, '') || '/';
  const anchor = url.hash ? decodeURIComponent(url.hash.slice(1)) : null;
  const under = (prefix: string, extension?: string) => (p.startsWith(prefix) ? decodeNotePath(p.slice(prefix.length), extension) : null);
  if (p === '/') return { name: 'today' };
  if (p.startsWith('/day/')) {
    const date = p.slice(5);
    return isISODate(date) ? { name: 'day', date, anchor } : { name: 'notfound' };
  }
  const simple: Record<string, Route> = {
    '/tasks': { name: 'tasks' },
    '/notes': { name: 'notes' },
    '/papers': { name: 'papers' },
    '/boards': { name: 'boards' },
    '/dashboards': { name: 'dashboards' },
    '/whiteboards': { name: 'whiteboards' },
    '/vault': { name: 'vault' },
    '/sync': { name: 'sync' },
  };
  if (simple[p]) return simple[p];
  if (p === '/search') return { name: 'search', q: url.searchParams.get('q') ?? '' };
  const note = under('/note/');
  if (note) return { name: 'note', path: note, anchor };
  const paper = under('/paper/');
  if (paper) {
    const page = Number(url.searchParams.get('page'));
    return { name: 'paper', path: paper, page: Number.isInteger(page) && page > 0 ? page : null, hl: url.searchParams.get('hl') };
  }
  const read = under('/read/');
  if (read) return { name: 'read', path: read };
  const board = under('/board/');
  if (board) return { name: 'board', path: board };
  const dashboard = under('/dashboard/');
  if (dashboard) return { name: 'dashboard', path: dashboard };
  // A whiteboard, and the frame (diagram) on it to show: /whiteboard/whiteboards/Plan#Architecture
  const whiteboard = under('/whiteboard/', '.excalidraw');
  if (whiteboard) return { name: 'whiteboard', path: whiteboard, frame: anchor };
  return { name: 'notfound' };
}

/** The URL that opens a note in the right screen for its kind. */
export function noteHref(path: string, kind?: string, anchor?: string | null): string {
  const hash = anchor ? `#${encodeURIComponent(anchor)}` : '';
  const date = journalDateOf(path);
  if (date) return `/day/${date}${hash}`;
  if (kind === 'paper') return `/paper/${encodeNotePath(path)}`;
  if (kind === 'board') return `/board/${encodeNotePath(path)}`;
  if (kind === 'dashboard') return `/dashboard/${encodeNotePath(path)}`;
  // A whiteboard's anchor names a frame on it; a line (L12, from a backlink) means nothing there.
  if (kind === 'whiteboard' || isWhiteboardPath(path)) return `/whiteboard/${encodeNotePath(path)}${anchor && !/^L\d+$/.test(anchor) ? hash : ''}`;
  return `/note/${encodeNotePath(path)}${hash}`;
}

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

window.addEventListener('popstate', notify);

export function navigate(href: string, options: { replace?: boolean } = {}): void {
  if (href === currentHref() + location.hash) return;
  if (options.replace) history.replaceState(null, '', appUrl(href));
  else history.pushState(null, '', appUrl(href));
  notify();
  if (!href.includes('#')) window.scrollTo(0, 0);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRoute(): Route {
  const href = useSyncExternalStore(subscribe, () => location.href);
  return useMemo(() => parseRoute(new URL(href)), [href]);
}

interface LinkProps {
  to: string;
  children?: ReactNode;
  className?: string;
  title?: string;
  'aria-current'?: 'page' | undefined;
  onNavigate?: () => void;
}

/** An <a> that navigates inside the app (and still opens in a new tab with Ctrl/Cmd-click). */
export function Link({ to, children, onNavigate, ...rest }: LinkProps) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
    onNavigate?.();
  };
  return createElement('a', { href: appUrl(to), onClick, ...rest }, children);
}
