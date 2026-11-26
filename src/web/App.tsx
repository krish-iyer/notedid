import { lazy, Suspense, useEffect, useState } from 'react';
import { Icon } from './components/Icon.tsx';
import { Overlays } from './components/Overlays.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { Switcher } from './components/Switcher.tsx';
import { useToday } from './hooks.ts';
import { JournalPage, NotePage } from './pages/NotePage.tsx';
import { NotesPage, NotFoundPage, SearchPage, TasksPage } from './pages/ListPages.tsx';
import { navigate, type Route, useRoute } from './router.ts';
import { startStores } from './stores.ts';

// Heavier screens load on first use (PDF.js, the vault's crypto).
const PapersPage = lazy(() => import('./pages/PapersPage.tsx').then((m) => ({ default: m.PapersPage })));
const PaperPage = lazy(() => import('./pages/PaperPage.tsx').then((m) => ({ default: m.PaperPage })));
const ReadPage = lazy(() => import('./pages/ReadPage.tsx').then((m) => ({ default: m.ReadPage })));
const BoardsPage = lazy(() => import('./pages/BoardPage.tsx').then((m) => ({ default: m.BoardsPage })));
const BoardPage = lazy(() => import('./pages/BoardPage.tsx').then((m) => ({ default: m.BoardPage })));
const DashboardsPage = lazy(() => import('./pages/DashboardPage.tsx').then((m) => ({ default: m.DashboardsPage })));
const DashboardPage = lazy(() => import('./pages/DashboardPage.tsx').then((m) => ({ default: m.DashboardPage })));
const VaultPage = lazy(() => import('./pages/VaultPage.tsx').then((m) => ({ default: m.VaultPage })));

function Screen({ route }: { route: Route }) {
  const today = useToday();
  switch (route.name) {
    case 'today':
      return <JournalPage key={today} date={today} />;
    case 'day':
      return <JournalPage key={route.date} date={route.date} anchor={route.anchor} />;
    case 'note':
      return <NotePage key={route.path} path={route.path} anchor={route.anchor} />;
    case 'search':
      return <SearchPage key={route.q} initialQuery={route.q} />;
    case 'tasks':
      return <TasksPage />;
    case 'notes':
      return <NotesPage />;
    case 'papers':
      return <PapersPage />;
    case 'paper':
      return <PaperPage key={route.path} path={route.path} page={route.page} highlight={route.hl} />;
    case 'read':
      return <ReadPage key={route.path} path={route.path} />;
    case 'boards':
      return <BoardsPage />;
    case 'board':
      return <BoardPage key={route.path} path={route.path} />;
    case 'dashboards':
      return <DashboardsPage />;
    case 'dashboard':
      return <DashboardPage key={route.path} path={route.path} />;
    case 'vault':
      return <VaultPage />;
    default:
      return <NotFoundPage />;
  }
}

export function App() {
  const route = useRoute();
  const [switcher, setSwitcher] = useState(false);
  const [menu, setMenu] = useState(false);

  useEffect(() => startStores(), []);
  useEffect(() => setMenu(false), [route]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && key === 'k') {
        event.preventDefault();
        setSwitcher(true);
      } else if (mod && event.shiftKey && key === 'f') {
        event.preventDefault();
        navigate('/search');
      } else if (mod && key === 's') {
        event.preventDefault(); // notes save on their own
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <Sidebar open={menu} onClose={() => setMenu(false)} onOpenSwitcher={() => setSwitcher(true)} />
      <div className="main">
        <header className="mobile-bar">
          <button type="button" className="icon-button" aria-label="Menu" onClick={() => setMenu(true)}>
            <Icon name="menu" />
          </button>
          <span className="brand">Notes</span>
          <button type="button" className="icon-button" aria-label="Find or create" onClick={() => setSwitcher(true)}>
            <Icon name="search" />
          </button>
        </header>
        <main className="content">
          <Suspense fallback={<p className="muted page">Loading…</p>}>
            <Screen route={route} />
          </Suspense>
        </main>
      </div>
      {switcher && <Switcher onClose={() => setSwitcher(false)} />}
      <Overlays />
    </div>
  );
}
