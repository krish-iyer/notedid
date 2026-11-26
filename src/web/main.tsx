import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { startServiceWorker } from './browserApp.ts';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

async function start(element: HTMLElement): Promise<void> {
  // The browser-only app first starts its backend (a service worker).
  if (__BROWSER_APP__) await startServiceWorker();
  createRoot(element).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

start(root).catch((err: unknown) => {
  root.textContent = `The app could not start: ${err instanceof Error ? err.message : String(err)}`;
});
