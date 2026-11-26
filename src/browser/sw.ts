/// <reference lib="webworker" />
import type { Hono } from 'hono';
import { startBackend } from './backend.ts';

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

let backend: Promise<Hono> | null = null;

async function api(request: Request): Promise<Response> {
  try {
    backend ??= startBackend();
    return await (await backend).fetch(request);
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
    const page = await cache.match('/index.html');
    if (page) return page;
  }
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) event.respondWith(api(event.request));
  else if (event.request.method === 'GET') event.respondWith(appFile(event.request));
});
