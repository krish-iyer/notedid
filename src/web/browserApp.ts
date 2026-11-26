import { showToast } from './toast.ts';

/**
 * The browser-only app: registers its service worker, which answers the app's /api requests from
 * the notes kept in this browser, and waits until it handles this page.
 */
export async function startServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    throw new Error('this browser can’t keep notes on its own here (no service workers; some private windows turn them off)');
  }
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
  }
  // Later, a new version of the app took over: it applies fully after a reload.
  navigator.serviceWorker.addEventListener('controllerchange', () => showToast('The app was updated. Reload the page to use the new version.'));
  // Ask the browser to keep the notes even when it runs short of space.
  void navigator.storage?.persist?.().catch(() => false);
}
