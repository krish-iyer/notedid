/// <reference lib="webworker" />
import { type Backend, startBackend } from './backend.ts';

/**
 * The service worker of the browser-only app. It answers the app's /api requests with the backend
 * (notes in IndexedDB), and serves the app's own files from a cache, so the app opens offline.
 * A new version of the app comes with a new worker, which replaces this one and its cache.
 */

declare const self: ServiceWorkerGlobalScope;
/** The app's files, as URL paths (filled in when the worker is built). */
declare const __APP_FILES__: string[];
/** This build's name, for the cache. */
declare const __BUILD__: string;

const CACHE = `notesapp-${__BUILD__}`;
/** Where the app is served from ('/', or a folder such as '/notedid/'): the worker's scope. */
const BASE = new URL(self.registration.scope).pathname;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(__APP_FILES__);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('notesapp-') && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

let backend: Promise<Backend> | null = null;

async function api(request: Request): Promise<Response> {
  try {
    backend ??= startBackend();
    // The backend's routes are /api/…, wherever the app is served from.
    const url = new URL(request.url);
    const routed = BASE === '/' ? request : new Request(`${url.origin}/${url.pathname.slice(BASE.length)}${url.search}`, request);
    return await (await backend).app.fetch(routed);
  } catch (err) {
    backend = null;
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `The app could not open your notes: ${message}` }, { status: 500 });
  }
}

/** The app's own files: from the cache, else from the network (and kept for next time, e.g. the WebAssembly). */
async function appFile(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  // Any page of the app (/note/…, /day/…) is index.html; the app shows the right one.
  if (request.mode === 'navigate') {
    const page = await cache.match(`${BASE}index.html`);
    if (page) return page;
  }
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(`${BASE}api/`)) {
    const response = api(event.request);
    event.respondWith(response);
    // A browser stops an idle worker after half a minute or so: after a change, stay until the notes'
    // new versions are kept (a minute after the last change, or a few minutes while changes go on).
    if (event.request.method !== 'GET') event.waitUntil(response.then(async () => (await backend)?.idle()).catch(() => undefined));
  } else if (event.request.method === 'GET') event.respondWith(appFile(event.request));
});
