import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { startServiceWorker } from './browserApp.ts';
import { appUrl } from './router.ts';
import { startSync } from './sync.ts';
import './styles.css';

// Whiteboards draw with fonts that come with the app (vite.excalidraw.ts puts them in excalidraw/fonts/):
// offline, and in the desktop app, which loads nothing from the web. A whole address: given a path,
// Excalidraw makes one with location.origin, which the desktop app's own scheme (notedid://) doesn't give.
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = new URL(appUrl('/excalidraw/'), location.href).href;

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

/** A service worker runs only over HTTPS (or on this computer): the browser-only app opened over plain http moves to https. */
function toHttps(): boolean {
  if (location.protocol !== 'http:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return false;
  location.replace(`https:${location.href.slice('http:'.length)}`);
  return true;
}

async function start(element: HTMLElement): Promise<void> {
  if (__BROWSER_APP__ && toHttps()) return;
  // The browser-only app first starts its backend (a service worker).
  if (__BROWSER_APP__) await startServiceWorker();
  createRoot(element).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  startSync();
}

start(root).catch((err: unknown) => {
  root.textContent = `The app could not start: ${err instanceof Error ? err.message : String(err)}`;
});
